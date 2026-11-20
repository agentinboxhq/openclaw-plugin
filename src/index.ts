// Agent Inbox for OpenClaw: messages to your agent on Telegram, Slack or email reach OpenClaw's gateway within
// seconds, and OpenClaw answers in the same conversation. Its tools ask the operator, write to people, and read the
// conversations and contacts.
import { defineChannelPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { agentInboxPlugin, statePath } from "./channel.js";
import { registerCli } from "./cli.js";
import { registerTools } from "./register-tools.js";
import { PLUGIN_ID } from "./settings.js";

export default defineChannelPluginEntry({
  id: PLUGIN_ID,
  name: "Agent Inbox",
  description:
    "Messages to your agent on Telegram, Slack or email reach OpenClaw within seconds, and OpenClaw answers in the same conversation.",
  plugin: agentInboxPlugin,
  // `openclaw agentinbox setup|status`, shown in `openclaw --help` before the channel loads.
  registerCliMetadata: (api) => registerCli(api, statePath),
  registerFull: (api) => registerTools(api),
});
