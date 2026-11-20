// OpenClaw's tools for Agent Inbox: ask the operator, write to someone, and read the conversations and contacts. They
// act as the agent with the key the plugin holds; the model never sees it.
//
// In the gateway, the tools work with the account that listens: it knows the operator, whose message started each
// chat, and which questions still wait, so an answer comes back into the chat that asked. Elsewhere (a local one-shot
// run) they call Agent Inbox on their own, and an answer reaches OpenClaw in that conversation once the gateway runs.
//
// In a contact's conversation on Agent Inbox, or a group, Agent Inbox is the operator's: OpenClaw only answers there.
// Writing to people, asking the operator, and reading other conversations and contacts are off, with nothing to
// approve; `guard.ts` stops the rest of Agent Inbox there (its MCP server, CLI, skills and keys). A contact the
// operator gave full access is the exception, in their own direct chat: it has what the operator's own chat has. In
// OpenClaw's other apps' chats, writing to anyone but the operator asks the operator first: a `before_tool_call` hook
// asks for OpenClaw's own plugin approval, and the tool sends nothing the approval didn't allow.
import { createPluginRuntimeStore } from "openclaw/plugin-sdk/runtime-store";
import { AgentInboxApi, ApiError, type FetchLike, type Json, isRecord } from "./api.js";
import type { AgentInboxGateway } from "./gateway.js";
import { CHANNEL_ID, HOST_NAME, type Settings, connectionOf, isConfigured, readSettings } from "./settings.js";
import type { Chat, WaitingQuestion } from "./state.js";
import * as words from "./words.js";

export const ASK_OPERATOR = "agentinbox_ask_operator";
export const ASK_HERE = "agentinbox_ask_here";
export const CARD = "agentinbox_card";
export const SEND = "agentinbox_send";
export const CONVERSATIONS = "agentinbox_conversations";
export const READ = "agentinbox_read";
export const CONTACTS = "agentinbox_contacts";
export const RESOLVE = "agentinbox_resolve";
export const TOOL_NAMES = [ASK_OPERATOR, ASK_HERE, CARD, SEND, CONVERSATIONS, READ, CONTACTS, RESOLVE] as const;

// What a card asks for, in the words of the CLI and the MCP server: `tell` nothing, `ask` words, `approve` Approve
// or Deny, `choose` one of a few options.
const KINDS = ["tell", "ask", "approve", "choose"] as const;

// How long the operator has to allow a write (Hermes's approval timeout; OpenClaw allows up to 10 minutes).
export const WRITE_APPROVAL_TIMEOUT_MS = 5 * 60_000;

// How long an allowed send may still run after its approval: longer than any approval waits.
const CLEARANCE_MS = 30 * 60_000;

// Sessions on the operator's own computer: whoever is at it owns this OpenClaw. `webchat` is the Control UI and the
// gateway TUI.
export const LOCAL_SURFACES = ["webchat", "tui", "cli"];

// What `to` may say for the operator.
const OPERATOR_WORDS = ["operator", "my operator", "the operator", "your operator", "me", "owner"];

// How many contacts a name is looked up among: the API's page, three times.
const CONTACT_PAGES = 3;

// An option's label on a card, at most (the API's limit).
const OPTION_MAX = 100;

/** A refusal or a failure, as the model reads it in the tool's result. */
export class ToolError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ToolError";
  }
}

// --- the gateways running in this process ---

/**
 * A map in OpenClaw's own store for the plugin (`createPluginRuntimeStore`), which the gateway and the tools of a
 * plugin instance share, so the tools find the account that listens.
 */
function sharedMap<V>(key: string): () => Map<string, V> {
  const store = createPluginRuntimeStore<Map<string, V>>({ key, errorMessage: `${key} is not set up` });
  return () => {
    let found = store.tryGetRuntime();
    if (!found) {
      found = new Map();
      store.setRuntime(found);
    }
    return found;
  };
}

const registry = sharedMap<AgentInboxGateway>("@agentinbox/openclaw/gateways");

/** The account listens now: tools for its connection go through it. */
export function bindGateway(gateway: AgentInboxGateway): void {
  registry().set(connectionOf(gateway.settings), gateway);
}

export function unbindGateway(gateway: AgentInboxGateway): void {
  const key = connectionOf(gateway.settings);
  if (registry().get(key) === gateway) registry().delete(key);
}

export function boundGateway(settings: Settings): AgentInboxGateway | null {
  if (!isConfigured(settings)) return null;
  return registry().get(connectionOf(settings)) ?? null;
}

/** Any running gateway for this channel: the approval capability works per account, and there is one account. */
export function anyGateway(): AgentInboxGateway | null {
  for (const gateway of registry().values()) return gateway;
  return null;
}

// --- where a tool runs ---

/** The session a tool runs for: its surface (`agentinbox`, `telegram`, `webchat`, …), and its Agent Inbox chat. */
export type Place = {
  surface: string;
  sessionKey: string;
  cron: boolean;
  // The Agent Inbox chat this session runs for, when the gateway started it.
  chat: Chat | null;
  // The person whose message this turn answers, as OpenClaw names them.
  senderId: string;
  toolCallId: string;
};

/** `agent:<id>:cron:<job>…`: a scheduled job's own session. */
export function isCronSessionKey(sessionKey: string): boolean {
  const parts = sessionKey.split(":");
  return parts[0] === "agent" && (parts[2] ?? "").toLowerCase() === "cron";
}

