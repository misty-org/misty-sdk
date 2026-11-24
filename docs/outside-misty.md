---
title: Outside Misty
order: 10
---

# Outside Misty

The same rooms an app opens inside Misty can be opened from anywhere else: a script, a CLI, an editor plugin, a
test, a bot or a server. `connect()` with a server connects straight to it instead of to Misty's window, and
`room()`, `read()` and `change()` work the same way.

```ts
import { connect } from "@misty/sdk";

const misty = await connect({ server: "https://api.example.com", space: "sp_…" });
const board = misty.room("board", { history: true });
await board.synced;
board.doc.getText("title").insert(0, "Q4");

await misty.change("notes", (doc) => doc.getText("text").insert(0, "Hello "));
misty.close();
```

The client has `room`, `read`, `change`, `identity` (who this sign-in is), `spaceId`, `onClose`, `close` and
`signOut`. Members, chat, files and calls are Misty's window's, so they aren't here.

## Signing in

There are two kinds of sign-in, by who the code acts as.

**A person's own code** (scripts, a CLI, tests) uses device sign-in. With no token, `connect({ server, space })`
asks the server for a code, prints a line with a link that opens Misty on it, and waits while the person approves
it there. Nothing polls: the wait is one held request. The session is kept in the OS keychain (macOS Keychain,
Windows Credential Manager, the Secret Service on Linux), shared with `misty login` in misty-cli, and never in a
file in the project. The next run reuses it without asking.

```ts
const misty = await connect({
  server: "https://api.example.com",
  space: "sp_…",
  name: "release script on studio-mac", // how the session is listed in Settings › Account › Devices
  onCode: ({ url, code }) => show(`Open ${url} and check the code ${code}`), // instead of the printed line
});
await misty.signOut(); // ends this session and forgets it
```

The keychain is the optional dependency `@napi-rs/keyring`, loaded only in Node and only when a session is kept.
Without it, or with `keychain: false`, the session lasts as long as the process. Access tokens last five minutes;
the SDK refreshes them before they run out.

**Code that runs on its own in a shared Space** (bots, webhooks, servers) uses a Space integration, made from the
Space menu's Integrations. Its token, `misty_int_…`, is shown once. Keep it in your own secret store and pass it:

```ts
const misty = await connect({ server: "https://api.example.com", token: process.env.MISTY_TOKEN });
```

The SDK trades it for a five-minute access token and trades it again before that runs out. An integration belongs
to one Space, so `space` can be left out, and it shows in presence under its own name. It reaches only what it was
given (rooms read or write, and only keys under its prefix).

The SDK never logs a token.

## Transports

A room speaks one protocol (an open message, Yjs sync and awareness frames, and option messages), and a transport
carries it. Nothing above the transport knows which one is in use.

| Transport | Carries | Pick it for |
| --- | --- | --- |
| `webSocketTransport` | one WebSocket per room, to `/v1/collab` | the default wherever there is a WebSocket |
| `streamTransport` | frames down as a server-sent event stream, frames up as POSTs | proxies and runtimes where WebSockets are awkward |
| `requestTransport` | one request, no session | `read` and `change` |
| `hostTransport` | Misty's own channel | inside Misty; `connect()` picks it |
| `memoryTransport` | two ends in one process | tests |

`connect({ server })` uses a WebSocket (or the stream where there is none; `via: "stream"` picks it) and the
request transport for `read` and `change`. The room address comes from the server's `/v1/health` (`collab_url`),
falling back to the API's own host; `collab` names it yourself. Pass
`WebSocket` and `fetch` to use your own.

`connect({ transport, space })` names one, such as a test's in-memory one:

```ts
import { connect, memoryTransport } from "@misty/sdk";

const transport = memoryTransport((peer) => {
  peer.open({ room: "rm_1", role: "edit", options: peer.request.options, seats: 40, max_bytes: 8 << 20,
    identity: { kind: "person", id: "u1", name: "Ana" } });
  peer.onBinary((frame) => {/* answer sync frames like the server does */});
});
const misty = await connect({ transport, space: "sp_1" });
```

A room reconnects by itself by the server's close code: a room that lost access, was deleted, was opened with
other options, or whose sign-in was signed out stops for good (`onLost`); one moved to another server reconnects
there at once; one whose sign-in needs renewing gets a fresh access token and reconnects at once; anything else
reconnects after a pause that grows with each failure in a row.

## File rooms

`room(key, { file })` and `room.forFile(fileId)` work here too. The SDK runs the file's side itself (who writes,
loading, saving with the version it started from, conflicted copies, renames and changes made elsewhere) and reads
and saves through the Space's drive under the same sign-in, so the file is marked in use by this person while the
room is open. Pass `files` to use another `FileStore`.

## For hosts

Misty's window uses the same pieces the SDK runs outside it, so there is one implementation of each:

- `openRoomClient({ transport, space, key, options, identity })` is one room over a transport: its `doc`,
  `awareness`, `synced`, `opened` (the server's `opened` message), `history`, reconnection, and option messages
  (`send`, `onMessage`).
- `fileRoomOpener({ store, open })` runs the `file` option over a room client and a `FileStore`, the drive it reads
  and saves through: `entry`, `read`, `write` (with the version the save started from), `copy` (a file beside it),
  `watch` (the drive's changes, pushed), and optionally `hold` (marking it in use), `versions` (the server's
  content version) and `ref`.
- `createRoomBridge({ identity, source, files })` is the host's side of the app protocol's rooms: the calls and the
  `room` topic, over those two.
