import type { RepoConfig } from "@/lib/agent/repo-config";
import { assertCommandSucceeded, runShellCommand } from "@/lib/agent/command";

export interface DiffSummary {
  changedFiles: string[];
  addedLines: number;
  deletedLines: number;
}

export async function readDiffSummary(workspace: string): Promise<DiffSummary> {
  const intentResult = await runShellCommand({
    command: "git add --intent-to-add --all -- .",
    cwd: workspace,
    timeoutMs: 30_000,
  });
  assertCommandSucceeded(intentResult);

  const result = await runShellCommand({
    command: "git diff --numstat --no-renames",
    cwd: workspace,
    timeoutMs: 30_000,
  });
  assertCommandSucceeded(result);

  const changedFiles: string[] = [];
  let addedLines = 0;
  let deletedLines = 0;

  for (const line of result.stdout.split("\n")) {
    const [added, deleted, file] = line.split("\t", 3);
    if (!file) continue;
    changedFiles.push(file);
    addedLines += Number(added) || 0;
    deletedLines += Number(deleted) || 0;
  }

  return { changedFiles, addedLines, deletedLines };
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
