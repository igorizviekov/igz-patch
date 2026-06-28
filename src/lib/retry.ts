export interface RetryOptions {
  attempts: number;
  baseDelayMs?: number;
  maxDelayMs?: number;
  shouldRetry?: (error: unknown) => boolean;
  sleep?: (delayMs: number) => Promise<void>;
}

export async function withRetry<T>(
  operation: (attempt: number) => Promise<T>,
  options: RetryOptions,
): Promise<T> {
  const attempts = Math.max(1, options.attempts);
  const baseDelayMs = options.baseDelayMs ?? 250;
  const maxDelayMs = options.maxDelayMs ?? 2_000;
  const sleep = options.sleep ?? defaultSleep;

  for (let attempt = 1; attempt <= attempts; attempt += 1) {
    try {
      return await operation(attempt);
    } catch (error) {
      if (attempt === attempts || options.shouldRetry?.(error) === false) throw error;
      await sleep(Math.min(baseDelayMs * 2 ** (attempt - 1), maxDelayMs));
    }
  }

  throw new Error("Retry operation exhausted without a result");
}

export function isTransientError(error: unknown): boolean {
  if (!error || typeof error !== "object") {
    return /timeout|timed out|network|fetch failed|connection/i.test(String(error));
  }

  const status = "status" in error ? Number(error.status) : Number.NaN;
  if ([408, 409, 425, 429].includes(status) || status >= 500) return true;

  const code = "code" in error ? String(error.code) : "";
  if (["ECONNRESET", "ECONNREFUSED", "EHOSTUNREACH", "ENETUNREACH", "ETIMEDOUT"].includes(code)) {
    return true;
  }

  const message = error instanceof Error ? error.message : String(error);
  return /timeout|timed out|network|fetch failed|connection reset|temporarily unavailable|\b429\b|\b5\d\d\b/i.test(
    message,
  );
}

function defaultSleep(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
