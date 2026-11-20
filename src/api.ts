// Agent Inbox's API, as far as the plugin needs it: the calls `npx @agentinbox/cli listen` makes, connecting, and
// what OpenClaw's tools read and send.
import { DEFAULT_AGENT, HOST_ID, PLUGIN_VERSION } from "./settings.js";

// The longest the server holds one wait for messages, in seconds (the API's own limit).
export const MAX_WAIT_SECONDS = 25;

// Who calls, as the API records it: `plugin`, Agent Inbox's plugin in a host's gateway, which holds the agent's key
// as the CLI does. The host header names OpenClaw, so agentinbox.md shows "OpenClaw · Plugin" and the lease is
// OpenClaw's.
export const VIA_HEADER = "Agent-Inbox-Via";
export const VIA = "plugin";
export const HOST_HEADER = "Agent-Inbox-Host";

// The codes the API puts on the errors the listener acts on.
export const LISTENING_ELSEWHERE = "listening_elsewhere";
export const NOT_LISTENING = "not_listening";
export const AGENT_PAUSED = "agent_paused";
export const INVALID_CURSOR = "invalid_listen_cursor";

// The longest one ordinary call waits.
const CALL_TIMEOUT_MS = 60_000;

export type Json = Record<string, unknown>;

/** A request that failed: `status` 0 when Agent Inbox wasn't reached at all. */
export class ApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: unknown = null,
  ) {
    super(message);
    this.name = "ApiError";
  }

  get code(): string | null {
    const code = isRecord(this.body) ? this.body.code : undefined;
    return typeof code === "string" ? code : null;
  }

  /** The lease's holder that a `listening_elsewhere` or `not_listening` error names, if it names one. */
  get listening(): Json | null {
    const listening = isRecord(this.body) ? this.body.listening : undefined;
    return isRecord(listening) && "computerId" in listening ? listening : null;
  }

  /** The key was regenerated on agentinbox.md (or never worked): no retry will help. */
  get keyRejected(): boolean {
    return this.status === 401;
  }

  /**
   * Agent Inbox wasn't reached, or was busy for a moment: the same call may go through a little later. A limit
   * with a code of its own, such as the day's messages, lasts too long to wait for.
   */
  get outage(): boolean {
    if (this.status === 429) return this.code === null;
    return this.status === 0 || this.status === 408 || this.status >= 500;
  }
}

