// Agent Inbox as one of OpenClaw's channels: the account config, the gateway loop that listens, each message as a
// turn in its conversation's own session, the reply back into the conversation, and approvals to the operator (or to a
// contact with full access, for their own run).
import type { ChannelGatewayContext } from "openclaw/plugin-sdk/channel-contract";
import { type ChannelPlugin, createChatChannelPlugin } from "openclaw/plugin-sdk/channel-core";
import { registerChannelRuntimeContext } from "openclaw/plugin-sdk/channel-runtime-context";
import { isHostNoticePayload } from "openclaw/plugin-sdk/reply-payload";
import { resolveStateDir } from "openclaw/plugin-sdk/state-paths";
import { join } from "node:path";
import { AgentInboxApi, type FetchLike, isRecord } from "./api.js";
import { APPROVAL_CONTEXT_CAPABILITY, createApprovalCapability } from "./approvals.js";
import { computerName } from "./computer.js";
import {
  AgentInboxGateway,
  type ApprovalDecision,
  type ApprovalKind,
  type GatewayHost,
  type InboundTurn,
  type Reply,
  TYPING_EVERY_MS,
  TYPING_MOST_MS,
} from "./gateway.js";
import type { Logger } from "./listener.js";
import {
  ACCOUNT_ID,
  CHANNEL_ID,
  CHANNEL_LABEL,
  type Settings,
  isConfigured,
  readSettings,
} from "./settings.js";
import { type Chat, FileStateStore, sessionThread } from "./state.js";
import { bindGateway, boundGateway, unbindGateway } from "./tools.js";
import * as words from "./words.js";

export type ResolvedAccount = {
  accountId: string;
  enabled: boolean;
  configured: boolean;
  settings: Settings;
};

export function resolveAccount(cfg: unknown, accountId?: string | null): ResolvedAccount {
  const settings = readSettings(cfg);
  return {
    accountId: accountId || ACCOUNT_ID,
    enabled: settings.enabled,
    configured: isConfigured(settings),
    settings,
  };
}

/** The plugin's own state file, in OpenClaw's state folder (`~/.openclaw`, or the profile's). */
export function statePath(): string {
  return join(resolveStateDir(), "agentinbox", "state.json");
}

// --- what the gateway needs of OpenClaw's channel runtime ---

type Route = { agentId: string; sessionKey: string; mainSessionKey?: string };

type ChannelRuntimeLike = {
  routing: { resolveAgentRoute: (input: Record<string, unknown>) => Route };
  inbound: {
    run: (params: Record<string, unknown>) => Promise<unknown>;
    buildContext: (params: Record<string, unknown>) => unknown;
  };
};

function runtimeOf(ctx: ChannelGatewayContext<ResolvedAccount>): ChannelRuntimeLike | null {
  const runtime = ctx.channelRuntime as unknown as Partial<ChannelRuntimeLike> | undefined;
  if (!runtime?.routing?.resolveAgentRoute || !runtime.inbound?.run || !runtime.inbound.buildContext) return null;
  return runtime as ChannelRuntimeLike;
}

function loggerOf(ctx: ChannelGatewayContext<ResolvedAccount>): Logger {
  return {
    info: (message) => ctx.log?.info?.(message),
    warn: (message) => ctx.log?.warn?.(message),
    error: (message) => ctx.log?.error?.(message),
  };
}

function waitUntilAbort(signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) resolve();
    else signal.addEventListener("abort", () => resolve(), { once: true });
  });
}

/**
 * A conversation's session, one per conversation whatever `session.dmScope` says, and a fresh one per round and per
 * change of a contact's level, as OpenClaw's own threads of a chat: the key ends in `:thread:` and what tells them
 * apart (`round-2`, `full-1`, `round-2-limited-2`).
 */
export function routeFor(runtime: ChannelRuntimeLike, cfg: unknown, accountId: string, chat: Chat): Route {
  const route = runtime.routing.resolveAgentRoute({
    cfg,
    channel: CHANNEL_ID,
    accountId,
    peer: { kind: chat.isDirect ? "direct" : "group", id: chat.conversationId },
    dmScope: "per-account-channel-peer",
  });
  const thread = sessionThread(chat);
  const sessionKey = thread ? `${route.sessionKey}:thread:${thread}` : route.sessionKey;
  return { agentId: route.agentId, sessionKey, mainSessionKey: route.mainSessionKey };
}

