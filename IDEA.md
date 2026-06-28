# The Problem

I am applying for the following role: https://jobs.ashbyhq.com/eigen-labs/c02fa001-23c9-4d68-8c0a-e27a742d76a4/application . Review it.

As part of the application, they ask: “Please share details and/or a link to an agent you have built.”.

So I want to build an agent that will satisfy the application.

# ClawSweeper

Review ClawSweeper agent code https://github.com/openclaw/clawsweeper. We can take this code as a refference for our agent. Consider borrowing these ideas from ClawSweeper code: keep a **single marker-backed status comment** per issue/run rather than spraying multiple comments. ClawSweeper’s public materials emphasize conservative backlog handling, maintainer-visible but tidy comments, durable review records, guarded repair, and dashboard/audit state. That pattern is excellent for recruiter readability and for a future operator experience.

# Mac Mini local-LLM as an option for operations, and cost comparison

A local-first worker is a good fit for my setup because the expensive is the **iterative agentic loop executed by LLM**. Running that loop on a Mac Mini lets use a local model for cheap, and avoid long-running cloud compute for the MVP. Ollama’s official docs expose a local API at `http://localhost:11434/api`

Possible Polling pattern:

In order to do **not** send GitHub webhooks directly to my home machine:

1. GitHub App webhook arrives at the public Vercel endpoint.
2. The endpoint verifies the signature and writes a job to the queue.
3. The Mac Mini worker polls every few seconds and claims pending jobs.
4. The worker fetches an installation token, clones the repo, and runs the local loop.

That keeps my Mac Mini outbound-only, which is operationally simpler and safer. GitHub’s webhook docs emphasize secure delivery verification, while Supabase Queues are explicitly pull-based.

IMPORTANT: This is for production, for developer we will use Ollamna cloud LLMs

# OpenClaw

Review OpenClaw and whatever it can be utilized for the development workflow or as a host, to operate a deployed agent. One reason I see is the OpenClaw is already configured, it has scheduled jobs and connected to a local LLM on Mac Mini, so it will save costs on LLM.

# Agent design

Review these articles:

- https://www.anthropic.com/engineering/managed-agents
- https://www.anthropic.com/engineering/demystifying-evals-for-ai-agents
- https://www.anthropic.com/engineering/harness-design-long-running-apps
- https://code.claude.com/docs/en/agent-sdk/agent-loop
- https://simonwillison.net/2025/Sep/30/designing-agentic-loops
- https://www.anthropic.com/engineering/building-effective-agents
- https://cdn.openai.com/pdf/5d1e1489-21c0-43e4-9d42-f87efdbf0082/the-shift-to-agentic-ai-evidence-from-codex.pdf

After, review what are the best practices for building such agents, and agentic loops. As of today. Make sure to use this knowledge when developing our agent.

# Proposed Solution

### Delivery plan

The build should be staged. The highest-probability route is to get a **minimal end-to-end run** working first, then add auditability, then polish the presentation.

### IgzPatch agent specs

An **auditable GitHub issue→PR agent** is a strong MVP for the Eigen Labs role because it directly demonstrates the capabilities the job description emphasizes: agent runtime/orchestration, reliability, observability, cost awareness, production usefulness, and developer tooling. The role explicitly calls for building agent runtimes and orchestration systems, making agents reliable, observable, cheap, and useful in production, and integrating LLMs, APIs, and external data into coherent systems. It also says they care more about evidence than years of experience and want candidates who have “built hard things that work,” shipped real systems, and gone beyond simple demos.

#### Security requirements

Agent should look safe and auditable. The design principle is not “maximum autonomy”; it is **bounded autonomy with evidence**. GitHub’s own best practices emphasize minimum permissions and app-scoped installation tokens, while Docker gives you enforceable resource limits, and Anthropic’s recent agent-evals guidance underscores the importance of making behavior visible before it hurts users.

| Control             | MVP policy                                                               |
| ------------------- | ------------------------------------------------------------------------ |
| Installation scope  | Only selected repositories                                               |
| Trigger policy      | Issue must have explicit label or maintainer command                     |
| Identity            | All repo actions via GitHub App installation token, not personal account |
| Sandbox             | Docker container with CPU, memory, and timeout caps                      |
| Filesystem exposure | Mount only repo workspace, never home directory or secrets locations     |
| Network             | Allow package install during setup                                       |
| Command allowlist   | Only lint/test/build/install/search/git-safe commands                    |
| Path allowlist      | App/source/test files only                                               |
| Path denylist       | `.env*`, infra, workflows, auth, payments, migrations                    |
| Mutation limits     | Max files changed, max diff lines, max iterations                        |
| Output mode         | Draft PR only; no merge or deploy                                        |
| Secret hygiene      | Redact known token prefixes in logs and comments                         |

