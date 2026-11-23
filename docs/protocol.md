---
title: Wire protocol
order: 8
---

# Wire protocol

This is the contract between an app and Misty. `@misty/sdk` is one client of it; an app written in any language
(Rust or Go compiled to WebAssembly, a page with no build step) can speak it directly. What is written here is
kept: Misty speaks every version it ever shipped, and a version only grows by new calls and topics, which an app
finds by asking.

## The start message

When the app's page has loaded, Misty posts one message to the page's own window (in a native webview) or from the
parent frame (in an iframe):

```json
{ "type": "misty:init", "version": 1, "versions": [1] }
```

with a `MessagePort` in `event.ports[0]`. `versions` lists every protocol version this Misty speaks; `version` is
the newest, and is all an older Misty sends. The app picks the highest version both sides speak (from `versions`,
or `[version]` when there is no list) and uses the port for everything after. A page that speaks none of them
closes the port.

Accept the start message only from `window.parent` or the page's own `window`. Misty may post it before the app's
code has run, so listen early (the SDK does at import) and keep the last one.

## Frames

Every message on the port is one frame, an object with a `t` field. Ids are integers the sender of a `req` or
`sub` picks, unique on the port.

| Frame | From | Meaning |
| --- | --- | --- |
| `{ t: "req", id, method, params? }` | app | Call a method |
| `{ t: "res", id, ok: true, result? }` | Misty | The call's result |
| `{ t: "res", id, ok: false, error }` | Misty | The call failed |
| `{ t: "sub", id, topic, params? }` | app | Start a subscription |
| `{ t: "evt", id, data }` | Misty | A subscription's value: its current one first, then each change |
| `{ t: "end", id, error? }` | Misty | The subscription stopped on its own, and why |
| `{ t: "unsub", id }` | app | Stop a subscription; Misty sends nothing after it |
| `{ t: "mcp", message }` | both | One JSON-RPC message of the app's MCP server |

An `error` is `{ code, message }`, `code` one of `permission_denied`, `not_found`, `conflict`, `invalid`,
`unsupported`, `cancelled`, `closed` or `internal`. `message` is a sentence for a person.

Bytes (room updates, file contents) are binary: `Uint8Array` or `ArrayBuffer` in a structured clone over a
`MessagePort`. However Misty carries a frame underneath (the native channel encodes binary fields and moves large
bytes out of band), the page sees the same frames. A frame Misty can't deliver fails its call with an error rather
than going missing.

Unknown frame types, and fields a side doesn't know, are ignored. That is how the protocol grows.

## Hello

The app's first call is `hello`:

```json
{ "t": "req", "id": 1, "method": "hello", "params": { "sdk": "my-app/1.0", "protocol": 1, "versions": [1] } }
```

The result is the app's context:

| Field | What it is |
| --- | --- |
| `app_id` | The app's id |
| `space` | `{ id, name, description?, is_mod }` |
| `me` | `{ user_id, name, role, avatar_version?, tone? }`: the person using the app; `tone` is their avatar color |
| `theme` | `{ mode, tokens, fonts: { sans, mono, css? } }` |
| `route` | `{ path, params }`: the app's own address inside the Space |
| `permissions` | What the Space's mod approved: `files`, `chat.post`, `rooms`, `members`, `calls` |
| `protocol` | The version this connection speaks |
| `versions` | Every version this Misty speaks |
| `offers` | `{ calls: string[], topics: string[] }`: everything this Misty answers |

A Misty that sends no `offers` answers the first version's calls and topics, the ones below not marked as added
later. Before using anything newer, look it up in `offers`; a call Misty doesn't answer fails with `unsupported`.

## Calls

Each needs the permission in its row; a call outside what was approved fails with `permission_denied`.