// --- replies ---

type PayloadLike = {
  text?: string;
  isReasoning?: boolean;
  isCommentary?: boolean;
  fallbackText?: { text?: string };
  presentation?: { title?: string; blocks?: unknown[] };
  interactive?: { blocks?: unknown[] };
  mediaUrl?: string;
  mediaUrls?: string[];
};

function buttonsOf(blocks: unknown[] | undefined): Record<string, unknown>[] {
  return (blocks ?? [])
    .filter(isRecord)
    .flatMap((block) => (block.type === "buttons" && Array.isArray(block.buttons) ? block.buttons : []))
    .filter(isRecord);
}

/** OpenClaw's own approval prompt: approvals reach the operator as cards, never as a message in the conversation. */
export function isApprovalPrompt(payload: PayloadLike): boolean {
  const buttons = [...buttonsOf(payload.presentation?.blocks), ...buttonsOf(payload.interactive?.blocks)];
  return buttons.some((button) => {
    const action = isRecord(button.action) ? button.action : {};
    const command = String(action.command ?? button.value ?? "");
    return action.type === "approval" || command.trim().startsWith("/approve");
  });
}

/** A reply's text, or its ask_user question with the options as buttons. */
export function replyOf(payload: PayloadLike): Reply {
  const blocks = (payload.presentation?.blocks ?? []).filter(isRecord);
  const shown = blocks
    .filter((block) => block.type === "text" || block.type === "context")
    .map((block) => String(block.text ?? "").trim())
    .filter(Boolean);
  const text = String(payload.text ?? "").trim() || shown.join("\n\n") || String(payload.fallbackText?.text ?? "").trim();
  const choices = buttonsOf(payload.presentation?.blocks).filter((button) => {
    const action = isRecord(button.action) ? button.action : {};
    return action.type === "question" && "optionValue" in action;
  });
  if (choices.length) {
    const title = [payload.presentation?.title, ...shown].filter(Boolean).join("\n\n") || text;
    return {
      text,
      question: { text: title, options: choices.map((button) => String(button.label ?? "")), multiple: false },
    };
  }
  return { text };
}

function typingFor(gateway: AgentInboxGateway, conversationId: string) {
  let timer: ReturnType<typeof setInterval> | null = null;
  let until = 0;
  const stop = () => {
    if (timer) clearInterval(timer);
    timer = null;
  };
  return {
    onReplyStart: async () => {
      until = Date.now() + TYPING_MOST_MS;
      void gateway.showTyping(conversationId);
      if (timer) return;
      timer = setInterval(() => {
        if (Date.now() > until) stop();
        else void gateway.showTyping(conversationId);
      }, TYPING_EVERY_MS);
      timer.unref?.();
    },
    onIdle: stop,
    onCleanup: stop,
  };
}

// --- the gateway account ---

