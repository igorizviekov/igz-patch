import { mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  assertCommandSucceeded,
  runProcess,
  safeExecutionEnvironment,
  type CommandResult,
} from "@/lib/agent/command";
import { BlockedRunError, enforceDiffPolicy, readDiffSummary } from "@/lib/agent/diff";
import { runConfiguredAgent } from "@/lib/agent/providers";
import { defaultRepoConfig, type RepoConfig } from "@/lib/agent/repo-config";
import { loadRepoConfig } from "@/lib/agent/repo-config-local";
import { createDockerSandbox, type AgentSandbox } from "@/lib/agent/sandbox";
import {
  addRunEvent,
  isRunCancellationRequested,
  updateRun,
  type RunRecord,
} from "@/lib/db/runs";
import { getInstallationOctokit, getInstallationToken } from "@/lib/github/app";
import { upsertRunStatusComment } from "@/lib/github/status-comment";
import { redactText, truncateText } from "@/lib/redaction";
import { isTransientError, withRetry } from "@/lib/retry";

type InstallationOctokit = Awaited<ReturnType<typeof getInstallationOctokit>>;

export async function executeRun(run: RunRecord): Promise<void> {
  let octokit: InstallationOctokit | null = null;
  let currentRun = run;
  let workspace: string | null = null;
  let config: RepoConfig | null = null;
  let sandbox: AgentSandbox | null = null;

  try {
    octokit = await retryTransient(() => getInstallationOctokit(run.installation_id));
    currentRun = await retryTransient(() =>
      upsertRunStatusComment({
        octokit: requireOctokit(octokit),
        run: currentRun,
        headline: "running",
        details: ["Worker claimed the run and is preparing a repository workspace."],
      }),
    );
    await assertRunActive(run.id);
    await addRunEvent(run.id, "workspace", "Preparing checkout");
    const token = await retryTransient(() => getInstallationToken(run.installation_id));
    workspace = prepareWorkspace(run.id);

    await retryCommand(async () => {
      workspace = prepareWorkspace(run.id);
      await cloneRepository({
        token,
        repositoryFullName: run.repository_full_name,
        workspace: requireWorkspace(workspace),
      });
    });

    config = loadConfigOrBlock(workspace);
    await assertRunActive(run.id);
    enforceTriggerConfig(run, config);
    if (!config.enabled) throw new BlockedRunError("IgzPatch is disabled by repository config.");
    if (config.issue_scope.requires_acceptance_criteria && !hasAcceptanceCriteria(run.issue_body)) {
      throw new BlockedRunError("Issue lacks explicit acceptance criteria required by repository config.");
    }
    const deadline = Date.now() + config.sandbox.timeout_minutes * 60_000;
    sandbox = createDockerSandbox({
      workspace,
      runId: run.id,
      config,
      runtimeEnv: {
        IGZPATCH_RUN_ID: run.id,
        IGZPATCH_REPOSITORY: run.repository_full_name,
        IGZPATCH_ISSUE_NUMBER: String(run.issue_number),
        IGZPATCH_ISSUE_TITLE: run.issue_title,
      },
    });
    await sandbox.ensureAvailable();
    await addRunEvent(run.id, "sandbox", "Docker sandbox is ready", {
      image: config.sandbox.image,
      setup_network: config.sandbox.setup_network,
      run_network: config.sandbox.run_network,
      cpu_limit: config.sandbox.cpu_limit,
      memory_mb: config.sandbox.memory_mb,
    });

    const branchName = formatBranchName(config.branch.prefix, run);

    await git(
      workspace,
      ["checkout", "-b", branchName, `origin/${config.repo.default_branch}`],
      safeExecutionEnvironment(),
      remainingTimeout(deadline, 120_000),
    );
    currentRun = await updateRun(run.id, { branch_name: branchName });
    currentRun = await retryTransient(() =>
      upsertRunStatusComment({
        octokit: requireOctokit(octokit),
        run: currentRun,
        headline: "editing",
        details: ["Repository cloned.", `Branch: \`${branchName}\``],
      }),
    );

    await runSetup(run.id, sandbox, config, deadline);
    await assertRunActive(run.id);
    await addRunEvent(run.id, "agent", "Starting configured agent provider", {
      provider: process.env.IGZPATCH_AGENT_PROVIDER ?? config.routing.primary.provider,
      model: process.env.IGZPATCH_AGENT_MODEL ?? config.routing.primary.model,
    });
    const agentResult = await runAgent(workspace, currentRun, config, sandbox, deadline);
    await assertRunActive(run.id);
    await addRunEvent(run.id, "agent_completed", "Agent provider completed", {
      provider: agentResult.provider,
      model: agentResult.model,
      summary: truncateText(redactText(agentResult.summary, config.audit.redact_patterns)),
    });
    await runChecks(run.id, sandbox, config, deadline);
    await assertRunActive(run.id);
    sandbox.cleanupRuntime();

    const diffSummary = await readDiffSummary(workspace);
    enforceDiffPolicy(diffSummary, config);
    await addRunEvent(run.id, "diff", "Diff policy passed", {
      changed_files: diffSummary.changedFiles,
      added_lines: diffSummary.addedLines,
      deleted_lines: diffSummary.deletedLines,
    });

    await git(workspace, ["config", "user.name", "IgzPatch"], safeExecutionEnvironment(), remainingTimeout(deadline, 120_000));
    await git(
      workspace,
      ["config", "user.email", "igzpatch[bot]@users.noreply.github.com"],
      safeExecutionEnvironment(),
      remainingTimeout(deadline, 120_000),
    );
    await git(workspace, ["add", "-A"], safeExecutionEnvironment(), remainingTimeout(deadline, 120_000));
    await git(
      workspace,
      ["commit", "-m", `IgzPatch: fix issue #${run.issue_number}`],
      safeExecutionEnvironment(),
      remainingTimeout(deadline, 120_000),
    );
    const finalWorkspace = workspace;
    const finalConfig = config;
    await assertRunActive(run.id);
    const pushToken = await retryTransient(() => getInstallationToken(run.installation_id));
    await retryCommand(() =>
      git(
        finalWorkspace,
        ["push", "--force-with-lease", "origin", branchName],
        gitAuthEnvironment(pushToken),
        remainingTimeout(deadline, 120_000),
      ),
    );

    await assertRunActive(run.id);
    const prUrl = await retryTransient(() =>
      openDraftPullRequest({
        octokit: requireOctokit(octokit),
        run: currentRun,
        branchName,
        baseBranch: finalConfig.repo.default_branch,
        title: finalConfig.pull_request.title_template.replace("#{issue_number}", String(run.issue_number)),
        body: renderPullRequestBody({ run: currentRun, diffSummary }),
      }),
    );

    const succeeded = await updateRun(run.id, {
      status: "succeeded",
      pull_request_url: prUrl,
    });
    await addRunEvent(run.id, "succeeded", "Opened draft pull request", { pull_request_url: prUrl });
    await retryTransient(() =>
      upsertRunStatusComment({
        octokit: requireOctokit(octokit),
        run: succeeded,
        headline: "draft PR opened",
        details: [
          `PR: ${prUrl}`,
          `Changed files: ${diffSummary.changedFiles.length}`,
          `Diff lines: +${diffSummary.addedLines} / -${diffSummary.deletedLines}`,
        ],
      }),
    );
  } catch (error) {
    const patterns = config?.audit.redact_patterns ?? defaultRepoConfig.audit.redact_patterns;
    const message = truncateText(redactText(error instanceof Error ? error.message : String(error), patterns));
    const retryQueued = !(error instanceof BlockedRunError) && isTransientError(error) && run.attempts < run.max_attempts;
    const status = retryQueued ? "queued" : error instanceof BlockedRunError ? "blocked" : "failed";
    const updated = await updateRun(run.id, {
      status,
      blocked_reason: status === "blocked" ? message : null,
      error_message: status === "failed" || status === "queued" ? message : null,
    });
    await addRunEvent(run.id, retryQueued ? "retry_queued" : status, message, {
      attempt: run.attempts,
      max_attempts: run.max_attempts,
    });
    if (octokit) {
      try {
        await retryTransient(() =>
          upsertRunStatusComment({
            octokit: requireOctokit(octokit),
            run: updated,
            headline: retryQueued ? "retry queued" : status,
            details: [message],
          }),
        );
      } catch (commentError) {
        await addRunEvent(
          run.id,
          "status_comment_failed",
          truncateText(redactText(commentError instanceof Error ? commentError.message : String(commentError), patterns)),
        );
      }
    }
  } finally {
    if (sandbox) await sandbox.dispose();
    if (workspace) rmSync(workspace, { recursive: true, force: true });
  }
}

