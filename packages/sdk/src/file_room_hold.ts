import * as decoding from "lib0/decoding";
import * as syncProtocol from "y-protocols/sync";
import * as Y from "yjs";
import type { RoomClient } from "./room_client.js";

export interface FreezeMark {
  asks: number;
  link: number;
}

export interface SyncHold {
  readonly active: boolean;
  readonly asks: number;
  start(): void;
  arm(ms: number, stalled: () => void): void;
  release(replay: boolean): void;
  resendAll(): void;
  resendAfterFreeze(since: FreezeMark, link: number, ms: number): void;
  stop(): void;
}

export type HoldLink = Pick<RoomClient, "doc" | "tapSync" | "applySync" | "sendUpdate" | "linked">;

const asksResend = (message: Uint8Array) => {
  try {
    return decoding.peekVarUint(decoding.createDecoder(message)) === syncProtocol.messageYjsSyncStep1;
  } catch {
    return false;
  }
};

export function holdSync(link: HoldLink): SyncHold {
  let held: Uint8Array[] | null = null;
  let timer: ReturnType<typeof setTimeout> | undefined;
  let asks = 0;
  let resendTimer: ReturnType<typeof setTimeout> | undefined;
  link.tapSync({
    incoming(message) {
      if (asksResend(message)) {
        asks += 1;
        clearTimeout(resendTimer);
        resendTimer = undefined;
      }
      if (!held) return false;
      held.push(message.slice());
      return true;
    },
    outgoing: () => held !== null,
  });
  const stop = () => {
    clearTimeout(timer);
    timer = undefined;
  };
  const resendAll = () => {
    clearTimeout(resendTimer);
    resendTimer = undefined;
    if (held || !link.linked) return;
    link.sendUpdate(Y.encodeStateAsUpdate(link.doc));
  };
  return {
    get active() {
      return held !== null;
    },
    get asks() {
      return asks;
    },
    start() {
      stop();
      held = [];
    },
    arm(ms, stalled) {
      if (!held) return;
      stop();
      timer = setTimeout(() => {
        timer = undefined;
        if (held) stalled();
      }, ms);
    },
    release(replay) {
      stop();
      const queued = held;
      held = null;
      if (!queued || !replay) return;
      for (const message of queued) link.applySync(message);
    },
    resendAll,
    resendAfterFreeze(since, at, ms) {
      if (since.link !== at) {
        resendAll();
        return;
      }
      if (asks > since.asks) return;
      clearTimeout(resendTimer);
      resendTimer = setTimeout(resendAll, ms);
    },
    stop() {
      stop();
      clearTimeout(resendTimer);
      resendTimer = undefined;
    },
  };
}