| Method | Permission | Params | Result |
| --- | --- | --- | --- |
| `hello` | | `{ sdk, protocol, versions? }` | The context above |
| `route.navigate` | | `{ route: { path, params }, replace? }` | |
| `members.list` | `members` | | `Member[]`: `{ user_id, name, role, avatar_version?, joined_at, tone? }` |
| `members.mentionables` | `members` | `{ query }` | `{ kind: "member" \| "role", id, name }[]`, at most 20 |
| `chat.post` | `chat.post` | `{ target, spans, card? }` | `{ message_id }` |
| `chat.open` | `chat.post` | `target` | |
| `chat.notify` | `chat.post` | `{ user_id, text, route? }` | |
| `files.pick` | `files` | `{ accept?, multiple? }` | `FileRef[]` (empty when the person cancels) |
| `files.open` | `files` | `{ file_id, app_id? }` | |
| `files.save` | `files` | `{ name, mime, folder?, data }` | `FileRef` |
| `files.list` | `files` | `{ folder?, accept?, limit?, cursor? }` | `{ files: FileRef[], next_cursor? }` |
| `files.upload` | `files` | `{ name, mime, folder?, data }` | `FileRef` |
| `files.download` | `files` | `{ file_id }` | `{ file: FileRef, data: ArrayBuffer }` |
| `room.update` | `rooms` | `{ id, update }` | |
| `room.awareness` | `rooms` | `{ id, update }` | |
| `room.sync` (added) | `rooms` | `{ id, message }` | `{ messages: bytes[] }` |
| `room.serialized` (added) | `rooms` | `{ id, request, data? , error? }` | |
| `calls.join` | `calls` | `{ channel_id }` | |
| `calls.leave` | `calls` | | |
| `calls.mute` | `calls` | `{ muted }` | |

### Chat

- `target` is `{ channel }` (a channel's id or its name) or `{ dm }` (a member's user id).
- `spans` is a list of `{ kind: "text", text }`, `{ kind: "mention", mention: { kind: "member" | "role", id } }`
  and `{ kind: "link", url, text? }`. A link to a Misty address (`/spaces/…`) stays a link; any other address is
  written out as text.
- `card` is `{ title, detail?, route?, file_id? }`: a link under the message that opens this app, at that file.
- `chat.open` takes the person to that chat in their own window.
- `chat.notify` tells one member: the person using the app sees a notice in their window; anyone else gets it as a
  direct message from them, with a link back to the app.

### Files

A `FileRef` is `{ id, name, mime, size, folder?, updated_at, in_use? }`. `in_use` lists who has the file open now:
`{ user_id, name, editing, you }`. `folder` defaults to the app's own folder (`/<App name>`) for `files.list`,
`files.save` and `files.upload`. Saving a file the app opened writes over it; if someone changed it meanwhile, a
text file merges both and anything else keeps the last save, the replaced one going to the trash.

A file the app opened with `files.open` or `files.pick`, or holds as a live document, is marked in use by this
person while the app keeps it, and can't be trashed meanwhile.

## Topics

| Topic | Permission | Params | Each event |
| --- | --- | --- | --- |
| `theme` | | | The theme |
| `route` | | | The route |
| `members.presence` | `members` | | `Presence[]`, everyone at once |
| `files.watch` | `files` | `{ folder?, accept?, default_folder? }` | `{ kind: "added" \| "changed", file }` or `{ kind: "removed", id }` |
| `room` | `rooms` | `{ id, gc?, sync? }` or `{ file, gc?, sync? }` | A room event, below |
| `calls.channels` | `calls` | | `{ channel_id, name, people: string[] }[]` |
| `calls.current` | `calls` | | `{ channel_id: string \| null, mic_on }` |
| `agents.control` (added) | | | `{ agent: { id, name, user_id } \| null, driver: "person" \| "agent" }` |

- **Presence** is `{ user_id, state, working, status?, app_id? }`: `state` is `online` or `offline`, `status` is
  `online`, `idle`, `dnd` or `offline`, `working` is true while one of the member's agents works in the Space, and
  `app_id` is the app the member has open, if any. Nothing inside another person's app is ever shared.
