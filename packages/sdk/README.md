# @misty/sdk

Build apps for a Misty Space: Space files, live Yjs rooms, presence, chat, voice calls and agent tools, over
Misty's channel. One package for any web build, whatever framework or language it's made with. MIT.

```bash
npm install @misty/sdk yjs y-protocols lib0
```

Yjs, `y-protocols` and `lib0` are peer dependencies, so the app, the SDK and an editor's Yjs binding share one copy.
The no-build script, `misty-sdk.js`, carries its own.

```ts
import { connect } from "@misty/sdk";

const misty = await connect();
const room = misty.room.forFile(fileId);
await room.ready;
```

| Entry point | What it is |
| --- | --- |
| `@misty/sdk` | The client: `connect()`, rooms, files, chat, members, calls, live values, the MCP frame transport |
| `@misty/sdk/store` | A plain object store on a room, one entry per key |
| `@misty/sdk/codemirror` | A room bound to CodeMirror 6 (needs `y-codemirror.next`) |
| `@misty/sdk/monaco` | A room bound to Monaco (needs `y-monaco`) |
| `@misty/sdk/prosemirror` | A room bound to ProseMirror (needs `y-prosemirror`) |
| `@misty/sdk/tiptap` | Options for TipTap's Collaboration and caret extensions |
| `@misty/sdk/misty-sdk.js` | A script for pages with no build step: sets `window.MistySDK`, Yjs included |
| `@misty/sdk/misty_theme.css` | Misty's theme tokens |

The guides and the wire protocol are at https://github.com/misty-org/misty-sdk/tree/main/docs.
