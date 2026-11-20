// Agent Inbox as a channel of OpenClaw's gateway, apart from OpenClaw's own types. Each conversation is a session, and a
// fresh one once it is resolved, or once a contact's full access is turned on or off; OpenClaw's answer is the reply in
// it; OpenClaw's approval prompts go to the operator as Allow and Deny buttons, or to a contact with full access for a
// run of their own, and its questions to the person in the conversation. A question OpenClaw asks with its tools gets
// its answer back in the chat that asked, as a message there.
import { type AgentInboxApi, ApiError, type Json } from "./api.js";
import { Listener, type Logger, StopForGood, type Timing, silentLogger } from "./listener.js";
import { HOST_NAME, type Settings } from "./settings.js";
import {
  type Chat,
  type ConversationLevel,
  FIRST_LEVEL,
  type Starter,
  type StateStore,
  type WaitingQuestion,
  remember,
  setLevel,
  waitFor,
} from "./state.js";
import * as words from "./words.js";

// The id of the extra button on an approval card: OpenClaw's `allow-always`, which this plugin keeps for the session
// only. For a command it would write OpenClaw's own allowlist, which the operator does at OpenClaw itself, so it is
// offered only for the plugin's own send tool.
export const ALLOW_FOR_SESSION = "session";

// How long a question to a person waits for the answer.
export const QUESTION_TTL_SECONDS = 10 * 60;

// How long agentinbox_ask_here waits for the answer within its call. A later answer comes into the chat as a message.
export const ASK_HERE_WAIT_MS = 5 * 60_000;

// How often an open card's answer is looked up, when it didn't come with the messages.
export const ANSWER_POLL_MS = 5_000;

// How often the answers to OpenClaw's own questions are looked up: a contact the agent doesn't listen to answers only
// where the plugin looks.
export const WAITING_POLL_MS = 20_000;

// What a contact may still type as a command in their own conversation: stopping the run there.
export const CONTACT_COMMANDS = ["/stop"];

// How often "typing…" is shown again while OpenClaw works, and for how long at most.
export const TYPING_EVERY_MS = 4_000;
export const TYPING_MOST_MS = 10 * 60_000;

// When OpenClaw resolves the conversation it works in, how long it must be quiet there first: any message into a
// conversation opens it again, OpenClaw's own answer too, and OpenClaw refreshes its typing every few seconds while it
// works.
export const RESOLVE_QUIET_MS = 10_000;

export type ApprovalKind = "exec" | "plugin";
export type ApprovalDecision = "allow-once" | "allow-always" | "deny";

export type Sender = { id: string; name: string; isOperator: boolean };

/** One message as OpenClaw gets it: in which chat and session, from whom, and what it may run. */
export type InboundTurn = {
  chat: Chat;
  sessionKey: string;
  messageId: string;
  timestamp: number;
  sender: Sender;
  channel: string;
  rawText: string;
  bodyForAgent: string;
  // What OpenClaw may parse as a command: the text for the operator's commands and a contact's /stop, else "".
  commandBody: string;
  commandAuthorized: boolean;
};

/** What OpenClaw's gateway does for the plugin. */
export interface GatewayHost {
  /** The session a conversation runs in, for its round and a contact's level (`sessionThread`). */
  sessionKeyFor(chat: Chat): string;
  /** Hands one message to OpenClaw as a turn in that session; its replies come back through `deliver`. */
  dispatch(turn: InboundTurn): Promise<void>;
  /** Settles an approval OpenClaw waits on. */
  resolveApproval(approvalId: string, kind: ApprovalKind, decision: ApprovalDecision): Promise<void>;
}

/** A reply from OpenClaw: text, or a question with options from its ask_user tool. */
export type Reply = {
  text: string;
  question?: { text: string; options: string[]; multiple: boolean } | null;
};

type PendingApproval = {
  kind: "approval";
  approvalId: string;
  approvalKind: ApprovalKind;
  sessionKey: string;
  allowForSession: boolean;
  recipientId: string | null;
  // The contact with full access the card went to, or null when it went to the operator.
  approver: string | null;
};

/** Who answers the approvals of a full-access contact's run: that contact, in their own conversation. */
export type Approver = { id: string; conversationId: string };

type PendingQuestion = {
  kind: "question";
  chat: Chat;
  sessionKey: string;
  options: Record<string, string>;
};

type Pending = PendingApproval | PendingQuestion;

/** An answer agentinbox_ask_here got while it waited: what it asked, and what came back. */
export type HereOutcome = { question: WaitingQuestion; status: string; picked: string | null; text: string | null };

/** Whom OpenClaw's send tool writes to, and what, for the card its approval asks the operator with. */
export type Write = { name: string; text: string; recipientId: string; sessionKey: string };

