import {
  lstatSync,
  mkdirSync,
  readFileSync,
  readdirSync,
  realpathSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { dirname, isAbsolute, normalize, relative, resolve, sep } from "node:path";

import {
  assertCommandSucceeded,
  runProcess,
  runShellCommand,
  safeExecutionEnvironment,
  type CommandResult,
} from "@/lib/agent/command";
import type { RepoConfig } from "@/lib/agent/repo-config";
import type { AgentToolDefinition } from "@/lib/agent/providers/types";

const maxToolOutput = 30_000;
const ignoredDirectories = new Set([
  ".git",
  ".igzpatch-runtime",
  ".next",
  "coverage",
  "dist",
  "node_modules",
]);
const sensitiveFileNames = new Set([".netrc", ".npmrc", ".pypirc"]);

export interface AgentToolbox {
  definitions: AgentToolDefinition[];
  requiredCheckCommands: readonly string[];
  readonly mutationCount: number;
  readonly requiredChecksPassed: boolean;
  runRequiredCheck(command: string): Promise<CommandResult>;
  execute(name: string, input: unknown): Promise<string>;
}

export function createAgentToolbox({
  workspace,
  config,
  timeoutMs,
  deadline = Date.now() + timeoutMs,
  runCheck,
  runTool,
}: {
  workspace: string;
  config: RepoConfig;
  timeoutMs: number;
  deadline?: number;
  runCheck?: (command: string, timeoutMs: number) => Promise<CommandResult>;
  runTool?: (name: string, input: unknown, timeoutMs: number) => Promise<CommandResult>;
}): AgentToolbox {
  let mutations = 0;
  const checkResults = new Map<string, boolean>();
  const definitions = createToolDefinitions();
  const requiredCheckCommands = [...config.checks.required];
  const runRequiredCheck = async (command: string): Promise<CommandResult> => {
    if (!requiredCheckCommands.includes(command)) {
      throw new Error("Only configured required checks may be run");
    }
    const checkTimeout = remainingTimeout(deadline, timeoutMs);
    const result = runCheck
      ? await runCheck(command, checkTimeout)
      : await runShellCommand({
          command,
          cwd: workspace,
          timeoutMs: checkTimeout,
          env: safeExecutionEnvironment(),
          inheritEnv: false,
        });
    checkResults.set(command, result.exitCode === 0 && !result.timedOut && !result.outputLimitExceeded);
    return result;
  };

  return {
    definitions,
    requiredCheckCommands,
    get mutationCount() {
      return mutations;
    },
    get requiredChecksPassed() {
      return config.checks.required.every((command) => checkResults.get(command) === true);
    },
    runRequiredCheck,
    async execute(name, input) {
      const args = asObject(input);

      if (runTool) {
        const result = await runTool(name, args, remainingTimeout(deadline, timeoutMs));
        assertCommandSucceeded(result);
        if (name === "write_file" || name === "replace_in_file") {
          mutations += 1;
          checkResults.clear();
        }
        return truncate(result.stdout);
      }

      switch (name) {
        case "list_files": {
          const start = resolveReadablePath(workspace, optionalString(args.path) ?? ".");
          const files = collectFiles(workspace, start)
            .map((path) => toWorkspacePath(workspace, path))
            .filter((path) => !isSensitivePath(path))
            .slice(0, 500);
          return JSON.stringify({ ok: true, files, truncated: files.length === 500 });
        }
        case "read_file": {
          const path = requiredString(args.path, "path");
          assertReadablePath(path);
          const absolutePath = resolveReadablePath(workspace, path);
          if (!statSync(absolutePath).isFile()) throw new Error(`Not a file: ${path}`);
          if (statSync(absolutePath).size > 1_000_000) {
            throw new Error(`File is too large to read through the agent tool: ${path}`);
          }
          const content = readFileSync(absolutePath, "utf8");
          const startLine = optionalPositiveInteger(args.start_line) ?? 1;
          const endLine = optionalPositiveInteger(args.end_line) ?? startLine + 399;
          const lines = content.split("\n");
          const selected = lines.slice(startLine - 1, endLine);
          return truncate(
            selected.map((line, index) => `${startLine + index}: ${line}`).join("\n"),
          );
        }
        case "search_files": {
          const query = requiredString(args.query, "query").toLocaleLowerCase();
          const start = resolveReadablePath(workspace, optionalString(args.path) ?? ".");
          const matches: string[] = [];
          for (const absolutePath of collectFiles(workspace, start)) {
            const path = toWorkspacePath(workspace, absolutePath);
            if (isSensitivePath(path) || statSync(absolutePath).size > 1_000_000) continue;
            const content = readFileSync(absolutePath, "utf8");
            if (content.includes("\0")) continue;
            content.split("\n").forEach((line, index) => {
              if (matches.length < 100 && line.toLocaleLowerCase().includes(query)) {
                matches.push(`${path}:${index + 1}:${line}`);
              }
            });
            if (matches.length >= 100) break;
          }
          return truncate(JSON.stringify({ ok: true, matches, truncated: matches.length === 100 }));
        }
        case "get_diff": {
          const result = await runProcess({
            command: "git",
            args: ["diff", "--no-ext-diff", "--unified=3", "--"],
            cwd: workspace,
            timeoutMs: remainingTimeout(deadline, Math.min(timeoutMs, 120_000)),
            env: safeExecutionEnvironment(),
            inheritEnv: false,
          });
          assertCommandSucceeded(result);
          return truncate(result.stdout || "No diff yet.");
        }
        case "write_file": {
          const path = requiredString(args.path, "path");
          const content = requiredString(args.content, "content", true);
          const absolutePath = resolveWritablePath(workspace, path, config);
          mkdirSync(dirname(absolutePath), { recursive: true });
          writeFileSync(absolutePath, content, "utf8");
          mutations += 1;
          checkResults.clear();
          return JSON.stringify({ ok: true, path, bytes: Buffer.byteLength(content) });
        }
        case "replace_in_file": {
          const path = requiredString(args.path, "path");
          const oldText = requiredString(args.old_text, "old_text", true);
          const newText = requiredString(args.new_text, "new_text", true);
          if (oldText === "") throw new Error("old_text must not be empty");
          const absolutePath = resolveWritablePath(workspace, path, config);
          const content = readFileSync(absolutePath, "utf8");
          const firstIndex = content.indexOf(oldText);
          if (firstIndex === -1) throw new Error(`old_text was not found in ${path}`);
          if (content.indexOf(oldText, firstIndex + oldText.length) !== -1) {
            throw new Error(`old_text occurs more than once in ${path}; provide a larger unique block`);
          }
          writeFileSync(
            absolutePath,
            `${content.slice(0, firstIndex)}${newText}${content.slice(firstIndex + oldText.length)}`,
            "utf8",
          );
          mutations += 1;
          checkResults.clear();
          return JSON.stringify({ ok: true, path });
        }
        default:
          throw new Error(`Unknown agent tool: ${name}`);
      }
    },
  };
}

function createToolDefinitions(): AgentToolDefinition[] {
  const tools: AgentToolDefinition[] = [
    {
      name: "list_files",
      description: "List repository files below an optional relative path.",
      parameters: objectSchema({ path: { type: "string" } }),
      readOnly: true,
    },
    {
      name: "read_file",
      description: "Read a line-numbered slice of a UTF-8 repository file.",
      parameters: objectSchema(
        {
          path: { type: "string" },
          start_line: { type: "integer", minimum: 1 },
          end_line: { type: "integer", minimum: 1 },
        },
        ["path"],
      ),
      readOnly: true,
    },
    {
      name: "search_files",
      description: "Search UTF-8 repository files for a case-insensitive literal string.",
      parameters: objectSchema(
        { query: { type: "string" }, path: { type: "string" } },
        ["query"],
      ),
      readOnly: true,
    },
    {
      name: "get_diff",
      description: "Read the current uncommitted Git diff.",
      parameters: objectSchema({}),
      readOnly: true,
    },
    {
      name: "write_file",
      description: "Create or fully overwrite an allowed UTF-8 repository file.",
      parameters: objectSchema(
        { path: { type: "string" }, content: { type: "string" } },
        ["path", "content"],
      ),
      readOnly: false,
    },
    {
      name: "replace_in_file",
      description: "Replace one exact, unique text block in an allowed UTF-8 repository file.",
      parameters: objectSchema(
        {
          path: { type: "string" },
          old_text: { type: "string" },
          new_text: { type: "string" },
        },
        ["path", "old_text", "new_text"],
      ),
      readOnly: false,
    },
  ];

  return tools;
}

function objectSchema(
  properties: Record<string, unknown>,
  required: string[] = [],
): Record<string, unknown> {
  return { type: "object", properties, required, additionalProperties: false };
}

function collectFiles(workspace: string, start: string): string[] {
  if (statSync(start).isFile()) return [start];
  const files: string[] = [];
  const pending = [start];

  while (pending.length > 0 && files.length < 500) {
    const directory = pending.pop();
    if (!directory) break;
    const entries = readdirSync(directory, { withFileTypes: true }).sort((a, b) =>
      a.name.localeCompare(b.name),
    );
    for (const entry of entries) {
      if (ignoredDirectories.has(entry.name)) continue;
      const absolutePath = resolve(directory, entry.name);
      if (entry.isSymbolicLink()) continue;
      if (entry.isDirectory()) pending.push(absolutePath);
      if (entry.isFile()) files.push(absolutePath);
      if (files.length >= 500) break;
    }
  }

  return files.sort((a, b) => relative(workspace, a).localeCompare(relative(workspace, b)));
}

function resolveReadablePath(workspace: string, path: string): string {
  const absolutePath = resolveWorkspacePath(workspace, path);
  const realWorkspace = realpathSync(workspace);
  const realPath = realpathSync(absolutePath);
  if (!isWithin(realWorkspace, realPath)) throw new Error(`Path escapes workspace: ${path}`);
  return realPath;
}

function resolveWritablePath(workspace: string, path: string, config: RepoConfig): string {
  const normalizedPath = normalizeWorkspacePath(path);
  if (!config.paths.allowed.some((pattern) => matchesGlob(normalizedPath, pattern))) {
    throw new Error(`Path is outside paths.allowed: ${normalizedPath}`);
  }
  if (config.paths.blocked.some((pattern) => matchesGlob(normalizedPath, pattern))) {
    throw new Error(`Path matches paths.blocked: ${normalizedPath}`);
  }

  const absolutePath = resolveWorkspacePath(workspace, normalizedPath);
  const realWorkspace = realpathSync(workspace);
  let existingAncestor = absolutePath;
  while (!exists(existingAncestor)) existingAncestor = dirname(existingAncestor);
  if (!isWithin(realWorkspace, realpathSync(existingAncestor))) {
    throw new Error(`Path escapes workspace through a symbolic link: ${normalizedPath}`);
  }
  if (exists(absolutePath) && lstatSync(absolutePath).isSymbolicLink()) {
    throw new Error(`Refusing to write through a symbolic link: ${normalizedPath}`);
  }
  return absolutePath;
}

function resolveWorkspacePath(workspace: string, path: string): string {
  const normalizedPath = normalizeWorkspacePath(path);
  const absoluteWorkspace = resolve(workspace);
  const absolutePath = resolve(absoluteWorkspace, normalizedPath);
  if (!isWithin(absoluteWorkspace, absolutePath)) throw new Error(`Path escapes workspace: ${path}`);
  return absolutePath;
}

function normalizeWorkspacePath(path: string): string {
  if (isAbsolute(path)) throw new Error(`Absolute paths are not allowed: ${path}`);
  const normalizedPath = normalize(path).split(sep).join("/").replace(/^\.\//, "");
  if (normalizedPath === ".." || normalizedPath.startsWith("../")) {
    throw new Error(`Path escapes workspace: ${path}`);
  }
  return normalizedPath || ".";
}

function toWorkspacePath(workspace: string, absolutePath: string): string {
  return relative(workspace, absolutePath).split(sep).join("/");
}

function isWithin(parent: string, child: string): boolean {
  return child === parent || child.startsWith(`${parent}${sep}`);
}

function assertReadablePath(path: string): void {
  const normalizedPath = normalizeWorkspacePath(path);
  if (isSensitivePath(normalizedPath)) throw new Error(`Refusing to read sensitive path: ${path}`);
}

function isSensitivePath(path: string): boolean {
  const parts = path.split("/");
  const name = parts.at(-1) ?? "";
  return parts.includes(".git") || name === ".env" || name.startsWith(".env.") || sensitiveFileNames.has(name);
}

function matchesGlob(path: string, glob: string): boolean {
  let pattern = "^";
  for (let index = 0; index < glob.length; index += 1) {
    const character = glob[index];
    if (character === "*" && glob[index + 1] === "*") {
      pattern += ".*";
      index += 1;
    } else if (character === "*") {
      pattern += "[^/]*";
    } else if (character === "?") {
      pattern += "[^/]";
    } else {
      pattern += character?.replace(/[|\\{}()[\]^$+?.]/g, "\\$&") ?? "";
    }
  }
  return new RegExp(`${pattern}$`).test(path);
}

function exists(path: string): boolean {
  try {
    lstatSync(path);
    return true;
  } catch {
    return false;
  }
}

function asObject(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Tool arguments must be an object");
  }
  return value as Record<string, unknown>;
}

function requiredString(
  value: unknown,
  name: string,
  allowEmpty = false,
): string {
  if (typeof value !== "string" || (!allowEmpty && value.trim() === "")) {
    throw new Error(`${name} must be a${allowEmpty ? "" : " non-empty"} string`);
  }
  return value;
}

function optionalString(value: unknown): string | undefined {
  if (value === undefined) return undefined;
  if (typeof value !== "string") throw new Error("Optional path must be a string");
  return value;
}

function optionalPositiveInteger(value: unknown): number | undefined {
  if (value === undefined) return undefined;
  if (!Number.isInteger(value) || Number(value) < 1) throw new Error("Line numbers must be positive integers");
  return Number(value);
}

function truncate(value: string, limit = maxToolOutput): string {
  return value.length <= limit ? value : `${value.slice(0, limit)}\n...[truncated]`;
}

function remainingTimeout(deadline: number, maximum: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Agent provider timed out");
  return Math.min(remaining, maximum);
}
