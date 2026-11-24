---
title: Agents in a room
order: 6
---

# Agents in a room

When an agent uses an app's tools, its edits should arrive the way a collaborator's do: live for everyone, under
the agent's own name and cursor, and undone on their own. An agent's edit never lands in its person's undo, and
its person's undo never takes it back. `joinAsAgent` gives an agent that place in a room.

```ts
import { agentOfCall, connect, joinAsAgent } from "@misty/sdk";

const misty = await connect();
const room = misty.room.forFile(fileId, { load, serialize });

server.registerTool("add_card", schema, async (args, extra) => {
  const caller = agentOfCall(extra);
  if (!caller) return addCardAsPerson(args);
  const agent = joinAsAgent(room, caller, { scope: (doc) => doc.getMap("cards") });
  agent.transact((doc) => doc.getMap("cards").set(args.id, args));
  agent.setPresence({ selected: [args.id] });
  return { content: [{ type: "text", text: "Added." }] };
});
```

## Who is calling

Misty names the agent behind every tool call:

- An MCP tool (`mcp: "frame"`) finds it in the request's `_meta["misty/agent"]`: `{ id, name }`.
- A registry adapter finds it in the third argument of `window.mistyAdapter.call(name, args, context)`:
  `context.agent`.

`agentOfCall` reads either one and returns `{ id, name }`, or `null` when a person, or an older Misty, made the
call. The app never decides who an agent is: Misty reads it from the agent's own run.

## The agent's own copy

`joinAsAgent(room, agent, options)` returns the same handle for the same agent each time. The agent writes into a
copy of the room's document of its own (`agent.doc`), a Yjs client with its own id, kept in step with the room as
it changes. What it writes reaches the room, and everyone in it, at once, carried as the agent's edits:

- `agent.transact(work)` makes one change in the agent's copy. Make every edit through the `doc` it hands you, the
  same shared types by the same names as the room's.
- Your own code sees the agent's edits arrive on the room's document with `agent.origin` as the transaction's
  origin, never your local origin: apply them to the app as you apply a collaborator's. An editor whose undo
  tracks only the person's own origin keeps agents' edits out of it.
- `options.scope` names the shared types the agent's undo covers. `agent.undo()` and `agent.redo()` take back or
  bring back only that agent's changes. Give agents a tool for it (`undo_my_change`), so an agent can take back its
  own last step without touching anyone else's.

## Where the agent is

The agent has its own awareness state. `agent.setPresence(value)` sets what it is doing (a selection, a cursor,
the page it is on), the way a person's copy of the app publishes theirs; `agent.editing` lists the keys its last
change touched, `{ type, key }` (the shared type's name, and the map key or entry it changed), and is published
with it, so an app can mark what an agent is working on even without a presence of its own.

Misty stamps the agent's state with its identity, as it stamps a person's: `misty` becomes
`{ user_id, name, tone, agent: { id, name } }`, the person being the agent's owner and `name` the agent's. Misty
does this only for an agent it knows is at work in that window (one that called the app's tools or drives it with
its pointer), drops a state that claims any other agent, and takes the agent's state down when that window stops
being one it may act in. `room.identity(clientId)` and `peersOf(room)` return agents with their `agent` field set,
so a presence UI can show "Ana's agent" beside "Ana". The person's own agents show in their own copy of the app
too: `peersOf` lists them, though the room's server never sends them back.

`agent.destroy()` leaves the room and takes its presence down.

## Opening the Space's file

`openDocument(misty, options)` does what nearly every integration needs before any of this: it opens the file
Misty opened the app with as a live document (`room.forFile`), or saves and reopens it plainly where live rooms
aren't available, or starts a blank document and saves it under a free name (`Diagram.mmd`, `Diagram 2.mmd`) on
the first edit.

```ts
const opened = openDocument(misty, {
  extension: ".mmd",
  mime: "text/vnd.mermaid",
  name: "Diagram",
  load: (data, doc) => doc.getText("text").insert(0, new TextDecoder().decode(data)),
  serialize: (doc) => doc.getText("text").toString(),
  current: () => editor.getValue(),
  show: (data) => editor.setValue(new TextDecoder().decode(data)),
  live: (room) => bindToEditor(room),
});
editor.onChange(() => opened.changed());
```

- `load` and `serialize` turn the file into the room's document and back, as `room.forFile` takes them.
- `live(room)` runs once the file's room holds the file: bind the app to it there.
- `show(data, file)` shows a file without a room, and again after someone else saves it while this copy has
  nothing waiting to save.
- `current()` is the app's own content, for a blank document's first save and for saving without a room.
- Call `opened.changed()` after every local edit. With a room it does nothing; without one it saves a second
  after the last edit, and a blank document becomes a file on its first.
- `opened.room`, `opened.file` and `opened.onFile(listener)` say where it stands. `liveRooms: false` keeps it to
  plain saves.
