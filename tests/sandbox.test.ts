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
  assertArgPair(args, "--cpus", "1.5");
  assertArgPair(args, "--memory", "2048m");
  assertArgPair(args, "--memory-swap", "2048m");
  assertArgPair(args, "--pids-limit", "256");
  assertArgPair(args, "--cap-drop", "ALL");
  assertArgPair(args, "--security-opt", "no-new-privileges");
  assertArgPair(args, "--volume", "/tmp/repository:/workspace:rw");
  assert.ok(args.includes("/tmp/repository/.git:/workspace/.git:ro"));
  assert.ok(args.includes("--read-only"));
  assert.equal(args.filter((arg) => arg.includes(":/workspace")).length, 2);
});

test("Docker run phase disables network and never exposes environment values in arguments", () => {
  const config = structuredClone(defaultRepoConfig);
  config.sandbox.run_network = "disabled";
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

test("Codex provider container keeps API networking separate from command networking", () => {
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
    containerEnv: { CODEX_API_KEY: "not-visible" },
    workspaceReadOnly: true,
  });

  assertArgPair(args, "--network", "bridge");
  assert.ok(args.includes("sandbox_workspace_write.network_access=false"));
  assert.ok(args.includes("/tmp/repository:/workspace:ro"));
  assert.equal(args.includes("not-visible"), false);
});

function assertArgPair(args: string[], key: string, value: string): void {
  const index = args.indexOf(key);
  assert.notEqual(index, -1, `${key} should be present`);
  assert.equal(args[index + 1], value);
}