function prepareWorkspace(runId: string): string {
  const workspace = join(tmpdir(), "igzpatch", runId);
  rmSync(workspace, { recursive: true, force: true });
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
  const cloneUrl = `https://github.com/${repositoryFullName}.git`;
  const result = await runProcess({
    command: "git",
    args: ["clone", cloneUrl, "."],
    displayCommand: `git clone https://github.com/${repositoryFullName}.git .`,
    cwd: workspace,
    timeoutMs: 120_000,
    env: gitAuthEnvironment(token),
    inheritEnv: false,
  });
  assertCommandSucceeded(result);
}

async function runSetup(
  runId: string,
  sandbox: AgentSandbox,
  config: RepoConfig,
  deadline: number,
): Promise<void> {
  for (const command of config.sandbox.setup) {
    const result = await sandbox.runCommand({
      command,
      phase: "setup",
      timeoutMs: remainingTimeout(deadline, config.sandbox.timeout_minutes * 60_000),
    });
    await recordCommandEvent(runId, "setup_command", result, config);
    assertBlockingCommandSucceeded(result, "Setup command failed");
  }
}

async function runAgent(
  workspace: string,
  run: RunRecord,
  config: ReturnType<typeof loadRepoConfig>,
  sandbox: AgentSandbox,
  deadline: number,
): ReturnType<typeof runConfiguredAgent> {
  try {
    return await runConfiguredAgent({
      workspace,
      run,
      config,
      sandbox,
      timeoutMs: remainingTimeout(deadline, config.sandbox.timeout_minutes * 60_000),
      onToolEvent: config.audit.store_tool_calls
        ? async (event) => {
            await addRunEvent(
              run.id,
              "tool_call",
              `${event.name} ${event.ok ? "completed" : "failed"}`,
              summarizeToolEvent(event, config.audit.redact_patterns),
            );
          }
        : undefined,
    });
  } catch (error) {
    if (isTransientError(error)) throw error;
    const message = error instanceof Error ? error.message : String(error);
    throw new BlockedRunError(`Agent provider failed: ${message}`);
  }
}

