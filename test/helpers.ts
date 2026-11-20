// What several tests share: a gateway on the fake API, and a fake of what OpenClaw's gateway does for it.
import type { Json } from "../src/api.js";
import {
  AgentInboxGateway,
  type ApprovalDecision,
  type ApprovalKind,
  type GatewayHost,
  type InboundTurn,
} from "../src/gateway.js";
import type { Settings } from "../src/settings.js";
import { type Chat, MemoryStateStore, type State, sessionThread } from "../src/state.js";
import { FakeApi } from "./fake-api.js";

export const SETTINGS: Settings = { secretKey: "sk_test", agent: "human-relay", apiUrl: "https://api.test", enabled: true };

export class FakeHost implements GatewayHost {
  readonly turns: InboundTurn[] = [];
  readonly approvals: Array<[string, ApprovalKind, ApprovalDecision]> = [];

  /** As the channel's own routing makes it: the conversation's key, and its thread for a round or a level. */
  sessionKeyFor(chat: Chat): string {
    const base = `agent:main:agentinbox:default:${chat.isDirect ? "direct" : "group"}:${chat.conversationId}`;
    const thread = sessionThread(chat);
    return thread ? `${base}:thread:${thread}` : base;
  }

  async dispatch(turn: InboundTurn): Promise<void> {
    this.turns.push(turn);
  }

  async resolveApproval(approvalId: string, kind: ApprovalKind, decision: ApprovalDecision): Promise<void> {
    this.approvals.push([approvalId, kind, decision]);
  }
}

export function makeGateway(fake: FakeApi, options: { state?: State | null; host?: FakeHost; askWaitMs?: number } = {}) {
  const host = options.host ?? new FakeHost();
  const store = new MemoryStateStore(options.state ?? null);
  const gateway = new AgentInboxGateway({
    settings: SETTINGS,
    api: fake.api(),
    store,
    computerName: "MacBook",
    host,
    timing: { waitSeconds: 1, retryMs: [10], allowPollMs: 10, pausedRetryMs: 10 },
    answerPollMs: 10,
    waitingPollMs: 10,
    askWaitMs: options.askWaitMs,
    resolveQuietMs: 60,
  });
  gateway.listener.operatorId = "op_ada";
  gateway.listener.holding = true;
  return { gateway, host, store };
}

/** What the gateway does with a message from the listener. */
export function receive(gateway: AgentInboxGateway, message: Json): Promise<void> {
  return (gateway as unknown as { onMessage: (message: Json) => Promise<void> }).onMessage(message);
}

export function answer(gateway: AgentInboxGateway, message: Json): Promise<boolean> {
  return (gateway as unknown as { onAnswer: (message: Json) => Promise<boolean> }).onAnswer(message);
}

export function card(sent: Json): Json {
  return sent.card as Json;
}
