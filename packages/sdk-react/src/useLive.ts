import type { Unsubscribe } from "@misty/sdk";
import { useCallback, useEffect, useRef, useState } from "react";

export interface Loaded<T> {
  /** Undefined until the first value arrives. */
  value: T | undefined;
  /** True until the first value arrives or it fails. */
  loading: boolean;
  error: Error | undefined;
}

const asError = (error: unknown): Error => (error instanceof Error ? error : new Error(String(error)));

/**
 * One value a subscription keeps current. `key` says when to subscribe again (a string, so it is a data
 * dependency); `subscribe` is read through a ref and may be a new function each render.
 */
export function useLive<T>(
  key: string,
  subscribe: (listener: (value: T) => void, onEnd: (error?: Error) => void) => Unsubscribe,
): Loaded<T> {
  const subscribeRef = useRef(subscribe);
  subscribeRef.current = subscribe;
  const [state, setState] = useState<Loaded<T>>({ value: undefined, loading: true, error: undefined });

  useEffect(() => {
    setState({ value: undefined, loading: true, error: undefined });
    return subscribeRef.current(
      (value) => setState({ value, loading: false, error: undefined }),
      (error) => setState((prev) => ({ value: prev.value, loading: false, error: error ?? prev.error })),
    );
  }, [key]);

  return state;
}

/** One value a call loads, and `reload` to fetch it again. `key` says when to load again. */
export function useLoaded<T>(key: string, load: () => Promise<T>): Loaded<T> & { reload: () => void } {
  const loadRef = useRef(load);
  loadRef.current = load;
  const [version, setVersion] = useState(0);
  const [state, setState] = useState<Loaded<T>>({ value: undefined, loading: true, error: undefined });

  useEffect(() => {
    let cancelled = false;
    setState((prev) => ({ value: prev.value, loading: true, error: undefined }));
    loadRef.current().then(
      (value) => {
        if (!cancelled) setState({ value, loading: false, error: undefined });
      },
      (error: unknown) => {
        if (!cancelled) setState((prev) => ({ value: prev.value, loading: false, error: asError(error) }));
      },
    );
    return () => {
      cancelled = true;
    };
  }, [key, version]);

  const reload = useCallback(() => setVersion((v) => v + 1), []);
  return { ...state, reload };
}
