import { spawn } from "node:child_process";

export interface CommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
  timedOut: boolean;
}

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
}: {
  command: string;
  args?: string[];
  displayCommand?: string;
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
  inheritEnv?: boolean;
  stdin?: string;
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
    let settled = false;
    const renderedCommand = displayCommand ?? [command, ...args].join(" ");
    const timer = setTimeout(() => {
      timedOut = true;
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, timeoutMs);

    child.stdin.end(stdin);
    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
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
      });
    });
    child.on("close", (exitCode) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ command: renderedCommand, exitCode, stdout, stderr, timedOut });
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
  if (result.exitCode !== 0) {
    throw new Error(
      [
        result.timedOut
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
