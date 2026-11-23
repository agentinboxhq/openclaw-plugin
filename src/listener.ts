// The listen loop, with the rules of `npx @agentinbox/cli listen`: nothing starts before the operator allows it, one
// computer listens at a time (the lease), and only the operator's messages and those of the contacts the agent
// listens to come here. OpenClaw's gateway runs the sessions; this hands it each message.
import {
  AGENT_PAUSED,
  type AgentInboxApi,
  ApiError,
  INVALID_CURSOR,
  type Json,
  LISTENING_ELSEWHERE,
  NOT_LISTENING,
} from "./api.js";
import { HOST_ID, HOST_NAME, type Settings, connectionOf } from "./settings.js";
import { type State, type StateStore, remember } from "./state.js";
import * as words from "./words.js";

// How long the operator has to allow listening here.
export const ALLOW_TTL_SECONDS = 60 * 60;

// Hosts as people read them, for where the agent listens now.
export const HOST_NAMES: Record<string, string> = {
  "claude-code": "Claude Code",
  codex: "Codex",
  opencode: "OpenCode",
  cursor: "Cursor",
  hermes: "Hermes",
  openclaw: "OpenClaw",
};

export type Timing = {
  // How long the server holds one wait for messages, in seconds.
  waitSeconds: number;
  // How often a paused agent is tried again: a pause is the operator's choice, not an outage.
  pausedRetryMs: number;
  // How long to wait after one, two, three… failures in a row.
  retryMs: readonly number[];
  // How often the answer to the Allow question is looked up.
  allowPollMs: number;
};

export const DEFAULT_TIMING: Timing = {
  waitSeconds: 25,
  pausedRetryMs: 180_000,
  retryMs: [5_000, 15_000, 30_000, 60_000],
  allowPollMs: 2_000,
};

export type Logger = {
  info: (message: string) => void;
  warn: (message: string) => void;
  error: (message: string) => void;
};

export const silentLogger: Logger = { info: () => {}, warn: () => {}, error: () => {} };

/** Trying again won't help until something changes: a new key, the operator's answer, a restart to take it back. */
export class StopForGood extends Error {
  constructor(
    readonly reason: string,
    message: string,
  ) {
    super(message);
    this.name = "StopForGood";
  }
}

export function nowIso(): string {
  return new Date().toISOString().replace(/\.\d{3}Z$/, "Z");
}

function msUntil(stamp: unknown, now: number): number | null {
  if (typeof stamp !== "string" || !stamp) return null;
  const at = Date.parse(stamp);
  return Number.isNaN(at) ? null : at - now;
}

/** Waits `ms`, or less when `signal` aborts; then throws its reason. */
export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new Error("aborted"));
      return;
    }
    const done = () => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", aborted);
    };
    const aborted = () => {
      done();
      reject(signal?.reason ?? new Error("aborted"));
    };
    const timer = setTimeout(() => {
      done();
      resolve();
    }, ms);
    signal?.addEventListener("abort", aborted, { once: true });
  });
}

export type OnMessage = (message: words.ListenMessage) => Promise<void>;
export type OnAnswer = (message: words.ListenMessage) => Promise<boolean>;

export class Listener {
  readonly api: AgentInboxApi;
  readonly store: StateStore;
  readonly settings: Settings;
  readonly computerName: string;
  state: State;
  operatorId: string | null = null;
  // This gateway holds the lease now: only then may it wait for messages, show typing, or let go of it.
  holding = false;
  private renewAt = 0;
  private failures = 0;
  private toldPaused = false;
  private readonly timing: Timing;
  private readonly clock: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly log: Logger;
  private readonly signal?: AbortSignal;
  private readonly onMessage: OnMessage;
  private readonly onAnswer: OnAnswer;
  private readonly onListening?: (listening: boolean) => void;

  constructor(options: {
    api: AgentInboxApi;
    store: StateStore;
    settings: Settings;
    computerName: string;
    onMessage: OnMessage;
    onAnswer: OnAnswer;
    timing?: Partial<Timing>;
    clock?: () => number;
    sleep?: (ms: number) => Promise<void>;
    log?: Logger;
    signal?: AbortSignal;
    onListening?: (listening: boolean) => void;
  }) {
    this.api = options.api;
    this.store = options.store;
    this.settings = options.settings;
    this.computerName = options.computerName;
    this.onMessage = options.onMessage;
    this.onAnswer = options.onAnswer;
    this.onListening = options.onListening;
    this.timing = { ...DEFAULT_TIMING, ...options.timing };
    this.clock = options.clock ?? Date.now;
    this.signal = options.signal;
    this.sleep = options.sleep ?? ((ms) => abortableSleep(ms, this.signal));
    this.log = options.log ?? silentLogger;
    this.state = this.store.load(connectionOf(this.settings));
  }

