import assert from "node:assert/strict";
import { createHmac } from "node:crypto";
import test from "node:test";

import { assertCommandSucceeded, runProcess } from "@/lib/agent/command";
import { optionalNumberEnv } from "@/lib/env";
import { verifyGitHubSignature } from "@/lib/github/signature";
import { redactText } from "@/lib/redaction";
import { isTransientError, withRetry } from "@/lib/retry";
import { startLeaseHeartbeat } from "@/worker/lease";

test("retry applies bounded exponential delays and returns the successful result", async () => {
  const delays: number[] = [];
  let calls = 0;
  const result = await withRetry(
    async () => {
      calls += 1;
      if (calls < 3) throw new Error("temporary network failure");
      return "ok";
    },
    {
      attempts: 3,
      baseDelayMs: 10,
      sleep: async (delay) => {
        delays.push(delay);
      },
    },
  );

  assert.equal(result, "ok");
  assert.equal(calls, 3);
  assert.deepEqual(delays, [10, 20]);
});

test("transient error detection distinguishes retryable service failures", () => {
  assert.equal(isTransientError({ status: 503 }), true);
  assert.equal(isTransientError(Object.assign(new Error("reset"), { code: "ECONNRESET" })), true);
  assert.equal(isTransientError({ status: 422 }), false);
});

test("lease heartbeat renews periodically and stops cleanly", async () => {
  let heartbeats = 0;
  const lease = startLeaseHeartbeat({
    leaseMs: 30,
    minimumIntervalMs: 5,
    heartbeat: async () => {
      heartbeats += 1;
    },
  });

  await wait(35);
  await lease.stop();
  const stoppedAt = heartbeats;
  await wait(20);
  assert.ok(stoppedAt >= 2);
  assert.equal(heartbeats, stoppedAt);
});

test("lease heartbeat makes renewal failures fatal to the worker", async () => {
  const lease = startLeaseHeartbeat({
    leaseMs: 20,
    minimumIntervalMs: 5,
    heartbeat: async () => {
      throw new Error("lease lost");
    },
  });
  await wait(15);
  assert.throws(() => lease.assertActive(), /lease lost/);
  await lease.stop();
});

test("process output is bounded and terminates flooding commands", async () => {
  const result = await runProcess({
    command: process.execPath,
    args: ["-e", "process.stdout.write('x'.repeat(100000))"],
    cwd: process.cwd(),
    timeoutMs: 5_000,
    maxOutputBytes: 256,
  });
  assert.equal(result.outputLimitExceeded, true);
  assert.ok(Buffer.byteLength(result.stdout) <= 256);
  assert.throws(() => assertCommandSucceeded(result), /output limit/);
});

test("webhook signatures are verified without accepting malformed values", () => {
  const body = JSON.stringify({ action: "labeled" });
  const secret = "webhook-secret";
  const signature = `sha256=${createHmac("sha256", secret).update(body).digest("hex")}`;
  assert.equal(verifyGitHubSignature({ body, secret, signature }), true);
  assert.equal(verifyGitHubSignature({ body, secret, signature: "sha256=wrong" }), false);
  assert.equal(verifyGitHubSignature({ body, secret, signature: null }), false);
});

test("audit redaction removes token bodies and private keys", () => {
  const value = [
    "token sk-exampleSecret123",
    "github github_pat_exampleSecret456",
    "Authorization: Basic dXNlcjpzZWNyZXQ=",
    "DATABASE_URL=postgres://user:password@db.example/app",
    "-----BEGIN PRIVATE KEY-----",
    "secret-material",
    "-----END PRIVATE KEY-----",
  ].join("\n");
  const redacted = redactText(value, ["sk-", "github_pat_"]);
  assert.doesNotMatch(redacted, /exampleSecret|secret-material|dXNlcjpzZWNyZXQ|user:password/);
  assert.match(redacted, /\[REDACTED\]/);
  assert.match(redacted, /\[REDACTED PRIVATE KEY\]/);
});

test("numeric worker settings reject zero and negative values", () => {
  const previous = process.env.TEST_INTERVAL;
  try {
    process.env.TEST_INTERVAL = "0";
    assert.throws(() => optionalNumberEnv("TEST_INTERVAL", 1), /positive number/);
    process.env.TEST_INTERVAL = "-5";
    assert.throws(() => optionalNumberEnv("TEST_INTERVAL", 1), /positive number/);
  } finally {
    if (previous === undefined) delete process.env.TEST_INTERVAL;
    else process.env.TEST_INTERVAL = previous;
  }
});

function wait(delayMs: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, delayMs));
}
