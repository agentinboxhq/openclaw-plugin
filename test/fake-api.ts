// A fake of Agent Inbox's API, as far as the plugin calls it, behind a `fetch` the plugin is handed.
import { AgentInboxApi, type Json } from "../src/api.js";
import { DEFAULT_AGENT } from "../src/settings.js";

export const OPERATOR = "op_ada";

export function stamp(secondsFromNow = 0): string {
  return new Date(Date.now() + secondsFromNow * 1000).toISOString().replace(/\.\d{3}Z$/, "Z");
}

export function message(
  id: string,
  options: {
    conversation?: string;
    text?: string;
    operator?: boolean;
    name?: string;
    sender?: string;
    channel?: string;
    round?: number;
    direct?: boolean;
    // A contact whose operator gave them full access: the API sets `from.fullAccess`, and leaves it out otherwise.
    fullAccess?: boolean;
    answers?: string;
    answer?: Json;
  } = {},
): Json {
  const text = options.text ?? "hello";
  const found: Json = {
    id,
    conversationId: options.conversation ?? "conv_1",
    channel: options.channel ?? "telegram",
    text,
    from: {
      id: options.sender ?? OPERATOR,
      name: options.name ?? "Ada",
      isOperator: options.operator ?? true,
      ...(options.fullAccess ? { fullAccess: true } : {}),
    },
    at: stamp(),
    round: options.round ?? 0,
    isDirectMessage: options.direct ?? true,
  };
  if (options.answers) {
    found.answersMessageId = options.answers;
    found.answer = options.answer ?? { status: "answered", text };
  }
  return found;
}

type Failure = { status: number; body: Json };

export class FakeApi {
  holder: Json | null = null;
  paused = false;
  operator: string | null = OPERATOR;
  queue: Json[] = [];
  interactions: Record<string, Json> = {};
  sent: Json[] = [];
  typing: string[] = [];
  calls: string[] = [];
  // Who each call said it is: the plugin's `Agent-Inbox-Via` and `Agent-Inbox-Host` headers.
  callers: Array<[string | null, string | null]> = [];
  keys: Array<string | null> = [];
  failures: Record<string, Failure[]> = {};
  codes: Record<string, Json> = {};
  released = 0;
  // What the tools read: the contacts (pages of `contactsPage`), the conversations, and each one's messages.
  contacts: Json[] = [];
  contactsPage = 100;
  conversations: Json[] = [];
  conversationsNext: string | null = null;
  views: Record<string, Json> = {};
  reads: Array<Record<string, string>> = [];
  // Recipients whose channels take nothing: a send to them comes back with them in `failedTo`.
  unreachable: string[] = [];
  // The conversations resolved, in order, with the agent each was asked for.
  resolved: Array<{ id: string; agent: string | null }> = [];
  // The bodies the card was shown with, each a showing.
  cardsShown: Json[] = [];
  private next = 0;
  private waiters: Array<() => void> = [];

  // --- what a test does ---

  deliver(...messages: Json[]): void {
    this.queue.push(...messages);
    for (const wake of this.waiters.splice(0)) wake();
  }

  answer(interactionId: string, status: string, options: { optionId?: string; text?: string } = {}): void {
    const interaction = this.interactions[interactionId];
    if (!interaction) throw new Error(`no interaction ${interactionId}`);
    interaction.status = status;
    interaction.response = {
      type: options.optionId ? "option" : "text",
      optionId: options.optionId ?? null,
      text: options.text ?? null,
      respondedAt: stamp(),
    };
  }

  /** The next `times` calls of `route` ("POST /v1/listen/lease") answer with this error. */
  fail(route: string, status: number, body: Json = {}, times = 1): void {
    const list = (this.failures[route] ??= []);
    for (let index = 0; index < times; index += 1) list.push({ status, body });
  }

  last(kind: string): Json {
    const found = this.sent.filter((each) => each.kind === kind);
    const last = found[found.length - 1];
    if (!last) throw new Error(`nothing of kind ${kind} was sent`);
    return last;
  }

  api(key = "sk_test", agent: string = DEFAULT_AGENT): AgentInboxApi {
    return new AgentInboxApi("https://api.test", key, agent, { fetch: this.fetch });
  }