  get computerId(): string {
    return this.state.computerId;
  }

  save(): void {
    this.store.save(this.state);
  }

  /** One of the plugin's own questions: its answer never starts OpenClaw, also after a restart. */
  rememberOwn(interactionId: string): void {
    remember(this.state, "own", interactionId);
    this.save();
  }

  /** Listens until aborted. Throws `StopForGood` when it can't go on. */
  async run(): Promise<void> {
    this.save(); // keeps the computer id from the first start on
    this.operatorId = await this.keepTrying(() => this.api.findOperator());
    if (!this.operatorId) throw new StopForGood("no_operator", words.NO_OPERATOR_MESSAGE);
    await this.ensureAllowed();
    await this.listen();
  }

  /** Lets go of the lease, so agentinbox.md shows nobody listening until the gateway is back. */
  async close(): Promise<void> {
    if (!this.holding) return;
    this.holding = false;
    try {
      await this.api.releaseLease(this.computerId);
    } catch (error) {
      this.log.info(`[Agent Inbox] Couldn't let go of listening (${String(error)}); it lapses by itself.`);
    }
  }

  // --- turning it on ---

  private async ensureAllowed(): Promise<void> {
    if (this.state.allowedAt) return;

    const status = await this.keepTrying(() => this.api.getLease(this.signal));
    const elsewhere = this.isMine(status.listening) ? null : status.listening;
    const { title, body } = words.allowCard({
      computerName: this.computerName,
      elsewhere,
      computerId: this.computerId,
      hostNames: HOST_NAMES,
    });
    let asked = this.state.asked;
    // The same request waits on the same question; one that reads otherwise now asks anew, since the operator
    // allows what they read.
    if (!asked || asked.title !== title || (msUntil(asked.expiresAt, this.clock()) ?? 0) <= 0) {
      const operator = this.operatorId;
      const interaction = await this.keepTrying(() =>
        this.api.createInteraction({
          kind: "approve",
          card: { title, body, approveLabel: "Allow", denyLabel: "Deny" },
          to: operator,
          from: HOST_NAME,
          ttlSeconds: ALLOW_TTL_SECONDS,
        }),
      );
      asked = {
        id: String(interaction.id),
        expiresAt: typeof interaction.expiresAt === "string" ? interaction.expiresAt : null,
        title,
      };
      this.state.asked = asked;
      remember(this.state, "own", asked.id);
      this.save();
      this.log.info(`[Agent Inbox] Asked your operator to allow listening on ${this.computerName}.`);
    }

    const outcome = await this.waitForAllow(asked);
    this.state.asked = null;
    if (outcome === "approved") {
      this.state.allowedAt = nowIso();
      this.state.takeOver = Boolean(elsewhere);
      this.save();
      this.log.info(`[Agent Inbox] Your operator allowed listening on ${this.computerName}.`);
      return;
    }
    this.save();
    if (outcome === "denied") throw new StopForGood("denied", words.DENIED_MESSAGE);
    throw new StopForGood("unanswered", words.UNANSWERED_MESSAGE);
  }

  private async waitForAllow(asked: { id: string; expiresAt: string | null }): Promise<string> {
    for (;;) {
      const interaction = await this.keepTrying(() => this.api.getInteraction(asked.id));
      const status = String(interaction.status ?? "");
      if (status === "approved") return "approved";
      // Words instead of a button aren't an Allow.
      if (status === "denied" || status === "answered") return "denied";
      const left = msUntil(interaction.expiresAt ?? asked.expiresAt, this.clock());
      if ((status !== "" && status !== "pending") || (left !== null && left < -60_000)) return "unanswered";
      await this.sleep(this.timing.allowPollMs);
    }
  }

  // --- listening ---

  private async listen(): Promise<void> {
    for (;;) {
      if (this.signal?.aborted) throw this.signal.reason ?? new Error("aborted");
      let messages: Json[];
      let after: string;
      try {
        if (this.clock() >= this.renewAt) await this.takeLease();
        const wait = Math.max(1, Math.min(this.timing.waitSeconds, Math.floor((this.renewAt - this.clock()) / 1000)));
        ({ messages, after } = await this.api.waitForMessages({
          computerId: this.computerId,
          after: this.state.cursor,
          wait,
          signal: this.signal,
        }));
        this.failures = 0;
      } catch (error) {
        if (this.signal?.aborted) throw error;
        if (!(error instanceof ApiError)) throw error;
        await this.onError(error);
        continue;
      }

      for (const message of messages) await this.handle(message as words.ListenMessage);
      if (messages.length || (after && after !== this.state.cursor)) {
        this.state.cursor = after || this.state.cursor;
        this.save();
      }
    }
  }

