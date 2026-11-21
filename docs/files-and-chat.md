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

An app declares the kinds it opens in its manifest with `opens`, such as `image/*` or `.psd`.

## Chat

```ts
await misty.chat.post(
  { channel: "general" },
  [{ kind: "text", text: "Exported " }, { kind: "link", url: "https://example.com", text: "the deck" }],
  { title: "Launch deck", detail: "12 slides", route: { path: "/decks/1", params: {} } },
);
```

`post` adds an app message to a channel or a direct message (`{ channel }` or `{ dm }`). The optional card gives
it an Open button that leads back into the app at `route`. A message is a list of spans: `text`, `mention` or
`link`.

- `chat.openChat(target)` takes the person to a chat.
- `chat.notify(userId, text, route?)` sends one person a notification.

## Members

```ts
const members = await misty.members.list();
const stop = misty.members.presence((presence) => {
  // everyone's state now, and on every change
});
```

`presence` entries carry `state` (`online` or `offline`) and `working`, which is true while one of the member's
agents is working in the Space. `mentionables(query)` gives what a mention picker should offer for what was typed.
