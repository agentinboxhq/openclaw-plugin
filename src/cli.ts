// `openclaw agentinbox setup` connects this OpenClaw to an agent with a one-time code from agentinbox.md, and
// `openclaw agentinbox status` shows where the agent listens.
import { createInterface } from "node:readline/promises";
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { AgentInboxApi, ApiError, type FetchLike, type Json, isRecord } from "./api.js";
import { computerName, personAtTerminal } from "./computer.js";
import { HOST_NAMES, nowIso } from "./listener.js";
import {
  CHANNEL_ID,
  DEFAULT_API_URL,
  HOST_ID,
  HOST_NAME,
  RESTART_COMMAND,
  SETUP_COMMAND,
  type Settings,
  connectionOf,
  isConfigured,
  readSettings,
} from "./settings.js";
import { FileStateStore, type StateStore } from "./state.js";

// The API's rule for an agent's handle: what its address starts with, before the @.
const HANDLE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const HANDLE_MAX = 32;

export const CANCELED_MESSAGE = "Nothing changed. The code still works for the rest of its 10 minutes.";

export class SetupError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "SetupError";
  }
}

/** `atlas`, `Atlas` and `atlas@agentinbox.md` all name the agent `atlas`. */
export function readAgent(value: unknown): string {
  const handle = String(value ?? "")
    .trim()
    .toLowerCase()
    .split("@")[0] ?? "";
  if (!HANDLE.test(handle) || handle.length > HANDLE_MAX) {
    throw new SetupError("Name the agent as its address starts, before the @: openclaw agentinbox setup atlas --code BCDF-GHJK");
  }
  return handle;
}

/** The code as agentinbox.md shows it, e.g. `BCDF-GHJK`. Case, spaces and the dash don't matter. */
export function readCode(value: unknown): string {
  const letters = String(value ?? "")
    .toUpperCase()
    .replace(/[\s-]/g, "");
  if (!/^[A-Z]{8}$/.test(letters)) {
    throw new SetupError("Pass the one-time code from agentinbox.md: eight letters, like --code BCDF-GHJK.");
  }
  return `${letters.slice(0, 4)}-${letters.slice(4)}`;
}

export type Out = {
  info: (text: string) => void;
  success: (text: string) => void;
  warning: (text: string) => void;
  error: (text: string) => void;
};

const consoleOut: Out = {
  info: (text) => console.log(text),
  success: (text) => console.log(text),
  warning: (text) => console.warn(text),
  error: (text) => console.error(text),
};

async function askYesNo(question: string, fallback: boolean): Promise<boolean> {
  const prompt = createInterface({ input: process.stdin, output: process.stdout });
  try {
    const answer = (await prompt.question(`${question} [${fallback ? "Y/n" : "y/N"}] `)).trim().toLowerCase();
    return answer ? answer === "y" || answer === "yes" : fallback;
  } finally {
    prompt.close();
  }
}

/** What setup writes into `channels.agentinbox`, keeping whatever else is there. */
export type Connection = { secretKey: string; agent: string; apiUrl: string | null };

export function withConnection(cfg: Json, connection: Connection): Json {
  const channels = isRecord(cfg.channels) ? { ...cfg.channels } : {};
  const current = isRecord(channels[CHANNEL_ID]) ? { ...(channels[CHANNEL_ID] as Json) } : {};
  const next: Json = { ...current, enabled: true, secretKey: connection.secretKey, agent: connection.agent };
  if (connection.apiUrl) next.apiUrl = connection.apiUrl;
  else delete next.apiUrl;
  channels[CHANNEL_ID] = next;
  return { ...cfg, channels };
}

async function writeConnectionToConfig(connection: Connection): Promise<void> {
  const { mutateConfigFile } = await import("openclaw/plugin-sdk/config-mutation");
  await mutateConfigFile({
    mutate: (draft) => {
      const next = withConnection(draft as unknown as Json, connection);
      (draft as unknown as Json).channels = next.channels;
    },
  });
}

export type SetupDeps = {
  config: unknown;
  store: StateStore;
  ask?: (question: string, fallback: boolean) => Promise<boolean>;
  atTerminal?: () => boolean;
  writeConfig?: (connection: Connection) => Promise<void>;
  out?: Out;
  fetch?: FetchLike;
  computer?: string;
};

