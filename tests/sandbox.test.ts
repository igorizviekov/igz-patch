import assert from "node:assert/strict";
import test from "node:test";

import { defaultRepoConfig } from "@/lib/agent/repo-config";
import { buildDockerRunArgs } from "@/lib/agent/sandbox";

test("Docker setup containers enforce resources and allow setup networking", () => {
  const config = structuredClone(defaultRepoConfig);
  config.sandbox.cpu_limit = 1.5;
  config.sandbox.memory_mb = 2048;
  config.sandbox.setup_network = "enabled";
  const args = buildDockerRunArgs({
    name: "igzpatch-test-setup",
    workspace: "/tmp/repository",
    image: "node:22-bookworm",
    phase: "setup",
    config,
    entrypoint: "sh",
    commandArgs: ["-s"],
  });

  assertArgPair(args, "--network", "bridge");
  assert.equal(args.includes("seccomp=unconfined"), false);
  assert.ok(args.includes("--interactive"));
  assert.ok(args.includes("--init"));
  assertArgPair(args, "--cpus", "1.5");
  assertArgPair(args, "--memory", "2048m");
  assertArgPair(args, "--memory-swap", "2048m");
  assertArgPair(args, "--pids-limit", "256");
  assertArgPair(args, "--cap-drop", "ALL");
  assertArgPair(args, "--security-opt", "no-new-privileges");
  assertArgPair(args, "--volume", "/tmp/repository:/workspace:rw");
  assert.ok(args.includes("/tmp/repository/.git:/workspace/.git:ro"));
  assert.ok(args.includes("--read-only"));
  assertArgPair(args, "--tmpfs", "/tmp:rw,noexec,nosuid,size=268435456");
  assert.ok(args.includes("/codex-home:rw,nosuid,size=67108864"));
  assert.equal(args.filter((arg) => arg.includes(":/workspace")).length, 2);
});

test("Docker run phase disables network and never exposes environment values in arguments", () => {
  const config = structuredClone(defaultRepoConfig);
  config.sandbox.run_network = "enabled";
  const args = buildDockerRunArgs({
    name: "igzpatch-test-run",
    workspace: "/tmp/repository",
    image: "node:22-bookworm",
    phase: "run",
    config,
    entrypoint: "sh",
    commandArgs: ["-s"],
    containerEnv: { SECRET_TOKEN: "not-visible" },
  });

  assertArgPair(args, "--network", "none");
  assertArgPair(args, "--env", "SECRET_TOKEN");
  assert.equal(args.includes("not-visible"), false);
});

test("Codex provider container keeps API networking constrained by the default seccomp policy", () => {
  const config = structuredClone(defaultRepoConfig);
  const args = buildDockerRunArgs({
    name: "igzpatch-test-codex",
    workspace: "/tmp/repository",
    image: "igzpatch/codex-agent:0.1.0",
    phase: "provider",
    config,
    entrypoint: "codex",
    commandArgs: [
      "exec",
      "--config",
      "sandbox_workspace_write.network_access=false",
      "-",
    ],
    containerEnv: {
      CODEX_API_KEY: "not-visible",
      CODEX_HOME: "/codex-home",
      LD_PRELOAD: "/usr/local/lib/libigzpatch-nodump.so",
    },
    workspaceReadOnly: true,
  });

  assertArgPair(args, "--network", "bridge");
  assert.ok(args.includes("--interactive"));
  assert.equal(args.includes("--init"), false);
  assert.equal(args.includes("seccomp=unconfined"), false);
  assert.ok(args.some((arg, index) => arg === "--env" && args[index + 1] === "CODEX_HOME"));
  assert.ok(args.some((arg, index) => arg === "--env" && args[index + 1] === "LD_PRELOAD"));
  assert.ok(args.includes("/codex-home:rw,nosuid,size=67108864"));
  assert.ok(args.includes("sandbox_workspace_write.network_access=false"));
  assert.equal(args.at(-1), "-");
  assert.ok(args.includes("/tmp/repository:/workspace:ro"));
  assert.equal(args.includes("/codex-home"), false);
  assert.equal(args.includes("not-visible"), false);
});

function assertArgPair(args: string[], key: string, value: string): void {
  const index = args.indexOf(key);
  assert.notEqual(index, -1, `${key} should be present`);
  assert.equal(args[index + 1], value);
}
