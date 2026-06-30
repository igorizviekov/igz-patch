import type postgres from "postgres";
import { randomUUID } from "node:crypto";

import { getSql } from "@/lib/db/client";

export type RunStatus =
  | "queued"
  | "running"
  | "succeeded"
  | "blocked"
  | "failed";

export interface RunRecord {
  id: string;
  github_delivery_id: string;
  installation_id: number;
  repository_id: number;
  repository_full_name: string;
  issue_number: number;
  issue_title: string;
  issue_body: string | null;
  issue_url: string;
  trigger_kind: string;
  trigger_value: string;
  trigger_actor: string | null;
  cancel_requested_at: Date | null;
  cancel_requested_by: string | null;
  status: RunStatus;
  lease_owner: string | null;
  lease_token: string | null;
  lease_expires_at: Date | null;
  attempts: number;
  max_attempts: number;
  status_comment_id: number | null;
  status_comment_url: string | null;
  branch_name: string | null;
  pull_request_url: string | null;
  blocked_reason: string | null;
  error_message: string | null;
  created_at: Date;
  updated_at: Date;
  started_at: Date | null;
  finished_at: Date | null;
}

export interface CreateRunInput {
  githubDeliveryId: string;
  installationId: number;
  repositoryId: number;
  repositoryFullName: string;
  issueNumber: number;
  issueTitle: string;
  issueBody?: string | null;
  issueUrl: string;
  triggerKind: string;
  triggerValue: string;
  triggerActor?: string | null;
}

export interface RunLease {
  owner: string;
  token: string;
}

type RunCommentFields = Partial<
  Pick<RunRecord, "status_comment_id" | "status_comment_url">
>;

type LeasedRunFields = RunCommentFields & Partial<
  Pick<
    RunRecord,
    "status" | "branch_name" | "pull_request_url" | "blocked_reason" | "error_message"
  >
>;

export class LeaseLostError extends Error {
  constructor(runId: string) {
    super(`Worker no longer owns the active lease for run ${runId}`);
    this.name = "LeaseLostError";
  }
}

export async function createRun(input: CreateRunInput): Promise<RunRecord> {
  const sql = getSql();
  const [run] = await sql<RunRecord[]>`
    insert into igz_runs (
      github_delivery_id,
      installation_id,
      repository_id,
      repository_full_name,
      issue_number,
      issue_title,
      issue_body,
      issue_url,
      trigger_kind,
      trigger_value,
      trigger_actor
    )
    values (
      ${input.githubDeliveryId},
      ${input.installationId},
      ${input.repositoryId},
      ${input.repositoryFullName},
      ${input.issueNumber},
      ${input.issueTitle},
      ${input.issueBody ?? null},
      ${input.issueUrl},
      ${input.triggerKind},
      ${input.triggerValue},
      ${input.triggerActor ?? null}
    )
    on conflict do nothing
    returning *
  `;
  if (run) {
    await addRunEvent(run.id, "queued", `Queued from ${input.triggerKind}`);
    return run;
  }

  const [existing] = await sql<RunRecord[]>`
    select * from igz_runs
    where github_delivery_id = ${input.githubDeliveryId}
       or (
         repository_full_name = ${input.repositoryFullName}
         and issue_number = ${input.issueNumber}
         and status in ('queued', 'running')
       )
    order by (github_delivery_id = ${input.githubDeliveryId}) desc
    limit 1
  `;
  if (!existing) throw new Error("Failed to create or load run");
  return existing;
}

export async function claimNextRun(workerId: string, leaseMs: number): Promise<RunRecord | null> {
  const sql = getSql();
  const leaseToken = randomUUID();
  return sql.begin(async (tx) => {
    const [candidate] = await tx<Pick<RunRecord, "id" | "attempts" | "max_attempts">[]>`
      select id, attempts, max_attempts
      from igz_runs
      where
        (
          status = 'queued'
          or (status = 'running' and lease_expires_at < now())
        )
        and attempts < max_attempts
      order by created_at asc
      for update skip locked
      limit 1
    `;

    if (!candidate) return null;

    const [run] = await tx<RunRecord[]>`
      update igz_runs
      set
        status = 'running',
        lease_owner = ${workerId},
        lease_token = ${leaseToken},
        lease_expires_at = now() + (${String(leaseMs)} || ' milliseconds')::interval,
        attempts = attempts + 1,
        started_at = coalesce(started_at, now()),
        updated_at = now()
      where id = ${candidate.id}
      returning *
    `;

    return run ?? null;
  });
}