async function connect(apiUrl: string, agent: string, code: string, fetchImpl?: FetchLike) {
  const options = fetchImpl ? { fetch: fetchImpl } : {};
  let connected: Json;
  try {
    connected = await new AgentInboxApi(apiUrl, "", undefined, options).connectWithCode(agent, code);
  } catch (error) {
    if (error instanceof ApiError) {
      if (error.status === 404 && !error.code) throw new SetupError("This API can't connect with a one-time code.");
      throw new SetupError(error.message);
    }
    throw error;
  }
  const details = isRecord(connected.agent) ? connected.agent : {};
  const settings: Settings = {
    secretKey: String(connected.apiKey),
    agent: String(details.identifier ?? ""),
    apiUrl,
    enabled: true,
  };
  if (!settings.agent) throw new SetupError("Agent Inbox didn't say which agent the code is for. Try again with a new code.");
  const api = new AgentInboxApi(settings.apiUrl, settings.secretKey, settings.agent, options);
  let operator: string | null = null;
  let listening: Json | null = null;
  try {
    operator = await api.findOperator();
    listening = (await api.getLease()).listening;
  } catch {
    operator = null;
    listening = null;
  }
  return { settings, details, operator, listening };
}

export async function runSetup(
  args: { agent: unknown; code: unknown; apiUrl?: string | null; yes?: boolean },
  deps: SetupDeps,
): Promise<number> {
  const out = deps.out ?? consoleOut;
  const ask = deps.ask ?? askYesNo;
  const atTerminal = deps.atTerminal ?? (() => personAtTerminal());
  let connected: Awaited<ReturnType<typeof connect>>;
  try {
    const agent = readAgent(args.agent);
    const code = readCode(args.code);
    const current = readSettings(deps.config);
    if (isConfigured(current) && !args.yes) {
      const already = `This ${HOST_NAME} is connected to Agent Inbox already.`;
      if (!atTerminal()) {
        throw new SetupError(`${already} Run the same command with --yes to connect it to ${agent} instead: the code still works.`);
      }
      if (!(await ask(`${already} Connect it to ${agent} instead?`, false))) {
        out.info(CANCELED_MESSAGE);
        return 1;
      }
    }
    const apiUrl = (args.apiUrl || current.apiUrl || DEFAULT_API_URL).replace(/\/+$/, "");
    connected = await connect(apiUrl, agent, code, deps.fetch);
  } catch (error) {
    if (error instanceof SetupError) {
      out.error(error.message);
      return 1;
    }
    throw error;
  }

  const { settings, details, operator, listening } = connected;
  // What the operator allowed belongs to one connection: a new one starts over, and only this computer's id stays.
  // It is saved before the config, so a running gateway that picks up the new config finds it.
  const state = deps.store.load(connectionOf(settings));
  const here = deps.computer ?? computerName();
  const mine = listening && listening.computerId === state.computerId && listening.host === HOST_ID;
  const elsewhere = listening && !mine ? listening : null;
  let moves = "";
  if (elsewhere) {
    const its = HOST_NAMES[String(elsewhere.host)] ?? String(elsewhere.host);
    moves = ` It listens on ${String(elsewhere.computerName)} (${its}) now; this moves it here.`;
  }
  // Run by the operator at their own terminal, `--yes` is their yes to listening here: the commands from
  // agentinbox.md are pasted together, and a question would take the next one as its answer. An agent's run never
  // turns it on: the gateway then asks the operator when it starts.
  const person = atTerminal();
  if (person && args.yes) {
    state.allowedAt = nowIso();
    state.takeOver = Boolean(elsewhere);
  } else if (person) {
    const question = `Listen for messages on ${here}, so that one from you, or from a contact it listens to, starts ${HOST_NAME}?${moves}`;
    if (await ask(question, true)) {
      state.allowedAt = nowIso();
      state.takeOver = Boolean(elsewhere);
    }
  }
  deps.store.save(state);

  await (deps.writeConfig ?? writeConnectionToConfig)({
    secretKey: settings.secretKey,
    agent: settings.agent,
    apiUrl: settings.apiUrl === DEFAULT_API_URL ? null : settings.apiUrl,
  });

  const handle = String(details.handle ?? args.agent);
  const name = String(details.name ?? "");
  const named = name && name.toLowerCase() !== handle ? ` (${name})` : "";
  out.success(`Connected this ${HOST_NAME} to ${handle}${named}.`);
  if (!operator) out.warning("The account has no operator contact yet: finish setting it up on agentinbox.md first.");
  if (person && args.yes) out.success(`Listening for messages on ${here} is on.${moves}`);
  if (state.allowedAt) {
    out.info(`Restart the gateway to start listening: ${RESTART_COMMAND}`);
  } else {
    out.info(
      `Restart the gateway: ${RESTART_COMMAND}. Your operator then gets an Allow and Deny message on their channel, and listening starts once they allow it.`,
    );
  }
  return 0;
}