export function placeOf(options: {
  surface?: string | null;
  sessionKey?: string | null;
  senderId?: string | null;
  toolCallId?: string | null;
  gateway: AgentInboxGateway | null;
}): Place {
  const sessionKey = String(options.sessionKey ?? "");
  const chat = sessionKey && options.gateway ? options.gateway.chatForSession(sessionKey) : null;
  const surface = String(options.surface ?? "").toLowerCase() || (chat ? CHANNEL_ID : "");
  return {
    surface,
    sessionKey,
    cron: isCronSessionKey(sessionKey),
    chat,
    senderId: String(options.senderId ?? ""),
    toolCallId: String(options.toolCallId ?? ""),
  };
}

export function inAgentInbox(place: Place): boolean {
  return place.surface === CHANNEL_ID;
}

/**
 * A chat on Agent Inbox that isn't the operator's own direct chat: a contact's, or a group, even when the operator
 * writes there. Agent Inbox is the operator's there, and OpenClaw only answers. A chat whose starter isn't known counts
 * as a contact's. So does a session the gateway didn't start, such as a helper OpenClaw spawned, unless it runs for
 * the operator: which chat started a helper can't be told, so a helper never has full access.
 */
export function isContactChat(gateway: AgentInboxGateway | null, place: Place): boolean {
  if (!inAgentInbox(place)) return false;
  if (place.chat) return !(place.chat.isDirect && startedByOperator(gateway, place) === true);
  const operator = gateway?.operatorId;
  return !(operator && place.senderId && place.senderId === operator);
}

/**
 * Whether an Agent Inbox chat runs at full access: a contact's own direct chat whose session started at full access,
 * while their conversation is still at it (`AgentInboxGateway.fullAccessFor`). It has everything the operator's own
 * chat has.
 */
export function hasFullAccess(gateway: AgentInboxGateway | null, place: Place): boolean {
  return Boolean(gateway && inAgentInbox(place) && gateway.fullAccessFor(place.chat));
}

/**
 * Whether a tool call has a contact's limits: in a contact's chat or a group, unless it runs at full access. Each call
 * is judged anew, so a full-access run has a contact's limits as soon as the plugin sees the switch off.
 */
export function hasContactLimits(gateway: AgentInboxGateway | null, place: Place): boolean {
  return isContactChat(gateway, place) && !hasFullAccess(gateway, place);
}

function starterOf(gateway: AgentInboxGateway | null, place: Place): words.ListenMessage | Json | null {
  if (!gateway || !place.chat) return null;
  return (gateway.starterOf(place.chat.conversationId) ?? place.chat.starter) as words.ListenMessage | null;
}

/** Whether the operator's message started this Agent Inbox chat; null when that isn't known. */
function startedByOperator(gateway: AgentInboxGateway | null, place: Place): boolean | null {
  const starter = starterOf(gateway, place) as words.ListenMessage | null;
  if (!starter) return null;
  return Boolean(starter.from?.isOperator);
}

/**
 * Writing to a contact from another app's chat asks the operator first. The operator's own places write without
 * asking: their own chat here, the Control UI or a terminal, and a job they scheduled. So does a full-access
 * contact's chat here; another contact's can't write at all (`hasContactLimits`).
 */
export function operatorAsksFirst(_gateway: AgentInboxGateway | null, place: Place): boolean {
  if (place.cron || inAgentInbox(place)) return false;
  return Boolean(place.surface) && !LOCAL_SURFACES.includes(place.surface);
}

function talkingWith(place: Place, to: Recipient): boolean {
  if (!inAgentInbox(place) || !place.chat?.isDirect) return false;
  const here = place.chat.userId || place.senderId;
  return Boolean(here) && to.id === here;
}

// --- running the work ---

type Work<T> = (api: AgentInboxApi, gateway: AgentInboxGateway | null) => Promise<T>;

/** Runs `work` with the listening account's client and what it knows; outside the gateway, with a client of its own. */
async function run<T>(settings: Settings, work: Work<T>, fetchImpl?: FetchLike): Promise<T> {
  const gateway = boundGateway(settings);
  if (gateway) return work(gateway.api, gateway);
  if (!isConfigured(settings)) throw new ToolError(words.NOT_SET_UP_MESSAGE);
  const api = new AgentInboxApi(settings.apiUrl, settings.secretKey, settings.agent, fetchImpl ? { fetch: fetchImpl } : {});
  return work(api, null);
}

function failure(error: ApiError): string {
  if (error.keyRejected) return words.KEY_CHANGED_MESSAGE;
  if (error.outage) return `Agent Inbox couldn't be reached (${error.message}). Try again in a moment.`;
  return error.message;
}

// --- reading arguments ---

function required(value: unknown, name: string): string {
  const text = words.clean(value).trim();
  if (!text) throw new ToolError(`\`${name}\` is required.`);
  return text;
}

/** A plain list, or the shapes small models send for one: a comma-separated string, or objects with a label. */
export function readOptions(value: unknown): string[] {
  let items: unknown[] = [];
  if (typeof value === "string") items = value.split(/\r?\n/).flatMap((line) => line.split(","));
  else if (Array.isArray(value)) items = value;
  const found: string[] = [];
  for (let item of items) {
    if (isRecord(item)) item = item.label ?? item.text ?? item.item ?? Object.values(item)[0] ?? "";
    const label = words.clean(item).trim();
    if (label) found.push(label.slice(0, OPTION_MAX));
  }
  return found;
}

function limitOf(value: unknown, fallback: number, most: number): number {
  const number = Number.parseInt(String(value ?? ""), 10);
  return Number.isNaN(number) ? fallback : Math.max(1, Math.min(most, number));
}

