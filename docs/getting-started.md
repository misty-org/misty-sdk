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
| `chat` | Posting into the Space's chat |
| `files` | Picking, opening, saving and watching Space files |
| `room(id)` | A live shared Yjs document |
| `mcpTransport()` | The app's MCP stream for agents |

## Permissions

The manifest, `misty-app.json`, lists what the app asks for: `files`, `chat.post`, `rooms` and `members`. A call
outside what was approved rejects with a `MistyError` whose `code` is `permission_denied`.

## Errors

Every failure is a `MistyError` with a `code`: `permission_denied`, `not_found`, `conflict`, `invalid`,
`unsupported`, `cancelled`, `closed` or `internal`.

## Theme

Add `@misty/sdk/misty-theme.css` for the tokens, and the client applies Misty's theme to the page, so the app
looks like it belongs. Pass `{ applyTheme: false }` to `connect()` to do it yourself.
