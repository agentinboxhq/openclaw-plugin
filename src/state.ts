// What the plugin keeps between gateway runs, in OpenClaw's state folder: which computer it is, what the operator
// allowed, where the wait for messages got to, and the level of each contact's conversation.
import { randomBytes } from "node:crypto";
import { chmodSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

// How many handled and own ids are kept: far more than one wait ever brings back.
export const IDS_KEPT = 500;

// How many of OpenClaw's own questions wait for their answers at once: the oldest go first.
export const WAITING_KEPT = 100;

// How many conversations' levels are kept: the oldest go first, and one forgotten starts over at a contact's limits.
export const LEVELS_KEPT = 500;

// The API's rule for a computer id: 16–64 of `[A-Za-z0-9_-]`.
const COMPUTER_ID = /^[A-Za-z0-9_-]{16,64}$/;

export function newComputerId(): string {
  return `cmp_${randomBytes(18).toString("base64url")}`;
}

/** A chat an answer goes back to: the conversation, its round, and whose message started it. */
export type Chat = {
  conversationId: string;
  round: number;
  isDirect: boolean;
  userId: string | null;
  userName: string | null;
  chatName: string;
  starter: Starter | null;
  // In a contact's own direct chat: the level its session runs at, full access or a contact's limits, and how many
  // times the conversation's level had changed when that session started. Absent for the operator's own chat and for
  // groups, which never change level.
  fullAccess?: boolean;
  levelChanges?: number;
};

/** A contact's direct conversation's level now, and how many times it changed: each change starts a fresh session. */
export type ConversationLevel = { fullAccess: boolean; changes: number };

/** A conversation that never changed level: a contact's limits. */
export const FIRST_LEVEL: ConversationLevel = { fullAccess: false, changes: 0 };

/**
 * What comes after `:thread:` in a chat's session key, if anything: its round once its conversation was resolved, and
 * its level once that changed or while it is full access. Each round and each change of level is a fresh session, and
 * the key of a full-access session says so, so no session ever goes on at the other level.
 */
export function sessionThread(chat: Chat): string {
  const parts = chat.round ? [`round-${chat.round}`] : [];
  const changes = chat.levelChanges ?? 0;
  if (chat.fullAccess) parts.push(`full-${changes}`);
  else if (changes > 0) parts.push(`limited-${changes}`);
  return parts.join("-");
}

/** What the plugin keeps of the message that started a chat: enough to say whose run it is after a restart. */
export type Starter = {
  from: { id: string | null; name: string | null; isOperator: boolean };
  channel: string;
  text: string;
};

/** A question OpenClaw asked with its tools that still waits for an answer. */
export type WaitingQuestion = {
  id: string;
  question: string;
  to: string;
  toOperator: boolean;
  toName: string;
  kind: string;
  options: Record<string, string>;
  conversation: string;
  expiresAt: string | null;
  chat: Chat | null;
};

export type AskedAllow = { id: string; expiresAt: string | null; title: string };

export type State = {
  // This gateway as a computer the lease names, kept for good: the API knows it again after a restart or a new key.
  computerId: string;
  // The connection everything below belongs to: connecting anew starts it over.
  connection: string;
  // When the operator allowed listening here. Nothing is taken or started without it.
  allowedAt: string | null;
  // The operator agreed to move listening here from another computer: the first lease takes it over.
  takeOver: boolean;
  // The Allow question still waiting for its answer, and its title: the same question is only asked anew when it
  // would read otherwise now.
  asked: AskedAllow | null;
  // Where the next wait for messages goes on from.
  cursor: string | null;
  // The latest handled message ids, so none is handled twice.
  handled: string[];
  // What the plugin sent lately (its questions): an answer to one of its own questions never starts OpenClaw.
  own: string[];
  // The questions OpenClaw asked with its tools that still wait for an answer, by id.
  waiting: Record<string, WaitingQuestion>;
  // The level of each contact's direct conversation whose level ever changed, by conversation: which session its next
  // message goes on in, also after a restart.
  levels: Record<string, ConversationLevel>;
};

export function freshState(connection: string, computerId: string = newComputerId()): State {
  return {
    computerId,
    connection,
    allowedAt: null,
    takeOver: false,
    asked: null,
    cursor: null,
    handled: [],
    own: [],
    waiting: {},
    levels: {},
  };
}

/** A conversation's level now: the newest goes last, and the oldest are forgotten past `LEVELS_KEPT`. */
export function setLevel(state: State, conversationId: string, level: ConversationLevel): void {
  state.levels ??= {};
  delete state.levels[conversationId];
  state.levels[conversationId] = level;
  const ids = Object.keys(state.levels);
  for (const stale of ids.slice(0, Math.max(0, ids.length - LEVELS_KEPT))) delete state.levels[stale];
}

function levelsIn(value: unknown): Record<string, ConversationLevel> {
  const levels: Record<string, ConversationLevel> = {};
  if (!value || typeof value !== "object" || Array.isArray(value)) return levels;
  for (const [key, level] of Object.entries(value as Record<string, Partial<ConversationLevel>>)) {
    const changes = Number(level?.changes);
    if (typeof level?.fullAccess === "boolean" && Number.isInteger(changes) && changes >= 0) {
      levels[key] = { fullAccess: level.fullAccess, changes };
    }
  }
  return Object.fromEntries(Object.entries(levels).slice(-LEVELS_KEPT));
}

export function remember(state: State, list: "handled" | "own", item: string): void {
  const items = state[list];
  if (!items.includes(item)) {
    items.push(item);
    if (items.length > IDS_KEPT) items.splice(0, items.length - IDS_KEPT);
  }
}

export function waitFor(state: State, question: WaitingQuestion): void {
  state.waiting[question.id] = question;
  const ids = Object.keys(state.waiting);
  for (const stale of ids.slice(0, Math.max(0, ids.length - WAITING_KEPT))) delete state.waiting[stale];
}

function strings(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((item) => typeof item === "string" && item).map(String) : [];
}

function clone(state: State): State {
  return JSON.parse(JSON.stringify(state)) as State;
}

export interface StateStore {
  load(connection: string): State;
  save(state: State): void;
}

export class FileStateStore implements StateStore {
  constructor(readonly path: string) {}

  /** The state for `connection`. For another, a fresh one that keeps only which computer this is. */
  load(connection: string): State {
    let raw: Record<string, unknown> = {};
    try {
      const parsed: unknown = JSON.parse(readFileSync(this.path, "utf8"));
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) raw = parsed as Record<string, unknown>;
    } catch {
      raw = {};
    }
    const computerId =
      typeof raw.computerId === "string" && COMPUTER_ID.test(raw.computerId) ? raw.computerId : newComputerId();
    if (raw.connection !== connection) return freshState(connection, computerId);
    const waiting: Record<string, WaitingQuestion> = {};
    if (raw.waiting && typeof raw.waiting === "object" && !Array.isArray(raw.waiting)) {
      for (const [key, value] of Object.entries(raw.waiting as Record<string, unknown>)) {
        if (value && typeof value === "object" && !Array.isArray(value)) waiting[key] = value as WaitingQuestion;
      }
    }
    const asked = raw.asked && typeof raw.asked === "object" ? (raw.asked as AskedAllow) : null;
    return {
      computerId,
      connection,
      allowedAt: typeof raw.allowedAt === "string" && raw.allowedAt ? raw.allowedAt : null,
      takeOver: raw.takeOver === true,
      asked: asked && typeof asked.id === "string" ? asked : null,
      cursor: typeof raw.cursor === "string" && raw.cursor ? raw.cursor : null,
      handled: strings(raw.handled).slice(-IDS_KEPT),
      own: strings(raw.own).slice(-IDS_KEPT),
      waiting,
      levels: levelsIn(raw.levels),
    };
  }

  /** Written aside and moved into place, so a crash never leaves half a file; only this user can read it. */
  save(state: State): void {
    mkdirSync(dirname(this.path), { recursive: true, mode: 0o700 });
    const temporary = join(dirname(this.path), `.state-${randomBytes(6).toString("hex")}`);
    try {
      writeFileSync(temporary, `${JSON.stringify(state, null, 2)}\n`, { encoding: "utf8", mode: 0o600 });
      chmodSync(temporary, 0o600);
      renameSync(temporary, this.path);
    } catch (error) {
      rmSync(temporary, { force: true });
      throw error;
    }
  }
}

/** For tests: the same rules, kept in memory. */
export class MemoryStateStore implements StateStore {
  constructor(public current: State | null = null) {}

  load(connection: string): State {
    if (!this.current || this.current.connection !== connection) {
      return freshState(connection, this.current?.computerId ?? newComputerId());
    }
    return clone(this.current);
  }

  save(state: State): void {
    this.current = clone(state);
  }
}