export async function runStatus(deps: { config: unknown; store: StateStore; out?: Out; fetch?: FetchLike; computer?: string }): Promise<number> {
  const out = deps.out ?? consoleOut;
  const settings = readSettings(deps.config);
  if (!isConfigured(settings)) {
    out.warning(`Agent Inbox isn't set up for this ${HOST_NAME}. Run: ${SETUP_COMMAND}`);
    return 1;
  }
  const state = deps.store.load(connectionOf(settings));
  out.info(`Agent: ${settings.agent} at ${settings.apiUrl}`);
  out.info(`This computer: ${deps.computer ?? computerName()}`);
  out.info(state.allowedAt ? `Allowed here: ${state.allowedAt}` : "Not allowed here yet: when the gateway starts, it asks your operator.");
  let status: { listening: Json | null; paused: boolean };
  try {
    const api = new AgentInboxApi(settings.apiUrl, settings.secretKey, settings.agent, deps.fetch ? { fetch: deps.fetch } : {});
    status = await api.getLease();
  } catch (error) {
    out.error(`Couldn't ask Agent Inbox: ${String(error instanceof Error ? error.message : error)}`);
    return 1;
  }
  if (status.paused) out.warning(`The agent is paused on agentinbox.md: nothing starts ${HOST_NAME} until you resume it there.`);
  const listening = status.listening;
  if (!listening) {
    out.info("Listening: nowhere right now.");
    return 0;
  }
  const mine = listening.computerId === state.computerId && listening.host === HOST_ID;
  const host = HOST_NAMES[String(listening.host)] ?? String(listening.host);
  const where = mine ? "this gateway" : `${String(listening.computerName)} (${host})`;
  out.success(`Listening on ${where} since ${String(listening.since ?? "")}.`);
  return 0;
}

type CommandLike = {
  command: (name: string) => CommandLike;
  description: (text: string) => CommandLike;
  argument: (name: string, description?: string) => CommandLike;
  option: (flags: string, description?: string) => CommandLike;
  requiredOption: (flags: string, description?: string) => CommandLike;
  action: (handler: (...args: unknown[]) => unknown) => CommandLike;
};

export const CLI_DESCRIPTION =
  "Agent Inbox: `setup` connects this OpenClaw with a one-time code, `status` shows where it listens";

export function registerCli(api: OpenClawPluginApi, statePath: () => string): void {
  api.registerCli(
    ({ program, config }) => {
      const root = (program as unknown as CommandLike).command("agentinbox").description(CLI_DESCRIPTION);
      root
        .command("setup")
        .description("Connect this OpenClaw to an agent with a one-time code from agentinbox.md, so its messages reach OpenClaw")
        .argument("<agent>", "The agent, as its address starts: atlas for atlas@agentinbox.md")
        .requiredOption("--code <code>", "The one-time code agentinbox.md shows, like BCDF-GHJK")
        .option("--api-url <url>", `Agent Inbox's API (default ${DEFAULT_API_URL})`)
        .option("-y, --yes", "Ask nothing: replace a connection this OpenClaw has already, and at your own terminal, listen here")
        .action(async (agent: unknown, options: unknown) => {
          const flags = (options ?? {}) as { code?: string; apiUrl?: string; yes?: boolean };
          process.exitCode = await runSetup(
            { agent, code: flags.code, apiUrl: flags.apiUrl ?? null, yes: Boolean(flags.yes) },
            { config, store: new FileStateStore(statePath()) },
          );
        });
      root
        .command("status")
        .description("Show the connection, and where the agent listens")
        .action(async () => {
          process.exitCode = await runStatus({ config, store: new FileStateStore(statePath()) });
        });
    },
    { descriptors: [{ name: "agentinbox", description: CLI_DESCRIPTION, hasSubcommands: true }] },
  );
}
