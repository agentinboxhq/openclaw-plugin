// What OpenClaw loads while the channel is unconfigured or disabled: the channel's description, without its gateway.
import { defineSetupPluginEntry } from "openclaw/plugin-sdk/channel-core";
import { agentInboxPlugin } from "./channel.js";

export default defineSetupPluginEntry(agentInboxPlugin);