function hostFor(
  ctx: ChannelGatewayContext<ResolvedAccount>,
  runtime: ChannelRuntimeLike,
  gateway: () => AgentInboxGateway,
): GatewayHost {
  const log = loggerOf(ctx);
  return {
    sessionKeyFor: (chat) => routeFor(runtime, ctx.cfg, ctx.accountId, chat).sessionKey,
    async dispatch(turn: InboundTurn) {
      const route = routeFor(runtime, ctx.cfg, ctx.accountId, turn.chat);
      const target = `${CHANNEL_ID}:${turn.chat.conversationId}`;
      await runtime.inbound.run({
        channel: CHANNEL_ID,
        accountId: ctx.accountId,
        raw: turn,
        adapter: {
          ingest: () => ({
            id: turn.messageId,
            timestamp: turn.timestamp,
            rawText: turn.rawText,
            textForAgent: turn.bodyForAgent,
            textForCommands: turn.commandBody,
            raw: turn,
          }),
          resolveTurn: (input: { id: string; timestamp?: number; rawText: string; textForAgent?: string; textForCommands?: string }) => ({
            cfg: ctx.cfg,
            channel: CHANNEL_ID,
            accountId: ctx.accountId,
            route: { agentId: route.agentId, sessionKey: turn.sessionKey },
            ctxPayload: runtime.inbound.buildContext({
              // Agent Inbox decides who reaches OpenClaw: the operator, and the contacts the agent listens to.
              channelIngress: "unsupported",
              channel: CHANNEL_ID,
              accountId: ctx.accountId,
              provider: CHANNEL_ID,
              surface: CHANNEL_ID,
              messageId: input.id,
              timestamp: input.timestamp,
              from: `${CHANNEL_ID}:${turn.sender.id}`,
              sender: { id: turn.sender.id, ...(turn.sender.name ? { name: turn.sender.name } : {}) },
              conversation: {
                kind: turn.chat.isDirect ? "direct" : "group",
                id: turn.chat.conversationId,
                label: turn.chat.chatName,
              },
              route: {
                agentId: route.agentId,
                accountId: ctx.accountId,
                routeSessionKey: turn.sessionKey,
                dispatchSessionKey: turn.sessionKey,
                ...(route.mainSessionKey ? { mainSessionKey: route.mainSessionKey } : {}),
              },
              reply: { to: target, originatingTo: target },
              message: {
                rawBody: input.rawText,
                commandBody: input.textForCommands ?? "",
                bodyForAgent: input.textForAgent ?? input.rawText,
              },
              access: { commands: { authorized: turn.commandAuthorized } },
              extra: {
                AgentInboxConversationId: turn.chat.conversationId,
                AgentInboxRound: turn.chat.round,
                AgentInboxChannel: turn.channel || undefined,
              },
            }),
            delivery: {
              deliver: async (payload: PayloadLike, info?: { kind?: string }) => {
                // Only OpenClaw's answer reaches the conversation: not its tool progress, its thinking, or its approval
                // prompts.
                if (info?.kind === "tool" || payload.isReasoning === true || payload.isCommentary === true || isApprovalPrompt(payload)) {
                  return { visibleReplySent: false };
                }
                // OpenClaw's own notices are for the operator: they show in the operator's own conversation, and
                // never in a contact's or a group's, full access or not.
                if (isHostNoticePayload(payload as never) && !(turn.chat.isDirect && turn.sender.isOperator)) {
                  log.info(`[Agent Inbox] Kept an ${CHANNEL_LABEL} notice out of ${turn.chat.conversationId}.`);
                  return { visibleReplySent: false };
                }
                const reply = replyOf(payload);
                const id = await gateway().deliver(turn.chat, turn.sessionKey, reply);
                return id ? { visibleReplySent: true, messageIds: [id], content: reply.text } : { visibleReplySent: false };
              },
              onError: (error: unknown, info: { kind: string }) => {
                log.error(`[Agent Inbox] Couldn't reply in ${turn.chat.conversationId} (${info.kind}): ${String(error)}`);
              },
            },
            dispatcherOptions: { typingCallbacks: typingFor(gateway(), turn.chat.conversationId) },
            record: {
              onRecordError: (error: unknown) => log.warn(`[Agent Inbox] Session update failed: ${String(error)}`),
            },
          }),
        },
      });
    },
    async resolveApproval(approvalId: string, kind: ApprovalKind, decision: ApprovalDecision) {
      // Settled as the operator's channel, also when a contact with full access answered: the plugin chose who to
      // ask, and took their Allow only while their full access was on.
      const { resolveApprovalOverGateway } = await import("openclaw/plugin-sdk/approval-gateway-runtime");
      await resolveApprovalOverGateway({
        cfg: ctx.cfg,
        approvalId,
        approvalKind: kind,
        decision,
        channel: CHANNEL_ID,
        accountId: ctx.accountId,
        senderId: gateway().operatorId,
        clientDisplayName: "Agent Inbox",
      });
    },
  };
}

