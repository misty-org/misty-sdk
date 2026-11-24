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

const ERROR_CODES: ReadonlySet<string> = new Set<ErrorCode>([
  "permission_denied",
  "not_found",
  "conflict",
  "invalid",
  "unsupported",
  "cancelled",
  "closed",
  "internal",
  "too_large",
  "too_large_warning",
  "stalled",
  "read_only",
  "save_failed",
  "reloaded",
]);

export function asMistyError(cause: unknown, fallback: ErrorCode = "internal"): MistyError {
  if (cause instanceof MistyError) return cause;
  if (typeof cause === "object" && cause !== null) {
    const { code, message } = cause as { code?: unknown; message?: unknown };
    if (typeof code === "string" && ERROR_CODES.has(code))
      return new MistyError(code as ErrorCode, typeof message === "string" ? message : "");
  }
  const message =
    cause instanceof Error ? cause.message : typeof cause === "string" ? cause : "Something went wrong.";
  return new MistyError(fallback, message || "Something went wrong.");
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