/**
 * What the plugin keeps of the message that started a chat. Not its full access: that is the conversation's level,
 * kept on its own (`State.levels`), and the chat's session's (`Chat.fullAccess`).
 */
export function starterKept(message: words.ListenMessage | Starter | null | undefined): Starter | null {
  if (!message) return null;
  const sender = message.from ?? {};
  return {
    from: {
      id: sender.id ? String(sender.id) : null,
      name: sender.name ? String(sender.name) : null,
      isOperator: Boolean(sender.isOperator),
    },
    channel: words.clean(message.channel),
    text: words.clean(message.text).slice(0, 200),
  };
}

/** The chat a message belongs to: its conversation, its round, and who wrote it. */
export function chatOf(message: words.ListenMessage, starter: Starter | null): Chat {
  const sender = message.from ?? {};
  const conversation = String(message.conversationId);
  const round = Number(message.round);
  return {
    conversationId: conversation,
    round: Number.isInteger(round) && round > 0 ? round : 0,
    isDirect: message.isDirectMessage !== false,
    userId: sender.id ? String(sender.id) : null,
    userName: words.clean(sender.name) || null,
    chatName: words.clean(sender.name) || conversation,
    starter,
  };
}

/** Whether a full-access contact's Allow still counts: it came from them, with their full access still on. */
function stillHasFullAccess(approver: string, from: words.ListenMessage["from"]): boolean {
  return String(from?.id ?? "") === approver && words.hasFullAccess(from);
}

/** A contact's own direct chat, whose level can change: never the operator's own, nor a group. */
function changesLevel(chat: Chat): boolean {
  return chat.isDirect && !chat.starter?.from.isOperator;
}

/** Whether an interaction is past its time, as Agent Inbox says. */
function expired(interaction: Json): boolean {
  const at = Date.parse(String(interaction.expiresAt ?? ""));
  return !Number.isNaN(at) && at <= Date.now();
}

/**
 * Where an answer goes when OpenClaw asked outside an Agent Inbox chat (the Control UI, a scheduled job): the
 * question's own conversation, the person asked in it.
 */
export function conversationChat(question: WaitingQuestion): Chat | null {
  if (!question.conversation) return null;
  return {
    conversationId: question.conversation,
    round: 0,
    isDirect: true,
    userId: question.to || null,
    userName: null,
    chatName: question.conversation,
    starter: {
      from: { id: question.to || null, name: question.toName || null, isOperator: Boolean(question.toOperator) },
      channel: "",
      text: "",
    },
  };
}

export class AgentInboxGateway {
  readonly settings: Settings;
  readonly api: AgentInboxApi;
  readonly listener: Listener;
  readonly computerName: string;
  private readonly host: GatewayHost;
  private readonly log: Logger;
  private readonly answerPollMs: number;
  private readonly waitingPollMs: number;
  private readonly askWaitMs: number;
  private waitingPolledAt = 0;
  private readonly pending = new Map<string, Pending>();
  // Each conversation's latest message, which the cards of its run name: "For Ben's message on Telegram".
  private readonly latest = new Map<string, words.ListenMessage | Starter>();
  // Each session's chat, by session key.
  private readonly chats = new Map<string, Chat>();
  // What the send tool asked to write, by tool call and by session, for the card its approval shows next.
  private readonly writes = new Map<string, Write>();
  // "Allow for this session": whom OpenClaw may write to again in a session without asking.
  private readonly grants = new Set<string>();
  // The card each approval was asked with, to withdraw it when OpenClaw settles the approval another way.
  private readonly approvalCards = new Map<string, string>();
  // The agentinbox_ask_here calls still waiting for their question's answer, by question: its conversation, and how
  // to end the wait.
  private readonly asking = new Map<string, { conversationId: string; settle: (outcome: HereOutcome | null) => void }>();
  // The conversations OpenClaw resolved, each with its wait for OpenClaw to be quiet there.
  private readonly resolving = new Map<string, ReturnType<typeof setTimeout> | null>();
  private readonly resolveQuietMs: number;
  private polling: Promise<void> | null = null;
  private stopped = false;

  constructor(options: {
    settings: Settings;
    api: AgentInboxApi;
    store: StateStore;
    computerName: string;
    host: GatewayHost;
    log?: Logger;
    timing?: Partial<Timing>;
    answerPollMs?: number;
    waitingPollMs?: number;
    askWaitMs?: number;
    resolveQuietMs?: number;
    clock?: () => number;
    sleep?: (ms: number) => Promise<void>;
    signal?: AbortSignal;
    onListening?: (listening: boolean) => void;
  }) {
    this.settings = options.settings;
    this.api = options.api;
    this.computerName = options.computerName;
    this.host = options.host;
    this.log = options.log ?? silentLogger;
    this.answerPollMs = options.answerPollMs ?? ANSWER_POLL_MS;
    this.waitingPollMs = options.waitingPollMs ?? WAITING_POLL_MS;
    this.askWaitMs = options.askWaitMs ?? ASK_HERE_WAIT_MS;
    this.resolveQuietMs = options.resolveQuietMs ?? RESOLVE_QUIET_MS;
    this.listener = new Listener({
      api: options.api,
      store: options.store,
      settings: options.settings,
      computerName: options.computerName,
      onMessage: (message) => this.onMessage(message),
      onAnswer: (message) => this.onAnswer(message),
      timing: options.timing,
      clock: options.clock,
      sleep: options.sleep,
      log: this.log,
      signal: options.signal,
      onListening: options.onListening,
    });
  }

