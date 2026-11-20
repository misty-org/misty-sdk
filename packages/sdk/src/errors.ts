import type { ErrorCode, WireError } from "./protocol.js";

/** An error the host answered a call with, or that ended a subscription. */
export class MistyError extends Error {
  readonly code: ErrorCode;

  constructor(code: ErrorCode, message: string) {
    super(message);
    this.name = "MistyError";
    this.code = code;
  }

  static fromWire(error: WireError): MistyError {
    return new MistyError(error.code, error.message);
  }
}
