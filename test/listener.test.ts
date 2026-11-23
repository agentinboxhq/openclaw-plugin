import { describe, expect, it } from "vitest";
import type { Json } from "../src/api.js";
import { Listener, StopForGood, type Timing } from "../src/listener.js";
import { type Settings, connectionOf } from "../src/settings.js";
import { MemoryStateStore, type State, freshState } from "../src/state.js";
import { FakeApi, message, until } from "./fake-api.js";

export const SETTINGS: Settings = { secretKey: "sk_test", agent: "human-relay", apiUrl: "https://api.test", enabled: true };
export const FAST: Partial<Timing> = { waitSeconds: 1, pausedRetryMs: 10, retryMs: [10], allowPollMs: 10 };

export function allowedState(extra: Partial<State> = {}): State {
  return {
    ...freshState(connectionOf(SETTINGS), "cmp_test_computer_1"),
    allowedAt: "2026-11-05T10:00:00Z",
    ...extra,
  };
}

class Harness {
  readonly store: MemoryStateStore;
  readonly started: Json[] = [];
  readonly answers: Json[] = [];
  readonly listener: Listener;
  private readonly controller = new AbortController();
  private running: Promise<unknown> | null = null;

  constructor(
    readonly fake: FakeApi,
    state: State | null = null,
    answered: string[] = [],
  ) {
    this.store = new MemoryStateStore(state);
    this.listener = new Listener({
      api: fake.api(),
      store: this.store,
      settings: SETTINGS,
      computerName: "MacBook",
      onMessage: async (found) => {
        this.started.push(found);
      },
      onAnswer: async (found) => {
        if (answered.includes(String(found.answersMessageId))) {
          this.answers.push(found);
          return true;
        }
        return false;
      },
      timing: FAST,
      signal: this.controller.signal,
    });
  }

  run(): Promise<unknown> {
    this.running = this.listener.run();
    return this.running;
  }

  async stop(): Promise<void> {
    this.controller.abort();
    await this.running?.catch(() => undefined);
  }

  async runUntil(done: () => boolean): Promise<void> {
    const running = this.run();
    try {
      await Promise.race([until(done), running.then(() => Promise.reject(new Error("stopped early")))]);
    } finally {
      await this.stop();
    }
  }
}

function current(store: MemoryStateStore): State {
  if (!store.current) throw new Error("nothing saved");
  return store.current;
}