/** What the person may answer with: `tell` none, `ask` words, `approve` Approve or Deny, `choose` one option. */
type Answer = {
  kind: (typeof KINDS)[number];
  options: Record<string, string>;
  approveLabel?: string;
  denyLabel?: string;
};

/**
 * `kind`, `options`, `approve_label` and `deny_label`, as the CLI and the MCP server take them. Options without a kind,
 * or with `ask` or `tell`, make it `choose`; labels without a kind make it `approve`.
 */
function answerOf(args: Json, fallback: Answer["kind"]): Answer {
  const picks = readOptions(args.options);
  const [approveLabel, denyLabel] = [args.approve_label, args.deny_label].map((label) =>
    words.clean(label).trim().slice(0, OPTION_MAX),
  );
  let kind = String(args.kind ?? "").trim().toLowerCase();
  if (!kind) kind = picks.length ? "choose" : approveLabel || denyLabel ? "approve" : fallback;
  else if (picks.length && (kind === "tell" || kind === "ask")) kind = "choose";
  const known = KINDS.find((each) => each === kind);
  if (!known) throw new ToolError(`\`kind\` is one of: ${KINDS.join(", ")}.`);
  if ((approveLabel || denyLabel) && known !== "approve") {
    throw new ToolError("`approve_label` and `deny_label` go with `kind: approve`.");
  }
  if (known === "choose") {
    if (picks.length < 2 || picks.length > 10) throw new ToolError("`kind: choose` takes 2 to 10 `options`.");
    const options: Record<string, string> = {};
    picks.forEach((label, index) => {
      options[`opt_${index + 1}`] = label;
    });
    return { kind: known, options };
  }
  return { kind: known, options: {}, approveLabel, denyLabel };
}

function cardOf(text: string, answer: Answer, body?: string | null): Json {
  const card: Json = { title: words.clipCard(text) };
  if (body) card.body = words.clipCard(body);
  if (answer.kind === "approve") {
    Object.assign(card, { approveLabel: answer.approveLabel || "Approve", denyLabel: answer.denyLabel || "Deny" });
  }
  if (answer.kind === "choose") card.options = Object.entries(answer.options).map(([id, label]) => ({ id, label }));
  return card;
}

// --- people ---

type Recipient = { id: string; name: string; isOperator: boolean };

function nameOf(contact: Json): string {
  const name = [contact.firstName, contact.lastName]
    .map((part) => words.clean(part).trim())
    .filter(Boolean)
    .join(" ");
  return name || words.clean(contact.email) || words.clean(contact.id);
}

async function operatorOf(api: AgentInboxApi, gateway: AgentInboxGateway | null): Promise<string> {
  const operator = gateway?.operatorId ?? (await api.findOperator());
  if (!operator) throw new ToolError(words.NO_OPERATOR_MESSAGE);
  return operator;
}

async function allContacts(api: AgentInboxApi): Promise<Json[]> {
  const found: Json[] = [];
  let after: string | null = null;
  for (let page = 0; page < CONTACT_PAGES; page += 1) {
    const result = await api.listContacts({ limit: 100, after });
    found.push(...result.items);
    after = result.next;
    if (!after) break;
  }
  return found;
}

/** `to` as the person it names: the operator, or one contact by id, email or name. */
export async function recipientOf(api: AgentInboxApi, gateway: AgentInboxGateway | null, to: string): Promise<Recipient> {
  const operator = await operatorOf(api, gateway);
  const wanted = to.trim();
  const lowered = wanted.toLowerCase();
  if (OPERATOR_WORDS.includes(lowered) || wanted === operator) {
    return { id: operator, name: "your operator", isOperator: true };
  }
  const contacts = await allContacts(api);
  let matches = contacts.filter((each) => String(each.id ?? "") === wanted);
  if (!matches.length) {
    matches = contacts.filter(
      (each) => words.clean(each.email).trim().toLowerCase() === lowered || nameOf(each).toLowerCase() === lowered,
    );
  }
  if (!matches.length) matches = contacts.filter((each) => words.clean(each.firstName).trim().toLowerCase() === lowered);
  if (matches.length > 1) {
    const listed = matches
      .slice(0, 10)
      .map((each) => `${nameOf(each)} (${String(each.id)})`)
      .join("; ");
    throw new ToolError(`Several contacts match “${wanted}”: ${listed}. Write to one of them by their id.`);
  }
  const contact = matches[0];
  if (!contact) {
    throw new ToolError(
      `No contact matches “${wanted}”. ${CONTACTS} lists them; your operator adds new ones on agentinbox.md.`,
    );
  }
  const isOperator = Boolean(contact.isOperator) || contact.id === operator;
  return { id: String(contact.id), name: isOperator ? "your operator" : nameOf(contact), isOperator };
}

// --- the sends the operator allowed ---

type Clearance = { at: number; decision: string | null };

// The sends the hook asked about, by tool call and by what they send: a send that needed the operator runs only once
// its approval allowed it.
const clearances = sharedMap<Clearance>("@agentinbox/openclaw/cleared");

function clearanceKeys(place: Place, args: Json): string[] {
  const content = [
    place.sessionKey,
    words.clean(args.to).trim().toLowerCase(),
    words.clean(args.text).split(/\s+/).filter(Boolean).join(" "),
  ].join("\n");
  return [place.toolCallId ? `call\n${place.toolCallId}` : "", `send\n${content}`].filter(Boolean);
}

