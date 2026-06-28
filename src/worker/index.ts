import "dotenv/config";

import { executeRun } from "@/lib/agent/executor";
import {
  claimNextRun,
  addRunEventWithLease,
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

    if (!run.lease_token) throw new Error(`Claimed run ${run.id} has no lease token`);
    const lease = { owner: workerId, token: run.lease_token };
    await addRunEventWithLease(run.id, lease, "claimed", `Claimed by ${workerId}`);
    const leaseHeartbeat = startLeaseHeartbeat({
      leaseMs,
      heartbeat: () => heartbeatRun(run.id, lease, leaseMs),
      onError: (error) => console.error("Lease heartbeat failed", error),
    });
    try {
      await executeRun(run, lease, () => leaseHeartbeat.assertActive());
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
