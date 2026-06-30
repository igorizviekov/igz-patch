# IgzPatch

IgzPatch is a GitHub App that turns explicitly labeled issues into verified draft pull requests. A Vercel control plane accepts webhooks, Postgres stores durable run state, and an always-on worker runs a configurable coding agent inside Docker.

## Features

- Triggers from configured labels or maintainer-only `@IgzPatch fix`, `@IgzPatch status`, and `@IgzPatch stop` commands.
- Authenticates with short-lived GitHub App installation tokens, never personal credentials.
- Supports configurable Codex CLI and OpenAI Responses API providers and models.
- Runs bounded agent, setup, repair, and verification loops in disposable Docker containers.
- Keeps generated commands offline; dependency setup requires explicit network opt-in.
- Validates a fail-closed `.igzpatch.yml` contract and enforces path, resource, file, and diff limits.
- Protects immutable tests, secret-scans output, and verifies patches again in a fresh checkout.
- Deduplicates webhooks, permits one active run per issue, and stores append-only audit events under fenced Postgres leases.
- Maintains one marker-backed issue comment with provider/model details and a password-protected run dashboard.
- Creates concise commits and draft PRs only after required checks pass; it never merges them.

## Setup

Requires Node.js 20.9+, Docker, Postgres (or Supabase Postgres), Vercel, and a GitHub account that can create an App.

### 1. Install and initialize

```bash
npm install
cp .env.example .env
```

Set `DATABASE_URL` and `IGZPATCH_DASHBOARD_PASSWORD` in `.env`, then apply the database schema:

```bash
set -a; source .env; set +a
npm run db:init
```

### 2. Choose an agent

Set either `CODEX_API_KEY` or `OPENAI_API_KEY` in `.env`. The target repository selects its provider and model in `.igzpatch.yml`; `IGZPATCH_AGENT_PROVIDER` and `IGZPATCH_AGENT_MODEL` provide worker-wide overrides.

### 3. Configure the target repository

Copy [`config/igzpatch.example.yml`](config/igzpatch.example.yml) into the target repository as `.igzpatch.yml`. Enable it and tailor its triggers, provider, model, setup commands, checks, allowed paths, and limits.

Set `IGZPATCH_ALLOW_SETUP_NETWORK="true"` on the worker only when setup must download dependencies.

### 4. Validate

```bash
npm run docker:build-agent
npm run typecheck
npm test
npm run build
```

### 5. Deploy and connect GitHub

1. Deploy this repository to Vercel with `DATABASE_URL` and `IGZPATCH_DASHBOARD_PASSWORD`.
2. Create a GitHub App with webhook URL `https://<your-domain>/api/github/webhook`.
3. Grant Metadata read, Contents read/write, Issues read/write, Pull requests read/write, and Checks read; subscribe to Issues and Issue comments.
4. Create a webhook secret and private key, then install the App only on selected repositories.
5. Add `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`, and `GITHUB_PRIVATE_KEY` to `.env` and Vercel, then redeploy. Store the PEM on one quoted line with literal `\n` separators.

### 6. Run

Keep the worker running on an always-on Docker host:

```bash
npm run worker
```

Add the configured label (default: `igz:fix`) to an issue. For local control-plane development, run `npm run dev`. The dashboard username is `igzpatch`; its password is `IGZPATCH_DASHBOARD_PASSWORD`.

## Links

- [GitHub App](https://github.com/apps/igzpatch)
- [Run dashboard](https://igz-patch.vercel.app/) — requires HTTP Basic authentication
- [Demo repository](https://github.com/igorizviekov/igzpatch-demo) — seeded logic and responsive-CSS issues
- [Source repository](https://github.com/igorizviekov/igz-patch)
