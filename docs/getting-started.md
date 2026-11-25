---
title: Getting started
order: 1
---

# Getting started

An app runs in a Space inside a sandboxed frame. The SDK is how it reaches the Space: its members, files, chat,
live rooms and theme. Every call is checked by Misty against the permissions the person approved when they
installed the app on their computer. The app learns which Space it's in from `hello`.

```bash
npm install @misty/sdk yjs y-protocols lib0
```

Yjs and its two helpers are peer dependencies, so the app, the SDK and any editor binding share one copy.

```ts
import { connect } from "@misty/sdk";

const misty = await connect();

console.log(misty.space().name, misty.me().name);
await misty.chat.post({ channel: "general" }, [{ kind: "text", text: "Hello" }]);
```

`connect()` waits for Misty to start the app and answer its hello, then resolves with the client. It rejects when
the page isn't running inside Misty, or Misty doesn't answer, after `timeoutMs` (10 seconds by default).

If Misty restarts the app's channel, the client moves over on its own: subscriptions start again, rooms come back
into step, and calls that were waiting fail with `internal`. If it can't (Misty now speaks for another app, Space
or person), the client closes; `misty.onClose(listener)` hears it, and the app should reload. Every call gives up
with `internal` when Misty doesn't answer in time: a minute for most, longer for picking and moving files.

## The client

| Part | What it gives |
| --- | --- |
| `space()`, `me()` | The Space and the person using the app |
| `theme()`, `onTheme()` | Misty's colors and fonts, applied to the document for you |
| `route()`, `onRoute()`, `navigate()` | The app's own address inside the Space |
| `members` | The member list, presence and mention suggestions |
| `chat` | Posting into the Space's chat, opening a chat, notifying someone |
| `files` | Picking, opening, saving and watching Space files, with who has each open |
| `room(key, options)`, `room.forFile(fileId)` | A live shared Yjs document, of the app's own or of a Space file |
| `read(key)`, `change(key, edit)` | A room's content, or one change to it, without joining |
| `calls` | The Space's voice channels and this window's call |
| `agents.control()` | When an agent drives the app in this window |
| `live` | Each of the above that changes, as a value with `get()` and `subscribe()` |
| `mcpTransport()` | The app's MCP stream for agents |
| `supports(name)`, `protocol` | What this Misty answers, and the protocol version in use |

Outside Misty, `connect({ server, space })` connects straight to the Space's server instead: see
[Outside Misty](outside-misty.md).

## Permissions

The manifest, `misty-app.json`, lists what the app asks for: `files`, `chat.post`, `rooms`, `members` and
`calls`. `misty.permissions` is what Misty says the person approved, which may be less than the manifest asks;
don't assume the app got what it asked for. A call outside what was approved rejects with a `MistyError` whose
`code` is `permission_denied`, and that can still happen to a call `permissions` lists, for instance after the
person removes the app or a newer version asks for more.

## Older and newer Misty

An app keeps working on every Misty: Misty speaks every protocol version it ever shipped and only adds to them.
Something added later may not be in the Misty the person has, so ask before using it:

```ts
if (misty.supports("room.sync")) {
  const room = misty.room.forFile(fileId);
}
```

`supports(name)` takes the name of a call (`room.sync`, `room.serialized`), a topic (`agents.control`) or a feature
of one (`room.connection`, `room.problem`: the room events of those names).

The protocol underneath is written up in [Wire protocol](protocol.md), for an app that speaks it without this
package.

## Errors

Every failure is a `MistyError` with a `code`: `permission_denied`, `not_found`, `conflict`, `invalid`,
`unsupported`, `cancelled`, `closed` or `internal`. A live room adds its own (`too_large`, `stalled`, `read_only`
and the rest), listed in [Live rooms](live-rooms.md#staying-in-step).

## Theme

Add `@misty/sdk/misty_theme.css` for the tokens, and the client applies Misty's theme to the page, so the app
looks like it belongs. Pass `{ applyTheme: false }` to `connect()` to do it yourself.
