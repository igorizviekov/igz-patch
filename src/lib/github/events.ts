import type { CreateRunInput } from "@/lib/db/runs";

const DEFAULT_TRIGGER_LABEL = "igz:fix";
const DEFAULT_COMMANDS = ["@igzpatch fix"];

interface WebhookPayload {
  action?: string;
  installation?: { id?: number };
  repository?: {
    id?: number;
    full_name?: string;
  };
  issue?: {
    number?: number;
    title?: string;
    html_url?: string;
    body?: string | null;
    pull_request?: unknown;
    labels?: Array<{ name?: string }>;
  };
  label?: { name?: string };
  comment?: {
    body?: string;
    user?: { login?: string };
  };
  sender?: { login?: string };
}

export function runInputFromWebhook({
  eventName,
  deliveryId,
  payload,
}: {
  eventName: string;
  deliveryId: string;
  payload: WebhookPayload;
}): CreateRunInput | null {
  if (eventName !== "issues" && eventName !== "issue_comment") return null;
  if (!payload.issue || payload.issue.pull_request) return null;

  const installationId = payload.installation?.id;
  const repositoryId = payload.repository?.id;
  const repositoryFullName = payload.repository?.full_name;
  const issueNumber = payload.issue.number;
  const issueTitle = payload.issue.title;
  const issueBody = payload.issue.body ?? null;
  const issueUrl = payload.issue.html_url;

  if (!installationId || !repositoryId || !repositoryFullName || !issueNumber || !issueTitle || !issueUrl) {
    return null;
  }

  if (eventName === "issues" && issueEventTriggersRun(payload)) {
    return {
      githubDeliveryId: deliveryId,
      installationId,
      repositoryId,
      repositoryFullName,
      issueNumber,
      issueTitle,
      issueBody,
      issueUrl,
      triggerKind: `issues.${payload.action ?? "unknown"}`,
      triggerActor: payload.sender?.login ?? null,
    };
  }

  if (eventName === "issue_comment" && issueCommentTriggersRun(payload)) {
    return {
      githubDeliveryId: deliveryId,
      installationId,
      repositoryId,
      repositoryFullName,
      issueNumber,
      issueTitle,
      issueBody,
      issueUrl,
      triggerKind: "issue_comment.command",
      triggerActor: payload.comment?.user?.login ?? payload.sender?.login ?? null,
    };
  }

  return null;
}

function issueEventTriggersRun(payload: WebhookPayload): boolean {
  if (!["opened", "reopened", "edited", "labeled"].includes(payload.action ?? "")) return false;
  if (payload.action === "labeled") {
    return normalize(payload.label?.name) === DEFAULT_TRIGGER_LABEL;
  }
  return payload.issue?.labels?.some((label) => normalize(label.name) === DEFAULT_TRIGGER_LABEL) ?? false;
}

function issueCommentTriggersRun(payload: WebhookPayload): boolean {
  if (payload.action !== "created") return false;
  const body = normalize(payload.comment?.body);
  return DEFAULT_COMMANDS.some((command) => body.includes(command));
}

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}