- **`files.watch`** with no `folder` watches the whole drive; with `default_folder: true`, the same folder
  `files.list` lists by default. A file's `in_use` changing is a `changed` event.
- **`agents.control`** says when an agent is driving the app in this person's window: `agent` is the agent and
  whose it is, `driver` is `agent` while it has control and `person` once the person takes it back. Misty draws
  the agent's pointer and owns control; the app may show this in its own interface.

## Rooms

A room is a Yjs document with awareness, kept on the Space's server.

- `{ id }` is one of the app's own rooms: any id of 1 to 128 of `A-Z a-z 0-9 _ . : -`. Everyone who opens the same
  id shares it.
- `{ file }` opens a Space file as a live document (added), described below. Its room id in calls is
  `file/<file id>`, which no app room id can be.
- `gc: false` keeps deleted content, on both sides.

Room events:

| Event | Meaning |
| --- | --- |
| `{ type: "sync", update }` | A Yjs update to apply. Without `sync`, the first one is the whole document |
| `{ type: "awareness", update }` | A y-protocols awareness update to apply |
| `{ type: "message", message }` (added) | A y-protocols sync message: answer it with `room.sync` |
| `{ type: "file", file, format, writer }` (added) | The file, its format, and whether this copy writes it |
| `{ type: "load", request, version, data }` (added) | Fill the empty room from the file's bytes |
| `{ type: "serialize", request }` (added) | Turn the room into the file's bytes and answer with `room.serialized` |

The app sends its own document changes with `room.update` (a Yjs update) and its awareness with
`room.awareness`.

### Staying in step

With `sync: true`, the app and Misty speak Yjs's own sync protocol (`y-protocols/sync`): a `message` is a sync
step 1 (a state vector), step 2 (what the other side lacks) or an update, without any outer message type.

1. The app subscribes with `sync: true` and calls `room.sync` with its step 1. Misty answers with its step 2 and
   its own step 1; the app applies the first and answers the second with `room.sync`. The room is in step.
2. Misty may send its step 1 as a `message` event at any time (when the room opens, and after its own connection
   to the server comes back); the app answers it the same way.
3. If any `room.update` or `room.sync` fails, the app runs step 1 again, so whatever was lost is sent again rather
   than dropped. Updates are idempotent, so sending one twice is harmless.

Without `sync`, Misty sends the whole document as the first `sync` event, as in the first version.

### Who is who

Misty owns the awareness field `misty`: `{ user_id, name, tone }`, the person behind each awareness state and
their avatar color. Misty writes it into every state the app sends and the server refuses a state that names
anyone else, so it can't be faked. The app's own fields (a cursor, a selection) are its own. An app can only
send states for its own awareness clients.

### Files as live documents

`{ file }` opens the live document of a Space file, after VS Code's custom editors: Misty owns opening, saving
and keeping the document, and the app only turns it into bytes.

- `format` is `text` for plain text (Markdown, code, CSV and the like): the document is the `Y.Text` named
  `text`, and the server saves it into the file itself. Anything else is `app`: the document is the app's own,
  and every app has its own room for the file.
- One open copy holds the writer's lease, held on the server by its connection and passed to another open copy
  when it closes. There is no timer and no election among apps. The `file` event's `writer` says whether this
  copy holds it, and is sent again when that changes.
- When the room is new and this copy writes, Misty fills it: for `text` it puts the file's text in, for `app` it
  sends `load` with the file's bytes. The app fills the document, then sets `loaded` in the map `misty:file` to
  the event's `version`. A room with `loaded` set is never loaded again.
- When the room has changed, Misty asks the writing copy to `serialize`. The app answers
  `room.serialized { id, request, data }` with the file's bytes, or `{ id, request, error }`, and Misty saves the
  file. Nothing unsaved is lost in the meantime: it lives in the room on the server until a writer saves it.
- The file is marked in use by this person while the room is open.

## The MCP stream

`{ t: "mcp", message }` carries the app's MCP server for agents, one JSON-RPC message per frame, in both
directions. See [Agent tools](mcp-tools.md).
