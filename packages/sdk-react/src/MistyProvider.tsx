import { connect } from "@misty/sdk";
import type { ConnectOptions, Misty } from "@misty/sdk";
import { useEffect, useState } from "react";
import type { ReactNode } from "react";
import { MistyContext } from "./context.js";

export interface MistyProviderProps {
  children: ReactNode;
  /** Shown while the app connects to Misty. */
  pending?: ReactNode;
  /** Shown when it can't, such as when the page isn't running inside Misty. */
  failed?: (error: Error) => ReactNode;
  /** An already connected client, for tests and previews. Skips `connect`. */
  client?: Misty;
  options?: ConnectOptions;
}

type State = { status: "pending" } | { status: "ready"; misty: Misty } | { status: "failed"; error: Error };

/** Connects once and provides the client to the hooks below it. */
export function MistyProvider({ children, pending = null, failed, client, options }: MistyProviderProps) {
  const [state, setState] = useState<State>(client ? { status: "ready", misty: client } : { status: "pending" });
  const timeoutMs = options?.timeoutMs;
  const applyTheme = options?.applyTheme;

  useEffect(() => {
    if (client) {
      setState({ status: "ready", misty: client });
      return;
    }
    let cancelled = false;
    let connected: Misty | undefined;
    setState({ status: "pending" });
    connect({ timeoutMs, applyTheme }).then(
      (misty) => {
        if (cancelled) misty.close();
        else {
          connected = misty;
          setState({ status: "ready", misty });
        }
      },
      (error: unknown) => {
        if (!cancelled) setState({ status: "failed", error: error instanceof Error ? error : new Error(String(error)) });
      },
    );
    return () => {
      cancelled = true;
      connected?.close();
    };
  }, [client, timeoutMs, applyTheme]);

  if (state.status === "pending") return <>{pending}</>;
  if (state.status === "failed") return <>{failed ? failed(state.error) : null}</>;
  return <MistyContext.Provider value={state.misty}>{children}</MistyContext.Provider>;
}
