// What OpenClaw may do in a contact's conversation on Agent Inbox, or in a group: talk with them. It reads and
// resolves that conversation, asks the person, and uses only what the operator lets contacts use
// (`channels.agentinbox.contactsCanUse`): OpenClaw's tools and tool groups by name, MCP servers by name, and
// `agentinbox` for this plugin's tools. Everything else is blocked outright, with nothing to approve. Keys and
// OpenClaw's own files stay closed whatever the list says. The plugin's `before_tool_call` hook asks this before
// every tool call in such a chat. A contact with full access, in their own direct chat, is never asked about here:
// their runs have no limits, as the operator's own (`hasContactLimits` in tools.ts).
//
// It is a fence, not a wall: a command can still reach a key in ways no check here reads, such as a script OpenClaw
// wrote first. A contact who may run commands may run any.
import { type Json, isRecord } from "./api.js";
import { ASK_HERE, ASK_OPERATOR, CONTACTS, CONVERSATIONS, type Place, READ, RESOLVE, SEND } from "./tools.js";
import * as words from "./words.js";

/** The name that gives contacts this plugin's own tools, in `contactsCanUse`. */
export const AGENT_INBOX_TOOLS = "agentinbox";

/**
 * OpenClaw's core tool groups, as OpenClaw 2026.11.5 has them: a plugin can't read OpenClaw's own table, so a tool
 * OpenClaw adds to a group later stays off for contacts until it is named here, or by itself.
 */
export const TOOL_GROUPS: Readonly<Record<string, readonly string[]>> = {
  "group:fs": ["ls", "read", "write", "edit", "apply_patch"],
  "group:runtime": ["exec", "process", "code_execution", "secrets"],
  "group:web": ["web_search", "web_fetch", "x_search"],
  "group:memory": ["memory_search", "memory_get", "personal_instructions"],
  "group:sessions": [
    "presence",
    "sessions",
    "sessions_create",
    "sessions_list",
    "sessions_history",
    "sessions_search",
    "conversations_list",
    "conversations_send",
    "conversations_turn",
    "sessions_send",
    "sessions_spawn",
    "github_identity_status",
    "github_publish",
    "agents_wait",
    "sessions_yield",
    "subagents",
    "session_status",
    "suggest_task",
    "dismiss_task",
  ],
  "group:ui": ["browser", "screen", "theme", "dashboard", "terminal", "portal", "canvas", "show_widget"],
  "group:messaging": ["message"],
  "group:automation": ["automations", "gateway", "plugins", "openclaw"],
  "group:nodes": ["nodes", "computer", "mobile_ui"],
  "group:media": ["view_image", "image_generate", "music_generate", "video_generate", "tts", "pdf"],
  "group:agents": [
    "decision_evaluate",
    "agents_list",
    "get_goal",
    "create_goal",
    "update_goal",
    "progress_card",
    "ask_user",
    "skill_workshop",
    "skills_search",
    "skills_read",
  ],
};

/**
 * What a contact's conversation always has: asking the person something, and finding OpenClaw's tools that load on
 * demand, which only lists and describes them. A call of one goes through `dispatch_action`, judged by what it calls.
 */
const ALWAYS: ReadonlySet<string> = new Set(["ask_user", "tool_search", "tool_describe"]);

/** OpenClaw's tool that calls a tool `tool_search` found, by its id (`openclaw:<plugin>:<tool>`) or its name. */
const DISPATCH = "dispatch_action";

