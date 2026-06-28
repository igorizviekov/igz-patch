export interface LeaseHeartbeat {
  stop(): Promise<void>;
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
  const timer = setInterval(() => {
    if (pending) return;
    pending = heartbeat()
      .catch((error) => onError?.(error))
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
  };
}
