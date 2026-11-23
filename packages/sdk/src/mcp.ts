import type { Connection } from "./connection.js";

export type McpMessage = object;

export interface FrameTransport {
  onclose?: () => void;
  onerror?: (error: Error) => void;
  onmessage?: (message: McpMessage) => void;
  start(): Promise<void>;
  send(message: McpMessage): Promise<void>;
  close(): Promise<void>;
}

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
