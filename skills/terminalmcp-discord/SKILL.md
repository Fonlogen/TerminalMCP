---
name: terminalmcp-discord
description: Talk to Discord through the TerminalMCP `discord` tool — post messages as a bot or through a webhook, upload a file such as a screenshot or build log, read a channel's recent messages, block until a new one arrives, and edit, delete, react, open threads or list guilds, channels and members. Use whenever the `discord` tool is available and the task involves posting to Discord, reading a channel, or notifying someone there.
---

# Discord through TerminalMCP

## Two modes, and they are not equal

- **Webhook** — a URL. Can only post, to one channel. No setup, no permissions.
- **Bot token** — can read, edit, delete, react, list. Needs an application and
  an invite.

`me` tells you which are configured. If only a webhook is set, `send` uses it
automatically, and everything else will explain that it needs a bot.

## Posting

```
discord { action: "send", text: "Deploy finished: 3 services updated" }
discord { action: "send", channel: "123…", text: "…", reply_to: "456…" }
discord { action: "upload", path: ".terminalmcp/shots/2026-04-11.png", caption: "after the change" }
```

Pair `upload` with the `screen` and `browser` tools: capture, then send the
image where a person will see it. That is the cheapest way to show someone a
result — for them, not for you.

**Pings are suppressed by default.** `@everyone` and role mentions are sent as
plain text unless you pass `mentions: true`. Pinging a whole server by accident
is not recoverable, so ask before you pass it.

Messages over 2000 characters are split rather than rejected. If you are about
to post a long log, consider `upload` instead — a file is easier to read than
six messages, and cheaper for everyone.

## Reading

```
discord { action: "read", limit: 20 }
discord { action: "wait", wait: 60 }
```

`read` gives recent messages, oldest first. `wait` blocks until something new
arrives and returns immediately when it does, so **one call replaces a polling
loop** — that is the whole reason it exists. It resumes from wherever the last
`read` or `wait` got to, so a message that arrives between calls is not missed.

Use `wait` when you have asked a person something and need their answer. Do not
loop `read` on a timer.

## Finding ids

```
discord { action: "guilds" }
discord { action: "channels", guild: "…" }
```

Channel ids are copied from Discord with Developer Mode on (Settings →
Advanced). Setting `defaultChannel` in the config means never passing one.

## The permission errors you will actually hit

- **403 on `members`** — listing members needs the *Server Members* privileged
  intent, enabled in the developer portal. The error says so.
- **403 on a channel** — the bot's role cannot see or post there. That is a
  Discord permission for a person to fix, not something to retry.
- **429** — handled for you: the tool waits exactly as long as Discord asks and
  retries once. Twice in a row means you are going too fast; slow down rather
  than looping.

## Things that will bite you

- **Message ids are huge numbers.** Pass them exactly as you received them; do
  not reformat or round them.
- **`readOnly`** blocks `send`, `upload`, `edit`, `delete`, `react`, `thread`
  and `raw`. `me`, `guilds`, `channels`, `read` and `wait` still work.
- **`allowedChannels`** may be configured. A refusal is a `Policy: …` message —
  report it rather than trying another channel.
- The gateway is not used, so there is no presence, no typing events from
  others, and no voice. `wait` polls; that is by design.
