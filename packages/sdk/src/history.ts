import * as Y from "yjs";
import { fromBase64 } from "./base64.js";
import type { Unsubscribe } from "./connection.js";
import { MistyError, asMistyError } from "./errors.js";

export interface RoomVersion {
  id: string;
  at: string;
  size: number;
  by: string;
}

export interface RoomHistory {
  list(): Promise<RoomVersion[]>;
  read(version: string): Promise<Y.Doc>;
  restore(version: string): Promise<void>;
}

export interface HistoryLink {
  send(message: Record<string, unknown>): boolean | Promise<unknown>;
  onMessage(listener: (message: Record<string, unknown>) => void): Unsubscribe;
  onDown?(listener: () => void): Unsubscribe;
  available(): boolean | undefined;
}

const ANSWER_BOUND_MS = 30_000;

const versionsOf = (value: unknown): RoomVersion[] =>
  Array.isArray(value)
    ? value
        .filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null)
        .filter((item) => typeof item.id === "string")
        .map((item) => ({
          id: item.id as string,
          at: typeof item.at === "string" ? item.at : "",
          size: typeof item.size === "number" ? item.size : 0,
          by: typeof item.by === "string" ? item.by : "",
        }))
    : [];

const historyError = (code: unknown, message: unknown): MistyError => {
  const said = typeof message === "string" && message ? message : "";
  if (code === "not_found") return new MistyError("not_found", said || "That version isn't in the room's history.");
  if (code === "read_only" || code === "forbidden")
    return new MistyError("permission_denied", said || "Only someone who can edit this room can restore a version.");
  return new MistyError("internal", said || "The room's history couldn't be read.");
};

export function historyOver(link: HistoryLink): RoomHistory {
  let next = 0;
  let stops: Unsubscribe[] | null = null;
  const pending = new Map<number, { settle: (message: Record<string, unknown>) => void; fail: (error: MistyError) => void }>();
  const listen = () => {
    if (stops) return;
    stops = [
      link.onMessage((message) => {
        const request = message.request;
        if (typeof request !== "number") return;
        pending.get(request)?.settle(message);
      }),
      ...(link.onDown
        ? [
            link.onDown(() => {
              const waiting = [...pending.values()];
              pending.clear();
              for (const each of waiting)
                each.fail(new MistyError("closed", "The room's link dropped before the history answered."));
            }),
          ]
        : []),
    ];
  };
  const ask = (type: string, extra: Record<string, unknown> = {}) =>
    new Promise<Record<string, unknown>>((resolve, reject) => {
      if (link.available() === false) {
        reject(new MistyError("unsupported", "This room keeps no history. Open it with { history: true }."));
        return;
      }
      listen();
      next += 1;
      const request = next;
      const bound = setTimeout(() => {
        if (pending.delete(request)) reject(new MistyError("stalled", "The room's history didn't answer in time."));
      }, ANSWER_BOUND_MS);
      pending.set(request, {
        settle(message) {
          clearTimeout(bound);
          pending.delete(request);
          if (message.type === "error") reject(historyError(message.code, message.message));
          else resolve(message);
        },
        fail(error) {
          clearTimeout(bound);
          reject(error);
        },
      });
      const failed = (error: MistyError) => {
        if (!pending.delete(request)) return;
        clearTimeout(bound);
        reject(error);
      };
      let sent: boolean | Promise<unknown>;
      try {
        sent = link.send({ type, request, ...extra });
      } catch (error) {
        failed(asMistyError(error));
        return;
      }
      if (sent === false) failed(new MistyError("closed", "The room isn't connected right now."));
      else if (sent !== true) sent.catch((error: unknown) => failed(asMistyError(error)));
    });
  return {
    async list() {
      return versionsOf((await ask("list")).versions);
    },
    async read(version) {
      const answer = await ask("read", { version });
      if (typeof answer.update !== "string") throw new MistyError("internal", "The version came back empty.");
      const doc = new Y.Doc({ gc: false });
      Y.applyUpdate(doc, fromBase64(answer.update));
      return doc;
    },
    async restore(version) {
      await ask("restore", { version });
    },
  };
}
