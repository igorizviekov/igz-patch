export interface LeaseHeartbeat {
  stop(): Promise<void>;
  assertActive(): void;
}

export function startLeaseHeartbeat({
  leaseMs,
  heartbeat,
  onError,
  minimumIntervalMs = 1_000,
}: {
  leaseMs: number;
  heartbeat: () => Promise<void>;
  onError?: (error: unknown) => void;
  minimumIntervalMs?: number;
}): LeaseHeartbeat {
  const intervalMs = Math.max(minimumIntervalMs, Math.floor(leaseMs / 3));
  let pending: Promise<void> | null = null;
  let fatalError: unknown = null;
  const timer = setInterval(() => {
    if (pending || fatalError) return;
    pending = heartbeat()
      .catch((error) => {
        fatalError = error;
        onError?.(error);
      })
      .finally(() => {
        pending = null;
      });
  }, intervalMs);
  timer.unref();

  return {
    async stop() {
      clearInterval(timer);
      await pending;
    },
    assertActive() {
      if (fatalError) throw fatalError;
    },
  };
}