export function isRecord(value: unknown): value is Json {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Novu's `{ data: ... }` envelope, which some endpoints leave out. */
export function unwrap(body: unknown): unknown {
  if (isRecord(body) && body.data !== undefined && body.data !== null) return body.data;
  return body;
}

function messageOf(body: unknown): string | null {
  const message = isRecord(body) ? body.message : undefined;
  if (Array.isArray(message)) return message.map(String).join("; ");
  return typeof message === "string" ? message : null;
}

function records(value: unknown): Json[] {
  return Array.isArray(value) ? value.filter(isRecord) : [];
}

export type Page = { items: Json[]; next: string | null };

type RequestOptions = {
  json?: unknown;
  params?: Record<string, unknown>;
  timeoutMs?: number;
  signal?: AbortSignal;
  raw?: boolean;
};

export type FetchLike = (input: string, init: RequestInit) => Promise<Response>;

export class AgentInboxApi {
  readonly apiUrl: string;
  readonly agent: string;
  private readonly headers: Record<string, string>;
  private readonly fetchImpl: FetchLike;

  constructor(apiUrl: string, secretKey = "", agent: string = DEFAULT_AGENT, options: { fetch?: FetchLike } = {}) {
    this.apiUrl = apiUrl.replace(/\/+$/, "");
    this.agent = agent || DEFAULT_AGENT;
    this.headers = {
      [VIA_HEADER]: VIA,
      [HOST_HEADER]: HOST_ID,
      "User-Agent": `agentinbox-openclaw/${PLUGIN_VERSION}`,
      Accept: "application/json",
    };
    if (secretKey) this.headers.Authorization = `ApiKey ${secretKey}`;
    this.fetchImpl = options.fetch ?? ((input, init) => fetch(input, init));
  }

  /** The default agent stays out of every request, as the CLI leaves it out. */
  private agentParams(): Record<string, string> {
    return this.agent === DEFAULT_AGENT ? {} : { agentIdentifier: this.agent };
  }

  private url(path: string, params?: Record<string, unknown>): string {
    const query = new URLSearchParams();
    for (const [key, value] of Object.entries(params ?? {})) {
      if (value !== undefined && value !== null && value !== "") query.set(key, String(value));
    }
    const search = query.toString();
    return `${this.apiUrl}${path}${search ? `?${search}` : ""}`;
  }

  /** `raw` keeps the envelope, for a page whose `next` sits beside its `data`. */
  private async request(method: string, path: string, options: RequestOptions = {}): Promise<unknown> {
    const timeout = AbortSignal.timeout(options.timeoutMs ?? CALL_TIMEOUT_MS);
    const signal = options.signal ? AbortSignal.any([options.signal, timeout]) : timeout;
    const headers = { ...this.headers };
    if (options.json !== undefined) headers["Content-Type"] = "application/json";
    let res: Response;
    try {
      res = await this.fetchImpl(this.url(path, options.params), {
        method,
        headers,
        body: options.json === undefined ? undefined : JSON.stringify(options.json),
        signal,
      });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      if (timeout.aborted) throw new ApiError(`${method} ${path} timed out`, 408);
      throw new ApiError(`Couldn't reach Agent Inbox at ${this.apiUrl}: ${String(error)}`, 0);
    }
    const textBody = await res.text().catch(() => "");
    let body: unknown = null;
    if (textBody) {
      try {
        body = JSON.parse(textBody);
      } catch {
        body = textBody;
      }
    }
    if (res.status >= 400) {
      throw new ApiError(messageOf(body) ?? `${method} ${path} answered ${res.status}`, res.status, body);
    }
    return options.raw ? body : unwrap(body);
  }

  /** One page of a list: its items, and the cursor for the next page, null after the last. */
  private async page(path: string, params: Record<string, unknown>): Promise<Page> {
    const body = await this.request("GET", path, { params: { ...params, ...this.agentParams() }, raw: true });
    if (Array.isArray(body)) return { items: records(body), next: null };
    const envelope = isRecord(body) ? body : {};
    const next = typeof envelope.next === "string" && envelope.next ? envelope.next : null;
    return { items: records(envelope.data), next };
  }

  // --- connecting ---

  /** Trades the one-time code from agentinbox.md for the agent's key. It works once. */
  async connectWithCode(agent: string, code: string): Promise<Json> {
    const connected = await this.request("POST", "/v1/connect", { json: { agent, code } });
    if (!isRecord(connected) || !connected.apiKey) {
      throw new ApiError("Agent Inbox didn't connect. Try again with a new code.", 500, connected);
    }
    return connected;
  }

  /** The operator's contact id: the person whom permission questions and notices go to. */
  async findOperator(): Promise<string | null> {
    let data: unknown;
    try {
      data = await this.request("GET", "/v1/operator");
    } catch (error) {
      if (error instanceof ApiError && error.status === 404) return null;
      throw error;
    }
    if (!isRecord(data)) return null;
    const id = data.subscriberId;
    return typeof id === "string" && id ? id : null;
  }

  // --- listening ---

  /** Takes the lease, renews it, or with `takeOver` takes it from another computer. */
  async takeLease(options: { computerId: string; computerName: string; takeOver?: boolean; signal?: AbortSignal }): Promise<Json> {
    const json: Json = {
      computerId: options.computerId,
      computerName: options.computerName,
      host: HOST_ID,
      ...this.agentParams(),
    };
    if (options.takeOver) json.takeOver = true;
    const lease = await this.request("POST", "/v1/listen/lease", { json, signal: options.signal });
    return isRecord(lease) ? lease : {};
  }

  /** Where the agent is listening now (`listening`, or null), and whether its operator `paused` it. */
  async getLease(signal?: AbortSignal): Promise<{ listening: Json | null; paused: boolean }> {
    const status = await this.request("GET", "/v1/listen/lease", { params: this.agentParams(), signal });
    const found = isRecord(status) ? status : {};
    return { listening: isRecord(found.listening) ? found.listening : null, paused: found.paused === true };
  }

  /** Lets go of the lease: false when this computer didn't hold it, and another holder's is never touched. */
  async releaseLease(computerId: string): Promise<boolean> {
    const data = await this.request("POST", "/v1/listen/lease/release", {
      json: { computerId, host: HOST_ID, ...this.agentParams() },
    });
    return isRecord(data) && Boolean(data.released);
  }

  /** "Typing…" in the conversation for a few seconds; false where the chat has none, as in email. */
  async showTyping(computerId: string, conversationId: string): Promise<boolean> {
    const data = await this.request("POST", "/v1/listen/typing", {
      json: { computerId, host: HOST_ID, conversationId, ...this.agentParams() },
    });
    return isRecord(data) && Boolean(data.typing);
  }

  /**
   * Up to `wait` seconds for messages that may start OpenClaw: the operator's, and those of the contacts the agent
   * listens to. Only the lease's holder may wait. Oldest first, with where to go on from next time.
   */
  async waitForMessages(options: {
    computerId: string;
    after: string | null;
    wait: number;
    limit?: number;
    signal?: AbortSignal;
  }): Promise<{ messages: Json[]; after: string }> {
    const wait = Math.max(0, Math.min(options.wait, MAX_WAIT_SECONDS));
    const body = await this.request("GET", "/v1/listen/messages", {
      params: {
        computerId: options.computerId,
        host: HOST_ID,
        wait,
        limit: options.limit ?? 20,
        after: options.after ?? undefined,
        ...this.agentParams(),
      },
      timeoutMs: (wait + 30) * 1000,
      signal: options.signal,
      raw: true,
    });
    const envelope = isRecord(body) ? body : {};
    const next = typeof envelope.next === "string" && envelope.next ? envelope.next : options.after ?? "";
    return { messages: records(envelope.data), after: next };
  }

  // --- messages from the agent ---

  /**
   * Sends a message from the agent: `tell`, `ask`, `approve` or `choose`, into a conversation (`thread`) or to a
   * contact (`to`).
   */
  async createInteraction(payload: Json): Promise<Json> {
    const sent = await this.request("POST", "/v1/inbox/messages", { json: { ...payload, ...this.agentParams() } });
    return isRecord(sent) ? sent : {};
  }

  /**
   * Shows the agent's card to its operator: what the agent says, and what its card holds. The first showing is kept
   * on the agent, which is how agentinbox.md's onboarding sees it say hi.
   */
  async showCard(): Promise<Json> {
    const shown = await this.request("POST", "/v1/agent/card", { json: this.agentParams() });
    return isRecord(shown) ? shown : {};
  }

  async getInteraction(interactionId: string): Promise<Json> {
    const found = await this.request("GET", `/v1/inbox/messages/${encodeURIComponent(interactionId)}`);
    return isRecord(found) ? found : {};
  }

  /** Withdraws a question still open: it can't be answered any more, and shows as canceled. */
  async cancelInteraction(interactionId: string): Promise<Json> {
    const found = await this.request("POST", `/v1/inbox/messages/${encodeURIComponent(interactionId)}/cancel`, {
      json: {},
    });
    return isRecord(found) ? found : {};
  }

  // --- what OpenClaw's tools read ---

  /** The agent's conversations, latest activity first. Strangers' stay out, as in the CLI's `inbox list`. */
  listConversations(options: { filter?: string; status?: string; limit?: number; after?: string | null }): Promise<Page> {
    return this.page("/v1/inbox", {
      filter: options.filter ?? "all",
      status: options.status ?? "all",
      senders: "contacts",
      limit: options.limit ?? 20,
      after: options.after ?? undefined,
    });
  }

  /**
   * A conversation and its latest messages, oldest first; `hasMore` when older ones are left. Reading it doesn't
   * mark it read.
   */
  async getConversation(conversationId: string, options: { limit?: number; before?: string | null } = {}): Promise<Json> {
    const found = await this.request("GET", `/v1/inbox/${encodeURIComponent(conversationId)}`, {
      params: { limit: options.limit ?? 20, before: options.before ?? undefined, ...this.agentParams() },
    });
    return isRecord(found) ? found : {};
  }

  /**
   * Marks a conversation finished. Nothing is sent; the next message in it, from anyone, opens it again, and that
   * message starts the conversation's next round.
   */
  async resolveConversation(conversationId: string): Promise<Json> {
    const found = await this.request("POST", `/v1/inbox/${encodeURIComponent(conversationId)}/resolve`, {
      json: {},
      params: this.agentParams(),
    });
    return isRecord(found) ? found : {};
  }

  /** The operator's contacts, the operator among them. */
  listContacts(options: { limit?: number; after?: string | null } = {}): Promise<Page> {
    return this.page("/v1/contacts", { limit: options.limit ?? 50, after: options.after ?? undefined });
  }
}
