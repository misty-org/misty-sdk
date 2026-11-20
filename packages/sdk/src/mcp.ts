import type { Connection } from "./connection.js";

/** A JSON-RPC message of the Model Context Protocol. The SDK carries it and never reads it. */
export type McpMessage = object;

/**
 * The slice of the MCP library's `Transport` that the SDK provides, so an app can hand it straight to
 * the official library: `await new McpServer(...).connect(createFrameTransport(misty))`.
 */
export interface FrameTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: McpMessage) => void;
  start(): Promise<void>;
  send(message: McpMessage): Promise<void>;
  close(): Promise<void>;
}

/** The app's MCP stream (`mcp: frame` in its manifest): JSON-RPC over the SDK channel, to the host. */
export function createFrameTransport(connection: Connection): FrameTransport {
  let stopListening: (() => void) | undefined;
  let stopClosing: (() => void) | undefined;

  const transport: FrameTransport = {
    async start() {
      if (stopListening) throw new Error("The frame transport is already started.");
      stopListening = connection.onMcp((message) => {
        if (typeof message === "object" && message !== null) transport.onmessage?.(message as McpMessage);
        else transport.onerror?.(new Error("The host sent an MCP message that is not JSON-RPC."));
      });
      stopClosing = connection.onClose(() => {
        stopListening?.();
        stopListening = undefined;
        transport.onclose?.();
      });
    },
    async send(message) {
      if (connection.isClosed) throw new Error("The connection to Misty is closed.");
      connection.sendMcp(message);
    },
    async close() {
      stopListening?.();
      stopClosing?.();
      stopListening = undefined;
      stopClosing = undefined;
      transport.onclose?.();
    },
  };
  return transport;
}