  get operatorId(): string | null {
    return this.listener.operatorId;
  }

  // --- lifecycle ---

  /** Listens until aborted. Resolves with the reason when it stops for good: a Deny, a new key, another computer. */
  async run(): Promise<StopForGood | null> {
    if (Object.keys(this.listener.state.waiting).length) this.startPolling();
    try {
      await this.listener.run();
      return null;
    } catch (error) {
      if (error instanceof StopForGood) {
        this.log.warn(`[Agent Inbox] ${error.message}`);
        return error;
      }
      throw error;
    }
  }

  async stop(): Promise<void> {
    this.stopped = true;
    // OpenClaw resolved these and is stopping: resolve them now, or they'd stay open.
    for (const conversation of [...this.resolving.keys()]) await this.resolveNow(conversation);
    for (const [interactionId, pending] of [...this.pending]) {
      this.pending.delete(interactionId);
      if (pending.kind === "approval") this.approvalCards.delete(pending.approvalId);
      await this.withdraw(interactionId);
    }
    for (const waiting of [...this.asking.values()]) waiting.settle(null);
    await this.listener.close();
  }

  // --- inbound ---

  private async onMessage(message: words.ListenMessage): Promise<void> {
    const conversation = String(message.conversationId);
    const sender = message.from ?? {};
    const text = words.clean(message.text).trim();
    const first = text ? (text.split(/\s+/, 1)[0] ?? "").toLowerCase() : "";
    // The operator owns this OpenClaw: their commands work here as in any chat of theirs. A contact may only stop the
    // run in their own conversation; anything else they type is a message, and can't answer a prompt.
    const control = Boolean(sender.isOperator) || CONTACT_COMMANDS.includes(first);
    const command = control && text.startsWith("/");
    if (!command) {
      this.latest.set(conversation, message);
      // Someone wrote before OpenClaw's resolve went through: the conversation goes on.
      this.keepOpen(conversation);
      // A question OpenClaw waits on here stops waiting: what they wrote reaches OpenClaw as it is, and an answer still
      // to come does too, as a message.
      this.stopWaitingIn(conversation);
    }
    const written = chatOf(message, starterKept(this.latest.get(conversation) ?? message));
    // A contact's message sets their conversation's level; a command only goes to the session the run is in.
    if (!command) await this.takeLevel(written, message);
    const chat = this.atLevel(written);
    // `/stop` in a conversation: its open questions come off people's phones. OpenClaw cancels the run's approvals
    // itself, and their cards come off with them.
    if (command && first === "/stop") {
      await this.withdrawQuestions(this.host.sessionKeyFor(chat));
      for (const questionId of this.stopWaitingIn(conversation)) await this.withdraw(questionId);
    }
    const at = Date.parse(String(message.at ?? ""));
    this.dispatch({
      chat,
      sessionKey: this.host.sessionKeyFor(chat),
      messageId: String(message.id),
      timestamp: Number.isNaN(at) ? Date.now() : at,
      sender: { id: String(sender.id ?? ""), name: words.clean(sender.name), isOperator: Boolean(sender.isOperator) },
      channel: words.clean(message.channel),
      rawText: text,
      bodyForAgent: command ? text : words.messageForHost(message),
      commandBody: command ? text : "",
      commandAuthorized: command,
    });
  }

  /** Starts the turn without waiting for it: the listener goes on, so an approval's answer can reach the turn. */
  private dispatch(turn: InboundTurn): void {
    this.chats.set(turn.sessionKey, turn.chat);
    void this.host.dispatch(turn).catch((error: unknown) => {
      this.log.error(`[Agent Inbox] Couldn't hand message ${turn.messageId} to ${HOST_NAME}: ${String(error)}`);
    });
  }

  // --- a contact's level ---

  /** A contact's direct conversation's level now: full access or not, and how many times it changed. */
  private levelOf(conversationId: string): ConversationLevel {
    return this.listener.state.levels?.[conversationId] ?? FIRST_LEVEL;
  }

