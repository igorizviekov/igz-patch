import { NextResponse, type NextRequest } from "next/server";

import {
  addRunEvent,
  createRun,
  findLatestRunForIssue,
  requestRunCancellation,
  updateRun,
} from "@/lib/db/runs";
import {
  defaultRepoConfig,
  loadRepoConfigFromGitHub,
  RepoConfigValidationError,
} from "@/lib/agent/repo-config";
import { requiredEnv } from "@/lib/env";
import { getInstallationOctokit } from "@/lib/github/app";
import {
  configuredIssueCommand,
  runInputFromWebhook,
  webhookRepositoryContext,
} from "@/lib/github/events";
import { verifyGitHubSignature } from "@/lib/github/signature";
import { upsertRunStatusComment } from "@/lib/github/status-comment";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  const eventName = request.headers.get("x-github-event") ?? "";
  const deliveryId = request.headers.get("x-github-delivery") ?? "";

  if (!deliveryId) {
    return NextResponse.json({ error: "Missing X-GitHub-Delivery" }, { status: 400 });
  }

  const verified = verifyGitHubSignature({
    body: rawBody,
    signature,
    secret: requiredEnv("GITHUB_WEBHOOK_SECRET"),
  });

  if (!verified) {
    return NextResponse.json({ error: "Invalid GitHub signature" }, { status: 401 });
  }

  let payload: Parameters<typeof runInputFromWebhook>[0]["payload"];
  try {
    payload = JSON.parse(rawBody) as Parameters<typeof runInputFromWebhook>[0]["payload"];
  } catch {
    return NextResponse.json({ error: "Invalid JSON payload" }, { status: 400 });
  }

  if (eventName !== "issues" && eventName !== "issue_comment") {
    return NextResponse.json({ accepted: false, ignored: true });
  }

  const repositoryContext = webhookRepositoryContext(payload);
  if (!repositoryContext) {
    return NextResponse.json({ accepted: false, ignored: true });
  }
  const [owner, repo] = repositoryContext.repositoryFullName.split("/");
  if (!owner || !repo) {
    return NextResponse.json({ error: "Invalid repository name" }, { status: 400 });
  }

  let repoConfig = defaultRepoConfig;
  let configValidationError: string | null = null;
  let octokit: Awaited<ReturnType<typeof getInstallationOctokit>>;
  try {
    octokit = await getInstallationOctokit(repositoryContext.installationId);
    repoConfig = await loadRepoConfigFromGitHub({ octokit, owner, repo });
  } catch (error) {
    if (!(error instanceof RepoConfigValidationError)) throw error;
    configValidationError = error.message;
    octokit = await getInstallationOctokit(repositoryContext.installationId);
  }

  if (eventName === "issue_comment") {
    const configuredCommand = configuredIssueCommand(payload, repoConfig.triggers.commands);
    if (configuredCommand?.action === "status" || configuredCommand?.action === "stop") {
      const issueNumber = payload.issue?.number;
      if (!issueNumber) {
        return NextResponse.json({ accepted: false, ignored: true });
      }
      const actor = payload.comment?.user?.login ?? payload.sender?.login ?? null;
      const run = configuredCommand.action === "stop"
        ? await requestRunCancellation(repositoryContext.repositoryFullName, issueNumber, actor)
        : await findLatestRunForIssue(repositoryContext.repositoryFullName, issueNumber);
      if (!run) {
        return NextResponse.json({ accepted: false, command: configuredCommand.action, reason: "no-run" });
      }
      const updated = await upsertRunStatusComment({
        octokit,
        run,
        headline: configuredCommand.action === "stop" ? "cancellation requested" : "status requested",
        details: configuredCommand.action === "stop"
          ? [`Requested by: \`${actor ?? "unknown"}\``]
          : ["Status refreshed from the durable run record."],
      });
      return NextResponse.json({
        accepted: true,
        command: configuredCommand.action,
        runId: updated.id,
        status: updated.status,
      });
    }
  }

  if (!configValidationError && !repoConfig.enabled) {
    return NextResponse.json({ accepted: false, ignored: true, reason: "disabled" });
  }

  const input = runInputFromWebhook({
    eventName,
    deliveryId,
    payload,
    triggers: repoConfig.triggers,
  });

  if (!input) {
    return NextResponse.json({ accepted: false, ignored: true });
  }

  const run = await createRun(input);
  if (configValidationError) {
    const message = `Repository config validation failed: ${configValidationError}`;
    const blocked = await updateRun(run.id, {
      status: "blocked",
      blocked_reason: message,
      error_message: null,
    });
    await addRunEvent(run.id, "blocked", message);
    await upsertRunStatusComment({
      octokit,
      run: blocked,
      headline: "blocked",
      details: [message],
    });
    return NextResponse.json({ accepted: true, runId: blocked.id, status: blocked.status });
  }
  return NextResponse.json({ accepted: true, runId: run.id, status: run.status });
}
