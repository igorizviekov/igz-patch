# IgzPatch

IgzPatch is a GitHub App that turns explicitly labeled issues into verified draft pull requests. A Vercel control plane accepts webhooks, Postgres stores durable run state, and an always-on worker runs a configurable coding agent inside Docker.

## Features

- Triggers from configured labels or `@IgzPatch fix`; public fix commands are optional, while `status` and `stop` remain maintainer-only.
- Authenticates with short-lived GitHub App installation tokens, never personal credentials.
- Supports configurable Codex CLI, OpenAI Responses API, and local Ollama providers and models.
- Blocks explicit policy overrides, verification bypasses, protected-path tampering, and credential-access requests before invoking an agent.
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

The target repository selects its provider and model in `.igzpatch.yml`; `IGZPATCH_AGENT_PROVIDER` and `IGZPATCH_AGENT_MODEL` provide worker-wide overrides.

- For `codex`, set `CODEX_API_KEY`.
- For `openai`, set `OPENAI_API_KEY`.
- For `ollama`, start Ollama on the worker host, pull a model that supports tool calling, and set `IGZPATCH_OLLAMA_BASE_URL` if it is not available at `http://127.0.0.1:11434`. Local Ollama does not require an API key; `OLLAMA_API_KEY` is available for authenticated compatible endpoints.

For example, to select a locally installed Ollama model worker-wide:

```bash
IGZPATCH_AGENT_PROVIDER="ollama"
IGZPATCH_AGENT_MODEL="qwen3-coder"
IGZPATCH_OLLAMA_BASE_URL="http://127.0.0.1:11434"
```

If the worker itself runs in Docker, use a host-reachable address such as `http://host.docker.internal:11434`. Repository tools and required checks still execute in the isolated Docker sandbox; only the worker process talks to Ollama.

### 3. Configure the target repository

Copy [`config/igzpatch.example.yml`](config/igzpatch.example.yml) into the target repository as `.igzpatch.yml`. Enable it and tailor its triggers, provider, model, setup commands, checks, allowed paths, and limits.

Set `IGZPATCH_ALLOW_SETUP_NETWORK="true"` on the worker only when setup must download dependencies.

### 4. Validate

```bash
npm run docker:build-agent # required only for the Codex provider
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

To let any GitHub user trigger the configured fix command, set `IGZPATCH_ALLOW_PUBLIC_FIX_COMMANDS="true"` on Vercel and redeploy.

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

## License

Licensed under the [Apache License 2.0](LICENSE). Attribution notices are provided in [NOTICE](NOTICE).
