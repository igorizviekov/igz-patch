import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  assertCommandSucceeded,
  runProcess,
  safeExecutionEnvironment,
  type CommandResult,
} from "@/lib/agent/command";
import type { RepoConfig } from "@/lib/agent/repo-config";

export type SandboxPhase = "setup" | "run";

export interface AgentSandbox {
  ensureAvailable(): Promise<void>;
  runCommand(input: {
    command: string;
    phase: SandboxPhase;
    timeoutMs: number;
  }): Promise<CommandResult>;
  runCodex(input: {
    model: string;
    prompt: string;
    timeoutMs: number;
  }): Promise<CommandResult>;
  cleanupRuntime(): void;
  dispose(): Promise<void>;
}

export function createDockerSandbox({
  workspace,
  runId,
  config,
  env = process.env,
  runtimeEnv = {},
}: {
  workspace: string;
  runId: string;
  config: RepoConfig;
  env?: Record<string, string | undefined>;
  runtimeEnv?: Record<string, string>;
}): AgentSandbox {
  const dockerBinary = env.IGZPATCH_DOCKER_BIN?.trim() || "docker";
  const codexImage = env.IGZPATCH_CODEX_IMAGE?.trim() || "igzpatch/codex-agent:0.1.0";
  const runtimeDirectory = join(workspace, ".igzpatch-runtime");
  const containerPrefix = `igzpatch-${sanitizeName(runId).slice(0, 32)}`;
  let sequence = 0;
  const activeContainers = new Set<string>();

  function nextContainerName(phase: string): string {
    sequence += 1;
    return `${containerPrefix}-${phase}-${sequence}`.slice(0, 63);
  }

  async function runContainer({
    image,
    phase,
    timeoutMs,
    stdin,
    entrypoint,
    commandArgs,
    containerEnv = {},
    displayCommand,
  }: {
    image: string;
    phase: SandboxPhase | "provider";
    timeoutMs: number;
    stdin: string;
    entrypoint: string;
    commandArgs: string[];
    containerEnv?: Record<string, string>;
    displayCommand: string;
  }): Promise<CommandResult> {
    mkdirSync(runtimeDirectory, { recursive: true });
    const name = nextContainerName(phase);
    activeContainers.add(name);
    const effectiveContainerEnv = { ...runtimeEnv, ...containerEnv };
    const processEnv = {
      ...safeExecutionEnvironment(env as NodeJS.ProcessEnv),
      ...(env.DOCKER_CONTEXT ? { DOCKER_CONTEXT: env.DOCKER_CONTEXT } : {}),
      ...(env.DOCKER_HOST ? { DOCKER_HOST: env.DOCKER_HOST } : {}),
      ...effectiveContainerEnv,
    };
    const args = buildDockerRunArgs({
      name,
      workspace,
      image,
      phase,
      config,
      entrypoint,
      commandArgs,
      containerEnv: effectiveContainerEnv,
    });
    const result = await runProcess({
      command: dockerBinary,
      args,
      displayCommand,
      cwd: workspace,
      timeoutMs,
      env: processEnv,
      inheritEnv: false,
      stdin,
    });
    activeContainers.delete(name);
    if (result.timedOut) await removeContainer(dockerBinary, workspace, name);
    return result;
  }

  return {
    async ensureAvailable() {
      const result = await runProcess({
        command: dockerBinary,
        args: ["version", "--format", "{{.Server.Version}}"],
        displayCommand: "docker version",
        cwd: workspace,
        timeoutMs: 15_000,
        env: safeExecutionEnvironment(env as NodeJS.ProcessEnv),
        inheritEnv: false,
      });
      assertCommandSucceeded(result);
    },
    async runCommand({ command, phase, timeoutMs }) {
      const normalizedCommand = normalizeSandboxCommand(command);
      const script = renderSandboxScript(normalizedCommand);
      const result = await runContainer({
        image: config.sandbox.image,
        phase,
        timeoutMs,
        stdin: script,
        entrypoint: "sh",
        commandArgs: ["-s"],
        displayCommand: command,
      });
      return { ...result, command };
    },
    async runCodex({ model, prompt, timeoutMs }) {
      const apiKey = env.CODEX_API_KEY;
      if (!apiKey?.trim()) {
        throw new Error("CODEX_API_KEY is required when the Codex provider runs in Docker.");
      }
      return runContainer({
        image: codexImage,
        phase: "provider",
        timeoutMs,
        stdin: prompt,
        entrypoint: "codex",
        commandArgs: [
          "exec",
          "--ephemeral",
          "--ignore-user-config",
          "--sandbox",
          "workspace-write",
          "--color",
          "never",
          "--config",
          'approval_policy="never"',
          "--config",
          'shell_environment_policy.inherit="core"',
          "--config",
          "sandbox_workspace_write.network_access=false",
          "--model",
          model,
          "-",
        ],
        containerEnv: { CODEX_API_KEY: apiKey, CODEX_HOME: "/tmp/codex" },
        displayCommand: "docker run [Codex provider]",
      });
    },
    cleanupRuntime() {
      rmSync(runtimeDirectory, { recursive: true, force: true });
    },
    async dispose() {
      await Promise.all(
        [...activeContainers].map((name) => removeContainer(dockerBinary, workspace, name)),
      );
      activeContainers.clear();
      rmSync(runtimeDirectory, { recursive: true, force: true });
    },
  };
}

