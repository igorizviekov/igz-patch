import { spawn } from "node:child_process";

export interface CommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
  outputLimitExceeded?: boolean;
}

export const defaultMaximumCommandOutputBytes = 1_000_000;

export function runShellCommand({
  command,
  cwd,
  timeoutMs,
  env = {},
  inheritEnv = true,
}: {
  command: string;
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  inheritEnv?: boolean;
}): Promise<CommandResult> {
  return runProcess({
    command: "sh",
    args: ["-lc", command],
    displayCommand: command,
    cwd,
    timeoutMs,
    env,
    inheritEnv,
  });
}

export function runProcess({
  command,
  args = [],
  displayCommand,
  cwd,
  timeoutMs,
  env = {},
  inheritEnv = true,
  stdin,
  maxOutputBytes = defaultMaximumCommandOutputBytes,
}: {
  command: string;
  args?: string[];
  displayCommand?: string;
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  stdin?: string;
  maxOutputBytes?: number;
}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn(command, args, {
      cwd,
      env: {
        ...(inheritEnv ? process.env : {}),
        ...env,
      } as NodeJS.ProcessEnv,
      stdio: ["pipe", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    let timedOut = false;
    let outputLimitExceeded = false;
    let capturedBytes = 0;
    let settled = false;
    const renderedCommand = displayCommand ?? [command, ...args].join(" ");
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, timeoutMs);

    child.stdin.end(stdin);
    const capture = (stream: "stdout" | "stderr", chunk: Buffer | string) => {
      const value = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
      const remaining = Math.max(0, maxOutputBytes - capturedBytes);
      const captured = value.subarray(0, remaining).toString("utf8");
      capturedBytes += Math.min(value.length, remaining);
      if (stream === "stdout") stdout += captured;
      else stderr += captured;
      if (value.length > remaining && !outputLimitExceeded) {
        outputLimitExceeded = true;
        child.kill("SIGTERM");
        setTimeout(() => child.kill("SIGKILL"), 1_000).unref();
      }
    };
    child.stdout.on("data", (chunk) => capture("stdout", chunk));
    child.stderr.on("data", (chunk) => capture("stderr", chunk));
    child.on("error", (error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({
        command: renderedCommand,
        exitCode: null,
        stdout,
        stderr: [stderr, error.message].filter(Boolean).join("\n"),
        timedOut,
        outputLimitExceeded,
      });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ command: renderedCommand, exitCode, stdout, stderr, timedOut, outputLimitExceeded });
    });
  });
}

export function safeExecutionEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  const allowedNames = new Set([
    "CI",
    "COLORTERM",
    "COREPACK_HOME",
    "HOME",
    "LANG",
    "LOGNAME",
    "NODE_ENV",
    "NO_COLOR",
    "NPM_CONFIG_CACHE",
    "PATH",
    "PNPM_HOME",
    "SHELL",
    "TERM",
    "TMP",
    "TMPDIR",
    "TEMP",
    "USER",
    "XDG_CACHE_HOME",
  ]);

  return Object.fromEntries(
    Object.entries(source).filter(
      (entry): entry is [string, string] =>
        typeof entry[1] === "string" &&
        (allowedNames.has(entry[0]) || entry[0].startsWith("LC_")),
    ),
  );
}

export function assertCommandSucceeded(result: CommandResult): void {
  if (result.exitCode !== 0 || result.outputLimitExceeded) {
    throw new Error(
      [
        result.outputLimitExceeded
          ? `Command exceeded the output limit: ${result.command}`
          : result.timedOut
          ? `Command timed out: ${result.command}`
          : `Command failed (${result.exitCode}): ${result.command}`,
        result.stderr.trim(),
        result.stdout.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}
