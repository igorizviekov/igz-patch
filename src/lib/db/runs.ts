import type postgres from "postgres";

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
  trigger_actor: string | null;
  status: RunStatus;
  lease_owner: string | null;
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
  triggerActor?: string | null;
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
      ${input.triggerActor ?? null}
    )
    on conflict (github_delivery_id) do update
      set updated_at = igz_runs.updated_at
    returning *
  `;
  if (!run) throw new Error("Failed to create or load run");
  await addRunEvent(run.id, "queued", `Queued from ${input.triggerKind}`);
  return run;
}

export async function claimNextRun(workerId: string, leaseMs: number): Promise<RunRecord | null> {
  const sql = getSql();
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

export async function heartbeatRun(runId: string, workerId: string, leaseMs: number): Promise<void> {
  const sql = getSql();
  await sql`
    update igz_runs
    set
      lease_expires_at = now() + (${String(leaseMs)} || ' milliseconds')::interval,
      updated_at = now()
    where id = ${runId} and lease_owner = ${workerId} and status = 'running'
  `;
}

export async function updateRun(
  runId: string,
  fields: Partial<
    Pick<
      RunRecord,
      | "status"
      | "status_comment_id"
      | "status_comment_url"
      | "branch_name"
      | "pull_request_url"
      | "blocked_reason"
      | "error_message"
    >
  >,
): Promise<RunRecord> {
  const sql = getSql();
  const [current] = await sql<RunRecord[]>`
    select * from igz_runs where id = ${runId}
  `;
  if (!current) throw new Error(`Run not found: ${runId}`);

  const next = { ...current, ...fields };
  const isTerminal = ["succeeded", "blocked", "failed"].includes(next.status);

  const [updated] = await sql<RunRecord[]>`
    update igz_runs
    set
      status = ${next.status},
      status_comment_id = ${next.status_comment_id},
      status_comment_url = ${next.status_comment_url},
      branch_name = ${next.branch_name},
      pull_request_url = ${next.pull_request_url},
      blocked_reason = ${next.blocked_reason},
      error_message = ${next.error_message},
      lease_owner = ${isTerminal ? null : next.lease_owner},
      lease_expires_at = ${isTerminal ? null : next.lease_expires_at},
      finished_at = ${isTerminal ? new Date() : next.finished_at},
      updated_at = now()
    where id = ${runId}
    returning *
  `;
  if (!updated) throw new Error(`Failed to update run: ${runId}`);
  return updated;
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

export async function listRecentRuns(limit = 25): Promise<RunRecord[]> {
  const sql = getSql();
  return sql<RunRecord[]>`
    select *
    from igz_runs
    order by created_at desc
    limit ${limit}
  `;
}
