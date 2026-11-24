import { fromBase64 } from "./base64.js";
import { asMistyError } from "./errors.js";
import {
  CLOSE_CODES,
  LOST_LINK,
  fetchFollowing,
  httpBase,
  openMessage,
  readEvents,
  readJson,
  readOpened,
  statusClose,
  type OpenRequest,
  type TokenSource,
  type Transport,
  type TransportConnection,
  type TransportEvents,
} from "./transport.js";

export interface StreamTransportOptions {
  url: string;
  token: TokenSource;
  fetch?: typeof fetch;
}

const fetcher = (given?: typeof fetch): typeof fetch => given ?? ((input, init) => fetch(input, init));

async function codeIn(response: Response): Promise<unknown> {
  try {
    return readJson(await response.text())?.code;
  } catch {
    return undefined;
  }
}

export function streamTransport(options: StreamTransportOptions): Transport {
  const run = fetcher(options.fetch);
  return {
    open(request: OpenRequest, events: TransportEvents): TransportConnection {
      const abort = new AbortController();
      let base = httpBase(request.url ?? options.url);
      let conn: string | null = null;
      let closed = false;
      let reported = false;
      let queue: Promise<void> = Promise.resolve();
      const report = (code: number, reason: string) => {
        if (reported) return;
        reported = true;
        abort.abort();
        if (!closed) events.closed(code, reason);
      };
      const start = async () => {
        const token = await options.token(request.fresh ? { fresh: true } : undefined);
        if (closed) return;
        const { response, url } = await fetchFollowing(run, `${base}/v1/collab/stream`, {
          method: "POST",
          headers: {
            Authorization: `Bearer ${token}`,
            "Content-Type": "application/json",
            Accept: "text/event-stream",
          },
          body: JSON.stringify(openMessage(request)),
          signal: abort.signal,
        });
        base = httpBase(new URL(url).origin);
        if (!response.ok || !response.body) {
          report(statusClose(response.status, await codeIn(response)), "");
          return;
        }
        let admitted = false;
        await readEvents(response.body, ({ event, data }) => {
          if (closed || reported) return true;
          if (event === "opened") {
            const said = readOpened(readJson(data));
            if (!said || admitted) return false;
            admitted = true;
            conn = said.conn ?? null;
            if (conn === null) {
              report(CLOSE_CODES.bad_open, "The stream didn't name its connection.");
              return true;
            }
            events.opened(said);
            return false;
          }
          if (event === "b") {
            let frame: Uint8Array;
            try {
              frame = fromBase64(data);
            } catch {
              return false;
            }
            events.binary(frame);
            return false;
          }
          if (event === "t") {
            const message = readJson(data);
            if (message) events.text(message);
            return false;
          }
          if (event === "close") {
            const said = readJson(data) ?? {};
            report(typeof said.code === "number" ? said.code : LOST_LINK, typeof said.reason === "string" ? said.reason : "");
            return true;
          }
          return false;
        });
        report(LOST_LINK, "");
      };
      start().catch((error: unknown) => {
        const problem = asMistyError(error);
        report(problem.code === "permission_denied" ? CLOSE_CODES.unauthorized : LOST_LINK, problem.message);
      });
      const post = (body: BodyInit, type: string) => {
        if (closed || reported || conn === null) return;
        const at = conn;
        queue = queue
          .then(async () => {
            if (reported) return;
            const token = await options.token();
            const { response } = await fetchFollowing(run, `${base}/v1/collab/stream/${encodeURIComponent(at)}`, {
              method: "POST",
              headers: { Authorization: `Bearer ${token}`, "Content-Type": type },
              body,
            });
            await response.body?.cancel().catch(() => undefined);
            if (response.ok || response.status === 404) return;
            report(statusClose(response.status), "");
          })
          .catch(() => report(LOST_LINK, ""));
      };
      return {
        sendBinary(frame) {
          post(new Uint8Array(frame), "application/octet-stream");
        },
        sendText(message) {
          post(JSON.stringify(message), "application/json");
        },
        close() {
          if (closed) return;
          closed = true;
          void queue.finally(() => abort.abort());
        },
      };
    },
  };
}
