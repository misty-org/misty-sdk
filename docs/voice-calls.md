---
title: Voice calls
order: 7
---

# Voice calls

A Space's voice channels are calls people drop into: no ringing, and whoever is in a channel
hears everyone else in it. With the `calls` permission an app can show them in its own interface and steer
the person's call. The call itself runs in Misty's window, end-to-end encrypted between the people's
computers; an app never touches its sound or video, and neither does the Space's server.

```ts
const stop = misty.calls.channels((channels) => {
  for (const channel of channels) console.log(channel.name, channel.people.length);
});

misty.calls.current((call) => {
  // call.channel_id is the channel this window is in, or null; call.mic_on whether it is unmuted.
});

await misty.calls.join(channelId); // out of any other channel first
await misty.calls.setMuted(true);
await misty.calls.leave();
```

`people` are user ids; `misty.members.list()` names them. `misty.live.voiceChannels()` and `misty.live.call()`
hold the same as values ([Live values](live-values.md)). A voice channel holds at most 8 people, and
`join` fails with `not_found` for a channel that isn't one of the Space's voice channels.
