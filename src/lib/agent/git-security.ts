import { safeExecutionEnvironment } from "@/lib/agent/command";

export function protectedGitArguments(args: string[]): string[] {
  return ["-c", "core.hooksPath=/dev/null", "-c", "protocol.file.allow=never", ...args];
}

export function hardenedGitEnvironment(
  source: NodeJS.ProcessEnv = process.env,
): Record<string, string> {
  return {
    ...safeExecutionEnvironment(source),
    GIT_CONFIG_NOSYSTEM: "1",
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_TERMINAL_PROMPT: "0",
    GIT_LFS_SKIP_SMUDGE: "1",
  };
}

export function gitAuthEnvironment(token: string): Record<string, string> {
  return {
    ...hardenedGitEnvironment(),
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
}