  /**
   * A contact's message in their own direct chat sets the conversation's level, as its full access says. When that
   * changes, this message starts a fresh session at the new level, kept for after a restart too, and the approval
   * cards still waiting on the conversation's earlier sessions come off, each a Deny for OpenClaw.
   */
  private async takeLevel(chat: Chat, message: words.ListenMessage): Promise<void> {
    if (!changesLevel(chat)) return;
    const fullAccess = words.hasFullAccess(message.from);
    const level = this.levelOf(chat.conversationId);
    if (level.fullAccess === fullAccess) return;
    setLevel(this.listener.state, chat.conversationId, { fullAccess, changes: level.changes + 1 });
    this.listener.save();
    this.log.info(
      `[Agent Inbox] ${chat.conversationId} is ${fullAccess ? "at full access" : "back to a contact's limits"} now: ` +
        "it goes on in a fresh session.",
    );
    await this.withdrawApprovals(chat.conversationId);
  }

  /** A chat at its conversation's level now, which names its session. The operator's own chat and groups have none. */
  private atLevel(chat: Chat): Chat {
    if (!changesLevel(chat)) return chat;
    const level = this.levelOf(chat.conversationId);
    return { ...chat, fullAccess: level.fullAccess, levelChanges: level.changes };
  }

  /**
   * Whether a full-access session can't go on for an answer from its contact: their answer, or their conversation
   * since, shows their full access off.
   */
  private fullAccessEnded(chat: Chat, from: words.ListenMessage["from"]): boolean {
    return Boolean(chat.fullAccess) && !(words.hasFullAccess(from) && this.levelOf(chat.conversationId).fullAccess);
  }

  /**
   * An answer to one of the plugin's open cards resolves what OpenClaw waits on, and starts nothing. One to a question
   * OpenClaw asked with its tools goes to the chat that asked.
   */
  private async onAnswer(message: words.ListenMessage): Promise<boolean> {
    const answers = String(message.answersMessageId ?? "");
    const answer = message.answer ?? {};
    const status = String(answer.status ?? "answered");
    const optionId = answer.optionId ? String(answer.optionId) : null;
    const text = words.clean(answer.text ?? message.text) || null;
    const pending = this.pending.get(answers);
    if (pending) {
      this.pending.delete(answers);
      // An answer goes on in the session that asked, at its level. A full-access session doesn't, once the contact's
      // full access is off: their answer is then their next message, which goes on at the level it shows, in a fresh
      // session.
      if (pending.kind === "question" && this.fullAccessEnded(pending.chat, message.from)) {
        await this.onMessage(message);
        return true;
      }
      await this.resolve(pending, status, optionId, text, message.from ?? null);
      return true;
    }
    if (answers in this.listener.state.waiting) {
      await this.answered(answers, status, optionId, text);
      return true;
    }
    return false;
  }

  private async resolve(
    pending: Pending,
    status: string,
    optionId: string | null,
    text: string | null,
    from: words.ListenMessage["from"],
  ): Promise<void> {
    if (pending.kind === "approval") {
      this.approvalCards.delete(pending.approvalId);
      let decision: ApprovalDecision | null = null;
      if (status === "approved") {
        decision = pending.allowForSession && optionId === ALLOW_FOR_SESSION ? "allow-always" : "allow-once";
        // A contact's Allow counts only while their operator still gives them full access, as the message with it says.
        if (pending.approver && !stillHasFullAccess(pending.approver, from)) {
          this.log.warn(`[Agent Inbox] ${pending.approver} allowed ${pending.approvalId} without full access: denied.`);
          decision = "deny";
        }
      } else if (status === "denied" || (status === "answered" && text)) {
        // Words instead of a button aren't an Allow.
        decision = "deny";
      }
      // Expired or withdrawn: OpenClaw's own wait ends with the same timeout, as a Deny.
      if (!decision) return;
      if (decision === "allow-always" && pending.recipientId) this.grantSession(pending.sessionKey, pending.recipientId);
      try {
        await this.host.resolveApproval(pending.approvalId, pending.approvalKind, decision);
      } catch (error) {
        this.log.error(`[Agent Inbox] Couldn't settle approval ${pending.approvalId}: ${String(error)}`);
      }
      return;
    }
    if (status !== "answered" && status !== "approved" && status !== "denied") return;
    // A question's Approve and Deny buttons answer with their labels, as its options do.
    const button = status === "approved" ? "approve" : status === "denied" ? "deny" : "";
    const response = (optionId ? pending.options[optionId] : undefined) ?? pending.options[button] ?? text;
    if (!response) return;
    // OpenClaw takes a plain reply from the person asked as the answer to its open question.
    const sender = from ?? {};
    this.dispatch({
      chat: pending.chat,
      sessionKey: pending.sessionKey,
      messageId: `answer:${Date.now()}`,
      timestamp: Date.now(),
      sender: {
        id: String(sender.id ?? pending.chat.userId ?? ""),
        name: words.clean(sender.name ?? pending.chat.userName),
        isOperator: Boolean(sender.isOperator),
      },
      channel: "",
      rawText: response,
      bodyForAgent: response,
      commandBody: "",
      commandAuthorized: false,
    });
  }

