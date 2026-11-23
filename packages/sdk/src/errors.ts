import type { ErrorCode, WireError } from "./protocol.js";

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

export function safely(run: () => void): void {
  try {
    run();
  } catch (error) {
    queueMicrotask(() => {
      throw error;
    });
  }
}