  private async takeLease(): Promise<void> {
    let lease: Json;
    try {
      lease = await this.api.takeLease({
        computerId: this.computerId,
        computerName: this.computerName,
        takeOver: this.state.takeOver,
        signal: this.signal,
      });
    } catch (error) {
      if (error instanceof ApiError && error.code === LISTENING_ELSEWHERE) throw this.moved(error.listening);
      throw error;
    }
    if (!this.holding) {
      this.log.info(`[Agent Inbox] Listening on ${this.computerName} for ${HOST_NAME}.`);
      this.onListening?.(true);
    }
    this.holding = true;
    this.toldPaused = false;
    if (this.state.takeOver) {
      this.state.takeOver = false;
      this.save();
    }
    const renew = Number(lease.renewInSeconds);
    this.renewAt = this.clock() + Math.max(5, Number.isFinite(renew) && renew > 0 ? renew : 60) * 1000;
  }

  private async onError(error: ApiError): Promise<void> {
    if (error.keyRejected) {
      this.holding = false;
      throw new StopForGood("key_changed", words.KEY_CHANGED_MESSAGE);
    }
    if (error.code === AGENT_PAUSED) {
      if (!this.toldPaused) {
        this.toldPaused = true;
        this.log.info(`[Agent Inbox] ${words.PAUSED_MESSAGE}`);
      }
      this.renewAt = 0;
      await this.sleep(this.timing.pausedRetryMs);
      return;
    }
    if (error.code === NOT_LISTENING || error.code === LISTENING_ELSEWHERE) {
      const holder = error.listening;
      if (holder && !this.isMine(holder)) throw this.moved(holder);
      // The lease lapsed, as when the computer slept: take it again.
      this.holding = false;
      this.renewAt = 0;
      return;
    }
    if (error.code === INVALID_CURSOR) {
      // Not a cursor this API handed out (another deployment's, say): waiting goes on from now.
      this.state.cursor = null;
      this.save();
      return;
    }
    const retry = this.timing.retryMs;
    const wait = retry[Math.min(this.failures, retry.length - 1)] ?? 5_000;
    this.failures += 1;
    this.log.warn(`[Agent Inbox] ${error.message}; trying again in ${words.spanWords(wait / 1000)}.`);
    await this.sleep(wait);
  }

  private async handle(message: words.ListenMessage): Promise<void> {
    const messageId = String(message.id ?? "");
    if (!messageId || this.state.handled.includes(messageId) || !message.conversationId) return;
    remember(this.state, "handled", messageId);
    const answers = String(message.answersMessageId ?? "");
    try {
      if (answers && (await this.onAnswer(message))) return;
      if (answers && this.state.own.includes(answers)) return; // an answer to a question nothing waits for any more
      await this.onMessage(message);
    } catch (error) {
      if (this.signal?.aborted) throw error;
      // One message must not stop the others.
      this.log.error(`[Agent Inbox] Couldn't hand message ${messageId} to ${HOST_NAME}: ${String(error)}`);
    }
  }

  // --- helpers ---

  /**
   * Another computer, or another host here, took the agent over. The Allow went with it: the next start asks the
   * operator again, with a card that says it moves the agent back here.
   */
  private moved(holder: Json | null): StopForGood {
    this.holding = false;
    this.state.allowedAt = null;
    this.state.takeOver = false;
    this.save();
    return new StopForGood("listening_elsewhere", words.movedMessage(holder, this.computerId, HOST_NAMES));
  }

  isMine(listening: Json | null | undefined): boolean {
    return Boolean(listening) && listening?.computerId === this.computerId && listening?.host === HOST_ID;
  }

  /** A call before listening starts: tried again while Agent Inbox can't be reached or the agent is paused. */
  private async keepTrying<T>(call: () => Promise<T>): Promise<T> {
    let failures = 0;
    for (;;) {
      try {
        return await call();
      } catch (error) {
        if (this.signal?.aborted || !(error instanceof ApiError)) throw error;
        if (error.keyRejected) throw new StopForGood("key_changed", words.KEY_CHANGED_MESSAGE);
        if (error.code === AGENT_PAUSED) {
          if (!this.toldPaused) {
            this.toldPaused = true;
            this.log.info(`[Agent Inbox] ${words.PAUSED_MESSAGE}`);
          }
          await this.sleep(this.timing.pausedRetryMs);
          continue;
        }
        if (!error.outage) throw error;
        const retry = this.timing.retryMs;
        const wait = retry[Math.min(failures, retry.length - 1)] ?? 5_000;
        failures += 1;
        this.log.warn(`[Agent Inbox] ${error.message}; trying again in ${words.spanWords(wait / 1000)}.`);
        await this.sleep(wait);
      }
    }
  }
}
