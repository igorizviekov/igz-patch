import { lstatSync } from "node:fs";
import { join } from "node:path";

import type { RepoConfig } from "@/lib/agent/repo-config";
import { assertCommandSucceeded, runProcess } from "@/lib/agent/command";
import { hardenedGitEnvironment, protectedGitArguments } from "@/lib/agent/git-security";

export interface DiffSummary {
  changedFiles: string[];
  addedLines: number;
  deletedLines: number;
  binaryFiles: string[];
  fileBytes: Record<string, number>;
  patchBytes: number;
}

export async function readDiffSummary(workspace: string): Promise<DiffSummary> {
  const intentResult = await runGit(workspace, ["add", "--intent-to-add", "--all", "--", "."]);
  assertCommandSucceeded(intentResult);

  const result = await runGit(workspace, ["diff", "--numstat", "-z", "--no-renames", "--"]);
  assertCommandSucceeded(result);

  const patch = await readBinaryPatch(workspace, 5_000_000);
  const changedFiles: string[] = [];
  const binaryFiles: string[] = [];
  const fileBytes: Record<string, number> = {};
  let addedLines = 0;
  let deletedLines = 0;

  for (const record of result.stdout.split("\0")) {
    if (!record) continue;
    const firstTab = record.indexOf("\t");
    const secondTab = record.indexOf("\t", firstTab + 1);
    if (firstTab === -1 || secondTab === -1) continue;
    const added = record.slice(0, firstTab);
    const deleted = record.slice(firstTab + 1, secondTab);
    const file = record.slice(secondTab + 1);
    if (!file) continue;
    changedFiles.push(file);
    if (added === "-" || deleted === "-") binaryFiles.push(file);
    else {
      addedLines += Number(added);
      deletedLines += Number(deleted);
    }
    try {
      fileBytes[file] = lstatSync(join(workspace, file)).size;
    } catch {
      fileBytes[file] = 0;
    }
  }

  return {
    changedFiles,
    addedLines,
    deletedLines,
    binaryFiles,
    fileBytes,
    patchBytes: Buffer.byteLength(patch),
  };
}

export async function readBinaryPatch(workspace: string, maximumBytes: number): Promise<string> {
  const result = await runGit(
    workspace,
    ["diff", "--binary", "--full-index", "--no-ext-diff", "--no-renames", "--"],
    maximumBytes + 1,
  );
  if (result.outputLimitExceeded) {
    throw new BlockedRunError(`Patch exceeds the maximum transport size of ${maximumBytes} bytes.`);
  }
  assertCommandSucceeded(result);
  return result.stdout;
}

async function runGit(workspace: string, args: string[], maxOutputBytes?: number) {
  return runProcess({
    command: "git",
    args: protectedGitArguments(args),
    cwd: workspace,
    timeoutMs: 30_000,
    env: hardenedGitEnvironment(),
    inheritEnv: false,
    maxOutputBytes,
  });
}

export function enforceDiffPolicy(summary: DiffSummary, config: RepoConfig): void {
  if (summary.changedFiles.length === 0) {
    throw new BlockedRunError("Agent produced no file changes.");
  }

  if (summary.changedFiles.length > config.issue_scope.max_files_changed) {
    throw new BlockedRunError(
      `Changed ${summary.changedFiles.length} files, above max ${config.issue_scope.max_files_changed}.`,
    );
  }

  const diffLines = summary.addedLines + summary.deletedLines;
  if (diffLines > config.issue_scope.max_diff_lines) {
    throw new BlockedRunError(
      `Diff has ${diffLines} changed lines, above max ${config.issue_scope.max_diff_lines}.`,
    );
  }

  if (summary.binaryFiles.length > 0) {
    throw new BlockedRunError(`Binary changes are not allowed: ${summary.binaryFiles.join(", ")}`);
  }

  if (summary.patchBytes > config.issue_scope.max_patch_bytes) {
    throw new BlockedRunError(
      `Patch is ${summary.patchBytes} bytes, above max ${config.issue_scope.max_patch_bytes}.`,
    );
  }

  for (const [file, bytes] of Object.entries(summary.fileBytes)) {
    if (bytes > config.issue_scope.max_file_bytes) {
      throw new BlockedRunError(
        `Changed file ${file} is ${bytes} bytes, above max ${config.issue_scope.max_file_bytes}.`,
      );
    }
  }

  for (const file of summary.changedFiles) {
    if (config.paths.blocked.some((pattern) => matchesSimpleGlob(file, pattern))) {
      throw new BlockedRunError(`Changed blocked path: ${file}`);
    }
    if (!config.paths.allowed.some((pattern) => matchesSimpleGlob(file, pattern))) {
      throw new BlockedRunError(`Changed path outside allowlist: ${file}`);
    }
  }
}

export class BlockedRunError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "BlockedRunError";
  }
}

function matchesSimpleGlob(file: string, pattern: string): boolean {
  if (pattern.endsWith("/**")) {
    return file.startsWith(pattern.slice(0, -3));
  }
  if (pattern.endsWith("*")) {
    return file.startsWith(pattern.slice(0, -1));
  }
  return file === pattern;
}
