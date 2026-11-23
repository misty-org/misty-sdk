---
title: Getting started
order: 1
---

# Getting started

An app runs in a Space inside a sandboxed frame. The SDK is how it reaches the Space: its members, files, chat,
live rooms and theme. Every call is checked by Misty against the permissions the Space's mod approved when the
app was installed.

```bash
npm install @misty/sdk
```

```ts
import { connect } from "@misty/sdk";

const misty = await connect();

console.log(misty.space().name, misty.me().name);
await misty.chat.post({ channel: "general" }, [{ kind: "text", text: "Hello" }]);
```

`connect()` waits for Misty to start the app, then resolves with the client. It rejects when the page isn't
running inside Misty, after `timeoutMs` (10 seconds by default).

## The client

| Part | What it gives |
| --- | --- |
| `space()`, `me()` | The Space and the person using the app |
| `theme()`, `onTheme()` | Misty's colors and fonts, applied to the document for you |
| `route()`, `onRoute()`, `navigate()` | The app's own address inside the Space |
| `members` | The member list, presence and mention suggestions |
| `chat` | Posting into the Space's chat, opening a chat, notifying someone |
| `files` | Picking, opening, saving and watching Space files, with who has each open |
| `room(id)`, `room.forFile(fileId)` | A live shared Yjs document, of the app's own or of a Space file |
| `calls` | The Space's voice channels and this window's call |
| `agents.control()` | When an agent drives the app in this window |
| `live` | Each of the above that changes, as a value with `get()` and `subscribe()` |
| `mcpTransport()` | The app's MCP stream for agents |
| `supports(name)`, `protocol` | What this Misty answers, and the protocol version in use |

## Permissions

The manifest, `misty-app.json`, lists what the app asks for: `files`, `chat.post`, `rooms`, `members` and
`calls`. A call outside what was approved rejects with a `MistyError` whose `code` is `permission_denied`.

## Older and newer Misty

An app keeps working on every Misty: Misty speaks every protocol version it ever shipped and only adds to them.
Something added later may not be in the Misty the person has, so ask before using it:

```ts
if (misty.supports("room.sync")) {
  const room = misty.room.forFile(fileId);
}
```

The protocol underneath is written up in [Wire protocol](protocol.md), for an app that speaks it without this
package.

## Errors

Every failure is a `MistyError` with a `code`: `permission_denied`, `not_found`, `conflict`, `invalid`,
`unsupported`, `cancelled`, `closed` or `internal`.

## Theme

Add `@misty/sdk/misty_theme.css` for the tokens, and the client applies Misty's theme to the page, so the app
looks like it belongs. Pass `{ applyTheme: false }` to `connect()` to do it yourself.
