import { describe, expect, it } from "vitest";
import { type Connection, type Out, SetupError, readAgent, readCode, runSetup, runStatus, withConnection } from "../src/cli.js";
import { agentRunsThis, personAtTerminal } from "../src/computer.js";
import { connectionOf } from "../src/settings.js";
import { MemoryStateStore } from "../src/state.js";
import { FakeApi } from "./fake-api.js";

const CONNECTED = {
  apiKey: "sk_new",
  environmentId: "env_1",
  agent: { identifier: "atlas-x1y2", name: "Atlas", handle: "atlas" },
  host: "openclaw",
};

function setup(config: unknown = {}) {
  const fake = new FakeApi();
  fake.codes["BCDF-GHJK"] = CONNECTED;
  const written: Connection[] = [];
  const lines: string[] = [];
  const out: Out = {
    info: (text) => lines.push(text),
    success: (text) => lines.push(text),
    warning: (text) => lines.push(text),
    error: (text) => lines.push(text),
  };
  const store = new MemoryStateStore();
  const deps = (overrides: { ask?: (question: string) => boolean; atTerminal?: boolean } = {}) => {
    const asked: string[] = [];
    return {
      asked,
      deps: {
        config,
        store,
        out,
        fetch: fake.fetch,
        computer: "MacBook",
        atTerminal: () => overrides.atTerminal ?? true,
        ask: async (question: string) => {
          asked.push(question);
          if (!overrides.ask) throw new Error("nothing should be asked");
          return overrides.ask(question);
        },
        writeConfig: async (connection: Connection) => {
          written.push(connection);
        },
      },
    };
  };
  return { fake, written, lines, store, deps };
}

const ARGS = { agent: "atlas", code: "bcdf ghjk", apiUrl: null, yes: false };

describe("setup", () => {
  it("trades the code for the key, and asks at the terminal before listening here", async () => {
    const { written, store, deps, lines } = setup();
    const { asked, deps: found } = deps({ ask: () => true });
    expect(await runSetup(ARGS, found)).toBe(0);
    expect(written).toEqual([{ secretKey: "sk_new", agent: "atlas-x1y2", apiUrl: null }]);
    expect(asked).toEqual([
      "Listen for messages on MacBook, so that one from you, or from a contact it listens to, starts OpenClaw?",
    ]);
    const connection = connectionOf({ secretKey: "sk_new", agent: "atlas-x1y2", apiUrl: "https://www.agentinbox.md/api", enabled: true });
    expect(store.current?.connection).toBe(connection);
    expect(store.current?.allowedAt).toBeTruthy();
    expect(lines).toContain("Connected this OpenClaw to atlas.");
    expect(lines).toContain("Restart the gateway to start listening: openclaw gateway restart");
  });

  it("leaves the Allow to the operator's channel in an agent's run", async () => {
    const { store, deps, lines } = setup();
    const { deps: found } = deps({ atTerminal: false });
    expect(await runSetup(ARGS, found)).toBe(0);
    expect(store.current?.allowedAt).toBeNull();
    expect(lines.at(-1)).toContain("Your operator then gets an Allow and Deny message on their channel");
  });

  it("asks nothing with --yes at the operator's terminal, and listens here", async () => {
    // The commands from agentinbox.md are pasted together: a question would take the next one as its answer.
    const { fake, store, deps } = setup();
    fake.holder = { computerId: "cmp_other_computer", computerName: "Mac mini", host: "codex" };
    const { deps: found } = deps();
    expect(await runSetup({ ...ARGS, yes: true }, found)).toBe(0);
    expect(store.current?.allowedAt).toBeTruthy();
    expect(store.current?.takeOver).toBe(true);
  });

  it("leaves the Allow to the operator's channel with --yes in an agent's run", async () => {
    const { store, deps } = setup();
    const { deps: found } = deps({ atTerminal: false });
    await runSetup({ ...ARGS, yes: true }, found);
    expect(store.current?.allowedAt).toBeNull();
  });

  it("says when it moves listening here, and takes it over", async () => {
    const { fake, store, deps } = setup();
    fake.holder = { computerId: "cmp_other_computer", computerName: "Mac mini", host: "codex" };
    const { asked, deps: found } = deps({ ask: () => true });
    await runSetup(ARGS, found);
    expect(asked[0]?.endsWith("It listens on Mac mini (Codex) now; this moves it here.")).toBe(true);
    expect(store.current?.takeOver).toBe(true);
  });

  it("connects as OpenClaw's plugin", async () => {
    // agentinbox.md then lists the host as "OpenClaw · Plugin", not as the CLI.
    const { fake, deps } = setup();
    await runSetup(ARGS, deps({ atTerminal: false }).deps);
    expect(fake.callers.length).toBeGreaterThan(0);
    expect(new Set(fake.callers.map(([via, host]) => `${via}/${host}`))).toEqual(new Set(["plugin/openclaw"]));
  });

  it("changes nothing for a wrong code", async () => {
    const { written, deps, store } = setup();
    expect(await runSetup({ ...ARGS, code: "ZZZZ-ZZZZ" }, deps({ ask: () => true }).deps)).toBe(1);
    expect(written).toEqual([]);
    expect(store.current).toBeNull();
  });

  it("needs --yes without a terminal when this OpenClaw is connected already", async () => {
    const { written, deps } = setup({ channels: { agentinbox: { secretKey: "sk_old" } } });
    expect(await runSetup(ARGS, deps({ atTerminal: false }).deps)).toBe(1);
    expect(written).toEqual([]);
    expect(await runSetup({ ...ARGS, yes: true }, deps({ atTerminal: false }).deps)).toBe(0);
    expect(written[0]?.secretKey).toBe("sk_new");
  });

  it("keeps a local API", async () => {
    const { written, deps } = setup();
    const fakeLocal = deps({ atTerminal: false }).deps;
    await runSetup({ ...ARGS, apiUrl: "http://localhost:4300/api/" }, { ...fakeLocal, fetch: fakeLocal.fetch });
    expect(written[0]?.apiUrl).toBe("http://localhost:4300/api");
  });

  it("writes the connection into channels.agentinbox, keeping the rest", () => {
    const next = withConnection(
      { gateway: { port: 1 }, channels: { telegram: { token: "t" }, agentinbox: { enabled: false, apiUrl: "http://old" } } },
      { secretKey: "sk_new", agent: "atlas-x1y2", apiUrl: null },
    );
    expect(next).toEqual({
      gateway: { port: 1 },
      channels: { telegram: { token: "t" }, agentinbox: { enabled: true, secretKey: "sk_new", agent: "atlas-x1y2" } },
    });
  });

  it.each([
    ["Atlas@agentinbox.md", "BCDF-GHJK"],
    ["atlas", "bcdfghjk"],
  ])("reads the agent %s and the code %s as agentinbox.md shows them", (agent, code) => {
    expect(readAgent(agent)).toBe("atlas");
    expect(readCode(code)).toBe("BCDF-GHJK");
  });

  it.each(["", "BCDF-GHJ", "BCDF-GHJK1", "12345678"])("refuses the code %j", (code) => {
    expect(() => readCode(code)).toThrow(SetupError);
  });
});

