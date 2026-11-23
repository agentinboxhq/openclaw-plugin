// Where the plugin finds its connection: `channels.agentinbox` in OpenClaw's config, which
// `openclaw agentinbox setup` writes.
import { createHash } from "node:crypto";

export const PLUGIN_ID = "agentinbox";
export const CHANNEL_ID = "agentinbox";
export const CHANNEL_LABEL = "Agent Inbox";

// One agent per OpenClaw: the channel has a single account.
export const ACCOUNT_ID = "default";

// The host this plugin starts, as Agent Inbox names it (the API's ListenHostId) and as people read it.
export const HOST_ID = "openclaw";
export const HOST_NAME = "OpenClaw";

export const PLUGIN_VERSION = "0.1.1";

export const DEFAULT_API_URL = "https://www.agentinbox.md/api";

// The account's first agent, as the API names it. Requests leave it out, as the CLI does.
export const DEFAULT_AGENT = "human-relay";

export const SETUP_COMMAND = "openclaw agentinbox setup <agent> --code <code>";
export const RESTART_COMMAND = "openclaw gateway restart";

export type Settings = {
  secretKey: string;
  agent: string;
  apiUrl: string;
  enabled: boolean;
};

/** The `channels.agentinbox` section of a config, or an empty one. */
export function channelSection(cfg: unknown): Record<string, unknown> {
  const channels = (cfg as { channels?: Record<string, unknown> } | null | undefined)?.channels;
  const section = channels?.[CHANNEL_ID];
  return section && typeof section === "object" ? (section as Record<string, unknown>) : {};
}

function text(value: unknown): string {
  return typeof value === "string" ? value.trim() : "";
}

export function readSettings(cfg: unknown): Settings {
  const section = channelSection(cfg);
  return {
    secretKey: text(section.secretKey),
    agent: text(section.agent) || DEFAULT_AGENT,
    apiUrl: (text(section.apiUrl) || DEFAULT_API_URL).replace(/\/+$/, ""),
    enabled: section.enabled !== false,
  };
}

/**
 * What the operator lets contacts use in a contact's conversation, besides talking with them, reading it and
 * resolving it: `channels.agentinbox.contactsCanUse` in OpenClaw's config. OpenClaw's tools and tool groups by name
 * (`web_search`, `group:web`, …), MCP servers by name, and `agentinbox` for this plugin's tools. Nothing by default. A
 * list, or names split by commas.
 */
export function contactsCanUse(cfg: unknown): string[] {
  const given = channelSection(cfg).contactsCanUse;
  const names = typeof given === "string" ? given.split(",") : Array.isArray(given) ? given : [];
  return [...new Set(names.map((name) => (typeof name === "string" ? name.trim() : "")).filter(Boolean))];
}

export function isConfigured(settings: Settings): boolean {
  return Boolean(settings.secretKey);
}

/**
 * The connection as a fingerprint, never the key itself. What the operator allowed, and where the wait for
 * messages got to, belong to one connection: setting up anew starts both over.
 */
export function connectionOf(settings: Settings): string {
  const digest = createHash("sha256").update(settings.secretKey, "utf8").digest("hex").slice(0, 16);
  return `${settings.apiUrl}|${settings.agent}|${digest}`;
}