describe("listener", () => {
  it("asks the operator once and listens after Allow", async () => {
    const fake = new FakeApi();
    const harness = new Harness(fake);
    void harness.run().catch(() => undefined);
    try {
      await until(() => fake.sent.length > 0);
      const ask = fake.last("approve");
      expect(ask.to).toBe("op_ada");
      expect((ask.card as Json).title).toBe("Listen for messages on MacBook, and start OpenClaw?");
      expect((ask.card as Json).approveLabel).toBe("Allow");
      expect(fake.holder).toBeNull(); // nothing taken before the Allow

      fake.answer(String(ask.id), "approved");
      fake.deliver(message("m1"));
      await until(() => harness.started.length > 0);
      expect(harness.started.map((each) => each.id)).toEqual(["m1"]);
      expect(fake.holder?.computerName).toBe("MacBook");
      expect(current(harness.store).allowedAt).toBeTruthy();
      expect(current(harness.store).asked).toBeNull();
    } finally {
      await harness.stop();
    }
  });

  it("stops for good on a Deny and takes nothing", async () => {
    const fake = new FakeApi();
    const harness = new Harness(fake);
    const running = harness.run();
    await until(() => fake.sent.length > 0);
    fake.answer(String(fake.last("approve").id), "denied");
    await expect(running).rejects.toMatchObject({ reason: "denied" });
    expect(fake.holder).toBeNull();
    expect(current(harness.store).allowedAt).toBeNull();
  });

  it("takes words instead of Allow as no Allow", async () => {
    const fake = new FakeApi();
    const harness = new Harness(fake);
    const running = harness.run();
    await until(() => fake.sent.length > 0);
    fake.answer(String(fake.last("approve").id), "answered", { text: "sure, go ahead" });
    await expect(running).rejects.toMatchObject({ reason: "denied" });
  });

  it("takes the lease over when the Allow moves listening here", async () => {
    const fake = new FakeApi();
    fake.holder = { computerId: "cmp_other_computer", computerName: "Mac mini", host: "claude-code", project: "~/projects/app" };
    const harness = new Harness(fake);
    void harness.run().catch(() => undefined);
    try {
      await until(() => fake.sent.length > 0);
      const ask = fake.last("approve");
      expect((ask.card as Json).body).toContain(
        "It is listening on Mac mini now (Claude Code, in ~/projects/app); this moves it here.",
      );
      fake.answer(String(ask.id), "approved");
      await until(() => fake.holder?.computerName === "MacBook");
      expect(fake.holder?.host).toBe("openclaw");
      expect(current(harness.store).takeOver).toBe(false); // only the first lease takes it over
    } finally {
      await harness.stop();
    }
  });

  it("listens without asking once allowed, and hands each message once", async () => {
    const fake = new FakeApi();
    const harness = new Harness(fake, allowedState());
    fake.deliver(message("m1"), message("m2", { conversation: "conv_2", operator: false, name: "Ben", sender: "sub_ben" }));
    await harness.runUntil(() => harness.started.length === 2);
    expect(fake.sent).toEqual([]);
    expect(current(harness.store).cursor).toBe("m2");

    // The same messages again, as after a restart that lost the cursor: none is handled twice.
    const saved = current(harness.store);
    saved.cursor = null;
    const again = new Harness(fake, saved);
    await again.runUntil(() => fake.calls.filter((call) => call === "GET /v1/listen/messages").length > 6);
    expect(again.started).toEqual([]);
  });

  it("gives answers to what waits for them, never starting OpenClaw with them", async () => {
    const fake = new FakeApi();
    const harness = new Harness(fake, allowedState({ own: ["msg_old"] }), ["msg_card"]);
    fake.deliver(
      message("m1", { answers: "msg_card", answer: { status: "approved" } }),
      message("m2", { answers: "msg_old", answer: { status: "approved" } }),
      message("m3", { answers: "msg_agents_own_question", text: "tomorrow" }),
    );
    await harness.runUntil(() => harness.store.current?.cursor === "m3");
    expect(harness.answers.map((each) => each.id)).toEqual(["m1"]);
    // An answer to a question the agent asked itself (with the CLI or MCP) joins the run, as `listen` does.
    expect(harness.started.map((each) => each.id)).toEqual(["m3"]);
  });

  it("stops for good when another computer takes over", async () => {
    const fake = new FakeApi();
    const harness = new Harness(fake, allowedState());
    const running = harness.run();
    await until(() => Boolean(fake.holder));
    fake.holder = { computerId: "cmp_other_computer", computerName: "Mac mini", host: "codex" };
    await expect(running).rejects.toBeInstanceOf(StopForGood);
    const stop = (await running.catch((error) => error)) as StopForGood;
    expect(stop.reason).toBe("listening_elsewhere");
    expect(stop.message).toBe(
      "It is listening on Mac mini (Codex) now, so this gateway stopped. Restart the gateway to ask your operator to move it back here: openclaw gateway restart",
    );
    expect(harness.listener.holding).toBe(false);
    expect(current(harness.store).allowedAt).toBeNull();
  });

  it("asks the operator after a move, on restart, and moves it back", async () => {
    const fake = new FakeApi();
    const harness = new Harness(fake, allowedState());
    const running = harness.run();
    await until(() => Boolean(fake.holder));
    fake.holder = { computerId: "cmp_other_computer", computerName: "Mac mini", host: "codex" };
    await expect(running).rejects.toBeInstanceOf(StopForGood);

    // The gateway restarts on the state the stop saved.
    const again = new Harness(fake, current(harness.store));
    void again.run().catch(() => undefined);
    try {
      await until(() => fake.sent.length > 0);
      const ask = fake.last("approve");
      expect((ask.card as Json).body).toContain("It is listening on Mac mini now (Codex); this moves it here.");
      expect(fake.holder?.computerName).toBe("Mac mini"); // nothing taken before the Allow
      fake.answer(String(ask.id), "approved");
      await until(() => fake.holder?.computerName === "MacBook");
      expect(fake.holder?.host).toBe("openclaw");
    } finally {
      await again.stop();
    }
  });

  it("takes a lapsed lease again", async () => {
    const fake = new FakeApi();
    const harness = new Harness(fake, allowedState());
    void harness.run().catch(() => undefined);
    try {
      await until(() => Boolean(fake.holder));
      fake.holder = null; // it lapsed, as when the computer slept
      await until(() => Boolean(fake.holder));
      expect((fake.holder as Json | null)?.computerName).toBe("MacBook");
      expect(fake.calls.filter((call) => call === "POST /v1/listen/lease")).toHaveLength(2);
    } finally {
      await harness.stop();
    }
  });

  it("stops for good when the key changed", async () => {
    const fake = new FakeApi();
    fake.fail("GET /v1/operator", 401, { message: "Unauthorized" });
    const harness = new Harness(fake, allowedState());
    await expect(harness.run()).rejects.toMatchObject({ reason: "key_changed" });
  });

  it("waits an outage out", async () => {
    const fake = new FakeApi();
    fake.fail("POST /v1/listen/lease", 503, {}, 2);
    const harness = new Harness(fake, allowedState());
    fake.deliver(message("m1"));
    await harness.runUntil(() => harness.started.length > 0);
    expect(fake.calls.filter((call) => call === "POST /v1/listen/lease")).toHaveLength(3);
  });

  it("tries a paused agent again later", async () => {
    const fake = new FakeApi();
    fake.paused = true;
    const harness = new Harness(fake, allowedState());
    void harness.run().catch(() => undefined);
    try {
      await until(() => fake.calls.filter((call) => call === "POST /v1/listen/lease").length >= 2);
      expect(fake.holder).toBeNull();
      fake.paused = false;
      fake.deliver(message("m1"));
      await until(() => harness.started.length > 0);
    } finally {
      await harness.stop();
    }
  });

  it("starts from now on a cursor the API never handed out", async () => {
    const fake = new FakeApi();
    fake.fail("GET /v1/listen/messages", 400, { code: "invalid_listen_cursor", message: "Bad cursor" });
    const harness = new Harness(fake, allowedState({ cursor: "someone_elses" }));
    fake.deliver(message("m1"));
    await harness.runUntil(() => harness.started.length > 0);
    expect(current(harness.store).cursor).toBe("m1");
  });

  it("stops for good without an operator", async () => {
    const fake = new FakeApi();
    fake.operator = null;
    const harness = new Harness(fake);
    await expect(harness.run()).rejects.toMatchObject({ reason: "no_operator" });
  });

  it("lets go of the lease it holds on close", async () => {
    const fake = new FakeApi();
    const harness = new Harness(fake, allowedState());
    await harness.runUntil(() => Boolean(fake.holder));
    await harness.listener.close();
    expect(fake.holder).toBeNull();
    expect(fake.released).toBe(1);
  });

  it("sends who calls: OpenClaw's plugin", async () => {
    const fake = new FakeApi();
    const harness = new Harness(fake, allowedState());
    await harness.runUntil(() => Boolean(fake.holder));
    expect(new Set(fake.callers.map(([via, host]) => `${via}/${host}`))).toEqual(new Set(["plugin/openclaw"]));
    expect(fake.keys.every((key) => key === "ApiKey sk_test")).toBe(true);
  });
});