export function buildDockerRunArgs({
  name,
  workspace,
  image,
  phase,
  config,
  entrypoint,
  commandArgs,
  containerEnv = {},
}: {
  name: string;
  workspace: string;
  image: string;
  phase: SandboxPhase | "provider";
  config: RepoConfig;
  entrypoint: string;
  commandArgs: string[];
  containerEnv?: Record<string, string>;
}): string[] {
  const network = phase === "provider"
    ? "bridge"
    : phase === "setup"
      ? config.sandbox.setup_network === "enabled" ? "bridge" : "none"
      : config.sandbox.run_network === "enabled" ? "bridge" : "none";
  const user = typeof process.getuid === "function" && typeof process.getgid === "function"
    ? `${process.getuid()}:${process.getgid()}`
    : null;
  const args = [
    "run",
    "--rm",
    "--init",
    "--name",
    name,
    "--network",
    network,
    "--cpus",
    String(config.sandbox.cpu_limit),
    "--memory",
    `${config.sandbox.memory_mb}m`,
    "--memory-swap",
    `${config.sandbox.memory_mb}m`,
    "--pids-limit",
    "256",
    "--cap-drop",
    "ALL",
    "--security-opt",
    "no-new-privileges",
    "--read-only",
    "--tmpfs",
    "/tmp:rw,noexec,nosuid,size=268435456",
    "--volume",
    `${workspace}:/workspace:rw`,
    "--workdir",
    "/workspace",
    "--entrypoint",
    entrypoint,
  ];
  if (user) args.push("--user", user);
  for (const name of Object.keys(containerEnv)) args.push("--env", name);
  args.push(image, ...commandArgs);
  return args;
}

function renderSandboxScript(command: string): string {
  return [
    "set -eu",
    "export HOME=/workspace/.igzpatch-runtime/home",
    "export XDG_CACHE_HOME=/workspace/.igzpatch-runtime/cache",
    "export COREPACK_HOME=/workspace/.igzpatch-runtime/corepack",
    "export npm_config_cache=/workspace/.igzpatch-runtime/npm",
    "mkdir -p \"$HOME\" \"$XDG_CACHE_HOME\" \"$COREPACK_HOME\" \"$npm_config_cache\" /workspace/.igzpatch-runtime/bin",
    "export PATH=/workspace/.igzpatch-runtime/bin:/workspace/node_modules/.bin:$PATH",
    "if command -v corepack >/dev/null 2>&1; then corepack enable --install-directory /workspace/.igzpatch-runtime/bin >/dev/null 2>&1 || true; fi",
    command,
  ].join("\n");
}

function normalizeSandboxCommand(command: string): string {
  return command.trim() === "corepack enable"
    ? "corepack enable --install-directory /workspace/.igzpatch-runtime/bin"
    : command;
}

async function removeContainer(
  dockerBinary: string,
  workspace: string,
  name: string,
): Promise<void> {
  await runProcess({
    command: dockerBinary,
    args: ["rm", "--force", name],
    displayCommand: `docker rm --force ${name}`,
    cwd: workspace,
    timeoutMs: 15_000,
    env: safeExecutionEnvironment(),
    inheritEnv: false,
  });
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}