async function runChecks(
  runId: string,
  sandbox: AgentSandbox,
  config: RepoConfig,
  deadline: number,
): Promise<void> {
  for (const command of config.checks.required) {
    const result = await sandbox.runCommand({
      command,
      phase: "run",
      timeoutMs: remainingTimeout(deadline, config.sandbox.timeout_minutes * 60_000),
    });
    await recordCommandEvent(runId, "required_check", result, config);
    assertBlockingCommandSucceeded(result, "Required check failed");
  }

  for (const command of config.checks.optional) {
    const result = await sandbox.runCommand({
      command,
      phase: "run",
      timeoutMs: remainingTimeout(deadline, config.sandbox.timeout_minutes * 60_000),
    });
    await recordCommandEvent(runId, "optional_check", result, config);
  }
}

async function git(
  workspace: string,
  args: string[],
  env: Record<string, string> = safeExecutionEnvironment(),
  timeoutMs = 120_000,
): Promise<void> {
  const result = await runProcess({
    command: "git",
    args,
    cwd: workspace,
    timeoutMs,
    env,
    inheritEnv: false,
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
}: {
  octokit: InstallationOctokit;
  run: RunRecord;
  branchName: string;
  baseBranch: string;
  title: string;
  body: string;
}): Promise<string> {
  const [owner, repo] = run.repository_full_name.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository name: ${run.repository_full_name}`);

  const existing = await octokit.pulls.list({
    owner,
    repo,
    state: "open",
    head: `${owner}:${branchName}`,
    per_page: 1,
  });
  if (existing.data[0]) return existing.data[0].html_url;

  const repository = await octokit.repos.get({ owner, repo });
  const response = await octokit.pulls.create({
    owner,
    repo,
    title,
    head: branchName,
    base: baseBranch || repository.data.default_branch,
    body,
    draft: true,
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

function enforceTriggerConfig(run: RunRecord, config: RepoConfig): void {
  const values = run.trigger_kind.startsWith("issues.")
    ? config.triggers.labels
    : config.triggers.commands;
  if (!values.some((value) => value.trim().toLowerCase() === run.trigger_value.trim().toLowerCase())) {
    throw new BlockedRunError("Webhook trigger no longer matches repository config.");
  }
}

function gitAuthEnvironment(token: string): Record<string, string> {
  return {
    ...safeExecutionEnvironment(),
    GIT_TERMINAL_PROMPT: "0",
    GIT_CONFIG_COUNT: "1",
    GIT_CONFIG_KEY_0: "http.extraHeader",
    GIT_CONFIG_VALUE_0: `Authorization: Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}`,
  };
}

async function recordCommandEvent(
  runId: string,
  eventType: string,
  result: CommandResult,
  config: RepoConfig,
): Promise<void> {
  const metadata: Record<string, string | number | boolean | null> = {
    command: result.command,
    exit_code: result.exitCode,
    timed_out: result.timedOut,
  };
  if (config.audit.store_command_logs) {
    metadata.stdout = truncateText(redactText(result.stdout, config.audit.redact_patterns));
    metadata.stderr = truncateText(redactText(result.stderr, config.audit.redact_patterns));
  }
  await addRunEvent(
    runId,
    eventType,
    result.exitCode === 0 ? "Command completed" : "Command failed",
    metadata,
  );
}

function retryTransient<T>(operation: () => Promise<T>): Promise<T> {
  return withRetry(() => operation(), { attempts: 3, shouldRetry: isTransientError });
}

function retryCommand(operation: () => Promise<void>): Promise<void> {
  return withRetry(() => operation(), { attempts: 3 });
}

function requireOctokit(octokit: InstallationOctokit | null): InstallationOctokit {
  if (!octokit) throw new Error("GitHub installation client is unavailable");
  return octokit;
}

function requireWorkspace(workspace: string | null): string {
  if (!workspace) throw new Error("Repository workspace is unavailable");
  return workspace;
}

function remainingTimeout(deadline: number, maximum: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new BlockedRunError("Run exceeded the configured timeout.");
  return Math.min(remaining, maximum);
}

function summarizeToolEvent(
  event: { name: string; arguments: unknown; output: string; ok: boolean },
  redactPatterns: string[],
): Record<string, string | number | boolean> {
  const args = event.arguments && typeof event.arguments === "object" && !Array.isArray(event.arguments)
    ? event.arguments as Record<string, unknown>
    : {};
  const metadata: Record<string, string | number | boolean> = {
    tool: event.name,
    ok: event.ok,
    output_bytes: Buffer.byteLength(event.output),
  };
  for (const key of ["path", "query", "command", "start_line", "end_line"]) {
    const value = args[key];
    if (typeof value === "string") metadata[key] = truncateText(redactText(value, redactPatterns), 500);
    if (typeof value === "number") metadata[key] = value;
  }
  for (const key of ["content", "old_text", "new_text"]) {
    const value = args[key];
    if (typeof value === "string") metadata[`${key}_bytes`] = Buffer.byteLength(value);
  }
  if (!event.ok) metadata.error = truncateText(redactText(event.output, redactPatterns), 1_000);
  return metadata;
}

async function assertRunActive(runId: string): Promise<void> {
  if (await isRunCancellationRequested(runId)) {
    throw new BlockedRunError("Run was cancelled by a maintainer command.");
  }
}
