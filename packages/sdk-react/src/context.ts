import type { Misty } from "@misty/sdk";
import { createContext, useContext } from "react";

export const MistyContext = createContext<Misty | undefined>(undefined);

/** The connected client. Throws outside a `MistyProvider`, which is a bug in the app. */
export function useMisty(): Misty {
  const misty = useContext(MistyContext);
  if (!misty) throw new Error("useMisty must be used inside a MistyProvider.");
  return misty;
}
