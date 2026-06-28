import "dotenv/config";

import { executeRun } from "@/lib/agent/executor";
import {
  claimNextRun,
  addRunEvent,
  failExhaustedRuns,
  heartbeatRun,
} from "@/lib/db/runs";
import { optionalNumberEnv } from "@/lib/env";
import { startLeaseHeartbeat } from "@/worker/lease";

const once = process.argv.includes("--once");
const workerId = process.env.IGZPATCH_WORKER_ID || `worker-${process.pid}`;
const pollIntervalMs = optionalNumberEnv("IGZPATCH_POLL_INTERVAL_MS", 5_000);
const leaseMs = optionalNumberEnv("IGZPATCH_LEASE_MS", 10 * 60_000);

async function main(): Promise<void> {
  do {
    await failExhaustedRuns();
    const run = await claimNextRun(workerId, leaseMs);
    if (!run) {
      if (once) return;
      await sleep(pollIntervalMs);
      continue;
    }

    await addRunEvent(run.id, "claimed", `Claimed by ${workerId}`);
    const leaseHeartbeat = startLeaseHeartbeat({
      leaseMs,
      heartbeat: () => heartbeatRun(run.id, workerId, leaseMs),
      onError: (error) => console.error("Lease heartbeat failed", error),
    });
    try {
      await executeRun(run);
    } finally {
      await leaseHeartbeat.stop();
    }
  } while (!once);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
