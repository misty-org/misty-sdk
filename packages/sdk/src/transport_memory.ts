import type { RoomOpened } from "./protocol.js";
import type { OpenRequest, RequestTransport, Transport } from "./transport.js";

export interface MemoryPeer {
  readonly request: OpenRequest;
  readonly closed: boolean;
  open(opened: RoomOpened): void;
  sendBinary(frame: Uint8Array): void;
  sendText(message: Record<string, unknown>): void;
  close(code: number, reason?: string): void;
  onBinary(listener: (frame: Uint8Array) => void): () => void;
  onText(listener: (message: Record<string, unknown>) => void): () => void;
  onClose(listener: () => void): () => void;
}

export interface MemoryTransportOptions {
  request?: RequestTransport;
}

const later = (run: () => void) => queueMicrotask(run);

export function memoryTransport(accept: (peer: MemoryPeer) => void, options: MemoryTransportOptions = {}): Transport {
  return {
    ...(options.request ? { request: options.request } : {}),
    open(request, events) {
      let serverClosed = false;
      let clientLeft = false;
      let admitted = false;
      const binary = new Set<(frame: Uint8Array) => void>();
      const text = new Set<(message: Record<string, unknown>) => void>();
      const closes = new Set<() => void>();
      const ended = () => serverClosed || clientLeft;
      const toClient = (deliver: () => void) => {
        if (serverClosed || clientLeft) return;
        later(() => {
          if (!clientLeft) deliver();
        });
      };
      const peer: MemoryPeer = {
        request: structuredClone(request),
        get closed() {
          return ended();
        },
        open(opened) {
          const said = structuredClone(opened);
          toClient(() => {
            if (admitted) return;
            admitted = true;
            events.opened(said);
          });
        },
        sendBinary(frame) {
          const copy = frame.slice();
          toClient(() => {
            if (admitted) events.binary(copy);
          });
        },
        sendText(message) {
          const copy = structuredClone(message);
          toClient(() => {
            if (admitted) events.text(copy);
          });
        },
        close(code, reason = "") {
          if (ended()) return;
          toClient(() => events.closed(code, reason));
          serverClosed = true;
          for (const listener of [...closes]) listener();
        },
        onBinary(listener) {
          binary.add(listener);
          return () => binary.delete(listener);
        },
        onText(listener) {
          text.add(listener);
          return () => text.delete(listener);
        },
        onClose(listener) {
          closes.add(listener);
          return () => closes.delete(listener);
        },
      };
      later(() => {
        if (!ended()) accept(peer);
      });
      const toServer = (deliver: () => void) => {
        if (ended()) return;
        later(() => {
          if (!serverClosed) deliver();
        });
      };
      return {
        sendBinary(frame) {
          const copy = frame.slice();
          toServer(() => {
            for (const listener of [...binary]) listener(copy);
          });
        },
        sendText(message) {
          const copy = structuredClone(message);
          toServer(() => {
            for (const listener of [...text]) listener(copy);
          });
        },
        close() {
          if (ended()) return;
          later(() => {
            if (serverClosed || clientLeft) return;
            clientLeft = true;
            for (const listener of [...closes]) listener();
          });
        },
      };
    },
  };
}
