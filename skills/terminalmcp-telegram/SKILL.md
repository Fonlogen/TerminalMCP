---
name: terminalmcp-telegram
description: Talk to Telegram through the TerminalMCP `telegram` tool — send messages, upload a file such as a screenshot or log, long-poll for incoming messages with the read offset kept server-side, and edit, delete, pin, react, forward or download what someone sent. Use whenever the `telegram` tool is available and the task involves messaging someone on Telegram, notifying a group, or waiting for a reply.
---

# Telegram through TerminalMCP

## Sending

```
telegram { action: "send", text: "Backup finished, 4.2GB in 6m12s" }
telegram { action: "send", chat: "-1001234567890", text: "…" }
telegram { action: "send_file", path: ".terminalmcp/shots/now.png", caption: "the dashboard" }
```

`send_file` picks photo, video, audio or document from the extension. It pairs
naturally with the `screen` and `browser` tools: capture something, then put it
in front of a person.

Messages over 4096 characters are split rather than rejected. For a long log,
prefer `send_file` — a file beats three consecutive walls of text.

**Formatting is off by default**, and that is the right default: Telegram
rejects the whole message if Markdown is unbalanced, and log output is full of
underscores and asterisks. Only pass `parse_mode` when you are formatting on
purpose and control the text.

## Waiting for a reply

```
telegram { action: "updates", wait: 60 }
```

`getUpdates` long-polls on Telegram's side, so this returns the instant a
message arrives. **One call, not a loop.** The read offset is kept server-side,
so each message is delivered to you once and only once; `peek: true` looks
without consuming, when you want to leave it for a later call.

This is the action to use when you have asked a person something and need their
answer before continuing.

## The two confusions worth knowing

**"chat not found"** almost always means the bot has never spoken to that
person. A bot cannot start a conversation on Telegram — the human must message
it first, or add it to the group. The error says this; pass it on rather than
retrying.

**Privacy mode** means a bot in a group only sees commands and replies to
itself, not ordinary chatter. `me` reports whether it is on. If someone says
"the bot is not seeing my messages", that is usually why, and it is changed
through @BotFather, not from here.

## Finding a chat id

Send the bot a message, then:

```
telegram { action: "updates" }
```

Each line shows `chat <id>`. Put it in `defaultChat` to stop passing it.
Group ids are negative, and supergroup ids start `-100`; copy them exactly.

## Everything else

```
telegram { action: "chat" }                              title, type, member count
telegram { action: "admins" }
telegram { action: "edit", message_id: 123, text: "…" }
telegram { action: "delete", message_id: 123 }
telegram { action: "pin", message_id: 123 }
telegram { action: "react", message_id: 123, emoji: "👍" }
telegram { action: "download", file_id: "…", path: "got.jpg" }
telegram { action: "raw", method: "sendPoll", params: { … } }
```

`download` takes a `file_id` from an incoming message — `updates` prints one
for every attachment.

## Things that will bite you

- **`readOnly`** blocks `send`, `send_file`, `edit`, `delete`, `pin`, `react`,
  `forward` and `raw`. `me`, `updates`, `chat` and `admins` still work.
- **`allowedChats`** may be configured by the operator. A refusal comes back as
  `Policy: …`; report it rather than trying a different chat.
- **A bot may upload at most 50MB.** Archive or trim before sending something
  large.
- Two `updates` calls running at once make Telegram return a 409 conflict. One
  at a time.
