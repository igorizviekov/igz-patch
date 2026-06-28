import type { CreateRunInput } from "@/lib/db/runs";
import type { RepoConfig } from "@/lib/agent/repo-config";
import { z } from "zod";

export interface WebhookRepositoryContext {
  installationId: number;
  repositoryId: number;
  repositoryFullName: string;
}

export interface WebhookPayload {
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

const webhookPayloadSchema = z.object({
  action: z.string().max(100).optional(),
  installation: z.object({ id: z.number().int().positive().optional() }).passthrough().optional(),
  repository: z.object({
    id: z.number().int().positive().optional(),
    full_name: z.string().max(255).regex(/^[^/\s]+\/[^/\s]+$/).optional(),
  }).passthrough().optional(),
  issue: z.object({
    number: z.number().int().positive().optional(),
    title: z.string().max(1_000).optional(),
    html_url: z.string().url().max(2_000).optional(),
    body: z.string().max(200_000).nullable().optional(),
    pull_request: z.unknown().optional(),
    labels: z.array(z.object({ name: z.string().max(255).optional() }).passthrough()).max(100).optional(),
  }).passthrough().optional(),
  label: z.object({ name: z.string().max(255).optional() }).passthrough().optional(),
  comment: z.object({
    body: z.string().max(200_000).optional(),
    user: z.object({ login: z.string().max(255).optional() }).passthrough().optional(),
    author_association: z.string().max(100).optional(),
  }).passthrough().optional(),
  sender: z.object({ login: z.string().max(255).optional() }).passthrough().optional(),
}).passthrough();

export function parseWebhookPayload(value: unknown): WebhookPayload {
  return webhookPayloadSchema.parse(value);
}

export function durableRunCandidate({
  eventName,
  deliveryId,
  payload,
}: {
  eventName: string;
  deliveryId: string;
  payload: WebhookPayload;
}): CreateRunInput | null {
  if (!payload.issue || payload.issue.pull_request) return null;
  const trigger = eventName === "issues" && payload.action === "labeled"
    ? payload.label?.name?.trim() || null
    : eventName === "issue_comment"
      && payload.action === "created"
      && isMaintainerAssociation(payload.comment?.author_association)
      ? String(payload.comment?.body ?? "").split(/\r?\n/).map((line) => line.trim())
          .find((line) => /^@[^\s]+\s+fix$/i.test(line)) ?? null
      : null;
  if (!trigger) return null;
  return baseRunInput(payload, deliveryId, eventName === "issues" ? "issues.labeled" : "issue_comment.command", trigger);
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

  if (eventName === "issues") {
    const label = issueEventTrigger(payload, triggers.labels);
    if (!label) return null;
    return baseRunInput(payload, deliveryId, `issues.${payload.action ?? "unknown"}`, label);
  }

  if (eventName === "issue_comment") {
    const command = issueCommentTrigger(payload, triggers.commands);
    if (!command || commandAction(command) !== "fix") return null;
    return baseRunInput(payload, deliveryId, "issue_comment.command", command);
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
  if (payload.action !== "labeled") return null;
  const configuredLabels = new Map(labels.map((label) => [normalize(label), label]));
  return configuredLabels.get(normalize(payload.label?.name)) ?? null;
}

function baseRunInput(
  payload: WebhookPayload,
  deliveryId: string,
  triggerKind: string,
  triggerValue: string,
): CreateRunInput | null {
  const installationId = payload.installation?.id;
  const repositoryId = payload.repository?.id;
  const repositoryFullName = payload.repository?.full_name;
  const issueNumber = payload.issue?.number;
  const issueTitle = payload.issue?.title;
  const issueUrl = payload.issue?.html_url;
  if (!installationId || !repositoryId || !repositoryFullName || !issueNumber || !issueTitle || !issueUrl) return null;
  return {
    githubDeliveryId: deliveryId,
    installationId,
    repositoryId,
    repositoryFullName,
    issueNumber,
    issueTitle,
    issueBody: payload.issue?.body ?? null,
    issueUrl,
    triggerKind,
    triggerValue,
    triggerActor: payload.comment?.user?.login ?? payload.sender?.login ?? null,
  };
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