function clear(place: Place, args: Json): (decision: string) => void {
  const now = Date.now();
  const map = clearances();
  for (const [key, value] of map) if (now - value.at > CLEARANCE_MS) map.delete(key);
  const keys = clearanceKeys(place, args);
  for (const key of keys) map.set(key, { at: now, decision: null });
  return (decision) => {
    for (const key of keys) {
      const found = map.get(key);
      if (found) found.decision = decision;
    }
  };
}

/** Whether the operator allowed this very send; each allowance is used once. */
function wasAllowed(place: Place, args: Json): boolean {
  const map = clearances();
  const keys = clearanceKeys(place, args);
  const found = keys.map((key) => map.get(key)).find(Boolean);
  for (const key of keys) map.delete(key);
  return Boolean(
    found &&
      Date.now() - found.at <= CLEARANCE_MS &&
      (found.decision === "allow-once" || found.decision === "allow-always"),
  );
}

// --- asking and sending ---

function expect(
  gateway: AgentInboxGateway | null,
  sent: Json,
  options: { question: string; to: Recipient; answer: Answer; place: Place },
): string {
  const threads = Array.isArray(sent.threads) ? sent.threads : [];
  const first = isRecord(threads[0]) ? threads[0] : null;
  const conversation = first ? String(first.id ?? "") : "";
  const name = options.to.isOperator ? "your operator" : options.to.name;
  if (!gateway) {
    return `Asked ${name}. The answer reaches ${HOST_NAME} in that Agent Inbox conversation while its gateway runs.`;
  }
  const chat = inAgentInbox(options.place) && options.place.chat ? options.place.chat : null;
  const starter = chat ? gateway.starterOf(chat.conversationId) : null;
  const question: WaitingQuestion = {
    id: String(sent.id ?? ""),
    question: options.question,
    to: options.to.id,
    toOperator: options.to.isOperator,
    toName: options.to.isOperator ? "Your operator" : name,
    kind: options.answer.kind,
    options: options.answer.options,
    conversation,
    expiresAt: typeof sent.expiresAt === "string" ? sent.expiresAt : null,
    chat: chat ? { ...chat, starter: starter ? keptStarter(starter) : chat.starter } : null,
  };
  gateway.expectAnswer(question);
  if (question.chat) {
    return (
      `Asked ${name}. Their answer comes to you in this chat when they give it. Tell the person here you'll get ` +
      "back to them, then end your turn."
    );
  }
  return `Asked ${name}. The answer comes to ${HOST_NAME} in that Agent Inbox conversation.`;
}

function keptStarter(message: words.ListenMessage | Json): NonNullable<Chat["starter"]> {
  const from = (isRecord(message.from) ? message.from : {}) as Json;
  return {
    from: {
      id: from.id ? String(from.id) : null,
      name: from.name ? String(from.name) : null,
      isOperator: Boolean(from.isOperator),
    },
    channel: words.clean(message.channel),
    text: words.clean(message.text).slice(0, 200),
  };
}

export type ToolCall = { settings: Settings; place: Place; args: Json; fetch?: FetchLike; signal?: AbortSignal };

export async function askOperator({ settings, place, args, fetch: fetchImpl }: ToolCall): Promise<string> {
  const question = required(args.question, "question");
  const answer = answerOf(args, "ask");
  if (answer.kind === "tell") {
    throw new ToolError(`A question needs an answer; to tell your operator something, use ${SEND}.`);
  }
  const gateway = boundGateway(settings);
  if (hasContactLimits(gateway, place)) throw new ToolError(words.CONTACT_NO_ASKING);
  // A full-access contact's chat asks the operator as any other place does; only the operator's own answers here.
  if (inAgentInbox(place) && !hasFullAccess(gateway, place)) {
    throw new ToolError(`You're talking with your operator in this chat: ask them here with ${ASK_HERE} instead.`);
  }
  return run(
    settings,
    async (api, gateway) => {
      const operator = await operatorOf(api, gateway);
      const body = words.askCardBody(words.runStarter(starterOf(gateway, place) as words.ListenMessage | null));
      const sent = await api.createInteraction({
        kind: answer.kind,
        card: cardOf(question, answer, body),
        to: operator,
        from: HOST_NAME,
        ttlSeconds: words.TOOL_QUESTION_TTL_SECONDS,
      });
      return expect(gateway, sent, {
        question,
        to: { id: operator, name: "your operator", isOperator: true },
        answer,
        place,
      });
    },
    fetchImpl,
  );
}

/**
 * Who answers a question in this conversation, as its answer names them. Only what the operator writes, or a contact in
 * their own session at full access, is more than a request and data.
 */
function askedHere(
  gateway: AgentInboxGateway,
  place: Place,
  chat: Chat,
): Pick<WaitingQuestion, "to" | "toOperator" | "toName" | "trusted"> {
  if (!isContactChat(gateway, place)) return { to: gateway.operatorId ?? "", toOperator: true, toName: "Your operator" };
  if (!chat.isDirect) return { to: "", toOperator: false, toName: "Someone in this conversation" };
  return {
    to: chat.userId ?? "",
    toOperator: false,
    toName: chat.userName || "The contact",
    trusted: hasFullAccess(gateway, place),
  };
}

/**
 * Asks the people in this Agent Inbox conversation, in it, and waits for their answer, as `reply <id> ask`, `approve`
 * or `choose` does in the CLI. Past the wait, the question stays open, and its answer comes to the chat as a message.
 */