Docker’s docs are explicit that bind mounts give the container direct access to host paths, so IgzPatch should mount only the workspace directory and avoid exposing broader host paths. Docker also supports runtime memory and CPU constraints that should be enforced on every run.

#### Auditability requirements

The audit model should include:

- one **marker-backed status comment** per issue;
- durable run record in Postgres;
- per-step timestamps and state transitions;
- tool-call payload summaries;
- command output logs;
- diff summary;
- model/provider/runtime metadata;
- token and cost estimates;
- explicit blocked reason when the loop stops without a PR.

#### Blocked conditions

IgzPatch should stop and mark the run **blocked** when any of the following happens:

- issue lacks clear acceptance criteria or reproduction steps;
- relevant files cannot be identified;
- tests or build cannot be run successfully on the target branch;
- required fix touches blocked paths;
- diff exceeds configured size limits;
- retries are exhausted;
- repo access or installation token has expired and cannot be refreshed;

#### Safe-operation defaults

To support multi-repo installs safely, the default behavior should be conservative: **selected repositories only, trigger label required, draft PRs only, no merge, no direct deploy, narrow file scope, hard limits, and explicit blocked conditions**. GitHub Apps can be installed on only selected repositories, and GitHub’s own best-practice guidance favors using installation tokens for automations that act independently of users.

Borrowing one idea from ClawSweeper is especially worthwhile: keep a **single marker-backed status comment** per issue/run rather than spraying multiple comments. ClawSweeper’s public materials emphasize conservative backlog handling, maintainer-visible but tidy comments, durable review records, guarded repair, and dashboard/audit state. That pattern is excellent for recruiter readability and for a future operator experience.

#### Tech stack

| Layer              | Recommendation                    | Explicit package/service                           | Why this is the MVP choice                                                |
| ------------------ | --------------------------------- | -------------------------------------------------- | ------------------------------------------------------------------------- |
| GitHub App auth    | Keep native GitHub App auth       | `@octokit/app`                                     | Purpose-built for GitHub App ID + private key auth and installation flows |
| Webhook parsing    | Verify and route GitHub events    | `@octokit/webhooks`                                | Purpose-built webhook handling and signature verification helpers         |
| GitHub REST client | API calls for issues/PRs/contents | `@octokit/rest` + `@octokit/plugin-retry`          | Mature GitHub client plus retry support                                   |
| Webhook receiver   | Lightweight public endpoint       | Next.js Route Handlers on Vercel                   | Fast to deploy; good for webhook ingestion and dashboard in one codebase  |
| Queue/DB           | Durable state + background jobs   | Supabase Postgres, optionally Supabase Queues/pgmq | Simple SQL state plus durable pull-based queueing                         |
| ORM                | Typed DB access                   | Drizzle ORM                                        | Lightweight, TypeScript-friendly, easy migrations                         |
| Worker runtime     | Long-running process on Mac Mini  | Node.js service launched by `pm2` or `launchd`     | Fits local polling worker model                                           |
| Sandbox            | Execute repo setup/tests safely   | Docker Desktop for Mac                             | Standardized isolation, bind mounts, CPU/memory limits                    |
| Local LLM runtime  | Primary inference backend         | Ollama                                             | Local API on Mac; both support standard local-server usage                |
| Hosted fallback    | Optional only                     | Ollama Paid plan                                   | Rescue path for hard cases while keeping local-first economics            |
| CI/CD              | Verify target repo PRs            | GitHub Actions + Vercel Preview Deployments        | Standard CI plus highly visible PR previews                               |

The technologies above are supported by official documentation: GitHub App auth and webhooks, Next.js Route Handlers, Supabase durable queues, Docker resource constraints and bind mounts, Ollama local API at `localhost:11434`, and Ollamas paid plan for fallbacks.

