import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";

import {
  assertCommandSucceeded,
  runProcess,
  safeExecutionEnvironment,
  type CommandResult,
} from "@/lib/agent/command";
import { assertAllowedRepoCommand, type RepoConfig } from "@/lib/agent/repo-config";
import { sandboxToolRunnerSource } from "@/lib/agent/sandbox-tool-runner";

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
    readOnly: boolean;
  }): Promise<CommandResult>;
  runTool(input: {
    name: string;
    arguments: unknown;
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
    workspaceReadOnly = false,
  }: {
    image: string;
    phase: SandboxPhase | "provider";
    timeoutMs: number;
    stdin: string;
    entrypoint: string;
    commandArgs: string[];
    containerEnv?: Record<string, string>;
    displayCommand: string;
    workspaceReadOnly?: boolean;
  }): Promise<CommandResult> {
    mkdirSync(runtimeDirectory, { recursive: true });
    const name = nextContainerName(phase);
    activeContainers.add(name);
    const effectiveContainerEnv = phase === "setup"
      ? { ...containerEnv }
      : { ...runtimeEnv, ...containerEnv };
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
      workspaceReadOnly,
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
    if (result.timedOut || result.outputLimitExceeded) {
      await removeContainer(dockerBinary, workspace, name, env);
    }
    activeContainers.delete(name);
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
      assertAllowedRepoCommand(command, phase === "setup" ? "setup" : "check");
      const normalizedCommand = normalizeSandboxCommand(command, phase);
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
    async runCodex({ model, prompt, timeoutMs, readOnly }) {
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
          "--json",
          "--ephemeral",
          "--ignore-user-config",
          "--sandbox",
          readOnly ? "read-only" : "workspace-write",
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
        containerEnv: {
          CODEX_API_KEY: apiKey,
          CODEX_HOME: "/codex-home",
          LD_PRELOAD: "/usr/local/lib/libigzpatch-nodump.so",
        },
        displayCommand: "docker run [Codex provider]",
        workspaceReadOnly: readOnly,
      });
    },
    async runTool({ name, arguments: toolArguments, timeoutMs }) {
      const payload = Buffer.from(JSON.stringify({
        name,
        arguments: toolArguments,
        allowed: config.paths.allowed,
        blocked: config.paths.blocked,
      })).toString("base64url");
      return runContainer({
        image: config.sandbox.image,
        phase: "run",
        timeoutMs,
        entrypoint: "node",
        commandArgs: ["-"],
        stdin: `process.argv[2] = ${JSON.stringify(payload)};\n${sandboxToolRunnerSource}`,
        displayCommand: `sandbox tool ${name}`,
      });
    },
    cleanupRuntime() {
      rmSync(runtimeDirectory, { recursive: true, force: true });
    },
    async dispose() {
      await Promise.all(
        [...activeContainers].map((name) => removeContainer(dockerBinary, workspace, name, env)),
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
  workspaceReadOnly = false,
}: {
  name: string;
  workspace: string;
  image: string;
  phase: SandboxPhase | "provider";
  config: RepoConfig;
  entrypoint: string;
  commandArgs: string[];
  containerEnv?: Record<string, string>;
  workspaceReadOnly?: boolean;
}): string[] {
  const network = phase === "provider"
    ? "bridge"
    : phase === "setup"
      ? config.sandbox.setup_network === "enabled" ? "bridge" : "none"
      : "none";
  const user = typeof process.getuid === "function" && typeof process.getgid === "function"
    ? `${process.getuid()}:${process.getgid()}`
    : null;
  const args = [
    "run",
    "--rm",
    "--interactive",
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
    "--tmpfs",
    "/codex-home:rw,nosuid,size=67108864",
    "--volume",
    `${workspace}:/workspace:${workspaceReadOnly ? "ro" : "rw"}`,
    "--volume",
    `${join(workspace, ".git")}:/workspace/.git:ro`,
    "--workdir",
    "/workspace",
    "--entrypoint",
    entrypoint,
  ];
  if (phase !== "provider") args.splice(3, 0, "--init");
  if (phase === "provider") args.push("--security-opt", "seccomp=unconfined");
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
    "export npm_config_ignore_scripts=true",
    "export PNPM_IGNORE_SCRIPTS=true",
    "export YARN_ENABLE_SCRIPTS=false",
    "mkdir -p \"$HOME\" \"$XDG_CACHE_HOME\" \"$COREPACK_HOME\" \"$npm_config_cache\" /workspace/.igzpatch-runtime/bin",
    "export PATH=/workspace/.igzpatch-runtime/bin:/workspace/node_modules/.bin:$PATH",
    "if command -v corepack >/dev/null 2>&1; then corepack enable --install-directory /workspace/.igzpatch-runtime/bin >/dev/null 2>&1 || true; fi",
    command,
  ].join("\n");
}

function normalizeSandboxCommand(command: string, phase: SandboxPhase): string {
  const trimmed = command.trim();
  if (trimmed === "corepack enable") {
    return "corepack enable --install-directory /workspace/.igzpatch-runtime/bin";
  }
  if (phase !== "setup" || /(?:^|\s)--ignore-scripts(?:\s|$)/.test(trimmed)) return trimmed;
  const [binary, subcommand] = trimmed.split(/\s+/);
  return ["npm", "pnpm", "yarn"].includes(binary ?? "") && ["ci", "install"].includes(subcommand ?? "")
    ? `${trimmed} --ignore-scripts`
    : trimmed;
}

async function removeContainer(
  dockerBinary: string,
  workspace: string,
  name: string,
  sourceEnv: Record<string, string | undefined> = process.env,
): Promise<void> {
  const result = await runProcess({
    command: dockerBinary,
    args: ["rm", "--force", name],
    displayCommand: `docker rm --force ${name}`,
    cwd: workspace,
    timeoutMs: 15_000,
    env: {
      ...safeExecutionEnvironment(sourceEnv as NodeJS.ProcessEnv),
      ...(sourceEnv.DOCKER_CONTEXT ? { DOCKER_CONTEXT: sourceEnv.DOCKER_CONTEXT } : {}),
      ...(sourceEnv.DOCKER_HOST ? { DOCKER_HOST: sourceEnv.DOCKER_HOST } : {}),
    },
    inheritEnv: false,
  });
  if (result.exitCode !== 0 && !/No such container/i.test(result.stderr)) {
    throw new Error(`Failed to remove sandbox container ${name}: ${result.stderr.trim()}`);
  }
}

function sanitizeName(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9_.-]+/g, "-").replace(/^-+|-+$/g, "") || "run";
}