export async function askHere({ settings, place, args, signal }: ToolCall): Promise<string> {
  const question = required(args.question, "question");
  const answer = answerOf(args, "ask");
  if (answer.kind === "tell") throw new ToolError("A question needs an answer; anything else, say in your answer here.");
  const gateway = boundGateway(settings);
  const chat = place.chat;
  if (!gateway || !inAgentInbox(place) || !chat) {
    throw new ToolError(
      `${ASK_HERE} asks in the Agent Inbox conversation you're in, and this isn't one. To ask your operator, use ` +
        `${ASK_OPERATOR}.`,
    );
  }
  const since = gateway.latestIdIn(chat.conversationId);
  const sent = await gateway.api.createInteraction({
    kind: answer.kind,
    card: cardOf(question, answer),
    thread: chat.conversationId,
    ttlSeconds: words.TOOL_QUESTION_TTL_SECONDS,
  });
  const id = String(sent.id ?? "");
  const starter = gateway.starterOf(chat.conversationId);
  // Its answer comes to the chat, also after a restart, unless this call still waits for it.
  gateway.expectAnswer({
    id,
    question,
    ...askedHere(gateway, place, chat),
    kind: answer.kind,
    options: answer.options,
    conversation: chat.conversationId,
    expiresAt: typeof sent.expiresAt === "string" ? sent.expiresAt : null,
    chat: { ...chat, starter: starter ? keptStarter(starter) : chat.starter },
  });
  const outcome = await gateway.waitHere(id, chat.conversationId, since, signal);
  return outcome ? words.hereAnswer(outcome.question ?? {}, outcome.status, outcome) : words.NO_ANSWER_YET;
}

/**
 * Shows the agent's card, as `agentinbox card` does in the CLI and `agent_card` over MCP. Not in a contact's chat: its
 * greeting is for the operator, by their first name.
 */
export async function card({ settings, place, fetch: fetchImpl }: ToolCall): Promise<string> {
  if (hasContactLimits(boundGateway(settings), place)) throw new ToolError(words.CONTACT_NO_CARD);
  return run(settings, async (api) => words.cardText(await api.showCard()), fetchImpl);
}

/**
 * OpenClaw's `before_tool_call` hook, for agentinbox_send outside Agent Inbox. Before it writes to anyone but the
 * operator for another app's chat, it asks for OpenClaw's plugin approval, which goes to the operator; the tool runs
 * only once they allow it. On Agent Inbox nothing is asked: the operator's own chat writes, and a contact's can't
 * (`guard.ts`). Anything else goes on as it is.
 */
/** What the hook gives OpenClaw: its plugin approval, which the operator answers. */
export type WriteApproval = {
  requireApproval: {
    title: string;
    description: string;
    severity: "warning";
    timeoutMs: number;
    scope: { kind: "message-send"; target: string; recipientCount: number; recipients: string[]; audience: "external" };
    allowedDecisions: Array<"allow-once" | "allow-always" | "deny">;
    onResolution: (decision: string) => void;
  };
};

export async function beforeSend(call: ToolCall): Promise<WriteApproval | undefined> {
  const { settings, place, args } = call;
  const gateway = boundGateway(settings);
  if (!operatorAsksFirst(gateway, place)) return undefined;
  let text: string;
  let to: Recipient;
  try {
    text = required(args.text, "text");
    const toWords = required(args.to, "to");
    to = await run(settings, (api, gateway) => recipientOf(api, gateway, toWords), call.fetch);
  } catch (error) {
    if (error instanceof ToolError || error instanceof ApiError) return undefined; // the tool says what's wrong
    throw error;
  }
  if (to.isOperator || talkingWith(place, to)) return undefined;
  if (gateway?.hasGrant(place.sessionKey, to.id)) return undefined;
  gateway?.askBeforeWrite([place.toolCallId, place.sessionKey], {
    name: to.name,
    text,
    recipientId: to.id,
    sessionKey: place.sessionKey,
  });
  const decided = clear(place, args);
  const shown = text.split(/\s+/).filter(Boolean).join(" ");
  return {
    requireApproval: {
      title: `Write to ${to.name}`.slice(0, 80),
      description: `“${shown.length <= 200 ? shown : `${shown.slice(0, 199)}…`}”`,
      severity: "warning",
      timeoutMs: WRITE_APPROVAL_TIMEOUT_MS,
      // What the approval is about, as OpenClaw's approval surfaces show it.
      scope: { kind: "message-send", target: "agentinbox", recipientCount: 1, recipients: [to.name], audience: "external" },
      // allow-always is "Allow for this session": OpenClaw may write to this person again in the session.
      allowedDecisions: ["allow-once", "allow-always", "deny"],
      onResolution: (decision: string) => {
        decided(decision);
        if (decision === "allow-always") gateway?.grantSession(place.sessionKey, to.id);
      },
    },
  };
}