  // --- outbound ---

  /** OpenClaw's reply in a conversation: a message, or its question as buttons. */
  async deliver(chat: Chat, sessionKey: string, reply: Reply): Promise<string | null> {
    if (reply.question) {
      const card = words.questionCard(reply.question.text, reply.question.options, reply.question.multiple);
      let options: Record<string, string> = {};
      let content: Json;
      if (card.kind === "approve") {
        // Each button answers with its own label, as a pick among the options would.
        options = { approve: card.approveLabel, deny: card.denyLabel };
        content = { title: card.title, approveLabel: card.approveLabel, denyLabel: card.denyLabel };
      } else if (card.kind === "choose") {
        card.options.forEach((label, index) => {
          options[`opt_${index + 1}`] = label;
        });
        content = { title: card.title, options: Object.entries(options).map(([id, label]) => ({ id, label })) };
      } else {
        content = { title: card.title, ...(card.body ? { body: card.body } : {}) };
      }
      const asked = await this.api.createInteraction({
        kind: card.kind,
        card: content,
        thread: chat.conversationId,
        ttlSeconds: QUESTION_TTL_SECONDS,
      });
      this.watch(String(asked.id), { kind: "question", chat, sessionKey, options });
      this.sentInto(chat.conversationId);
      return String(asked.id ?? "") || null;
    }
    const text = reply.text.trim();
    if (!text) return null;
    const sent = await this.api.createInteraction({
      kind: "tell",
      card: { title: words.clipCard(text) },
      thread: chat.conversationId,
    });
    this.sentInto(chat.conversationId);
    return String(sent.id ?? "") || null;
  }

  /** "Typing…" in the conversation while OpenClaw works. A courtesy: the reply still goes out without it. */
  async showTyping(conversationId: string): Promise<void> {
    this.sentInto(conversationId);
    if (!this.listener.holding) return;
    try {
      await this.api.showTyping(this.listener.computerId, conversationId);
    } catch {
      // ignored
    }
  }

  // --- resolving ---

  /**
   * OpenClaw resolved the conversation it works in. Any message into it would open it again, OpenClaw's answer too,
   * so it is resolved once OpenClaw has been quiet there for a moment: no typing, no reply. A message from someone
   * there first keeps it open.
   */
  resolveAfterReply(conversationId: string): void {
    this.resolving.set(conversationId, null);
    this.sentInto(conversationId);
  }

  /** Something went into the conversation, or OpenClaw is still at work in it: its resolve waits a while longer. */
  sentInto(conversationId: string): void {
    if (!this.resolving.has(conversationId)) return;
    const waiting = this.resolving.get(conversationId);
    if (waiting) clearTimeout(waiting);
    const timer = setTimeout(() => void this.resolveNow(conversationId), this.resolveQuietMs);
    timer.unref?.();
    this.resolving.set(conversationId, timer);
  }

  /** Whether a resolve of this conversation waits for OpenClaw to be quiet there. */
  willResolve(conversationId: string): boolean {
    return this.resolving.has(conversationId);
  }

  /** OpenClaw's reply there didn't go out: the conversation stays open, as the person never got its answer. */
  replyFailed(conversationId: string): void {
    if (!this.resolving.has(conversationId)) return;
    this.keepOpen(conversationId);
    this.log.warn(`[Agent Inbox] Left ${conversationId} open, as ${HOST_NAME}'s reply there didn't go out.`);
  }

  private keepOpen(conversationId: string): void {
    const waiting = this.resolving.get(conversationId);
    if (waiting) clearTimeout(waiting);
    this.resolving.delete(conversationId);
  }

  private async resolveNow(conversationId: string): Promise<void> {
    if (!this.resolving.has(conversationId)) return;
    const waiting = this.resolving.get(conversationId);
    if (waiting) clearTimeout(waiting);
    this.resolving.delete(conversationId);
    try {
      await this.api.resolveConversation(conversationId);
      this.log.info(`[Agent Inbox] Resolved ${conversationId}, as ${HOST_NAME} asked.`);
    } catch (error) {
      this.log.warn(`[Agent Inbox] Couldn't resolve ${conversationId}: ${String(error)}`);
    }
  }

  // --- approvals ---

