import type { Unsubscribe } from "./connection.js";
import { MistyError } from "./errors.js";

export type LiveStatus = "waiting" | "ready" | "failed";

export interface LiveValue<T> {
  readonly status: LiveStatus;
  readonly value: T | undefined;
  readonly error: MistyError | undefined;
}

export interface Live<T> {
  get(): LiveValue<T>;
  subscribe(listener: (value: LiveValue<T>) => void): Unsubscribe;
}

export type LiveSource<T> = (set: (value: T) => void, fail: (error: MistyError) => void) => Unsubscribe;

const WAITING: LiveValue<never> = Object.freeze({ status: "waiting", value: undefined, error: undefined });

export function live<T>(source: LiveSource<T>): Live<T> {
  let current: LiveValue<T> = WAITING;
  let stop: Unsubscribe | undefined;
  let generation = 0;
  const listeners = new Set<(value: LiveValue<T>) => void>();

  const publish = (next: LiveValue<T>) => {
    current = next;
    for (const listener of [...listeners]) listener(next);
  };

  const start = () => {
    const mine = ++generation;
    const set = (value: T) => {
      if (mine === generation) publish(Object.freeze({ status: "ready", value, error: undefined }));
    };
    const fail = (error: MistyError) => {
      if (mine !== generation) return;
      publish(Object.freeze({ status: "failed", value: current.value, error }));
    };
    try {
      stop = source(set, fail);
    } catch (error) {
      fail(error instanceof MistyError ? error : new MistyError("internal", String(error)));
    }
  };

  return {
    get: () => current,
    subscribe(listener) {
      listeners.add(listener);
      if (listeners.size === 1 && !stop) start();
      listener(current);
      return () => {
        if (!listeners.delete(listener) || listeners.size > 0) return;
        generation += 1;
        const running = stop;
        stop = undefined;
        current = WAITING;
        running?.();
      };
    },
  };
}
