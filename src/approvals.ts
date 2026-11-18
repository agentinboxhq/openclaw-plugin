// OpenClaw's approvals for Agent Inbox turns: its exec approvals, and plugin approvals such as the send tool's, go to
// the operator as Allow and Deny buttons on their own channel, whoever's message started the run. The one exception is
// a run a contact with full access started in their own direct chat: its cards go to that contact, in that
// conversation, and their Allow counts only while their full access is still on. No other contact ever sees one, and
// none is ever posted as a plain message: when nobody can be asked, it is denied.
import { createChannelApprovalNativeRuntimeAdapterAsync } from "openclaw/plugin-sdk/approval-handler-runtime";
import type { ChannelApprovalCapability } from "openclaw/plugin-sdk/channel-contract";
import { type AgentInboxGateway, type ApprovalKind, type Approver } from "./gateway.js";
import { CHANNEL_ID } from "./settings.js";
import { SEND, anyGateway } from "./tools.js";
import * as words from "./words.js";

// The key the gateway account registers its approval context under (OpenClaw's native approval runtime context).
export const APPROVAL_CONTEXT_CAPABILITY = "approval.native";

export type ApprovalContext = { gateway: AgentInboxGateway; accountId: string };

type Card =
  | {
      title: string;
      body: string;
      allowForSession: boolean;
      recipientId: string | null;
      // The contact with full access who answers it, or null for the operator.
      approver: Approver | null;
      sessionKey: string;
      ttlSeconds: number;
    }
  | { deny: true; why: string };

type Entry = { approvalId: string; approvalKind: ApprovalKind; interactionId: string };

type RequestLike = {
  id: string;
  expiresAtMs?: number;
  request: Record<string, unknown>;
};

function contextOf(context: unknown): ApprovalContext | null {
  const found = context as Partial<ApprovalContext> | null | undefined;
  return found?.gateway ? (found as ApprovalContext) : null;
}

function requestOf(request: unknown): RequestLike {
  return request as RequestLike;
}

function isOurs(request: RequestLike, accountId?: string | null): boolean {
  const inner = request.request ?? {};
  if (inner.turnSourceChannel !== CHANNEL_ID) return false;
  const account = inner.turnSourceAccountId;
  return !account || !accountId || account === accountId;
}

function decisionsOf(view: { actions?: ReadonlyArray<{ decision?: string }> }): string[] {
  return (view.actions ?? []).map((action) => action.decision ?? "").filter(Boolean);
}

/**
 * The card for one approval: what OpenClaw wants, for whose message, and how long the person asked has. A run a contact
 * with full access started asks them, about their own message, so its card speaks to them: "for your message", without
 * the line that tells the operator whose message it is.
 */
export function cardFor(
  gateway: AgentInboxGateway,
  approvalKind: ApprovalKind,
  request: RequestLike,
  view: Record<string, unknown> & { actions?: ReadonlyArray<{ decision?: string }> },
  nowMs: number,
): Card {
  const inner = request.request ?? {};
  const sessionKey = String(inner.sessionKey ?? "");
  const approver = gateway.approverFor(sessionKey);
  const starter = approver ? "you" : words.runStarter(gateway.starterForSession(sessionKey) as words.ListenMessage | null);
  const ttlSeconds = Math.max(60, Math.round(((request.expiresAtMs ?? nowMs + 300_000) - nowMs) / 1000));
  if (approvalKind === "exec") {
    const command = String(view.commandText ?? inner.command ?? "");
    const reason = String(view.description ?? view.warningText ?? inner.warningText ?? "");
    const card = words.permissionCard({
      command,
      reason,
      computerName: gateway.computerName,
      starter,
      timeoutSeconds: ttlSeconds,
    });
    if (!card) return { deny: true, why: words.TOO_LONG_TO_ASK };
    // OpenClaw's allow-always writes its own allowlist, which the operator does at OpenClaw itself.
    return { ...card, allowForSession: false, recipientId: null, approver, sessionKey, ttlSeconds };
  }
  const write = inner.toolName === SEND ? gateway.writeFor([String(inner.toolCallId ?? ""), sessionKey]) : null;
  if (write) {
    const card = words.writeCard({ name: write.name, text: write.text, starter, timeoutSeconds: ttlSeconds });
    return {
      ...card,
      allowForSession: decisionsOf(view).includes("allow-always"),
      recipientId: write.recipientId,
      approver,
      sessionKey,
      ttlSeconds,
    };
  }
  const card = words.pluginCard({
    title: String(view.title ?? inner.title ?? ""),
    description: String(view.description ?? inner.description ?? ""),
    starter,
    timeoutSeconds: ttlSeconds,
  });
  // Another plugin's allow-always means what that plugin makes of it: not offered.
  return { ...card, allowForSession: false, recipientId: null, approver, sessionKey, ttlSeconds };
}

