import type * as Y from "yjs";
import { MistyError } from "../errors.js";

export function refuseCarriageReturns(text: Y.Text): void {
  if (!text.toString().includes("\r")) return;
  throw new MistyError(
    "unsupported",
    "This file has Windows line endings, which this editor can't keep in step with everyone else's copy.",
  );
}
