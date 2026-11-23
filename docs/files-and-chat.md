---
title: Files and chat
order: 2
---

# Files and chat

## Files

A Space's files are its drive: everyone in the Space sees them, and every app can reach them with the `files`
permission.

```ts
const [picked] = await misty.files.pick({ accept: ["image/*"] });

const { file, data } = await misty.files.download(picked.id);

await misty.files.save({ name: "poster.png", mime: "image/png", data: new Uint8Array(data) });
```

- `save` writes into the app's own folder (`/<App name>/`) unless `folder` says otherwise. Saving a file the app
  opened replaces it. If someone changed it meanwhile, a text file merges both; anything else keeps the last
  save, and the one it replaced waits in the trash.
- `list({ folder, accept, limit, cursor })` returns a page; `next_cursor` continues it.
- `watch(listener, { folder, accept })` calls back as files are added, changed or removed, and returns a function
  that stops it.
- `open(fileId, appId?)` opens a file in the app that handles it, this one or another installed app.
- `upload` and `download` move bytes without the picker.

Every `FileRef` carries `in_use`: who has the file open now (`{ user_id, name, editing, you }`), so an app can show
"Ana has this open". `watch` sends a `changed` event when that changes. A file the app opened (with `open`, the
picker, or as a live document) is marked in use by this person until the app lets it go, and can't be trashed
meanwhile. `misty.live.files({ folder })` keeps a folder's files current for you ([Live values](live-values.md)).

To edit a file together, open it as a live document with `misty.room.forFile(fileId)`
([Live rooms](live-rooms.md#a-file-as-a-live-document)).

An app declares the kinds it opens in its manifest with `opens`, such as `image/*` or `.psd`.

## Chat

```ts
await misty.chat.post(
  { channel: "general" },
  [{ kind: "text", text: "Exported " }, { kind: "link", url: "https://example.com", text: "the deck" }],
  { title: "Launch deck", detail: "12 slides", route: { path: "/decks/1", params: {} } },
);
```

`post` adds a message from the person using the app to a channel (`{ channel }`, its id or name) or a direct
message (`{ dm }`, a member's user id). A message is a list of spans: `text`, `mention` or `link`. A link to a
Misty address stays a link; any other address is written out as text. The optional card adds a link under the
message, named by its `title`, that opens this app at `file_id` (or `route.params.file`), with `detail` under it.

- `chat.openChat(target)` takes the person to a chat.
- `chat.notify(userId, text, route?)` tells one member: the person using the app sees a notice, and anyone else
  gets it as a direct message with a link back into the app.

## Members

```ts
const members = await misty.members.list();
const stop = misty.members.presence((presence) => {
  // everyone's state now, and on every change
});
```

`presence` entries carry `state` (`online` or `offline`), `status` (`online`, `idle`, `dnd` or `offline`),
`app_id` (the app the member has open, if any) and `working`, which is true while one of the member's agents is
working in the Space. Nothing inside another person's app is shared. `mentionables(query)` gives what a mention
picker should offer for what was typed: members and mentionable roles, at most 20. Members also carry `tone`,
their avatar color, so an app can draw them as Misty does.

## Agents in the app

An agent can drive the app in its person's window, with its own pointer that Misty draws. The app may show it:

```ts
misty.agents.control(({ agent, driver }) => {
  // agent: { id, name, user_id } while one is in the app, else null.
  // driver: "agent" while it has control, "person" once the person takes it back.
});
```

Misty owns control: one click by the person takes it back.
