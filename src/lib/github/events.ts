import type { CreateRunInput } from "@/lib/db/runs";
import type { RepoConfig } from "@/lib/agent/repo-config";

export interface WebhookRepositoryContext {
  installationId: number;
  repositoryId: number;
  repositoryFullName: string;
}

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
    author_association?: string;
  };
  sender?: { login?: string };
}

export function runInputFromWebhook({
  eventName,
  deliveryId,
  payload,
  triggers,
}: {
  eventName: string;
  deliveryId: string;
  payload: WebhookPayload;
  triggers: RepoConfig["triggers"];
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

  if (eventName === "issues") {
    const label = issueEventTrigger(payload, triggers.labels);
    if (!label) return null;
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
      triggerValue: label,
      triggerActor: payload.sender?.login ?? null,
    };
  }

  if (eventName === "issue_comment") {
    const command = issueCommentTrigger(payload, triggers.commands);
    if (!command || commandAction(command) !== "fix") return null;
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
      triggerValue: command,
      triggerActor: payload.comment?.user?.login ?? payload.sender?.login ?? null,
    };
  }

  return null;
}

export function webhookRepositoryContext(payload: WebhookPayload): WebhookRepositoryContext | null {
  const installationId = payload.installation?.id;
  const repositoryId = payload.repository?.id;
  const repositoryFullName = payload.repository?.full_name;
  if (!installationId || !repositoryId || !repositoryFullName) return null;
  return { installationId, repositoryId, repositoryFullName };
}

export function configuredIssueCommand(
  payload: WebhookPayload,
  commands: string[],
): { command: string; action: "fix" | "status" | "stop" } | null {
  const command = issueCommentTrigger(payload, commands);
  if (!command) return null;
  return { command, action: commandAction(command) };
}

function issueEventTrigger(payload: WebhookPayload, labels: string[]): string | null {
  if (!["opened", "reopened", "edited", "labeled"].includes(payload.action ?? "")) return null;
  const configuredLabels = new Map(labels.map((label) => [normalize(label), label]));
  if (payload.action === "labeled") {
    return configuredLabels.get(normalize(payload.label?.name)) ?? null;
  }
  for (const label of payload.issue?.labels ?? []) {
    const configured = configuredLabels.get(normalize(label.name));
    if (configured) return configured;
  }
  return null;
}

function issueCommentTrigger(payload: WebhookPayload, commands: string[]): string | null {
  if (payload.action !== "created") return null;
  if (!isMaintainerAssociation(payload.comment?.author_association)) return null;
  const lines = String(payload.comment?.body ?? "")
    .split(/\r?\n/)
    .map(normalize)
    .filter(Boolean);
  return commands.find((command) => lines.includes(normalize(command))) ?? null;
}

function isMaintainerAssociation(value: unknown): boolean {
  return ["OWNER", "MEMBER", "COLLABORATOR"].includes(String(value ?? "").toUpperCase());
}

function commandAction(command: string): "fix" | "status" | "stop" {
  const action = normalize(command).split(/\s+/).at(-1);
  if (action === "status" || action === "stop") return action;
  return "fix";
}

function normalize(value: unknown): string {
  return String(value ?? "").trim().toLowerCase();
}