Vercel is excellent for the public-facing parts of the MVP: webhook intake, dashboard, and maybe lightweight status endpoints. It is not where the full agent should run, because coding-agent loops are long-lived, stateful, and need container execution. Vercel documents function duration limits and timeouts; that is fine for “verify webhook and enqueue job,” but not ideal for “clone repo, install deps, run tests, retry, push branch.” A local Mac Mini worker avoids those limits and keeps model traffic private.

#### Shape and required configuration

It is a **conservative, auditable GitHub App** that can be installed on any GitHub repositories that reacts only to explicitly labeled issues, executes in a sandbox, runs bounded attempts via LLM agentic loops, and opens a **draft PR** only when verification passes.

Possible Architecture:

- IgzPatch GitHub App
- public webhook receiver
- durable queue of pending runs
- to lower the cost needed for agentic loops we can use Mac Mini I own for polling worker with Docker sandbox and local Ollama LLM runtime
- UI dashboard that will display the data for previous runs
- Vercel FE with seeded issues for demo. Vercel is excellent for the **public control plane**—dashboard, webhook receiver, preview deployments.

GitHub Apps are designed for minimum necessary permissions, installation tokens, and webhook-driven automation; Supabase offers a Postgres-native durable queue; Docker supports resource constraints and controlled execution; Ollama provide local APIs suitable for Mac-based inference;

For the MVP, IgzPatch should subscribe only to the events it actually needs and request the minimum repository permissions needed for its workflow. GitHub specifically advises selecting the minimum permissions required, and GitHub App webhooks should be scoped to only the events we plan to handle. Below is the example permissions in such GitHub App

| Category               | Recommendation              | Why                                              |
| ---------------------- | --------------------------- | ------------------------------------------------ |
| Repository permissions | `Contents: read/write`      | clone, create branch, push patch                 |
| Repository permissions | `Issues: read/write`        | read issue body, post status comments            |
| Repository permissions | `Pull requests: read/write` | open draft PR, update PR body                    |
| Repository permissions | `Metadata: read`            | repo identity and installation context           |
| Repository permissions | `Checks: read`              | optional read of CI/check state                  |
| Repository permissions | `Actions: read`             | optional workflow visibility                     |
| Webhook events         | `issues`                    | trigger on label attach/remove and issue edits   |
| Webhook events         | `issue_comment`             | slash-command style triggers and status requests |
| Webhook events         | `installation`              | handle installs/uninstalls cleanly               |
| Webhook events         | `installation_repositories` | sync selected repos after install changes        |

One subtle but important point: GitHub documents that `issue_comment` fires for both issues **and** pull requests, so the handler should explicitly branch on whether the commented object is an issue or a PR.

The following schema is a **possible addition to consider to IgzPatch repository contract**, not an official GitHub schema, so asses if it desgned well or we can borrow something. Its design is driven by GitHub App installation mechanics, webhook patterns, deterministic verification, and sandbox boundaries. The goals are multi-repo portability, safe defaults, and a strong audit trail.