export async function heartbeatRun(runId: string, lease: RunLease, leaseMs: number): Promise<void> {
  const sql = getSql();
  const renewed = await sql<{ id: string }[]>`
    update igz_runs
    set
      lease_expires_at = now() + (${String(leaseMs)} || ' milliseconds')::interval,
      updated_at = now()
    where id = ${runId}
      and lease_owner = ${lease.owner}
      and lease_token = ${lease.token}
      and status = 'running'
      and lease_expires_at > now()
    returning id
  `;
  if (renewed.length !== 1) throw new LeaseLostError(runId);
}

export async function updateRun(
  runId: string,
  fields: RunCommentFields,
): Promise<RunRecord> {
  return updateRunInternal(runId, fields);
}

export async function updateRunWithLease(
  runId: string,
  lease: RunLease,
  fields: LeasedRunFields,
): Promise<RunRecord> {
  return updateRunInternal(runId, fields, lease);
}

async function updateRunInternal(
  runId: string,
  fields: LeasedRunFields,
  lease?: RunLease,
): Promise<RunRecord> {
  const sql = getSql();
  const has = (name: keyof LeasedRunFields) => Object.prototype.hasOwnProperty.call(fields, name);
  const hasStatus = has("status");
  const nextStatus = fields.status ?? null;
  const releasesLease = hasStatus && nextStatus !== null
    && ["queued", "succeeded", "blocked", "failed"].includes(nextStatus);
  const isTerminal = hasStatus && nextStatus !== null
    && ["succeeded", "blocked", "failed"].includes(nextStatus);

  const [updated] = await sql<RunRecord[]>`
    update igz_runs
    set
      status = case when ${hasStatus} then ${nextStatus} else status end,
      status_comment_id = case when ${has("status_comment_id")} then ${fields.status_comment_id ?? null} else status_comment_id end,
      status_comment_url = case when ${has("status_comment_url")} then ${fields.status_comment_url ?? null} else status_comment_url end,
      branch_name = case when ${has("branch_name")} then ${fields.branch_name ?? null} else branch_name end,
      pull_request_url = case when ${has("pull_request_url")} then ${fields.pull_request_url ?? null} else pull_request_url end,
      blocked_reason = case when ${has("blocked_reason")} then ${fields.blocked_reason ?? null} else blocked_reason end,
      error_message = case when ${has("error_message")} then ${fields.error_message ?? null} else error_message end,
      lease_owner = case when ${releasesLease} then null else lease_owner end,
      lease_token = case when ${releasesLease} then null else lease_token end,
      lease_expires_at = case when ${releasesLease} then null else lease_expires_at end,
      finished_at = case
        when ${isTerminal} then coalesce(finished_at, now())
        when ${hasStatus} then null
        else finished_at
      end,
      updated_at = now()
    where id = ${runId}
      and (${lease?.owner ?? null}::text is null or (
        lease_owner = ${lease?.owner ?? null}
        and lease_token = ${lease?.token ?? null}
        and status = 'running'
        and lease_expires_at > now()
      ))
    returning *
  `;
  if (!updated) {
    if (lease) throw new LeaseLostError(runId);
    throw new Error(`Failed to update run: ${runId}`);
  }
  return updated;
}

export async function blockQueuedRun(runId: string, message: string): Promise<RunRecord> {
  const sql = getSql();
  const [blocked] = await sql<RunRecord[]>`
    update igz_runs
    set
      status = 'blocked',
      blocked_reason = ${message},
      error_message = null,
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      finished_at = coalesce(finished_at, now()),
      updated_at = now()
    where id = ${runId} and status = 'queued'
    returning *
  `;
  if (blocked) return blocked;

  const [current] = await sql<RunRecord[]>`select * from igz_runs where id = ${runId}`;
  if (!current) throw new Error(`Run not found: ${runId}`);
  return current;
}