export async function send({ settings, place, args, fetch: fetchImpl }: ToolCall): Promise<string> {
  const gateway = boundGateway(settings);
  if (hasContactLimits(gateway, place)) throw new ToolError(words.CONTACT_NO_WRITING);
  const toWords = required(args.to, "to");
  const text = required(args.text, "text");
  const answer = answerOf(args, "tell");
  const to = await run(settings, (api, gateway) => recipientOf(api, gateway, toWords), fetchImpl);
  if (talkingWith(place, to)) {
    throw new ToolError(
      `You're talking with ${to.name} in this chat: your answer already goes to them, and ${ASK_HERE} asks them ` +
        `something. Use ${SEND} only to write to someone else.`,
    );
  }
  if (
    !to.isOperator &&
    operatorAsksFirst(gateway, place) &&
    !gateway?.hasGrant(place.sessionKey, to.id) &&
    !wasAllowed(place, args)
  ) {
    // The hook didn't ask for an approval that allowed this call, so the operator wasn't asked.
    throw new ToolError("Your operator couldn't be asked to allow it, so nothing was sent.");
  }
  return run(
    settings,
    async (api, gateway) => {
      const payload: Json = { kind: answer.kind, card: cardOf(text, answer), to: to.id };
      if (answer.kind !== "tell") payload.ttlSeconds = words.TOOL_QUESTION_TTL_SECONDS;
      const sent = await api.createInteraction(payload);
      const failedTo = Array.isArray(sent.failedTo) ? sent.failedTo.map(String) : [];
      if (failedTo.includes(to.id)) {
        throw new ToolError(`It couldn't be delivered to ${to.name}: no channel of theirs took it.`);
      }
      if (answer.kind === "tell") return `Sent to ${to.name}.`;
      return expect(gateway, sent, { question: text, to, answer, place });
    },
    fetchImpl,
  );
}

// --- reading ---

