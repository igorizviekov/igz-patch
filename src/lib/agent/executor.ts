import { mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertCommandSucceeded,
  runShellCommand,
  safeExecutionEnvironment,
} from "@/lib/agent/command";
import { BlockedRunError, enforceDiffPolicy, readDiffSummary } from "@/lib/agent/diff";
import { runConfiguredAgent } from "@/lib/agent/providers";
import { loadRepoConfig } from "@/lib/agent/repo-config";
import { addRunEvent, updateRun, type RunRecord } from "@/lib/db/runs";
import { getInstallationOctokit, getInstallationToken } from "@/lib/github/app";
import { upsertRunStatusComment } from "@/lib/github/status-comment";

export async function executeRun(run: RunRecord): Promise<void> {
  const octokit = await getInstallationOctokit(run.installation_id);
  let currentRun = await upsertRunStatusComment({
    octokit,
    run,
    headline: "running",
    details: ["Worker claimed the run and is preparing a repository workspace."],
  });

  try {
    await addRunEvent(run.id, "workspace", "Preparing checkout");
    const token = await getInstallationToken(run.installation_id);
    const workspace = makeWorkspace(run.id);

    await cloneRepository({
      token,
      repositoryFullName: run.repository_full_name,
      workspace,
    });

    const config = loadConfigOrBlock(workspace);
    if (!config.enabled) throw new BlockedRunError("IgzPatch is disabled by repository config.");
    if (config.issue_scope.requires_acceptance_criteria && !hasAcceptanceCriteria(run.issue_body)) {
      throw new BlockedRunError("Issue lacks explicit acceptance criteria required by repository config.");
    }

    const branchName = formatBranchName(config.branch.prefix, run);

    await git(workspace, `checkout -b ${shellQuote(branchName)}`);
    currentRun = await updateRun(run.id, { branch_name: branchName });
    currentRun = await upsertRunStatusComment({
      octokit,
      run: currentRun,
      headline: "editing",
      details: ["Repository cloned.", `Branch: \`${branchName}\``],
    });

    await runSetup(workspace, config.sandbox.setup, config.sandbox.timeout_minutes);
    await addRunEvent(run.id, "agent", "Starting configured agent provider", {
      provider: process.env.IGZPATCH_AGENT_PROVIDER ?? config.routing.primary.provider,
      model: process.env.IGZPATCH_AGENT_MODEL ?? config.routing.primary.model,
    });
    await runAgent(workspace, currentRun, config);
    await runChecks(workspace, config.checks.required, config.sandbox.timeout_minutes);

    const diffSummary = await readDiffSummary(workspace);
    enforceDiffPolicy(diffSummary, config);

    await git(workspace, 'config user.name "IgzPatch"');
    await git(workspace, 'config user.email "igzpatch[bot]@users.noreply.github.com"');
    await git(workspace, "add -A");
    await git(workspace, `commit -m ${shellQuote(`IgzPatch: fix issue #${run.issue_number}`)}`);
    await git(workspace, `push origin ${shellQuote(branchName)}`);

    const prUrl = await openDraftPullRequest({
      octokit,
      run: currentRun,
      branchName,
      baseBranch: config.repo.default_branch,
      title: config.pull_request.title_template.replace("#{issue_number}", String(run.issue_number)),
      body: renderPullRequestBody({ run: currentRun, diffSummary }),
      draft: config.pull_request.draft,
    });

    const succeeded = await updateRun(run.id, {
      status: "succeeded",
      pull_request_url: prUrl,
    });
    await addRunEvent(run.id, "succeeded", "Opened draft pull request", { pull_request_url: prUrl });
    await upsertRunStatusComment({
      octokit,
      run: succeeded,
      headline: "draft PR opened",
      details: [`PR: ${prUrl}`, `Changed files: ${diffSummary.changedFiles.length}`],
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const status = error instanceof BlockedRunError ? "blocked" : "failed";
    const updated = await updateRun(run.id, {
      status,
      blocked_reason: status === "blocked" ? message : null,
      error_message: status === "failed" ? message : null,
    });
    await addRunEvent(run.id, status, message);
    await upsertRunStatusComment({
      octokit,
      run: updated,
      headline: status,
      details: [message],
    });
  }
}

function makeWorkspace(runId: string): string {
  const workspace = join(tmpdir(), "igzpatch", runId);
  mkdirSync(workspace, { recursive: true });
  return workspace;
}

async function cloneRepository({
  token,
  repositoryFullName,
  workspace,
}: {
  token: string;
  repositoryFullName: string;
  workspace: string;
}): Promise<void> {
  const cloneUrl = `https://x-access-token:${token}@github.com/${repositoryFullName}.git`;
  const result = await runShellCommand({
    command: `git clone ${shellQuote(cloneUrl)} .`,
    cwd: workspace,
    timeoutMs: 120_000,
  });
  assertCommandSucceeded({
    ...result,
    command: "git clone [redacted GitHub installation token URL] .",
  });
}

async function runSetup(workspace: string, commands: string[], timeoutMinutes: number): Promise<void> {
  for (const command of commands) {
    const result = await runShellCommand({
      command,
      cwd: workspace,
      timeoutMs: timeoutMinutes * 60_000,
      env: safeExecutionEnvironment(),
      inheritEnv: false,
    });
    assertBlockingCommandSucceeded(result, "Setup command failed");
  }
}

async function runAgent(
  workspace: string,
  run: RunRecord,
  config: ReturnType<typeof loadRepoConfig>,
): Promise<void> {
  try {
    await runConfiguredAgent({
      workspace,
      run,
      config,
      timeoutMs: config.sandbox.timeout_minutes * 60_000,
    });
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BlockedRunError(`Agent provider failed: ${message}`);
  }
}

async function runChecks(workspace: string, commands: string[], timeoutMinutes: number): Promise<void> {
  for (const command of commands) {
    const result = await runShellCommand({
      command,
      cwd: workspace,
      timeoutMs: timeoutMinutes * 60_000,
      env: safeExecutionEnvironment(),
      inheritEnv: false,
    });
    assertBlockingCommandSucceeded(result, "Required check failed");
  }
}

async function git(workspace: string, command: string): Promise<void> {
  const result = await runShellCommand({
    command: `git ${command}`,
    cwd: workspace,
    timeoutMs: 120_000,
  });
  assertCommandSucceeded(result);
}

async function openDraftPullRequest({
  octokit,
  run,
  branchName,
  baseBranch,
  title,
  body,
  draft,
}: {
  octokit: Awaited<ReturnType<typeof getInstallationOctokit>>;
  run: RunRecord;
  branchName: string;
  baseBranch: string;
  title: string;
  body: string;
  draft: boolean;
}): Promise<string> {
  const [owner, repo] = run.repository_full_name.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository name: ${run.repository_full_name}`);

  const repository = await octokit.repos.get({ owner, repo });
  const response = await octokit.pulls.create({
    owner,
    repo,
    title,
    head: branchName,
    base: baseBranch || repository.data.default_branch,
    body,
    draft,
  });

  return response.data.html_url;
}

function loadConfigOrBlock(workspace: string) {
  try {
    return loadRepoConfig(workspace);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BlockedRunError(`Repository config validation failed: ${message}`);
  }
}

function assertBlockingCommandSucceeded(
  result: Parameters<typeof assertCommandSucceeded>[0],
  context: string,
): void {
  try {
    assertCommandSucceeded(result);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new BlockedRunError(`${context}: ${message}`);
  }
}

function renderPullRequestBody({
  run,
  diffSummary,
}: {
  run: RunRecord;
  diffSummary: { changedFiles: string[]; addedLines: number; deletedLines: number };
}): string {
  return [
    `Fixes #${run.issue_number}`,
    "",
    "## What changed",
    "",
    "- IgzPatch produced a bounded patch for the linked issue.",
    `- Changed files: ${diffSummary.changedFiles.length}`,
    `- Diff lines: +${diffSummary.addedLines} / -${diffSummary.deletedLines}`,
    "",
    "## Verification",
    "",
    "- Required repository checks passed before this draft PR was opened.",
    "",
    "## Audit",
    "",
    `- IgzPatch run: ${run.id}`,
    `- Trigger: ${run.trigger_kind}`,
    "- This PR is draft-only and requires human review before merge.",
  ].join("\n");
}

function formatBranchName(prefix: string, run: RunRecord): string {
  const cleanPrefix = prefix.replace(/^\/+|\/+$/g, "") || "igzpatch";
  return `${cleanPrefix}/issue-${run.issue_number}-${run.id.slice(0, 8)}`;
}

function hasAcceptanceCriteria(issueBody: string | null): boolean {
  if (!issueBody) return false;
  return /acceptance criteria|acceptance|done when|expected behavior/i.test(issueBody);
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, "'\\''")}'`;
}
