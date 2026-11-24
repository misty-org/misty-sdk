import { asMistyError } from "./errors.js";
import {
  CLOSE_CODES,
  LOST_LINK,
  openMessage,
  readJson,
  readOpened,
  socketBase,
  type OpenRequest,
  type TokenSource,
  type Transport,
  type TransportConnection,
  type TransportEvents,
} from "./transport.js";

export type WebSocketConstructor = new (url: string) => WebSocket;

export interface WebSocketTransportOptions {
  url: string;
  token: TokenSource;
  WebSocket?: WebSocketConstructor;
}

export function socketConstructor(given?: WebSocketConstructor): WebSocketConstructor | undefined {
  return given ?? (globalThis as { WebSocket?: WebSocketConstructor }).WebSocket;
}

export function webSocketTransport(options: WebSocketTransportOptions): Transport {
  return {
    open(request: OpenRequest, events: TransportEvents): TransportConnection {
      let socket: WebSocket | null = null;
      let closed = false;
      let admitted = false;
      let reported = false;
      const report = (code: number, reason: string) => {
        if (reported || closed) return;
        reported = true;
        events.closed(code, reason);
      };
      const start = (token: string) => {
        if (closed) return;
        const Socket = socketConstructor(options.WebSocket);
        if (!Socket) {
          report(CLOSE_CODES.internal, "This runtime has no WebSocket. Pass one, or use the stream transport.");
          return;
        }
        let opened: WebSocket;
        try {
          opened = new Socket(`${socketBase(request.url ?? options.url)}/v1/collab`);
        } catch (error) {
          report(LOST_LINK, asMistyError(error).message);
          return;
        }
        socket = opened;
        opened.binaryType = "arraybuffer";
        opened.onopen = () => {
          if (closed) return;
          opened.send(JSON.stringify(openMessage(request, token)));
        };
        opened.onmessage = (event: MessageEvent) => {
          if (closed || reported) return;
          const data: unknown = event.data;
          if (typeof data === "string") {
            const message = readJson(data);
            if (!message) return;
            if (!admitted && message.type === "opened") {
              const said = readOpened(message);
              if (!said) return;
              admitted = true;
              events.opened(said);
              return;
            }
            events.text(message);
            return;
          }
          if (data instanceof ArrayBuffer) events.binary(new Uint8Array(data));
          else if (ArrayBuffer.isView(data)) events.binary(new Uint8Array(data.buffer, data.byteOffset, data.byteLength));
        };
        opened.onclose = (event: CloseEvent) => report(event.code || LOST_LINK, event.reason ?? "");
        opened.onerror = () => undefined;
      };
      options.token(request.fresh ? { fresh: true } : undefined).then(start, (error: unknown) => {
        const problem = asMistyError(error);
        report(problem.code === "permission_denied" ? CLOSE_CODES.unauthorized : LOST_LINK, problem.message);
      });
      const open = () => socket !== null && socket.readyState === 1 && admitted && !closed;
      return {
        sendBinary(frame) {
          if (open()) socket?.send(frame);
        },
        sendText(message) {
          if (open()) socket?.send(JSON.stringify(message));
        },
        close() {
          if (closed) return;
          closed = true;
          const was = socket;
          socket = null;
          if (!was) return;
          was.onmessage = null;
          was.onclose = null;
          if (was.readyState === 0) was.onopen = () => was.close(CLOSE_CODES.normal);
          else was.close(CLOSE_CODES.normal);
        },
      };
    },
  };
}