export async function startAccount(ctx: ChannelGatewayContext<ResolvedAccount>): Promise<void> {
  const log = loggerOf(ctx);
  const account = ctx.account;
  if (!account.enabled || !account.configured) {
    if (account.enabled) log.warn(`[Agent Inbox] ${words.NOT_SET_UP_MESSAGE}`);
    await waitUntilAbort(ctx.abortSignal);
    return;
  }
  const runtime = runtimeOf(ctx);
  if (!runtime) throw new Error("Agent Inbox needs OpenClaw's channel runtime. Update OpenClaw and try again.");

  const settings = account.settings;
  let gateway: AgentInboxGateway | null = null;
  const current = () => {
    if (!gateway) throw new Error("Agent Inbox isn't listening.");
    return gateway;
  };
  gateway = new AgentInboxGateway({
    settings,
    api: new AgentInboxApi(settings.apiUrl, settings.secretKey, settings.agent),
    store: new FileStateStore(statePath()),
    computerName: computerName(),
    host: hostFor(ctx, runtime, current),
    log,
    signal: ctx.abortSignal,
    onListening: (connected) => ctx.setStatus({ ...ctx.getStatus(), accountId: ctx.accountId, connected }),
  });
  bindGateway(gateway);
  const registration = registerChannelRuntimeContext({
    channelRuntime: ctx.channelRuntime,
    channelId: CHANNEL_ID,
    accountId: ctx.accountId,
    capability: APPROVAL_CONTEXT_CAPABILITY,
    context: { gateway, accountId: ctx.accountId },
    abortSignal: ctx.abortSignal,
  });
  ctx.setStatus({ ...ctx.getStatus(), accountId: ctx.accountId, running: true, connected: false, lastStartAt: Date.now() });
  try {
    const stopped = await gateway.run();
    if (stopped) {
      // Not an error to restart from: it waits for a new key, the operator's answer, or a restart.
      ctx.setStatus({ ...ctx.getStatus(), accountId: ctx.accountId, connected: false, lastError: stopped.message });
      await waitUntilAbort(ctx.abortSignal);
    }
  } catch (error) {
    if (!ctx.abortSignal.aborted) throw error;
  } finally {
    unbindGateway(gateway);
    registration?.dispose();
    await gateway.stop();
    ctx.setStatus({ ...ctx.getStatus(), accountId: ctx.accountId, running: false, connected: false, lastStopAt: Date.now() });
  }
}

// --- sends OpenClaw starts by itself ---

function stripTarget(raw: string): string {
  return raw.trim().replace(new RegExp(`^${CHANNEL_ID}:`, "i"), "").trim();
}

// The home target: a scheduled job's result, or OpenClaw's message for Agent Inbox, goes to the operator in a new
// conversation.
export const OPERATOR_TARGET = "operator";

export async function sendText(
  params: { cfg: unknown; to: string; text: string; sessionKey?: string | null },
  fetchImpl?: FetchLike,
) {
  const target = stripTarget(params.to);
  if (!target) throw new Error("Agent Inbox needs a conversation id to write into.");
  const settings = readSettings(params.cfg);
  if (!isConfigured(settings)) throw new Error(words.NOT_SET_UP_MESSAGE);
  const gateway = boundGateway(settings);
  const api =
    gateway?.api ??
    new AgentInboxApi(settings.apiUrl, settings.secretKey, settings.agent, fetchImpl ? { fetch: fetchImpl } : {});
  const card = { title: words.clipCard(params.text.trim()) };
  if (target.toLowerCase() === OPERATOR_TARGET) {
    const operator = gateway?.operatorId ?? (await api.findOperator());
    if (!operator) throw new Error(words.NO_OPERATOR_MESSAGE);
    const sent = await api.createInteraction({ kind: "tell", card, to: operator });
    return { messageId: String(sent.id ?? "") };
  }
  if (gateway && !gateway.mayWriteInto(target, params.sessionKey)) {
    throw new Error(
      "Only your operator has OpenClaw write to other people, from their own chat: not from a contact's conversation or a group.",
    );
  }
  const sent = await api.createInteraction({ kind: "tell", card, thread: target });
  // It opened the conversation again, if OpenClaw had resolved it: its resolve waits until OpenClaw is quiet there.
  gateway?.sentInto(target);
  return { messageId: String(sent.id ?? "") };
}