  readonly fetch = async (input: string, init: RequestInit = {}): Promise<Response> => {
    const url = new URL(input);
    // The site's `/api` (https://www.agentinbox.md/api/v1/…) or the API itself.
    const at = url.pathname.indexOf("/v1/");
    const path = at >= 0 ? url.pathname.slice(at) : url.pathname;
    const method = (init.method ?? "GET").toUpperCase();
    const route = `${method} ${path}`;
    const headers = new Headers(init.headers);
    this.calls.push(route);
    this.callers.push([headers.get("agent-inbox-via"), headers.get("agent-inbox-host")]);
    this.keys.push(headers.get("authorization"));
    const failure = this.failures[route]?.shift();
    if (failure) return json(failure.status, failure.body);
    const body = (init.body ? JSON.parse(String(init.body)) : {}) as Json;
    const params = Object.fromEntries(url.searchParams.entries());

    if (route === "GET /v1/operator") {
      return this.operator ? json(200, { data: { subscriberId: this.operator } }) : json(404, { message: "No operator" });
    }
    if (route === "POST /v1/connect") {
      const found = this.codes[String(body.code)];
      const agent = (found?.agent ?? {}) as Json;
      if (!found || agent.handle !== body.agent) {
        return json(400, { message: "That code doesn't work. Get a new one on agentinbox.md." });
      }
      return json(200, { data: found });
    }
    if (route === "GET /v1/listen/lease") return json(200, { data: { listening: this.holder, paused: this.paused } });
    if (route === "POST /v1/listen/lease") return this.take(body);
    if (route === "POST /v1/listen/lease/release") {
      const mine = this.isHolder(body);
      if (mine) {
        this.holder = null;
        this.released += 1;
      }
      return json(200, { data: { released: mine } });
    }
    if (route === "POST /v1/listen/typing") {
      this.typing.push(String(body.conversationId));
      return json(200, { data: { typing: true } });
    }
    if (route === "GET /v1/listen/messages") return this.wait(params, init.signal ?? undefined);
    if (route === "POST /v1/inbox/messages") {
      this.next += 1;
      const to = body.to ? String(body.to) : null;
      const conversation = body.thread ? String(body.thread) : `conv_with_${to}`;
      const interaction: Json = {
        id: `msg_${this.next}`,
        kind: body.kind,
        status: "pending",
        expiresAt: stamp(Number(body.ttlSeconds ?? 3600)),
        payload: body,
        threads: [{ id: conversation, unreadBefore: 0 }],
      };
      if (to && this.unreachable.includes(to)) interaction.failedTo = [to];
      this.interactions[String(interaction.id)] = interaction;
      this.sent.push({ ...body, id: interaction.id });
      return json(201, { data: interaction });
    }
    if (route === "POST /v1/agent/card") {
      this.cardsShown.push(body);
      return json(200, {
        data: {
          greeting: "Hi Ada, I’m JunoX. I have my own inbox now. Here’s my card, so people can email or message me directly.",
          name: "JunoX",
          handle: "junox",
          address: "junox@agentinbox.md",
          url: "https://agentinbox.md/p/junox",
          operatorFirstName: "Ada",
          look: { shape: "blob", color: "amber", art: { kind: "rays", seed: 7 } },
          firstShown: this.cardsShown.length === 1,
        },
      });
    }
    if (route === "GET /v1/contacts") {
      const start = Number.parseInt(params.after ?? "0", 10) || 0;
      const size = Math.min(Number.parseInt(params.limit ?? "50", 10) || 50, this.contactsPage);
      const page = this.contacts.slice(start, start + size);
      const more = start + size < this.contacts.length ? String(start + size) : null;
      return json(200, { data: page, next: more });
    }
    if (route === "GET /v1/inbox") {
      this.reads.push(params);
      return json(200, { data: this.conversations, next: this.conversationsNext });
    }
    const parts = path.split("/");
    if (method === "POST" && /^\/v1\/inbox\/[^/]+\/resolve$/.test(path) && !path.startsWith("/v1/inbox/messages/")) {
      const id = decodeURIComponent(parts[3] ?? "");
      this.resolved.push({ id, agent: params.agentIdentifier ?? null });
      return json(200, { data: { id, status: "resolved" } });
    }
    if (method === "POST" && path.startsWith("/v1/inbox/messages/") && path.endsWith("/cancel")) {
      const interaction = this.interactions[decodeURIComponent(parts[4] ?? "")];
      if (!interaction) return json(404, { message: "Not found" });
      interaction.status = "canceled";
      return json(200, { data: interaction });
    }
    if (method === "GET" && path.startsWith("/v1/inbox/messages/")) {
      const interaction = this.interactions[decodeURIComponent(parts[4] ?? "")];
      return interaction ? json(200, { data: interaction }) : json(404, { message: "Not found" });
    }
    if (method === "GET" && path.startsWith("/v1/inbox/")) {
      this.reads.push(params);
      const view = this.views[decodeURIComponent(parts[3] ?? "")];
      return view ? json(200, { data: view }) : json(404, { message: "Conversation not found" });
    }
    return json(404, { message: `No route ${route}` });
  };

  private isHolder(body: Json): boolean {
    return Boolean(this.holder) && this.holder?.computerId === body.computerId && this.holder?.host === body.host;
  }

  private take(body: Json): Response {
    if (this.paused) return json(403, { code: "agent_paused", message: "The agent is paused." });
    if (this.holder && !this.isHolder(body) && !body.takeOver) {
      return json(409, { code: "listening_elsewhere", message: "Listening elsewhere", listening: this.holder });
    }
    this.holder = {
      computerId: body.computerId,
      computerName: body.computerName,
      host: body.host,
      since: stamp(),
      renewedAt: stamp(),
      expiresAt: stamp(90),
    };
    return json(200, { data: { listening: this.holder, renewInSeconds: 60 } });
  }

  private async wait(params: Record<string, string>, signal?: AbortSignal): Promise<Response> {
    if (!this.isHolder({ computerId: params.computerId, host: params.host })) {
      return json(409, { code: "not_listening", message: "Not listening", listening: this.holder });
    }
    const after = params.after;
    const startOf = () => {
      if (!after) return 0;
      const index = this.queue.findIndex((each) => each.id === after);
      return index >= 0 ? index + 1 : 0;
    };
    if (startOf() >= this.queue.length) {
      // Holds the wait a moment, as the server does, so a test's loop doesn't spin.
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, 30);
        this.waiters.push(() => {
          clearTimeout(timer);
          resolve();
        });
        signal?.addEventListener("abort", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    if (signal?.aborted) throw signal.reason ?? new Error("aborted");
    const start = startOf();
    const page = this.queue.slice(start, start + (Number.parseInt(params.limit ?? "20", 10) || 20));
    const last = page[page.length - 1];
    return json(200, { data: page, next: last ? last.id : after ?? "" });
  }
}

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Waits until `check` holds, or fails after `ms`. */
export async function until(check: () => boolean, ms = 3000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!check()) {
    if (Date.now() > deadline) throw new Error("timed out waiting");
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
