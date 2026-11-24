import type { Connection } from "./connection.js";
import { bytesOf } from "./base64.js";
import type { MistyError } from "./errors.js";
import {
  CLOSE_CODES,
  LOST_LINK,
  readOpened,
  type OpenRequest,
  type RequestTransport,
  type Transport,
  type TransportConnection,
  type TransportEvents,
} from "./transport.js";

const endCode = (error?: MistyError): number => {
  if (!error) return CLOSE_CODES.normal;
  if (error.code === "permission_denied") return CLOSE_CODES.forbidden;
  if (error.code === "not_found") return CLOSE_CODES.not_found;
  if (error.code === "conflict") return CLOSE_CODES.options_conflict;
  if (error.code === "too_large") return CLOSE_CODES.too_large;
  if (error.code === "invalid") return CLOSE_CODES.bad_open;
  return LOST_LINK;
};

export function hostRequests(connection: Connection): RequestTransport {
  return {
    async read({ key, as }) {
      const answer = await connection.call("room.read", { key, as });
      if (!answer) return null;
      if (as === "json") return answer.json ?? {};
      return answer.update === undefined ? null : bytesOf(answer.update);
    },
    async write({ key, update, options }) {
      await connection.call("room.change", { key, update, ...(options ? { options } : {}) });
    },
  };
}

export function hostTransport(connection: Connection, requests = true): Transport {
  return {
    ...(requests ? { request: hostRequests(connection) } : {}),
    open(request: OpenRequest, events: TransportEvents): TransportConnection {
      let conn: string | null = null;
      let closed = false;
      let reported = false;
      let stop: (() => void) | null = null;
      const report = (code: number, reason: string) => {
        if (reported || closed) return;
        reported = true;
        stop?.();
        queueMicrotask(() => events.closed(code, reason));
      };
      const send = (body: { frame?: Uint8Array; message?: Record<string, unknown> }) => {
        if (closed || reported || conn === null) return;
        connection.call("room.frame", { conn, ...body }).catch(() => report(LOST_LINK, ""));
      };
      const ended = connection.subscribe(
        "room.frames",
        { key: request.key, options: request.options },
        (event) => {
          if (closed || reported) return;
          switch (event.type) {
            case "opened": {
              const said = readOpened(event.opened);
              if (!said || conn !== null) return;
              conn = event.conn;
              events.opened(said);
              return;
            }
            case "binary":
              events.binary(bytesOf(event.frame));
              return;
            case "text":
              events.text(event.message);
              return;
            case "closed":
              report(event.code, event.reason);
              return;
            default:
              return;
          }
        },
        (error) => report(endCode(error), error?.message ?? ""),
      );
      if (reported || closed) ended();
      else stop = ended;
      return {
        sendBinary(frame) {
          send({ frame });
        },
        sendText(message) {
          send({ message });
        },
        close() {
          if (closed) return;
          closed = true;
          stop?.();
        },
      };
    },
  };
}
