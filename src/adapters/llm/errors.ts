// Classification of model-provider failures (005 FR-513): only transient ones — the provider
// timed out, rate-limited, failed on its side or could not be reached — justify asking another
// provider. Refusals are answers (stopReason), never errors; 4xx means our request is wrong.

export class LlmProviderError extends Error {
  constructor(
    message: string,
    /** HTTP status, or null when no response arrived (timeout, connection failure). */
    readonly status: number | null,
    readonly transient: boolean,
    options?: { cause?: unknown },
  ) {
    super(message, options);
    this.name = "LlmProviderError";
  }
}

const TRANSIENT_NAMES = new Set([
  "APIConnectionTimeoutError",
  "APIConnectionError",
  "TimeoutError",
  "AbortError",
]);

export function isTransientStatus(status: number): boolean {
  return status === 408 || status === 429 || status >= 500;
}

export function isTransientLlmError(err: unknown): boolean {
  if (err instanceof LlmProviderError) return err.transient;
  if (
    err &&
    typeof err === "object" &&
    "primary" in err &&
    err.constructor?.name === "FallbackExhaustedError"
  ) {
    return isTransientLlmError((err as { primary: unknown }).primary);
  }
  if (!(err instanceof Error)) return false;
  if (TRANSIENT_NAMES.has(err.name)) return true;
  const status = (err as { status?: unknown }).status;
  return typeof status === "number" && isTransientStatus(status);
}
