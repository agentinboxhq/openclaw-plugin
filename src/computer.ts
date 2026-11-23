// This computer as the operator knows it, the way `npx @agentinbox/cli listen` names it, and whether a person or an
// agent runs a command.
import { execFileSync } from "node:child_process";
import { hostname } from "node:os";

// The API takes a computer name of 1–64 characters.
const COMPUTER_NAME_MAX = 64;

/**
 * What hosts put in the environment of the commands their agent runs (the CLI's `detectHost` markers): any of them
 * means an agent runs this, not a person at a terminal. OpenClaw sets `OPENCLAW_SHELL=exec` only for the commands its
 * exec tool runs (and `acp-client` for its ACP children); its own CLI and gateway set none of these in their own
 * process, so the environment `openclaw agentinbox setup` sees is the one it started with.
 */
const AGENT_MARKERS: ReadonlyArray<[string, string | null]> = [
  ["CODEX_THREAD_ID", null],
  ["CODEX_CI", "1"],
  ["CODEX_SANDBOX", null],
  ["CLAUDE_CODE_CHILD_SESSION", "1"],
  ["OPENCODE", "1"],
  ["OPENCODE_SESSION_ID", null],
  ["CURSOR_AGENT", null],
  ["CURSOR_SANDBOX", null],
  ["HERMES_AGENT", null],
  ["HERMES_SESSION_ID", null],
  ["OPENCLAW_SHELL", "exec"],
  ["OPENCLAW_SHELL", "acp-client"],
];

/** Its name on macOS ("Ada’s MacBook Pro"), its host name elsewhere. */
export function computerName(): string {
  if (process.platform === "darwin") {
    try {
      const name = execFileSync("scutil", ["--get", "ComputerName"], { encoding: "utf8", timeout: 5000 }).trim();
      if (name) return name.slice(0, COMPUTER_NAME_MAX);
    } catch {
      // Falls back to the host name.
    }
  }
  let name = hostname();
  if (name.toLowerCase().endsWith(".local")) name = name.slice(0, -".local".length);
  return (name || "this computer").slice(0, COMPUTER_NAME_MAX);
}

/** An agent's command, not a person typing: the operator is then asked on their channel instead. */
export function agentRunsThis(env: NodeJS.ProcessEnv = process.env): boolean {
  if (String(env.AI_AGENT ?? "").trim()) return true;
  return AGENT_MARKERS.some(([name, value]) => {
    const found = String(env[name] ?? "").trim();
    return Boolean(found) && (value === null || found === value);
  });
}

export function personAtTerminal(
  stdin: { isTTY?: boolean } = process.stdin,
  stdout: { isTTY?: boolean } = process.stdout,
  env: NodeJS.ProcessEnv = process.env,
): boolean {
  return Boolean(stdin.isTTY) && Boolean(stdout.isTTY) && !agentRunsThis(env);
}
