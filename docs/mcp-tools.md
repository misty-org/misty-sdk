---
title: Agent tools
order: 5
---

# Agent tools

An app that sets `mcp: "frame"` in its manifest can give agents its own tools. The SDK carries the app's MCP
stream between the app and Misty over the same channel; you hand it to the official MCP library.

```ts
import { connect } from "@misty/sdk";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

const misty = await connect();
const server = new McpServer({ name: "deck", version: "1.0.0" });

// register tools on `server`...

await server.connect(misty.mcpTransport());
```

`mcpTransport()` returns a `FrameTransport`: `start`, `send`, `close` and the `onmessage`, `onerror` and `onclose`
callbacks. The SDK never reads the messages; it only carries them. A tool call from an agent reaches the app
through the same gate as any other action, so it can only do what the app was approved to do.

Each call names the agent making it in `_meta["misty/agent"]`; `agentOfCall(extra)` reads it. To make the
agent's edits its own, live and with their own undo, see [Agents in a room](agents-in-rooms.md).

An app that needs a native server uses `mcp: "binary"` instead.