export const CHANNEL_CONFIG_SCHEMA = {
  type: "object",
  additionalProperties: true,
  properties: {
    enabled: { type: "boolean", description: "Listen for messages. On by default once setup connected an agent." },
    secretKey: { type: "string", description: "The agent's Agent Inbox key. `openclaw agentinbox setup` writes it." },
    agent: { type: "string", description: "Which agent the key acts as, by its API name. Set by setup." },
    apiUrl: { type: "string", description: "Agent Inbox's API, when it isn't https://www.agentinbox.md/api." },
    contactsCanUse: {
      type: "array",
      items: { type: "string" },
      description:
        "What OpenClaw may use in a contact's conversation besides talking with them: tools and tool groups (group:web), MCP servers by name, and agentinbox for this plugin's tools. Nothing by default.",
    },
  },
} as const;

export const agentInboxPlugin: ChannelPlugin<ResolvedAccount> = createChatChannelPlugin<ResolvedAccount>({
  base: {
    id: CHANNEL_ID,
    meta: {
      id: CHANNEL_ID,
      label: CHANNEL_LABEL,
      selectionLabel: "Agent Inbox (Telegram, Slack, email)",
      docsPath: "/channels/agentinbox",
      docsLabel: "agentinbox",
      blurb:
        "Messages to your agent on Telegram, Slack or email, from you and the contacts it listens to, start OpenClaw, and its answer goes back in the same conversation.",
      markdownCapable: false,
    },
    capabilities: { chatTypes: ["direct", "group"] },
    reload: { configPrefixes: [`channels.${CHANNEL_ID}`] },
    configSchema: {
      schema: CHANNEL_CONFIG_SCHEMA as unknown as Record<string, unknown>,
      uiHints: { secretKey: { label: "Agent key", sensitive: true } },
    },
    config: {
      listAccountIds: () => [ACCOUNT_ID],
      resolveAccount: (cfg, accountId) => resolveAccount(cfg, accountId),
      defaultAccountId: () => ACCOUNT_ID,
      isConfigured: (account) => account.configured,
      isEnabled: (account) => account.enabled,
      unconfiguredReason: () => words.NOT_SET_UP_MESSAGE,
      inspectAccount: (cfg) => {
        const account = resolveAccount(cfg);
        return {
          enabled: account.enabled,
          configured: account.configured,
          tokenStatus: account.configured ? "available" : "missing",
        };
      },
      describeAccount: (account) => ({
        accountId: account.accountId,
        enabled: account.enabled,
        configured: account.configured,
      }),
    },
    agentPrompt: {
      inboundFormattingHints: () => ({ text_markup: "plain text", rules: words.PLATFORM_HINT_RULES }),
    },
    messaging: {
      targetPrefixes: [CHANNEL_ID],
      normalizeTarget: (raw: string) => {
        const id = stripTarget(raw);
        return /^[A-Za-z0-9_.:-]+$/.test(id) ? id : undefined;
      },
      inferTargetChatType: () => "direct",
      targetResolver: {
        looksLikeId: (raw: string) => /^[A-Za-z0-9_.:-]+$/.test(stripTarget(raw)),
        hint: "an Agent Inbox conversation id, as agentinbox_conversations lists it",
      },
    },
    gateway: { startAccount: (ctx) => startAccount(ctx) },
    approvalCapability: createApprovalCapability(),
  },
  outbound: {
    base: {
      deliveryMode: "direct",
      textChunkLimit: words.CARD_TEXT_MAX,
      // OpenClaw's own approval prompts never go into a conversation: the operator, or a contact with full access for
      // their own run, gets a card.
      shouldSuppressLocalPayloadPrompt: ({ hint }: { hint?: { kind?: string } }) =>
        hint?.kind === "approval-pending" || hint?.kind === "approval-resolved",
    },
    attachedResults: {
      channel: CHANNEL_ID,
      sendText: (params) => sendText(params),
    },
  },
});