/** "just now", "5 min ago", "3 h ago", "2 d ago". */
function ago(stamp: unknown, now = Date.now()): string {
  const at = Date.parse(String(stamp ?? ""));
  if (Number.isNaN(at)) return "";
  const seconds = (now - at) / 1000;
  if (seconds < 60) return "just now";
  if (seconds < 3600) return `${Math.floor(seconds / 60)} min ago`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)} h ago`;
  return `${Math.floor(seconds / 86400)} d ago`;
}

function oneLine(text: unknown, most: number): string {
  const flat = words.clean(text).split(/\s+/).filter(Boolean).join(" ");
  return flat.length <= most ? flat : `${flat.slice(0, most - 1).trimEnd()}…`;
}

function people(thread: Json): string {
  const listed = (Array.isArray(thread.people) ? thread.people : [])
    .filter(isRecord)
    .map((person) => words.clean(person.name ?? person.id) + (person.kind === "stranger" ? " (stranger)" : ""))
    .filter(Boolean);
  return listed.join(", ") || "nobody yet";
}

function conversationLine(thread: Json): string {
  const where = words.clean(thread.channel) + (thread.isDirectMessage === false ? ", a group" : "");
  const parts = [words.clean(thread.id), people(thread), where, words.clean(thread.status) || "open"];
  const unread = Number(thread.unreadCount ?? 0);
  if (unread) parts.push(`${unread} unread`);
  let line = parts.filter(Boolean).join(" · ");
  const last = isRecord(thread.lastMessage) ? thread.lastMessage : null;
  if (last) {
    const who = last.from === "agent" ? "you" : last.from === "system" ? "Agent Inbox" : "them";
    line += ` · ${ago(last.at)}, ${who}: “${oneLine(last.text, 160)}”`;
  }
  return line;
}

export async function conversations({ settings, place, args, fetch: fetchImpl }: ToolCall): Promise<string> {
  if (hasContactLimits(boundGateway(settings), place)) throw new ToolError(words.CONTACT_NO_OTHERS);
  const status = String(args.status ?? "all").trim().toLowerCase() || "all";
  if (!["open", "resolved", "all"].includes(status)) throw new ToolError("`status` is one of: open, resolved, all.");
  const limit = limitOf(args.limit, 20, 50);
  const after = words.clean(args.after).trim() || null;
  return run(
    settings,
    async (api) => {
      const { items, next } = await api.listConversations({
        filter: args.unread_only ? "unread" : "all",
        status,
        limit,
        after,
      });
      if (!items.length) return after ? "No more conversations." : "No conversations yet.";
      const lines = items.map(conversationLine);
      if (next) lines.push(`\nMore: call ${CONVERSATIONS} with after: "${next}".`);
      return lines.join("\n");
    },
    fetchImpl,
  );
}

function messageLine(message: Json): string {
  let who: string;
  if (message.from === "agent") who = "You";
  else if (message.from === "system") who = "Agent Inbox";
  else {
    who = words.clean(message.senderName).trim() || "Someone";
    if (message.senderKind === "stranger") who += " (a stranger)";
  }
  let text = words.clean(message.text).trim();
  const files = (Array.isArray(message.attachments) ? message.attachments : []).filter(isRecord);
  if (files.length) text += ` (with ${files.length === 1 ? "a file" : `${files.length} files`})`;
  const interaction = isRecord(message.interaction) ? message.interaction : null;
  if (interaction?.status) text += ` [${words.clean(interaction.kind)}: ${words.clean(interaction.status)}]`;
  const shown = text.length <= 2000 ? text : `${text.slice(0, 1999)}…`;
  return `[${ago(message.at)}] ${who}: ${shown}`;
}

export async function read({ settings, place, args, fetch: fetchImpl }: ToolCall): Promise<string> {
  const conversation = required(args.conversation, "conversation");
  if (hasContactLimits(boundGateway(settings), place)) {
    const here = place.chat?.conversationId ?? null;
    if (conversation !== here) throw new ToolError(words.contactReadHereOnly(here));
  }
  const limit = limitOf(args.limit, 20, 100);
  const before = words.clean(args.before).trim() || null;
  return run(
    settings,
    async (api) => {
      const view = await api.getConversation(conversation, { limit, before });
      const thread = isRecord(view.thread) ? view.thread : {};
      const messages = (Array.isArray(view.messages) ? view.messages : []).filter(isRecord);
      const where = words.clean(thread.channel) + (thread.isDirectMessage === false ? ", a group" : "");
      const head = [words.clean(thread.id) || conversation, people(thread), where, words.clean(thread.status)]
        .filter(Boolean)
        .join(" · ");
      const lines = [head, "", ...(messages.length ? messages.map(messageLine) : ["No messages."])];
      if (view.hasMore && messages.length) {
        lines.push(`\nOlder: call ${READ} with before: "${words.clean(messages[0]?.id)}".`);
      }
      return lines.join("\n");
    },
    fetchImpl,
  );
}

export async function resolve({ settings, place, args, fetch: fetchImpl }: ToolCall): Promise<string> {
  const named = words.clean(args.conversation).trim();
  const here = inAgentInbox(place) && place.chat ? place.chat.conversationId : "";
  const target = named || here;
  if (!target) throw new ToolError(`Name the conversation to resolve: its id, as ${CONVERSATIONS} lists it.`);
  const gateway = boundGateway(settings);
  if (target === here) {
    await run(
      settings,
      async (api, listening) => {
        // Any message into it would open it again, your answer too: it is resolved once you're done here.
        if (listening) listening.resolveAfterReply(here);
        else await api.resolveConversation(here);
      },
      fetchImpl,
    );
    return "This conversation is resolved once your answer here goes out. Its next message, from anyone, opens it again, in a fresh session.";
  }
  if (hasContactLimits(gateway, place)) throw new ToolError(words.CONTACT_RESOLVE_HERE_ONLY);
  if (operatorAsksFirst(gateway, place)) {
    throw new ToolError(
      "Only your operator can have you resolve another conversation: from their own chat, the Control UI, a " +
        "terminal, or a scheduled job.",
    );
  }
  await run(settings, (api) => api.resolveConversation(target), fetchImpl);
  return `Resolved ${target}. Its next message, from anyone, opens it again.`;
}

function contactLine(contact: Json, operator: string | null): string {
  const channels = (Array.isArray(contact.channels) ? contact.channels : [])
    .filter((channel): channel is Json => isRecord(channel) && Boolean(channel.via))
    .map((channel) => words.clean(channel.via) + (channel.isDefault ? " (default)" : ""));
  const parts = [words.clean(contact.id), nameOf(contact), words.clean(contact.email), channels.join(", ") || "no channel yet"];
  const isOperator = Boolean(contact.isOperator) || (operator !== null && contact.id === operator);
  parts.push(isOperator ? "your operator" : `listen to: ${contact.listenTo ? "on" : "off"}`);
  return parts.filter(Boolean).join(" · ");
}

export async function contacts({ settings, place, args, fetch: fetchImpl }: ToolCall): Promise<string> {
  if (hasContactLimits(boundGateway(settings), place)) throw new ToolError(words.CONTACT_NO_OTHERS);
  const limit = limitOf(args.limit, 50, 100);
  const after = words.clean(args.after).trim() || null;
  return run(
    settings,
    async (api, gateway) => {
      const { items, next } = await api.listContacts({ limit, after });
      if (!items.length) return after ? "No more contacts." : "No contacts yet: your operator adds them on agentinbox.md.";
      const lines = items.map((item) => contactLine(item, gateway?.operatorId ?? null));
      if (next) lines.push(`\nMore: call ${CONTACTS} with after: "${next}".`);
      return lines.join("\n");
    },
    fetchImpl,
  );
}

// --- what OpenClaw sees ---

/** `kind`, `options` and the Approve and Deny labels, as the CLI and the MCP server name them. */
function asking(kinds: Answer["kind"][], first: Answer["kind"]): Json {
  const said: Record<Answer["kind"], string> = {
    tell: "tell: just a message",
    ask: "ask: they answer in words",
    approve: "approve: Approve and Deny buttons",
    choose: "choose: one of `options`",
  };
  return {
    kind: {
      type: "string",
      enum: kinds,
      description: `${kinds.map((kind) => said[kind] + (kind === first ? " (default)" : "")).join(". ")}.`,
    },
    options: {
      anyOf: [{ type: "array", items: { type: "string" } }, { type: "string" }],
      description: "With `kind: choose`: 2 to 10 short options, as buttons to pick one from.",
    },
    approve_label: {
      type: "string",
      description: "With `kind: approve`: the Approve button's words, e.g. “Ship it”. Default Approve.",
    },
    deny_label: { type: "string", description: "With `kind: approve`: the Deny button's words, e.g. “Hold”. Default Deny." },
  };
}

const ASK_DESCRIPTION =
  "Ask your operator, the person you work for, and get their answer back: from a scheduled job, the Control UI, or " +
  "another app's chat, before you do something only your operator can decide. It returns at once; when your " +
  "operator answers, even hours later, the answer comes back to you. In your operator's own Agent Inbox chat, ask " +
  `them there with ${ASK_HERE} instead. Off in a contact's Agent Inbox conversation, unless they have full access.`;

const ASK_HERE_DESCRIPTION =
  "Ask the people in the Agent Inbox conversation you're in something, there, and wait for the answer: words (kind " +
  "ask), Approve or Deny (kind approve), or one of a few options (kind choose). It waits up to 5 minutes; without an " +
  "answer by then, the question stays open, and the answer comes to you in this chat when they give it. Only in an " +
  `Agent Inbox conversation; to ask your operator from anywhere else, use ${ASK_OPERATOR}.`;

