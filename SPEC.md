# IgzPatch MVP Specification

## Purpose

IgzPatch is a conservative GitHub issue-to-draft-PR agent. The MVP must work as both a portfolio artifact for the Eigen Labs application and the first slice of a real multi-repository product, while staying small enough to ship quickly.

The application question asks for details or a link to an agent that was built. The strongest answer is not another chat demo. It is a small production-shaped system that shows agent runtime design, orchestration, reliability, observability, external API integration, and bounded autonomy.

## Critical Validation of IDEA.md

The core idea in `IDEA.md` is right: an auditable GitHub issue-to-PR agent is a strong fit for the role. The role values real systems, agent runtimes, reliability, observability, and developer tools. IgzPatch can demonstrate all of those in a compact product.

The MVP should keep these ideas:

- A GitHub App acts only through installation tokens.
- A public Vercel endpoint receives GitHub webhooks and enqueues durable work.
- A separate worker performs long-running repository work outside Vercel Functions.
- Runs are bounded by explicit limits and produce draft PRs only.
- Every run writes a single marker-backed GitHub status comment.
- Postgres is the system of record for runs, status, logs, and dashboard state.
- The first useful demo uses a separate repository with seeded bugs and deterministic tests.

The MVP should change or defer these ideas:

- Defer Mac Mini local inference. It is promising for cost, but it slows MVP delivery and may be weaker than hosted models for coding-agent loops.
- Use Codex first, with OpenAI Responses API and local Ollama available through the same provider contract.
- Use a plain Supabase Postgres jobs table first, not Supabase Queues or Vercel Workflows. It is simpler, reliable enough, easy to inspect, and gives us dashboard queries for free.
- Do not run the full coding loop inside Vercel. Vercel is the control plane, not the executor.
- Do not make OpenClaw a hard dependency. It can later host notifications, scheduled reports, or local model routing, but IgzPatch should stand alone.
- Do not overbuild multi-agent evaluator loops in the first slice. Start with one bounded loop, deterministic checks, and clear blocked states.

## Resolved Decisions

