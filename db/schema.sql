create extension if not exists pgcrypto;

create table if not exists igz_runs (
  id uuid primary key default gen_random_uuid(),
  github_delivery_id text not null unique,
  installation_id bigint not null,
  repository_id bigint not null,
  repository_full_name text not null,
  issue_number integer not null,
  issue_title text not null,
  issue_body text,
  issue_url text not null,
  trigger_kind text not null,
  trigger_value text not null,
  trigger_actor text,
  cancel_requested_at timestamptz,
  cancel_requested_by text,
  status text not null default 'queued',
  lease_owner text,
  lease_expires_at timestamptz,
  attempts integer not null default 0,
  max_attempts integer not null default 3,
  status_comment_id bigint,
  status_comment_url text,
  branch_name text,
  pull_request_url text,
  blocked_reason text,
  error_message text,
  created_at timestamptz not null default now(),
  updated_at timestamptz not null default now(),
  started_at timestamptz,
  finished_at timestamptz
);

alter table igz_runs add column if not exists trigger_value text;
update igz_runs set trigger_value = '' where trigger_value is null;
alter table igz_runs alter column trigger_value set not null;
alter table igz_runs add column if not exists cancel_requested_at timestamptz;
alter table igz_runs add column if not exists cancel_requested_by text;

create index if not exists igz_runs_queue_idx
  on igz_runs (status, created_at)
  where status in ('queued', 'running');

create index if not exists igz_runs_repo_issue_idx
  on igz_runs (repository_full_name, issue_number, created_at desc);

create table if not exists igz_run_events (
  id bigserial primary key,
  run_id uuid not null references igz_runs(id) on delete cascade,
  event_type text not null,
  message text not null,
  metadata jsonb not null default '{}'::jsonb,
  created_at timestamptz not null default now()
);

create index if not exists igz_run_events_run_idx
  on igz_run_events (run_id, created_at);