export function createApprovalCapability(): ChannelApprovalCapability {
  const nativeRuntime = createChannelApprovalNativeRuntimeAdapterAsync<Card, { approvalId: string }, Entry | null>({
    eventKinds: ["exec", "plugin"],
    availability: {
      isConfigured: ({ context }) => Boolean(contextOf(context)),
      shouldHandle: ({ context, request, accountId }) =>
        Boolean(contextOf(context)) && isOurs(requestOf(request), accountId),
    },
    presentation: {
      buildPendingPayload: ({ context, request, approvalKind, view, nowMs }) => {
        const found = contextOf(context);
        if (!found) return { deny: true, why: "Agent Inbox isn't listening." };
        return cardFor(found.gateway, approvalKind as ApprovalKind, requestOf(request), view as never, nowMs);
      },
      buildResolvedResult: async ({ context, request }) => {
        await contextOf(context)?.gateway.approvalSettled(requestOf(request).id);
        return { kind: "leave" };
      },
      buildExpiredResult: async ({ context, request }) => {
        await contextOf(context)?.gateway.approvalSettled(requestOf(request).id);
        return { kind: "leave" };
      },
    },
    transport: {
      prepareTarget: ({ request }) => {
        const id = requestOf(request).id;
        return { dedupeKey: `agentinbox-operator:${id}`, target: { approvalId: id } };
      },
      deliverPending: async ({ context, request, approvalKind, pendingPayload }) => {
        const found = contextOf(context);
        const id = requestOf(request).id;
        const kind = approvalKind as ApprovalKind;
        if (!found) return null;
        const deny = () => {
          // Settled after this delivery returns, so OpenClaw's own bookkeeping for it is in place.
          setTimeout(() => void found.gateway.settleApproval(id, kind, "deny"), 0);
        };
        if ("deny" in pendingPayload) {
          deny();
          return null;
        }
        const interactionId = await found.gateway.askApproval({
          approvalId: id,
          approvalKind: kind,
          sessionKey: pendingPayload.sessionKey,
          title: pendingPayload.title,
          body: pendingPayload.body,
          allowForSession: pendingPayload.allowForSession,
          recipientId: pendingPayload.recipientId,
          approver: pendingPayload.approver,
          ttlSeconds: pendingPayload.ttlSeconds,
        });
        if (!interactionId) {
          deny();
          return null;
        }
        return { approvalId: id, approvalKind: kind, interactionId };
      },
    },
    interactions: {
      cancelDelivered: async ({ context, entry }) => {
        if (entry) await contextOf(context)?.gateway.approvalSettled(entry.approvalId);
      },
    },
  });

  return {
    native: {
      describeDeliveryCapabilities: ({ request }) => ({
        enabled: isOurs(requestOf(request)),
        preferredSurface: "origin",
        supportsOriginSurface: true,
        supportsApproverDmSurface: false,
      }),
      // The plugin picks who gets the card (`askApproval`): the operator, whatever conversation the run is in, or the
      // contact with full access whose own run it is.
      resolveOriginTarget: ({ request }) => ({ to: String(requestOf(request).request.turnSourceTo ?? "operator") }),
    },
    nativeRuntimeAsync: nativeRuntime,
    delivery: {
      // Never as a message in a conversation: a contact could read it there, or answer it.
      shouldSuppressForwardingFallback: () => true,
      shouldBlockForwardingFallback: () => true,
    },
    // `/approve` typed in a conversation counts only from the operator. A contact with full access answers on their
    // card, which the plugin settles as the operator's channel (`resolveApproval` in channel.ts).
    authorizeActorAction: ({ senderId }) => {
      const operator = anyGateway()?.operatorId;
      return operator && senderId === operator
        ? { authorized: true }
        : { authorized: false, reason: "Only your operator allows things here, on the card Agent Inbox sent them." };
    },
  } as ChannelApprovalCapability;
}
