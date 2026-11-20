# Agent Inbox for OpenClaw

When your operator, or a contact your agent listens to, writes to your agent on Telegram, Slack or email, the message reaches OpenClaw's gateway within seconds, and OpenClaw answers in the same conversation. OpenClaw's approval prompts go to the operator as Allow and Deny buttons, or to a contact with [full access](#full-access), for their own requests.

It is a channel plugin: Agent Inbox becomes one more of OpenClaw's channels, next to the ones you already have. It also gives OpenClaw [tools](#tools) to ask you something, write to your contacts, read the conversations, and resolve them.

It needs OpenClaw 2026.11.1 or newer, which runs on Node 24.16 or newer.

## Install

```bash
openclaw plugins install clawhub:@agentinbox/openclaw
```

## Connect

1. On [agentinbox.md](https://agentinbox.md), open **Configure › Connect another agent**, pick **OpenClaw**, and copy the one-time code. It works once, for 10 minutes.
2. Connect this OpenClaw to the agent:

   ```bash
   openclaw agentinbox setup <agent> --code <code>
   ```

   `<agent>` is how the agent's address starts: `atlas` for `atlas@agentinbox.md`. The key goes into OpenClaw's config, under `channels.agentinbox`.
3. Restart the gateway:

   ```bash
   openclaw gateway restart
   ```

## Turning it on

Nothing starts until the operator allows it. When you run `setup` at a terminal, it asks there; with `--yes`, as in the commands agentinbox.md writes, it asks nothing and turns listening on. When an agent runs it, the gateway asks when it starts: the operator gets an Allow and Deny message on their channel:

```text
Listen for messages on MacBook, and start OpenClaw?
```

If nobody answers within an hour, or the operator says no, the gateway stops listening; restart it to ask again.

## Whom it listens to

- **The operator**, always.
- **A contact**, once the operator turns on their **Listen to** switch on agentinbox.md. It is off by default.
- **A stranger**, never: their messages never reach OpenClaw.

## What a contact can have OpenClaw do

A contact's conversation is for talking with them, and so is a group, even when the operator writes there. The one exception is a contact with [full access](#full-access), in their own direct chat. Everywhere else, OpenClaw can:

- answer them, and ask them something (`agentinbox_ask_here`, or OpenClaw's own `ask_user`);
- read that conversation (`agentinbox_read`) and resolve it (`agentinbox_resolve`);
- use what the operator lets contacts use, and nothing else.

Everything else is blocked outright, with nothing to approve: files, commands, the web, MCP servers, skills, memory, sessions, and Agent Inbox's own actions (writing to other people, asking the operator, listing the conversations and contacts).

The operator lets contacts use more in OpenClaw's config, by OpenClaw's tool names, its tool groups, MCP server names, and `agentinbox` for this plugin's tools:

```json
{
  "channels": {
    "agentinbox": {
      "contactsCanUse": ["group:web", "docs"]
    }
  }
}
```

For example, with `["group:web"]`, Ben can ask OpenClaw to look something up, but not to read a file. With `["group:runtime"]`, Ben can have OpenClaw run any command, the Agent Inbox CLI included: only list what you'd let any contact do. Restart the gateway after changing it.

The groups are OpenClaw's own: `group:fs` (files), `group:runtime` (commands), `group:web`, `group:memory`, `group:sessions`, `group:ui`, `group:messaging`, `group:automation`, `group:nodes`, `group:media` and `group:agents`. The plugin knows them as OpenClaw 2026.11.1 has them; a tool OpenClaw adds to a group later stays off for contacts until you name it.

Keys and OpenClaw's own files stay closed whatever the list says: `~/.agentinbox`, any `.env`, OpenClaw's state folder (`~/.openclaw`, with its config, sessions and memory), and OpenClaw's own CLI. Anything OpenClaw's approvals ask about still goes to the operator, never the contact.

OpenClaw reads every contact's message marked as coming from someone outside: a request, never instructions or a permission.

This is a fence, not a wall: a command can still reach a key in ways the plugin doesn't read, such as a script OpenClaw writes first. A contact who may run commands may run any.

## Full access

The operator can give a contact **Full access** on agentinbox.md, for that contact alone, while **Listen to** is on for them. It is off by default.

A message from a contact with full access, in their own direct chat, runs OpenClaw as the operator's own chat does:

- Nothing above limits it, and `contactsCanUse` doesn't apply: files, commands, the web, Agent Inbox's tools, keys and OpenClaw's own files are all open.
- OpenClaw keeps the operator's `USER.md` and `MEMORY.md` in the session.
- OpenClaw reads their message as from someone the operator gave full access, who approves its requests themselves.

Approvals go to that contact, not to the operator: the Allow and Deny card comes in their own conversation, and their Allow counts only while their full access is still on. `agentinbox_ask_operator` still asks the operator. Their commands are still only `/stop`, and OpenClaw's own notices still show only in the operator's conversation.

In a group they are a contact like any other. The switch counts message by message: once the operator turns it off, the contact's next message has a contact's limits again. Turning it on or off starts a fresh session with the next message, so nothing from one level carries into the other.

> **Warning:** full access includes the agent's key and the operator's memory files, and the person can run any command on this computer. Only turn it on for someone you'd trust with your agent's key.

## Sessions

Each conversation gets its own OpenClaw session, so OpenClaw remembers what was said and done in it, whatever `session.dmScope` says for your other channels. When the conversation is resolved, by OpenClaw with `agentinbox_resolve` or by another host, the next message starts a fresh session. A fresh session starts without the earlier talk, though OpenClaw can still read the whole conversation with `agentinbox_read` when asked about it. OpenClaw's answer is sent as the reply, and the chat shows it typing while it works (email has no typing).

The operator's commands work here as in any of their OpenClaw chats (`/stop`, `/new`, …). A contact can only stop the run in their own conversation with `/stop`; anything else they type is a message to OpenClaw.

OpenClaw's own notices, such as a model it couldn't sign in to, show in the operator's own conversation, never in a contact's or a group's.

## Approvals

OpenClaw's own approval settings decide what asks first. When something does, the question goes to the operator, whoever's message started the run, with **Allow** and **Deny**; only a run of a contact with [full access](#full-access) asks that contact instead. No answer in OpenClaw's approval timeout counts as Deny. No other contact ever sees an approval prompt, and none is ever posted as a plain message: when nobody can be asked, it is denied.

**Allow for this session** shows only for the plugin's own send tool. For a command, OpenClaw's "allow always" would add it to OpenClaw's allowlist for good, which the operator does at OpenClaw itself.

OpenClaw asks the people in a conversation with `agentinbox_ask_here`. When it asks with its own `ask_user` tool instead, the question goes to the conversation too, as buttons when there are a few options to pick from. Two options, one to approve and one to deny (Approve, Allow, Accept or Confirm, and Deny, Reject, Decline or Cancel), come as an approval with those two buttons, and OpenClaw gets back the label that was tapped. Yes and No stay a choice, because an answered approval reads "Approved" or "Denied".

## Tools

The plugin gives OpenClaw eight tools. They use the key the plugin already holds, so there is nothing else to set up.

| Tool | What it does |
|---|---|
| `agentinbox_ask_here` | Asks the people in the conversation OpenClaw is in, there: a question they answer in words (`kind: ask`), Approve and Deny buttons (`kind: approve`, with `approve_label` and `deny_label` for other words on them), or one of a few `options` (`kind: choose`). It waits up to 5 minutes for the answer; after that the question stays open, and the answer comes to the chat as a message. |
| `agentinbox_card` | Shows the agent's card: what it says, its name, its email address and the link where anyone can reach it, as `agentinbox card` does in the CLI. The first showing is how agentinbox.md's onboarding sees the agent say hi. Off in a contact's conversation, since its greeting is for the operator. |
| `agentinbox_ask_operator` | Asks the operator something, with the same kinds, from a scheduled job, the Control UI, or another app's chat. It returns at once; the answer comes back, even hours later. Off in a contact's conversation, unless the operator lets contacts use `agentinbox`. |
| `agentinbox_send` | Writes to the operator or to one of their contacts, in a new conversation: a message (`kind: tell`, the default), or a question with the same kinds. The answer comes back to the chat OpenClaw asked from. Off in a contact's conversation. |
| `agentinbox_conversations` | Lists the conversations, latest first. Off in a contact's conversation. |
| `agentinbox_read` | Reads one conversation. In a contact's conversation, only that one. |
| `agentinbox_contacts` | Lists the contacts, and whether the agent listens to each. Off in a contact's conversation. |
| `agentinbox_resolve` | Marks a conversation finished, once what it was about is done. Nothing is sent. The conversation OpenClaw is in is marked after its answer goes out, as any message, OpenClaw's too, opens it again. Another conversation only from the operator's own chat, the Control UI, the terminal, or a scheduled job. |

For example:

- The operator writes: "Ask Ben if he can come on Friday." OpenClaw asks Ben, with Yes and No. When Ben taps Yes, OpenClaw tells the operator in their chat. Ben's answer comes back because OpenClaw asked him; anything else he writes reaches OpenClaw only if **Listen to** is on for him.
- Ben writes: "Can I get a 10% discount?" OpenClaw can't ask the operator from Ben's conversation, so it tells Ben that only the operator can decide that.

Only the operator, and a contact with [full access](#full-access) in their own chat, have OpenClaw write to other people. In any other contact's conversation, and in a group, `agentinbox_send` is off, and a message OpenClaw sends by itself, with its `message` tool, can't go into another conversation. In the operator's own chat, in the Control UI, at the terminal, and in scheduled jobs, OpenClaw writes without asking. In OpenClaw's other channels, it asks first, and OpenClaw's own approvals decide who answers. OpenClaw never writes to the person it is talking with: its answer already goes to them.

A scheduled job can deliver to the operator with the target `operator`: it writes to them in a new conversation.

## One computer at a time

An agent listens on one computer at a time: this gateway, another one, or `npx @agentinbox/cli listen` with another host. When it already listens elsewhere, allowing it here moves it, and the other one stops. When another one takes it over, this gateway stops; restart the gateway to move it back, and the operator is asked again first. To see where it listens:

```bash
openclaw agentinbox status
```

## Profiles

Each OpenClaw profile keeps its own config and state, so it connects on its own: `openclaw --profile <profile> agentinbox setup <agent> --code <code>`. Two profiles can't run the same agent on one computer at once.

## Settings

`setup` writes these under `channels.agentinbox` in OpenClaw's config:

| Key | |
|---|---|
| `secretKey` | The agent's key. |
| `agent` | The agent, by its API name. |
| `apiUrl` | Agent Inbox's API, when it isn't `https://www.agentinbox.md/api`. |
| `enabled` | `false` stops listening without forgetting the connection. |

The plugin's own state (this computer's id, the operator's Allow, where the wait for messages got to) is in `agentinbox/state.json` in OpenClaw's state folder.

## Development

The tests use a fake of Agent Inbox's API and the OpenClaw package installed as a dev dependency. They need Node 24:

```bash
npm install
npm run typecheck
npm test
npm run build
```

To try a local build in OpenClaw:

```bash
npm run build
npm pack
openclaw plugins install npm-pack:./agentinbox-openclaw-0.1.0.tgz --force
```

## License

MIT
