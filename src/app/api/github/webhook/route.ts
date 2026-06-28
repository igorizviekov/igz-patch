import { NextResponse, type NextRequest } from "next/server";

import {
  defaultRepoConfig,
  loadRepoConfigFromGitHub,
  RepoConfigValidationError,
} from "@/lib/agent/repo-config";
import {
  addRunEvent,
  createRun,
  findLatestRunForIssue,
  requestRunCancellation,
  updateRun,
  type RunRecord,
} from "@/lib/db/runs";
import { requiredEnv } from "@/lib/env";
import { getInstallationOctokit } from "@/lib/github/app";
import {
  configuredIssueCommand,
  durableRunCandidate,
  parseWebhookPayload,
  runInputFromWebhook,
  webhookRepositoryContext,
} from "@/lib/github/events";
import { verifyGitHubSignature } from "@/lib/github/signature";
import { upsertRunStatusComment } from "@/lib/github/status-comment";

export const runtime = "nodejs";

const maximumWebhookBytes = 1_000_000;

export async function POST(request: NextRequest) {
  const contentLength = Number(request.headers.get("content-length") ?? "0");
  if (Number.isFinite(contentLength) && contentLength > maximumWebhookBytes) {
    return NextResponse.json({ error: "Webhook payload is too large" }, { status: 413 });
  }

  const rawBody = await request.text();
  if (Buffer.byteLength(rawBody) > maximumWebhookBytes) {
    return NextResponse.json({ error: "Webhook payload is too large" }, { status: 413 });
  }
  const signature = request.headers.get("x-hub-signature-256");
  const eventName = request.headers.get("x-github-event") ?? "";
  const deliveryId = request.headers.get("x-github-delivery") ?? "";

  if (!deliveryId || deliveryId.length > 255) {
    return NextResponse.json({ error: "Missing or invalid X-GitHub-Delivery" }, { status: 400 });
  }
  if (!verifyGitHubSignature({
    body: rawBody,
    signature,
    secret: requiredEnv("GITHUB_WEBHOOK_SECRET"),
  })) {
    return NextResponse.json({ error: "Invalid GitHub signature" }, { status: 401 });
  }

  let payload;
  try {
    payload = parseWebhookPayload(JSON.parse(rawBody) as unknown);
  } catch {
    return NextResponse.json({ error: "Invalid GitHub webhook payload" }, { status: 400 });
  }
  if (eventName !== "issues" && eventName !== "issue_comment") {
    return NextResponse.json({ accepted: false, ignored: true });
  }

  const repositoryContext = webhookRepositoryContext(payload);
  if (!repositoryContext) return NextResponse.json({ accepted: false, ignored: true });
  const [owner, repo] = repositoryContext.repositoryFullName.split("/");
  if (!owner || !repo) return NextResponse.json({ error: "Invalid repository name" }, { status: 400 });

  const candidate = durableRunCandidate({ eventName, deliveryId, payload });
  const durableRun = candidate ? await createRun(candidate) : null;
  const ownsDurableDelivery = durableRun?.github_delivery_id === deliveryId;

  let repoConfig = defaultRepoConfig;
  let configValidationError: string | null = null;
  let octokit: Awaited<ReturnType<typeof getInstallationOctokit>> | null = null;
  try {
    octokit = await getInstallationOctokit(repositoryContext.installationId);
    repoConfig = await loadRepoConfigFromGitHub({ octokit, owner, repo });
  } catch (error) {
    if (error instanceof RepoConfigValidationError) configValidationError = error.message;
    else if (durableRun) {
      return NextResponse.json(
        { accepted: true, runId: durableRun.id, status: durableRun.status, configPending: true },
        { status: 202 },
      );
    } else throw error;
  }

  if (eventName === "issue_comment" && octokit) {
    const configuredCommand = configuredIssueCommand(payload, repoConfig.triggers.commands);
    if (configuredCommand?.action === "status" || configuredCommand?.action === "stop") {
      const issueNumber = payload.issue?.number;
      if (!issueNumber) return NextResponse.json({ accepted: false, ignored: true });
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

  if (!durableRun) return NextResponse.json({ accepted: false, ignored: true });
  if (!ownsDurableDelivery) {
    return NextResponse.json({
      accepted: true,
      duplicate: true,
      runId: durableRun.id,
      status: durableRun.status,
    });
  }
  if (configValidationError) {
    return blockRun(durableRun, `Repository config validation failed: ${configValidationError}`, octokit);
  }
  if (!repoConfig.enabled) return blockRun(durableRun, "IgzPatch is disabled by repository config.", octokit);

  const configuredInput = runInputFromWebhook({ eventName, deliveryId, payload, triggers: repoConfig.triggers });
  if (!configuredInput) {
    return blockRun(durableRun, "Webhook trigger does not match repository config.", octokit);
  }
  return NextResponse.json({ accepted: true, runId: durableRun.id, status: durableRun.status });
}

async function blockRun(
  run: RunRecord,
  message: string,
  octokit: Awaited<ReturnType<typeof getInstallationOctokit>> | null,
) {
  const blocked = await updateRun(run.id, {
    status: "blocked",
    blocked_reason: message,
    error_message: null,
  });
  await addRunEvent(run.id, "blocked", message);
  if (octokit) {
    try {
      await upsertRunStatusComment({ octokit, run: blocked, headline: "blocked", details: [message] });
    } catch {
    }
  }
  return NextResponse.json({ accepted: true, runId: blocked.id, status: blocked.status });
}