  /**
   * Asks the operator, on their own channel, whoever's message started the run; or, for a run a full-access contact's
   * message started (`approver`), that contact, in their own conversation, where only they may answer. Returns the
   * card's id, or null when nobody could be asked: the approval is then denied, never posted as a plain message instead.
   */
  async askApproval(options: {
    approvalId: string;
    approvalKind: ApprovalKind;
    sessionKey: string;
    title: string;
    body: string;
    allowForSession: boolean;
    recipientId?: string | null;
    approver?: Approver | null;
    ttlSeconds: number;
  }): Promise<string | null> {
    const approver = options.approver ?? null;
    const operator = this.operatorId;
    if (this.stopped || (!approver && !operator)) return null;
    const who = approver ? approver.id : "the operator";
    const buttons: Json = { approveLabel: "Allow", denyLabel: "Deny" };
    if (options.allowForSession) buttons.extraActions = [{ id: ALLOW_FOR_SESSION, label: "Allow for this session" }];
    let asked: Json;
    try {
      asked = await this.api.createInteraction({
        kind: "approve",
        card: { title: options.title, body: options.body, ...buttons },
        ...(approver ? { thread: approver.conversationId, to: approver.id } : { to: operator }),
        from: HOST_NAME,
        // A late tap can't allow what OpenClaw already took as a Deny: the card expires with its wait.
        ttlSeconds: Math.max(60, Math.round(options.ttlSeconds)),
      });
    } catch (error) {
      this.log.error(`[Agent Inbox] Couldn't ask ${who} (${String(error)}): denied.`);
      return null;
    }
    const id = String(asked.id ?? "");
    if (!id) return null;
    // The card went into the conversation, which opens it again: a resolve there waits.
    if (approver) this.sentInto(approver.conversationId);
    this.approvalCards.set(options.approvalId, id);
    this.watch(id, {
      kind: "approval",
      approvalId: options.approvalId,
      approvalKind: options.approvalKind,
      sessionKey: options.sessionKey,
      allowForSession: options.allowForSession,
      recipientId: options.recipientId ?? null,
      approver: approver?.id ?? null,
    });
    this.log.info(`[Agent Inbox] Asked ${who}: ${words.clean(options.title).slice(0, 200)}`);
    return id;
  }

  /** Settles an approval for OpenClaw: a Deny when the operator couldn't be asked. */
  async settleApproval(approvalId: string, kind: ApprovalKind, decision: ApprovalDecision): Promise<void> {
    try {
      await this.host.resolveApproval(approvalId, kind, decision);
    } catch (error) {
      this.log.error(`[Agent Inbox] Couldn't settle approval ${approvalId}: ${String(error)}`);
    }
  }

  /** OpenClaw settled an approval another way (in time, elsewhere, or not at all): its card comes off the phone. */
  async approvalSettled(approvalId: string): Promise<void> {
    const interactionId = this.approvalCards.get(approvalId);
    if (!interactionId) return;
    this.approvalCards.delete(approvalId);
    if (this.pending.delete(interactionId)) await this.withdraw(interactionId);
  }

  // --- what OpenClaw's tools and approvals ask of the gateway ---

  /** The chat a session runs for, as this gateway started it; null before any message came for it. */
  chatForSession(sessionKey: string): Chat | null {
    return this.chats.get(sessionKey) ?? null;
  }

  /** The message that started this conversation's run, as its cards name it. */
  starterOf(conversationId: string): words.ListenMessage | Starter | null {
    return this.latest.get(conversationId) ?? null;
  }

  starterForSession(sessionKey: string | null | undefined): words.ListenMessage | Starter | null {
    const chat = sessionKey ? this.chats.get(sessionKey) : undefined;
    return chat ? this.starterOf(chat.conversationId) ?? chat.starter : null;
  }

  /**
   * The contact a chat's run has full access for, or null: a contact's own direct chat whose session started at full
   * access, while their conversation is still at it. Once their message, or their answer, shows the switch off, the
   * run has a contact's limits, and their next message goes on in a fresh session. A session that started at a
   * contact's limits keeps them, and a group never has full access.
   */
  fullAccessFor(chat: Chat | null | undefined): string | null {
    if (!chat?.isDirect || !chat.fullAccess || !chat.userId) return null;
    return this.levelOf(chat.conversationId).fullAccess ? chat.userId : null;
  }

  /** Who answers the approvals a session's run needs: its full-access contact, or null for the operator. */
  approverFor(sessionKey: string | null | undefined): Approver | null {
    const chat = sessionKey ? this.chats.get(sessionKey) : undefined;
    const contact = this.fullAccessFor(chat);
    return chat && contact ? { id: contact, conversationId: chat.conversationId } : null;
  }

  /** Whom the send tool writes to, and what, for the card its approval shows the operator next. */
  askBeforeWrite(keys: readonly string[], write: Write): void {
    for (const key of keys) if (key) this.writes.set(key, write);
    if (this.writes.size > 200) {
      for (const key of [...this.writes.keys()].slice(0, this.writes.size - 200)) this.writes.delete(key);
    }
  }