export async function addRunEvent(
  runId: string,
  eventType: string,
  message: string,
  metadata: postgres.JSONValue = {},
): Promise<void> {
  const sql = getSql();
  await sql`
    insert into igz_run_events (run_id, event_type, message, metadata)
    values (${runId}, ${eventType}, ${message}, ${sql.json(metadata)})
  `;
}

export async function addRunEventWithLease(
  runId: string,
  lease: RunLease,
  eventType: string,
  message: string,
  metadata: postgres.JSONValue = {},
): Promise<void> {
  const sql = getSql();
  const inserted = await sql<{ id: number }[]>`
    insert into igz_run_events (run_id, event_type, message, metadata)
    select id, ${eventType}, ${message}, ${sql.json(metadata)}
    from igz_runs
    where id = ${runId}
      and lease_owner = ${lease.owner}
      and lease_token = ${lease.token}
      and status = 'running'
      and lease_expires_at > now()
    returning id
  `;
  if (inserted.length !== 1) throw new LeaseLostError(runId);
}

export async function assertRunLease(runId: string, lease: RunLease): Promise<void> {
  const sql = getSql();
  const [run] = await sql<{ id: string }[]>`
    select id
    from igz_runs
    where id = ${runId}
      and lease_owner = ${lease.owner}
      and lease_token = ${lease.token}
      and status = 'running'
      and lease_expires_at > now()
  `;
  if (!run) throw new LeaseLostError(runId);
}

export async function listRecentRuns(limit = 25): Promise<RunRecord[]> {
  const sql = getSql();
  return sql<RunRecord[]>`
    select *
    from igz_runs
    order by created_at desc
    limit ${limit}
  `;
}

export async function findLatestRunForIssue(
  repositoryFullName: string,
  issueNumber: number,
): Promise<RunRecord | null> {
  const sql = getSql();
  const [run] = await sql<RunRecord[]>`
    select *
    from igz_runs
    where repository_full_name = ${repositoryFullName} and issue_number = ${issueNumber}
    order by created_at desc
    limit 1
  `;
  return run ?? null;
}

export async function requestRunCancellation(
  repositoryFullName: string,
  issueNumber: number,
  actor: string | null,
): Promise<RunRecord | null> {
  const sql = getSql();
  const [run] = await sql<RunRecord[]>`
    update igz_runs
    set
      cancel_requested_at = now(),
      cancel_requested_by = ${actor},
      status = case when status = 'queued' then 'blocked' else status end,
      blocked_reason = case when status = 'queued' then 'Cancelled before execution' else blocked_reason end,
      finished_at = case when status = 'queued' then now() else finished_at end,
      lease_owner = case when status = 'queued' then null else lease_owner end,
      lease_token = case when status = 'queued' then null else lease_token end,
      lease_expires_at = case when status = 'queued' then null else lease_expires_at end,
      updated_at = now()
    where id = (
      select id
      from igz_runs
      where
        repository_full_name = ${repositoryFullName}
        and issue_number = ${issueNumber}
        and status in ('queued', 'running')
      order by created_at desc
      limit 1
    )
    returning *
  `;
  if (run) {
    await addRunEvent(run.id, "cancellation_requested", "Cancellation requested", {
      actor: actor ?? "unknown",
    });
  }
  return run ?? null;
}

export async function isRunCancellationRequested(runId: string): Promise<boolean> {
  const sql = getSql();
  const [run] = await sql<{ cancel_requested_at: Date | null }[]>`
    select cancel_requested_at from igz_runs where id = ${runId}
  `;
  return Boolean(run?.cancel_requested_at);
}

export async function failExhaustedRuns(): Promise<number> {
  const sql = getSql();
  const exhausted = await sql<Pick<RunRecord, "id">[]>`
    update igz_runs
    set
      status = 'failed',
      error_message = 'Retry attempts exhausted',
      lease_owner = null,
      lease_token = null,
      lease_expires_at = null,
      finished_at = now(),
      updated_at = now()
    where
      attempts >= max_attempts
      and (
        status = 'queued'
        or (status = 'running' and lease_expires_at < now())
      )
    returning id
  `;

  for (const run of exhausted) {
    await addRunEvent(run.id, "failed", "Retry attempts exhausted");
  }
  return exhausted.length;
}
