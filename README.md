# misty-sdk

The SDK for open-source apps that run in a Misty Space, under the MIT license. Misty makes no apps of its own:
every app is someone else's, added to a Space by pasting its GitHub link. This package is for whoever writes an
app's integration with Misty, its maker or anyone else: the app's own MCP tools for agents (over the frame
transport), live co-editing through a shared Yjs document (`room()`), Space files, members and presence, and
posting into the Space's chat. An app with no integration still runs in a Space, wrapped by Misty.

`@misty/sdk` is one package for any web build, whatever framework or language it's made with: a typed client over
the sandbox channel (`connect()`), the frame transport for an app's MCP server, editor bindings, a standalone
script and `misty_theme.css`.

## Publishing

`npm publish -w @misty/sdk` builds it first (`prepublishOnly`) and publishes it publicly. Nothing is published
until the maintainers say so.

The SDK never imports host code (the host is AGPL). `npm run check:license` and the lint rule enforce it.

```ts
import { connect } from "@misty/sdk";

const misty = await connect();
await misty.chat.post({ channel: "general" }, [{ kind: "text", text: "Hello" }]);
```

Misty's own Code and Lab pages, parked for now in `misty-code` and `misty-lab`, use this same client, so the SDK
has no powers an app lacks. For now they speak the protocol's first version, without its syncing and file rooms.

## Live rooms

`room(id)` joins one of the app's shared Yjs documents in the Space, with everyone's awareness (cursors,
selections). Everyone who opens the same room id edits the same document; there is no session to start.

```ts
const room = misty.room("deck-1");
await room.synced; // the room's current state has arrived
room.doc.getText("title").insert(0, "Launch");
room.awareness.setLocalStateField("cursor", { x: 0.4, y: 0.2 });
room.onLost((error) => {
  // "not_found": the room was deleted; "permission_denied": this person can no longer reach it.
});
room.destroy(); // leave, and free the document
```

Pass `{ gc: false }` to keep deleted content in the document (on the app's side and in Misty's copy), for an app
that undoes its own history or shows who deleted what; a Space's server that doesn't keep it yet still collects it
there. Each awareness state carries Misty's own `misty` field (the person's id, name and avatar tone), which the
app can't set or fake; `room.identity(clientId)` reads it. Trust a name only from there: every other awareness
field is whatever the other copy of the app wrote.

A room says whether Misty's link to the server is up (`room.connected`, `onConnection`), hears problems such as a
room that is too large (`onError`), and opens itself again after a passing failure.

`room.forFile(fileId)` opens a Space file as a live document: plain text is saved by the server, and anything else
is saved by the one open copy that holds the writer's lease, through the app's own `load` and `serialize`.
`room.ready` waits until the file's content is in the room.

## Bindings and a script with no build step

`@misty/sdk/codemirror`, `/monaco`, `/prosemirror`, `/tiptap` and `/store` bind a room to an editor in a few
lines, with everyone's cursor drawn by Misty's identity and each person's undo taking back only their own work.
`@misty/sdk/misty-sdk.js` is one script that sets `window.MistySDK`, Yjs included, for pages with no build step and
for registry adapters. See [`docs/bindings.md`](docs/bindings.md).

## Live values

Presence, the voice channels, this window's call, a folder's files and an agent driving the app are each a value
with `get()` and `subscribe()` (`misty.live.presence()` and the rest), the shape React, Svelte and Vue all take.

## Never breaking an app

Misty speaks every protocol version it ever shipped and only adds to them; `misty.supports(name)` says whether
this Misty answers a call or topic. The protocol is the contract under this package, written up in
[`docs/protocol.md`](docs/protocol.md), so an app in any language can speak it.

## Docs

The guides are in [`docs/`](docs): getting started, files and chat, live rooms, editor bindings, agent tools,
voice calls, live values and the wire protocol. They are plain Markdown with a title and order in their front matter, so the Misty
docs site pulls them in as they are.
