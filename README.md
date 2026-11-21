# misty-sdk

The SDK for open-source apps that run in a Misty Space, under the MIT license. Misty makes no apps of its own:
every app is someone else's, added to a Space by pasting its GitHub link. This package is for whoever writes an
app's integration with Misty, its maker or anyone else: the app's own MCP tools for agents (over the frame
transport), live co-editing through a shared Yjs document (`room()`), Space files, members and presence, and
posting into the Space's chat. An app with no integration still runs in a Space, wrapped by Misty.

- `@misty/sdk`: a typed client over the sandbox channel (`connect()`), the frame transport for an app's MCP server,
  and `misty-theme.css`.
- `@misty/sdk-react`: `MistyProvider` and hooks (`useSpace`, `useMembers`, `usePresence`, `useRoom`, `useFiles`, ...).

The SDK never imports host code (the host is AGPL). `npm run check:license` and the lint rule enforce it.

```ts
import { connect } from "@misty/sdk";

const misty = await connect();
await misty.chat.post({ channel: "general" }, [{ kind: "text", text: "Hello" }]);
```

Misty's own Code and Lab pages use this same client for their live rooms, presence and cursors, so the SDK has no
powers an app lacks.

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

Pass `{ gc: false }` to keep deleted content in the document (on the app's side and Misty's), for an app that
undoes its own history or shows who deleted what. In React, `useRoom(id, options)` gives the room, whether it has
synced, and why it couldn't open or stopped.

## Docs

The guides are in [`docs/`](docs): getting started, files and chat, live rooms, React and agent tools. They are
plain Markdown with a title and order in their front matter, so the Misty docs site pulls them in as they are.
