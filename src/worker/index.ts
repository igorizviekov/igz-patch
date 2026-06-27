import { executeRun } from "@/lib/agent/executor";
import { claimNextRun, addRunEvent } from "@/lib/db/runs";
import { optionalNumberEnv } from "@/lib/env";

const once = process.argv.includes("--once");
const workerId = process.env.IGZPATCH_WORKER_ID || `worker-${process.pid}`;
const pollIntervalMs = optionalNumberEnv("IGZPATCH_POLL_INTERVAL_MS", 5_000);
const leaseMs = optionalNumberEnv("IGZPATCH_LEASE_MS", 10 * 60_000);

async function main(): Promise<void> {
  do {
    const run = await claimNextRun(workerId, leaseMs);
    if (!run) {
      if (once) return;
      await sleep(pollIntervalMs);
      continue;
    }

    await addRunEvent(run.id, "claimed", `Claimed by ${workerId}`);
    await executeRun(run);
  } while (!once);
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});