const CARD_DESCRIPTION =
  "Introduce yourself with your Agent Inbox card: your name, your email address, and the link where anyone can " +
  "email or message you. Call it when someone asks you to introduce yourself, to show or share your card, or who " +
  "you are on Agent Inbox. Say the greeting it returns in your answer, then show the card with its link. Off in a " +
  "contact's Agent Inbox conversation, unless they have full access.";

const SEND_DESCRIPTION =
  "Write to your operator or to one of their contacts, in a new conversation on their usual channel. Your answer " +
  `in this chat already goes to the person here, and ${ASK_HERE} asks them something, so use this only for someone ` +
  "else. With `kind`, it asks a question, and the answer comes back to you in this chat. Off in a contact's Agent Inbox conversation, unless " +
  "they have full access: only your operator, and a contact they gave full access, have you write to other people.";

const RESOLVE_DESCRIPTION =
  "Mark an Agent Inbox conversation finished, once what it was about is done and nothing is left to answer, as a " +
  "support desk closes a ticket. Nothing is sent. The conversation you're in is marked once your answer here goes " +
  "out; its next message, from anyone, opens it again and starts a fresh session. Another conversation, by its " +
  "id, only in your operator's own chat or a full-access contact's, at the terminal, or in a scheduled job.";

export type ToolSpec = {
  name: string;
  label: string;
  description: string;
  parameters: Json;
  run: (call: ToolCall) => Promise<string>;
};

function schema(properties: Json, requiredNames: string[] = []): Json {
  const parameters: Json = { type: "object", properties, additionalProperties: false };
  if (requiredNames.length) parameters.required = requiredNames;
  return parameters;
}

export const TOOLS: ToolSpec[] = [
  {
    name: ASK_OPERATOR,
    label: "Ask your operator",
    description: ASK_DESCRIPTION,
    parameters: schema(
      {
        question: {
          type: "string",
          description:
            "What to ask, as your operator should read it: say who wants what, e.g. “Ben asks for a 10% discount on his order. OK?”",
        },
        ...asking(["ask", "approve", "choose"], "ask"),
      },
      ["question"],
    ),
    run: askOperator,
  },
  {
    name: ASK_HERE,
    label: "Ask in this conversation",
    description: ASK_HERE_DESCRIPTION,
    parameters: schema(
      {
        question: { type: "string", description: "What to ask, as the people here should read it, e.g. “Deploy to staging?”" },
        ...asking(["ask", "approve", "choose"], "ask"),
      },
      ["question"],
    ),
    run: askHere,
  },
  {
    name: CARD,
    label: "Show the agent card",
    description: CARD_DESCRIPTION,
    parameters: schema({}),
    run: card,
  },
  {
    name: SEND,
    label: "Write to someone",
    description: SEND_DESCRIPTION,
    parameters: schema(
      {
        to: { type: "string", description: `“operator”, or a contact's id, email or name, as ${CONTACTS} lists them.` },
        text: { type: "string", description: "The message, as they should read it." },
        ...asking(["tell", "ask", "approve", "choose"], "tell"),
      },
      ["to", "text"],
    ),
    run: send,
  },
  {
    name: CONVERSATIONS,
    label: "Agent Inbox conversations",
    description: `List the agent's conversations, latest first: the id, who is in it, the channel, and the last message. ${READ} shows one in full. Off in a contact's Agent Inbox conversation, unless they have full access.`,
    parameters: schema({
      unread_only: { type: "boolean", description: "Only conversations with messages nobody read yet." },
      status: { type: "string", enum: ["open", "resolved", "all"], description: "Default all." },
      limit: { type: "integer", description: "How many, 1 to 50 (default 20)." },
      after: { type: "string", description: "The cursor from a previous call, for the next page." },
    }),
    run: conversations,
  },
  {
    name: READ,
    label: "Read a conversation",
    description:
      "Read one conversation's latest messages, oldest first, with who wrote each. It doesn't mark the conversation " +
      "read. In a contact's Agent Inbox conversation, only that conversation, unless they have full access.",
    parameters: schema(
      {
        conversation: { type: "string", description: `The conversation's id, as ${CONVERSATIONS} lists it.` },
        limit: { type: "integer", description: "How many messages, 1 to 100 (default 20)." },
        before: { type: "string", description: "A message id, for the messages before it." },
      },
      ["conversation"],
    ),
    run: read,
  },
  {
    name: CONTACTS,
    label: "Agent Inbox contacts",
    description: `List your operator's contacts: the id to use as \`to\` in ${SEND}, the name, email and channels, and whether you listen to them (whether their messages reach you). Off in a contact's Agent Inbox conversation, unless they have full access.`,
    parameters: schema({
      limit: { type: "integer", description: "How many, 1 to 100 (default 50)." },
      after: { type: "string", description: "The cursor from a previous call, for the next page." },
    }),
    run: contacts,
  },
  {
    name: RESOLVE,
    label: "Resolve a conversation",
    description: RESOLVE_DESCRIPTION,
    parameters: schema({
      conversation: {
        type: "string",
        description: `Another conversation's id, as ${CONVERSATIONS} lists it. Leave it out for the conversation you're in.`,
      },
    }),
    run: resolve,
  },
];

/** A tool's result as the model reads it: the text, or the refusal; OpenClaw marks a refusal as a failed call. */
export async function runTool(spec: ToolSpec, call: ToolCall): Promise<{ text: string; ok: boolean }> {
  try {
    return { text: await spec.run(call), ok: true };
  } catch (error) {
    if (error instanceof ToolError) return { text: error.message, ok: false };
    if (error instanceof ApiError) return { text: failure(error), ok: false };
    throw error;
  }
}

export { readSettings };