- Positioning: IgzPatch is both a portfolio demo and a real product seed, but the MVP optimizes for the smallest credible end-to-end loop.
- Inference: use hosted coding-agent execution first; defer Mac Mini local inference until the product loop is working.
- Queue: use a plain Supabase Postgres jobs table with polling leases first. It is the best reliability-to-effort tradeoff for this MVP.
- Contract: include `max_diff_lines`, explicit setup/run network phases, branch naming, PR title/body policy, and fail-closed config validation.
- Worker host: run the MVP worker on the current development machine first; the same process can move to a Mac Mini or VPS without a separate repository.
- Demo: use the separate [`igzpatch-demo`](https://github.com/igorizviekov/igzpatch-demo) RelayOps incident-board repository with five seeded issues and deterministic tests.
- Agent provider: support `codex`, `openai`, and `ollama`; select them per repository or with worker-wide environment overrides.
- Sandbox: run setup, checks, and agent tools inside resource-constrained Docker containers with explicit setup/run network policy.
- Deferred surfaces: provider fallback and token/cost dashboards are not part of this MVP.

## Remaining Questions and Gaps

- Supabase project: create the database and run `db/schema.sql`.
- GitHub App setup: create the app, install it only on the demo repo, and add the webhook secret/private key to the deployment.
- Deployment: configure the Vercel control plane, public webhook URL, and always-on worker environment.
- End-to-end proof: label one seeded demo issue and verify the resulting draft PR and status trail.

## Best Architecture

```text
GitHub issue label/comment
  -> GitHub App webhook
  -> Next.js Route Handler on Vercel
  -> signature verification
  -> Postgres run row
  -> polling worker claims row with lease
  -> status comment: running
  -> installation token
  -> clone repo
  -> load .igzpatch.yml
  -> create branch
  -> run setup
  -> run configured agent provider
  -> run required checks
  -> enforce path and diff limits
  -> push branch
  -> open draft PR
  -> status comment: PR opened
  -> dashboard shows run trail
```

### Components

| Component | MVP Choice | Reason |
| --- | --- | --- |
| Control plane | Next.js App Router on Vercel | Public webhook receiver and password-protected dashboard in one deploy |
| GitHub auth | GitHub App installation tokens | Minimum-permission identity, no personal token actions |
| Webhook verification | HMAC SHA-256 verification | Required safety boundary for public endpoint |
| Queue | Supabase Postgres job table | Durable, inspectable, low effort, supports polling leases |
| Worker | Node.js long-running process | No Vercel duration limit; easy local or VPS deployment |
| Agent execution | Provider router for Codex, OpenAI API, and Ollama | Keeps worker orchestration stable while inference changes |
| Sandbox | Docker-enforced setup, provider, and check execution | Resource, filesystem, privilege, network, and timeout boundaries |
| Dashboard | Server-rendered run table | Minimal visible proof of durability and state |
| Demo app | Separate GitHub repo | Keeps IgzPatch repo focused on agent/control-plane code |

## MVP Scope

### In Scope

- Register a GitHub App with minimum permissions.
- Receive `issues` and `issue_comment` webhooks.
- Trigger only when a configured label or command is present.
- Accept issue comment commands only from repository owners, members, or collaborators.
- Queue one run per GitHub delivery and issue.
- Let a worker claim jobs with lease/retry semantics.
- Create or update one marker-backed status comment per run.
- Clone the target repo with an installation token.
- Load `.igzpatch.yml` from the target repo, falling back to safe defaults.
- Run setup commands, a configured agent provider, and deterministic checks.
- Enforce max changed files, max diff lines, allowed paths, blocked paths, and max iterations.
- Push a branch and open a draft PR only when checks and limits pass.
- Mark blocked with an explicit reason when the run cannot safely produce a PR.
- Show recent runs in a minimal dashboard.
- Use a separate demo repository with seeded bugs and deterministic tests.

### Out of Scope for MVP

- Autonomous merge.
- Production local Mac Mini inference.
- Full multi-agent planner/generator/evaluator harness.
- Cross-repo cluster repair.
- Payment, billing, or marketplace flow.
- General-purpose issue triage.
- Support for private package registries beyond user-configured setup commands.
- Running as a public service for arbitrary third-party repositories.
- Provider fallback or automatic model failover.
- Token accounting or cost dashboards.

## Repository Contract

Target repositories can add `.igzpatch.yml`.

```yaml
version: 1
enabled: true

triggers:
  labels:
    - igz:fix
  commands:
    - '@IgzPatch fix'
    - '@IgzPatch status'
    - '@IgzPatch stop'

repo:
  default_branch: main
  language: typescript

branch:
  prefix: igzpatch

pull_request:
  draft: true
  title_template: 'IgzPatch: fix issue #{issue_number}'
  body_policy: evidence_summary

sandbox:
  image: node:22-bookworm
  setup_network: enabled
  run_network: disabled
  cpu_limit: 2
  memory_mb: 4096
  timeout_minutes: 20
  setup:
    - corepack enable
    - pnpm install --frozen-lockfile

checks:
  required:
    - pnpm test
  optional:
    - pnpm lint

paths:
  allowed:
    - app/**
    - src/**
    - tests/**
  blocked:
    - .env*
    - .github/workflows/**
    - infra/**
    - auth/**
    - payments/**
    - prisma/migrations/**

issue_scope:
  max_files_changed: 6
  max_diff_lines: 300
  max_file_bytes: 1000000
  max_patch_bytes: 2000000
  requires_acceptance_criteria: true

agent:
  max_iterations: 3
  read_only_first_pass: true
  open_pr_as_draft: true
  require_manual_merge: true

routing:
  primary:
    provider: codex
    model: gpt-5.4

audit:
  comment_strategy: marker_backed_single_comment
  store_tool_calls: true
  store_command_logs: true
  redact_patterns:
    - sk-
    - ghp_
    - github_pat_
```

Config validation must fail closed. If the file is invalid, the run should be blocked before editing code and the status comment should explain the validation error.

## Data Model

The MVP uses two tables:

- `igz_runs`: one durable run row per accepted webhook trigger.
- `igz_run_events`: append-only audit events for phase changes, command summaries, blocked reasons, and PR details.

Important queue behavior:

- `github_delivery_id` is unique for idempotency.
- Workers claim with `FOR UPDATE SKIP LOCKED`.
- Every claim writes a unique `lease_token`, `lease_owner`, `lease_expires_at`, and increments `attempts`.
- Worker state changes and audit events are fenced by owner, token, status, and unexpired lease.
- Expired leases can be reclaimed until `max_attempts`.
- Terminal statuses are `succeeded`, `blocked`, and `failed`.

## GitHub App Permissions

MVP repository permissions:

- `Metadata: read`
- `Contents: read/write`
- `Issues: read/write`
- `Pull requests: read/write`
- `Checks: read`

MVP webhook events:

- `issues`
- `issue_comment`
- `installation`
- `installation_repositories`

The `issue_comment` handler must branch on issues versus pull requests. MVP issue-to-PR runs only start from issue comments, not PR comments.

## Worker Execution Rules

The first worker is intentionally simple:

1. Poll and claim one queued run.
2. Update the run comment to `running`.
3. Clone the repository to a temporary workspace.
4. Create an `igzpatch/issue-<number>-<run>` branch.
5. Load and validate `.igzpatch.yml`.
6. Run setup commands.
7. Resolve the provider from `.igzpatch.yml`, optionally overridden by `IGZPATCH_AGENT_PROVIDER` and `IGZPATCH_AGENT_MODEL`, and run it in the repo workspace.
8. Run required checks.
9. Inspect changed files and diff size.
10. Commit, push, and open a draft PR.
11. Update the run comment and Postgres status.

Every provider receives the same issue, repository, policy, iteration, sandbox, and timeout contract. Setup and checks run in the target repository's configured Docker image. The Codex adapter invokes `codex exec` in a pinned provider image and non-interactive `workspace-write` mode. The OpenAI Responses API and Ollama adapters share a bounded tool loop whose write tools enforce repository path policy and whose command tool can run only configured checks. Worker-wide environment overrides make provider changes operational rather than code changes.

## Blocked Conditions

The worker must stop and mark the run blocked when:

- the repository config is missing required fields or is invalid;
- the issue lacks acceptance criteria when required;
- setup fails;
- the provider or model configuration is invalid;
- required provider credentials or runtime are unavailable;
- the provider exits non-zero, returns an API error, times out, or exhausts its iterations without editing;
- required checks fail;
- no diff is produced;
- a changed file falls outside `paths.allowed`;
- a changed file matches `paths.blocked`;
- changed file count exceeds `issue_scope.max_files_changed`;
- diff lines exceed `issue_scope.max_diff_lines`;
- branch push or draft PR creation fails after retry;
- the installation token cannot be refreshed.

## Demo Repository Plan

The demo repository is created separately from this repo. It contains:

- a small TypeScript or Next.js app;
- five seeded GitHub issues covering ordering, operational metrics, SLA boundaries, mobile overflow, and toolbar clipping;
- one deterministic test failure per issue;
- a simple `.igzpatch.yml`;
- a README that explains the expected demonstration flow;
- labels including `igz:fix`;
- GitHub Actions that run the same checks IgzPatch runs locally.

The first demo issue should be intentionally boring: a small pure function bug with a failing unit test. Recruiter-visible value comes from the system loop and audit trail, not from a clever bug.

## Implementation Plan

### Phase 1: Control Plane Skeleton

- Add Next.js app structure.
- Add GitHub webhook route.
- Add HMAC verification.
- Add Postgres run schema and queue functions.
- Add minimal dashboard.

### Phase 2: Worker Happy Path

- Add polling worker.
- Add GitHub App installation-token auth.
- Add status comment upsert.
- Add clone, branch, setup, provider routing, checks, diff gates, push, draft PR.

### Phase 3: Demo Repository

- Create a separate demo repo. Complete.
- Add `.igzpatch.yml`. Complete.
- Seed issues and deterministic tests. Complete.
- Install the GitHub App on only that repo.
- Run one issue through to draft PR.

### Phase 4: Audit Polish

- Add command and tool-call summaries. Complete.
- Improve dashboard event timeline later.
- Add screenshots or recorded demo.

### Phase 5: Product Hardening

- Add Docker sandbox execution for setup/checks/agent tools. Complete.
- Add retry policies for transient GitHub and provider failures. Complete.
- Add config UI and install state.
- Add eval fixtures from the demo repo.
- Consider Supabase Queues/pgmq only if plain polling becomes limiting.

## Current Recommendation

Build the smallest end-to-end path first: GitHub label to queued run to worker to draft PR on the demo repo. Keep every autonomy feature behind deterministic gates. Treat the status comment, dashboard, and blocked reasons as first-class product surface, not afterthoughts.
