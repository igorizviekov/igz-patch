import { spawn } from "node:child_process";

export interface CommandResult {
  command: string;
  exitCode: number | null;
  stdout: string;
  stderr: string;
}

export function runShellCommand({
  command,
  cwd,
  timeoutMs,
  env = {},
}: {
  command: string;
  cwd: string;
  timeoutMs: number;
  env?: Record<string, string>;
}): Promise<CommandResult> {
  return new Promise((resolve) => {
    const child = spawn("sh", ["-lc", command], {
      cwd,
      env: {
        ...process.env,
        ...env,
      },
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      child.kill("SIGTERM");
      setTimeout(() => child.kill("SIGKILL"), 10_000).unref();
    }, timeoutMs);

    child.stdout.on("data", (chunk) => {
      stdout += String(chunk);
    });
    child.stderr.on("data", (chunk) => {
      stderr += String(chunk);
    });
    child.on("close", (exitCode) => {
      clearTimeout(timer);
      resolve({ command, exitCode, stdout, stderr });
    });
  });
}

export function assertCommandSucceeded(result: CommandResult): void {
  if (result.exitCode !== 0) {
    throw new Error(
      [
        `Command failed (${result.exitCode}): ${result.command}`,
        result.stderr.trim(),
        result.stdout.trim(),
      ]
        .filter(Boolean)
        .join("\n"),
    );
  }
}