// What stays closed in a contact's conversation: the CLI's folder with its saved key, any `.env`, and OpenClaw's own
// state (its config holds this plugin's key under channels.agentinbox; its sessions and memory are the operator's).
const CLOSED = /(?:^|[\\/~\s'"=:]|\$HOME)\.(?:agentinbox|env|openclaw)\b|openclaw\.json/i;

// The tools that run what they are given as a command.
const COMMAND_TOOLS: ReadonlySet<string> = new Set(["exec", "process", "bash", "shell", "terminal", "run_command"]);

// What a tool names a command with, whatever else it does.
const COMMAND_KEYS = ["command", "cmd", "commands", "script"];

// What a tool names a file or folder with.
const PATH_KEYS = [
  "path",
  "paths",
  "file",
  "files",
  "file_path",
  "filePath",
  "filename",
  "target",
  "targetPath",
  "source",
  "destination",
  "dir",
  "directory",
  "cwd",
  "workdir",
  "root",
];

// What a tool names another tool with, when it calls one for OpenClaw.
const TOOL_KEYS = ["name", "tool", "toolName", "tool_name"];

// The plugin's own tools.
const OWN_TOOLS: ReadonlySet<string> = new Set([SEND, ASK_OPERATOR, ASK_HERE, CONVERSATIONS, CONTACTS, READ, RESOLVE]);

/** Every string in a tool's arguments, however deep, up to a limit. */
function stringsIn(value: unknown, found: string[] = [], depth = 0): string[] {
  if (found.length > 500 || depth > 6) return found;
  if (typeof value === "string") found.push(value);
  else if (Array.isArray(value)) for (const item of value) stringsIn(item, found, depth + 1);
  else if (isRecord(value)) for (const item of Object.values(value)) stringsIn(item, found, depth + 1);
  return found;
}

function stringsAt(args: Json, keys: readonly string[]): string[] {
  return keys.flatMap((key) => stringsIn(args[key]));
}

/** Whether a path or a command reaches what stays closed: a key, or OpenClaw's own files. */
export function reachesClosed(text: string): boolean {
  const configPath = process.env.OPENCLAW_CONFIG_PATH?.trim();
  const stateDir = process.env.OPENCLAW_STATE_DIR?.trim();
  return (
    CLOSED.test(text) ||
    Boolean(configPath && text.includes(configPath)) ||
    Boolean(stateDir && text.includes(stateDir)) ||
    // OpenClaw's own CLI reads its config and secrets: `openclaw config get channels.agentinbox.secretKey`.
    /(?:^|[;&|(`\n]|\$\()\s*(?:\S*\/)?openclaw\s/i.test(text)
  );
}

/** The MCP server of a tool, as OpenClaw names its tools: `<server>__<tool>`, maybe `-2` after. */
function mcpServerOf(tool: string): string | undefined {
  const split = tool.lastIndexOf("__");
  return split > 0 ? tool.slice(0, split) : undefined;
}

/** What the operator lets contacts use, by the names it gives, and the tools of each group named. */
export function contactTools(canUse: readonly string[]): ReadonlySet<string> {
  const names = canUse.map((name) => name.trim().toLowerCase()).filter(Boolean);
  return new Set([...ALWAYS, ...names.flatMap((name) => [name, ...(TOOL_GROUPS[name] ?? [])])]);
}

/** Whether a tool is one a contact's conversation has: named, in a group named, or a tool of an MCP server named. */
function mayUse(tool: string, allowed: ReadonlySet<string>): boolean {
  const server = mcpServerOf(tool);
  return allowed.has(tool) || (server !== undefined && allowed.has(server));
}

/**
 * The plugin's own tools: `undefined` for another tool, `null` when the call may go on, or why it can't. Asking,
 * reading and resolving go on for this very conversation.
 */
function ownToolBlock(tool: string, args: Json, place: Place): string | null | undefined {
  if (!OWN_TOOLS.has(tool)) return undefined;
  const here = place.chat?.conversationId ?? null;
  const named = words.clean(args.conversation).trim();
  // It asks only the people in this very conversation.
  if (tool === ASK_HERE) return null;
  if (tool === SEND) return words.CONTACT_NO_WRITING;
  if (tool === ASK_OPERATOR) return words.CONTACT_NO_ASKING;
  if (tool === CONVERSATIONS || tool === CONTACTS) return words.CONTACT_NO_OTHERS;
  if (tool === READ) return named && named === here ? null : words.contactReadHereOnly(here);
  return !named || named === here ? null : words.CONTACT_RESOLVE_HERE_ONLY;
}

/** The tool a tool that calls others for OpenClaw names, that a contact's conversation doesn't have. */
function callsOther(args: Json, allowed: ReadonlySet<string>): string | undefined {
  return stringsAt(args, TOOL_KEYS)
    .map((value) => value.trim().toLowerCase())
    .find((name) => name && !mayUse(name, allowed) && !(OWN_TOOLS.has(name) && allowed.has(AGENT_INBOX_TOOLS)));
}

/**
 * The tool a `dispatch_action` id stands for: a name as it is, and a search result's id (`openclaw:<plugin>:<tool>`,
 * `<source>:<server>:<tool>` for an MCP server's) as OpenClaw names the tool. Undefined when it can't be told.
 */
export function dispatchedTool(id: unknown): string | undefined {
  const given = typeof id === "string" ? id.trim() : "";
  if (!given.includes(":")) return given || undefined;
  const [source = "", owner = "", ...rest] = given.split(":");
  const tool = rest.join(":");
  if (!owner || !tool) return undefined;
  return source.toLowerCase() === "openclaw" ? tool : `${owner}__${tool}`;
}

/**
 * Why a tool call can't go on in a contact's conversation, or null when it may: what the operator lets contacts use
 * (`canUse`) goes on, but for what stays closed; anything else is blocked. `dispatch_action` is judged as the call it
 * makes.
 */
export function contactBlock(toolName: string, params: unknown, place: Place, canUse: readonly string[]): string | null {
  const tool = toolName.trim().toLowerCase();
  const args = isRecord(params) ? params : {};
  if (tool === DISPATCH) {
    const target = dispatchedTool(args.id);
    return target && target.toLowerCase() !== DISPATCH
      ? contactBlock(target, isRecord(args.args) ? args.args : {}, place, canUse)
      : words.contactCannotUse(String(args.id ?? DISPATCH));
  }
  const allowed = contactTools(canUse);
  const own = ownToolBlock(tool, args, place);
  if (own !== undefined) return own === null || allowed.has(AGENT_INBOX_TOOLS) ? null : own;
  if (!mayUse(tool, allowed)) return words.contactCannotUse(toolName);
  const other = callsOther(args, allowed);
  if (other) return words.contactCannotUse(other);
  const commands = COMMAND_TOOLS.has(tool) ? stringsIn(args) : stringsAt(args, COMMAND_KEYS);
  // A patch names its files inside its text.
  const paths = tool === "apply_patch" ? stringsIn(args) : stringsAt(args, PATH_KEYS);
  return [...commands, ...paths].some(reachesClosed) ? words.CONTACT_CLOSED : null;
}