describe("status", () => {
  it("says where the agent listens", async () => {
    const config = { channels: { agentinbox: { secretKey: "sk_new", agent: "atlas-x1y2", apiUrl: "https://api.test" } } };
    const { fake, lines, store } = setup(config);
    const settings = { secretKey: "sk_new", agent: "atlas-x1y2", apiUrl: "https://api.test", enabled: true };
    const state = store.load(connectionOf(settings));
    store.save(state);
    fake.holder = { computerId: state.computerId, computerName: "MacBook", host: "openclaw", since: "2026-11-06T10:00:00Z" };
    const out = { info: (t: string) => lines.push(t), success: (t: string) => lines.push(t), warning: (t: string) => lines.push(t), error: (t: string) => lines.push(t) };
    expect(await runStatus({ config, store, out, fetch: fake.fetch, computer: "MacBook" })).toBe(0);
    expect(lines).toContain("Listening on this gateway since 2026-11-06T10:00:00Z.");
  });

  it("says how to set up without a key", async () => {
    const { lines, store } = setup();
    const out = { info: (t: string) => lines.push(t), success: (t: string) => lines.push(t), warning: (t: string) => lines.push(t), error: (t: string) => lines.push(t) };
    expect(await runStatus({ config: {}, store, out })).toBe(1);
    expect(lines[0]).toContain("openclaw agentinbox setup <agent> --code <code>");
  });
});

describe("a person or an agent", () => {
  const tty = { isTTY: true };

  it("is a person at a terminal with no agent's marks", () => {
    expect(personAtTerminal(tty, tty, { PATH: "/usr/bin", TERM: "xterm-256color" })).toBe(true);
  });

  it("is a person in OpenClaw's TUI shell", () => {
    expect(personAtTerminal(tty, tty, { OPENCLAW_SHELL: "tui-local" })).toBe(true);
  });

  it("is an agent in a command OpenClaw's exec tool runs", () => {
    expect(agentRunsThis({ OPENCLAW_SHELL: "exec" })).toBe(true);
    expect(personAtTerminal(tty, tty, { OPENCLAW_SHELL: "exec" })).toBe(false);
  });

  it("is an agent for other hosts' marks", () => {
    for (const env of [{ AI_AGENT: "claude-code" }, { CODEX_THREAD_ID: "t1" }, { HERMES_SESSION_ID: "s1" }]) {
      expect(agentRunsThis(env)).toBe(true);
    }
  });

  it("is nobody at a terminal without one", () => {
    expect(personAtTerminal({ isTTY: false }, tty, {})).toBe(false);
  });
});