  writeFor(keys: readonly (string | null | undefined)[]): Write | null {
    for (const key of keys) {
      const found = key ? this.writes.get(key) : undefined;
      if (found) return found;
    }
    return null;
  }

  grantSession(sessionKey: string, recipientId: string): void {
    if (sessionKey && recipientId) this.grants.add(`${sessionKey}\n${recipientId}`);
  }

  hasGrant(sessionKey: string, recipientId: string): boolean {
    return Boolean(sessionKey) && this.grants.has(`${sessionKey}\n${recipientId}`);
  }

  /**
   * A question OpenClaw asked with its tools: its answer comes back to the chat that asked, also after a restart.
   */
  expectAnswer(question: WaitingQuestion): void {
    waitFor(this.listener.state, question);
    this.listener.save();
    this.startPolling();
  }

  /** The id of the latest message in this conversation; "" before any came here. */
  latestIdIn(conversationId: string): string {
    const latest = this.latest.get(conversationId) as { id?: unknown } | undefined;
    return String(latest?.id ?? "");
  }

  /**
   * agentinbox_ask_here waits for its question's answer, for 5 minutes at most, or until OpenClaw stops the call: while
   * it waits, the answer is the call's result instead of a message in the chat. Null when none came. Not when someone
   * wrote there after `since`, while it asked: that message ends the wait as any later one would.
   */
  waitHere(questionId: string, conversationId: string, since: string, signal?: AbortSignal): Promise<HereOutcome | null> {
    if (this.latestIdIn(conversationId) !== since) return Promise.resolve(null);
    return new Promise((resolve) => {
      const settle = (outcome: HereOutcome | null) => {
        clearTimeout(timer);
        signal?.removeEventListener("abort", stop);
        this.asking.delete(questionId);
        resolve(outcome);
      };
      const stop = () => settle(null);
      const timer = setTimeout(stop, this.askWaitMs);
      this.asking.set(questionId, { conversationId, settle });
      if (signal?.aborted) stop();
      else signal?.addEventListener("abort", stop, { once: true });
    });
  }

  /** The calls waiting in a conversation stop waiting; the questions they asked, by id. */
  private stopWaitingIn(conversationId: string): string[] {
    const stopped = [...this.asking].filter(([, waiting]) => waiting.conversationId === conversationId);
    for (const [, waiting] of stopped) waiting.settle(null);
    return stopped.map(([questionId]) => questionId);
  }

  private async answered(questionId: string, status: string, optionId: string | null, text: string | null): Promise<void> {
    const question = this.listener.state.waiting[questionId];
    if (!question) return;
    delete this.listener.state.waiting[questionId];
    // Its answer reached OpenClaw: another one, or the same coming with the messages later, starts nothing.
    remember(this.listener.state, "own", questionId);
    this.listener.save();
    const picked = optionId ? question.options?.[optionId] ?? null : null;
    // The chat that asked, in its own session; asked from elsewhere, the asked person's conversation at its level now.
    const elsewhere = question.chat ? null : conversationChat(question);
    const chat = question.chat ?? (elsewhere ? this.atLevel(elsewhere) : null);
    // A full-access session doesn't go on once the contact's full access is off, and nothing from it goes into
    // another session: what someone answered it is left out.
    const accessEnded = Boolean(chat?.fullAccess && !this.levelOf(chat.conversationId).fullAccess);
    const waiting = this.asking.get(questionId);
    // The call that asked still waits for it: the answer is its result.
    waiting?.settle(accessEnded ? null : { question, status, picked, text });
    if (waiting && !accessEnded) return;
    const note = status === "canceled" ? null : words.answerNote(question, status, { picked, text });
    if (!note || !chat) return;
    if (accessEnded) {
      this.log.info(`[Agent Inbox] Left ${questionId}'s answer out of ${chat.conversationId}: its full access is off since.`);
      return;
    }
    this.tellHost(chat, note, `${questionId}:answer`);
  }

  /** A message to OpenClaw in one of its Agent Inbox chats, from the plugin itself: it can run no command. */
  tellHost(chat: Chat, text: string, messageId: string): void {
    if (chat.starter && !this.latest.has(chat.conversationId)) {
      // After a restart: whose chat this is stays known, for what OpenClaw may do next in it.
      this.latest.set(chat.conversationId, chat.starter);
    }
    const from = chat.starter?.from;
    this.dispatch({
      chat,
      sessionKey: this.host.sessionKeyFor(chat),
      messageId,
      timestamp: Date.now(),
      sender: {
        id: String(chat.userId ?? from?.id ?? ""),
        name: words.clean(chat.userName ?? from?.name),
        isOperator: Boolean(from?.isOperator),
      },
      channel: chat.starter?.channel ?? "",
      rawText: text,
      bodyForAgent: text,
      commandBody: "",
      commandAuthorized: false,
    });
  }