| Field                                      | Type     | Required | Purpose                             | Example                                                               |
| ------------------------------------------ | -------- | -------: | ----------------------------------- | --------------------------------------------------------------------- |
| `version`                                  | integer  |      yes | config versioning                   | `1`                                                                   |
| `enabled`                                  | boolean  |      yes | repo opt-in switch                  | `true`                                                                |
| `triggers.labels`                          | string[] |      yes | labels that enqueue runs            | `["igz:fix"]`                                                         |
| `triggers.commands`                        | string[] |       no | commands handled in comments        | `["@IgzPatch fix", "@IgzPatch status", "@IgzPatch stop"]`             |
| `repo.default_branch`                      | string   |       no | override if needed                  | `"main"`                                                              |
| `repo.language`                            | enum     |       no | hint for agent prompts/tools        | `"typescript"`                                                        |
| `sandbox.image`                            | string   |      yes | container base image                | `"node:22-bookworm"`                                                  |
| `sandbox.setup`                            | string[] |      yes | install/bootstrap commands          | `["pnpm install --frozen-lockfile"]`                                  |
| `sandbox.network`                          | enum     |      yes | outbound network policy after setup | `"disabled_after_setup"`                                              |
| `sandbox.cpu_limit`                        | number   |      yes | cap runaway jobs                    | `2`                                                                   |
| `sandbox.memory_mb`                        | number   |      yes | cap runaway jobs                    | `4096`                                                                |
| `sandbox.timeout_minutes`                  | integer  |      yes | hard stop                           | `20`                                                                  |
| `checks.required`                          | string[] |      yes | deterministic pass/fail gate        | `["pnpm lint","pnpm test","pnpm build"]`                              |
| `checks.optional`                          | string[] |       no | extra diagnostics                   | `["pnpm test:e2e"]`                                                   |
| `paths.allowed`                            | string[] |      yes | mutation allowlist                  | `["app/**","components/**","src/**","tests/**"]`                      |
| `paths.blocked`                            | string[] |      yes | denylist for risky areas            | `[".env*","infra/**","auth/**","payments/**",".github/workflows/**"]` |
| `issue_scope.max_files_changed`            | integer  |      yes | keep fixes narrow                   | `6`                                                                   |
| `issue_scope.max_diff_lines`               | integer  |      yes | keep PR readable                    | `300`                                                                 |
| `issue_scope.requires_acceptance_criteria` | boolean  |      yes | force evaluable tickets             | `true`                                                                |
| `agent.max_iterations`                     | integer  |      yes | bounded repair loop                 | `3`                                                                   |
| `agent.read_only_first_pass`               | boolean  |      yes | plan before write                   | `true`                                                                |
| `agent.open_pr_as_draft`                   | boolean  |      yes | preserve human review               | `true`                                                                |
| `agent.require_manual_merge`               | boolean  |      yes | no autonomous merge in MVP          | `true`                                                                |
| `routing.primary.provider`                 | enum     |      yes | default inference backend           | `"ollama"`                                                            |
| `routing.primary.model`                    | string   |      yes | default local model                 | `"qwen-coder"`                                                        |
| `routing.fallback.provider`                | enum     |       no | hosted escalation path              | `"anthropic"`                                                         |
| `routing.fallback.enabled`                 | boolean  |      yes | keep cost explicit                  | `false`                                                               |
| `routing.fallback.conditions`              | string[] |       no | when to escalate                    | `["syntax_repair_failed","context_too_large"]`                        |
| `audit.comment_strategy`                   | enum     |      yes | one durable GitHub comment          | `"marker_backed_single_comment"`                                      |
| `audit.store_tool_calls`                   | boolean  |      yes | traceability                        | `true`                                                                |
| `audit.store_command_logs`                 | boolean  |      yes | traceability                        | `true`                                                                |
| `audit.redact_patterns`                    | string[] |      yes | protect secrets in logs             | `["sk-","ghp_","github_pat_"]`                                        |

Then a starter file could look like this:

```yaml
version: 1
enabled: true

triggers:
  labels: ['igz:fix']
  commands:
    - '@IgzPatch fix'
    - '@IgzPatch status'
    - '@IgzPatch stop'

sandbox:
  image: 'node:22-bookworm'
  setup:
    - 'corepack enable'
    - 'pnpm install --frozen-lockfile'
  network: 'disabled_after_setup'
  cpu_limit: 2
  memory_mb: 4096
  timeout_minutes: 20

checks:
  required:
    - 'pnpm lint'
    - 'pnpm test'
    - 'pnpm build'
  optional:
    - 'pnpm test:e2e'

paths:
  allowed:
    - 'app/**'
    - 'components/**'
    - 'src/**'
    - 'tests/**'
  blocked:
    - '.env*'
    - '.github/workflows/**'
    - 'infra/**'
    - 'auth/**'
    - 'payments/**'
    - 'prisma/migrations/**'

issue_scope:
  max_files_changed: 6
  requires_acceptance_criteria: true

agent:
  max_iterations: 3
  read_only_first_pass: true
  open_pr_as_draft: true
  require_manual_merge: true

routing:
  primary:
    provider: 'CHANGE_ME'
    model: 'CHANGE_ME'
  fallback:
    provider: 'CHANGE_ME'
    enabled: false
    conditions:
      - 'repair_failed_twice'

audit:
  comment_strategy: 'marker_backed_single_comment'
  store_tool_calls: true
  store_command_logs: true
  redact_patterns:
    - 'sk-'
    - 'ghp_'
    - 'github_pat_'
```

#### Iteration Loop

Agent loop should look like this:

```text
Issue intake
→ repo config load
→ repo map + targeted context retrieval
→ plan for a narrow fix
→ edit files
→ run checks
→ if checks fail, inspect errors and retry
→ if checks pass, push branch and open draft PR
→ otherwise post blocked report and stop
```
