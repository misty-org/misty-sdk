---
title: Agent tools
order: 5
---

# Agent tools

## Tools on the page

The simplest way to give agents your app's own tools is to register them on the page, in the shape of WebMCP
(`document.modelContext.registerTool`, a W3C draft). Misty provides `document.modelContext` on every app's page
where the browser has none, so the same code works in Misty today and in browsers once they ship it. No
manifest setting is needed.

```ts
import { agentOfCall, fileInput, registerTool } from "@misty/sdk";

const unregister = await registerTool({
  name: "insert_picture",
  description: "Put a picture on the open slide.",
  inputSchema: {
    type: "object",
    properties: {
      picture: fileInput("The picture, a file in your working folder."),
      rect: { type: "array", items: { type: "number" }, minItems: 4, maxItems: 4 },
    },
    required: ["picture"],
  },
  async execute({ picture, rect }, { signal, agent }) {
    const bytes = await (picture as File).arrayBuffer();
    return { id: deck.insertPicture(bytes, rect) };
  },
});
```

- `execute(input, { signal, agent })` returns any JSON value. `signal` aborts when the agent stops the call,
  and `agent` (or `agentOfCall(options)`) names the agent making it.
- A property made with `fileInput` (or `filesInput` for several) is a path in the agent's working folder. Misty
  reads the file on the person's computer and your tool gets a `File`, so agents never type a file out.
- Registering or unregistering a tool tells the agents' engines at once; register a tool when what it acts on
  exists, and unregister it when it goes.
- Next to your tools, every app gets Misty's screen tools (read, click, type, fill, select, hover, drag, wait
  and upload into a file picker), which act on your page as the person would.

## A server of your own

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
