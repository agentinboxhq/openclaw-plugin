// OpenClaw's side of the tools: one factory per tool, which sees the session it runs for, and the `before_tool_call`
// hook. In a contact's Agent Inbox conversation, or a group, the hook blocks every call that reaches Agent Inbox
// (`guard.ts`), unless a contact with full access runs it in their own direct chat; in another app's chat, it has the
// operator allow a write first.
import type { OpenClawPluginApi } from "openclaw/plugin-sdk/channel-core";
import { type Json, isRecord } from "./api.js";
import { contactBlock } from "./guard.js";
import { CHANNEL_ID, contactsCanUse, isConfigured, readSettings } from "./settings.js";
import {
  SEND,
  TOOLS,
  anyGateway,
  beforeSend,
  boundGateway,
  hasContactLimits,
  inAgentInbox,
  placeOf,
  runTool,
} from "./tools.js";
import * as words from "./words.js";

type ToolContext = {
  config?: unknown;
  runtimeConfig?: unknown;
  getRuntimeConfig?: () => unknown;
  sessionKey?: string;
  messageChannel?: string;
  requesterSenderId?: string;
};

type HookContext = {
  sessionKey?: string;
  channelId?: string;
  turnSourceChannel?: string;
  toolCallId?: string;
  requester?: { channel?: string; senderId?: string };
};

function configOf(context: ToolContext): unknown {
  return context.getRuntimeConfig?.() ?? context.runtimeConfig ?? context.config;
}

/** Whether a tool call runs for an Agent Inbox conversation: by its session, or by the channel its turn came from. */
function forAgentInbox(hook: HookContext, known: boolean): boolean {
  const parts = String(hook.sessionKey ?? "").split(":");
  if (parts[0] === "agent" && (parts[2] ?? "").toLowerCase() === CHANNEL_ID) return true;
  const channels = [hook.requester?.channel, hook.turnSourceChannel, hook.channelId];
  return known || channels.some((channel) => String(channel ?? "").toLowerCase() === CHANNEL_ID);
}

/** The operator's own workspace files a contact's session goes without: their profile and long-term memory. */
const PRIVATE_FILES: ReadonlySet<string> = new Set(["user.md", "memory.md"]);

/** A workspace file's name, as OpenClaw lists it among the files it puts in a session. */
function fileName(file: unknown): string {
  const named = isRecord(file) ? String(file.name ?? file.path ?? "") : "";
  return (named.split(/[\\/]/).pop() ?? "").toLowerCase();
}

/**
 * Whether a session has a contact's limits: a contact's Agent Inbox conversation, or a group's, by its key, as the
 * gateway knows it, unless a contact with full access runs it now. An Agent Inbox session that can't be told counts
 * as a contact's.
 */
function limitedSession(api: OpenClawPluginApi, sessionKey: string): boolean {
  const settings = anyGateway()?.settings ?? readSettings(api.config);
  if (!sessionKey || !isConfigured(settings)) return false;
  const gateway = boundGateway(settings);
  if (!forAgentInbox({ sessionKey }, Boolean(gateway?.chatForSession(sessionKey)))) return false;
  try {
    return hasContactLimits(gateway, placeOf({ surface: CHANNEL_ID, sessionKey, gateway }));
  } catch {
    return true;
  }
}

export function registerTools(api: OpenClawPluginApi): void {
  // OpenClaw puts the operator's workspace files in every session; a contact's goes without their profile and memory,
  // unless the operator gave them full access. OpenClaw asks this whenever it puts those files in a run's prompt, and
  // a change of level starts a fresh session, so the files of one level never reach the other's.
  api.registerHook(
    "agent:bootstrap",
    (event) => {
      const files = event.context.bootstrapFiles;
      const sessionKey = String(event.sessionKey || event.context.sessionKey || "");
      if (!Array.isArray(files) || !limitedSession(api, sessionKey)) return;
      for (let index = files.length - 1; index >= 0; index -= 1) {
        if (PRIVATE_FILES.has(fileName(files[index]))) files.splice(index, 1);
      }
    },
    {
      name: "agentinbox-contact-privacy",
      description: "Leaves the operator's USER.md and MEMORY.md out of a contact's session, unless they have full access.",
    },
  );


  for (const spec of TOOLS) {
    api.registerTool(
      (context: ToolContext) => {
        const settings = readSettings(configOf(context));
        // The tools show only to an OpenClaw that `openclaw agentinbox setup` connected.
        if (!isConfigured(settings)) return null;
        return {
          name: spec.name,
          label: spec.label,
          description: spec.description,
          parameters: spec.parameters,
          async execute(toolCallId: string, params: unknown, signal?: AbortSignal) {
            const place = placeOf({
              surface: context.messageChannel,
              sessionKey: context.sessionKey,
              senderId: context.requesterSenderId,
              toolCallId,
              gateway: boundGateway(settings),
            });
            const args = isRecord(params) ? params : {};
            const { text, ok } = await runTool(spec, { settings, place, args, signal });
            return { content: [{ type: "text", text }], details: ok ? { ok: true } : { ok: false, error: text } };
          },
        };
      },
      { name: spec.name },
    );
  }

  // Every tool, so that a contact's conversation has only what the operator lets contacts use, and a full-access
  // contact's own chat has everything, as the operator's does. Each call is judged anew, by its session's level and the
  // conversation's now. OpenClaw blocks a call when this hook fails, so outside Agent Inbox it only ever looks at the
  // send tool.
  api.on(
    "before_tool_call",
    async (event, context) => {
      const hook = context as HookContext;
      const toolName = String(event.toolName ?? "");
      // The listening account's connection, else the config this plugin was loaded with.
      const settings = anyGateway()?.settings ?? readSettings(api.config);
      if (!isConfigured(settings)) return undefined;
      const gateway = boundGateway(settings);
      const sessionKey = String(hook.sessionKey ?? "");
      const ours = forAgentInbox(hook, Boolean(sessionKey && gateway?.chatForSession(sessionKey)));
      const place = placeOf({
        surface: ours ? CHANNEL_ID : (hook.requester?.channel ?? hook.turnSourceChannel ?? hook.channelId),
        sessionKey,
        senderId: hook.requester?.senderId,
        toolCallId: event.toolCallId ?? hook.toolCallId,
        gateway,
      });
      if (inAgentInbox(place)) {
        let reason: string | null;
        try {
          reason = hasContactLimits(gateway, place)
            ? contactBlock(toolName, event.params, place, contactsCanUse(api.config))
            : null;
        } catch {
          // Not sure what this call reaches, in an Agent Inbox chat: it doesn't go on.
          reason = words.CONTACT_CHECK_FAILED;
        }
        return reason ? { block: true, blockReason: reason } : undefined;
      }
      if (toolName !== SEND) return undefined;
      return beforeSend({ settings, place, args: (event.params ?? {}) as Json });
    },
    { priority: 50 },
  );
}