  /**
   * Whether a send OpenClaw starts by itself (its message tool, a scheduled job) may go into a conversation: not
   * from a contact's chat, or a group, into another conversation, since only the operator has OpenClaw write to other
   * people, from their own chat, and so does a contact with full access, from theirs.
   */
  mayWriteInto(conversationId: string, sourceSessionKey: string | null | undefined): boolean {
    const chat = sourceSessionKey ? this.chats.get(sourceSessionKey) : undefined;
    if (!chat || chat.conversationId === conversationId) return true;
    if (!chat.isDirect) return false;
    const starter = this.starterOf(chat.conversationId) ?? chat.starter;
    return Boolean(starter?.from?.isOperator) || this.fullAccessFor(chat) !== null;
  }

  // --- open cards ---

  private watch(interactionId: string, pending: Pending): void {
    this.pending.set(interactionId, pending);
    this.listener.rememberOwn(interactionId);
    this.startPolling();
  }

  private startPolling(): void {
    if (this.polling || this.stopped) return;
    this.polling = this.pollAnswers()
      .catch((error: unknown) => {
        this.log.warn(`[Agent Inbox] Looking up answers stopped: ${String(error)}`);
      })
      .finally(() => {
        this.polling = null;
      });
  }

  /**
   * Answers usually come with the messages; this finds the ones that don't: a card's, and the answer of a contact the
   * agent doesn't listen to.
   */
  private async pollAnswers(): Promise<void> {
    while (!this.stopped && (this.pending.size || Object.keys(this.listener.state.waiting).length)) {
      await new Promise((resolve) => setTimeout(resolve, this.answerPollMs));
      if (this.stopped) return;
      for (const interactionId of [...this.pending.keys()]) {
        let asked: Json;
        try {
          asked = await this.api.getInteraction(interactionId);
        } catch {
          continue;
        }
        const status = String(asked.status ?? "pending");
        if (status === "pending") continue;
        const pending = this.pending.get(interactionId);
        if (!pending) continue;
        // A contact's Allow waits for the message that brings it, which says whether they still have full access.
        // OpenClaw's own timeout denies it when none comes.
        if (status === "approved" && pending.kind === "approval" && pending.approver) continue;
        // So does an answer for a full-access session, until its card is past its time; then it is left out.
        if (pending.kind === "question" && pending.chat.fullAccess && ["answered", "approved", "denied"].includes(status)) {
          if (expired(asked)) this.pending.delete(interactionId);
          continue;
        }
        this.pending.delete(interactionId);
        const response = (asked.response ?? {}) as Json;
        await this.resolve(
          pending,
          status,
          response.optionId ? String(response.optionId) : null,
          words.clean(response.text) || null,
          null,
        );
      }
      if (Object.keys(this.listener.state.waiting).length && Date.now() - this.waitingPolledAt >= this.waitingPollMs) {
        this.waitingPolledAt = Date.now();
        await this.pollWaiting();
      }
    }
  }

  private async pollWaiting(): Promise<void> {
    for (const questionId of Object.keys(this.listener.state.waiting)) {
      let asked: Json;
      try {
        asked = await this.api.getInteraction(questionId);
      } catch (error) {
        if (error instanceof ApiError && error.status === 404) {
          // Gone, as with another key: nothing will answer it.
          delete this.listener.state.waiting[questionId];
          this.listener.save();
        }
        continue;
      }
      const status = String(asked.status ?? "pending");
      if (status !== "pending") {
        const response = (asked.response ?? {}) as Json;
        await this.answered(
          questionId,
          status,
          response.optionId ? String(response.optionId) : null,
          words.clean(response.text) || null,
        );
      }
    }
  }

  private async withdrawQuestions(sessionKey: string): Promise<void> {
    for (const [interactionId, pending] of [...this.pending]) {
      if (pending.kind === "question" && pending.sessionKey === sessionKey) {
        this.pending.delete(interactionId);
        await this.withdraw(interactionId);
      }
    }
  }

  /** A conversation's level changed: the approval cards still waiting on its sessions come off, each a Deny. */
  private async withdrawApprovals(conversationId: string): Promise<void> {
    for (const [interactionId, pending] of [...this.pending]) {
      if (pending.kind !== "approval" || this.chats.get(pending.sessionKey)?.conversationId !== conversationId) continue;
      this.pending.delete(interactionId);
      this.approvalCards.delete(pending.approvalId);
      await this.withdraw(interactionId);
      await this.settleApproval(pending.approvalId, pending.approvalKind, "deny");
    }
  }

  private async withdraw(interactionId: string): Promise<void> {
    try {
      await this.api.cancelInteraction(interactionId);
    } catch {
      // It can't be answered in time anyway.
    }
  }
}
