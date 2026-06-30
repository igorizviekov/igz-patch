# IgzPatch

IgzPatch is a GitHub App that turns explicitly labeled issues into verified draft pull requests. A Vercel control plane accepts webhooks, Postgres stores durable run state, and an always-on worker runs a configurable coding agent inside Docker.

## How it works

1. A configured label or maintainer comment on an issue sends a webhook to Vercel.
2. Vercel validates the trigger, reads `.igzpatch.yml` from the target repository, and queues a run in Postgres.
3. The worker claims the run, clones the repository, runs an agent in Docker, re-verifies the patch in a fresh checkout, then pushes a branch and opens a draft PR.

## Features

- Triggers from configured issue labels or `@IgzPatch fix` comments; public fix commands are optional, while `status` and `stop` remain maintainer-only.
- Authenticates with short-lived GitHub App installation tokens.
- Supports configurable Codex, OpenAI, and Ollama providers.
- Blocks explicit policy overrides, verification bypasses, protected-path tampering, and credential-access requests before invoking an agent.
- Runs bounded agent, setup, repair, and verification loops in disposable Docker containers.
- Keeps generated commands offline; dependency setup requires explicit network opt-in.
- Validates a fail-closed `.igzpatch.yml` contract and enforces path, resource, file, and diff limits.
- Protects immutable tests, secret-scans output, and verifies patches again in a fresh checkout.
- Deduplicates webhooks, permits one active run per issue, and stores append-only audit events under fenced Postgres leases.
- Maintains one marker-backed issue comment with run metadata.
- Creates commits and opens draft PRs.

## Setup

Requires Node.js 20.9+, Docker, Postgres (or Supabase), Vercel, and permission to create a GitHub App.

### 1. Install and initialize the database

```bash
npm install
cp .env.example .env
```

Set `DATABASE_URL` and `IGZPATCH_DASHBOARD_PASSWORD` in `.env`, then apply the schema:

```bash
set -a; source .env; set +a
npm run db:init
```

### 2. Local validation

```bash
npm run docker:build-agent  # Codex provider only
npm run typecheck
npm test
npm run build
```

### 3. Deploy the control plane and connect GitHub

**Vercel** - deploy this repository. Set required `DATABASE_URL` and `IGZPATCH_DASHBOARD_PASSWORD`. After creating the GitHub App below, also add `GITHUB_APP_ID`, `GITHUB_WEBHOOK_SECRET`, and `GITHUB_PRIVATE_KEY`, then redeploy.

**GitHub App** - create one at [github.com/settings/apps/new](https://github.com/settings/apps/new):

| Setting     | Value                                                                                   |
| ----------- | --------------------------------------------------------------------------------------- |
| Webhook URL | `https://<your-domain>/api/github/webhook`                                              |
| Permissions | Metadata (read), Contents (read/write), Issues (read/write), Pull requests (read/write) |
| Events      | Issues, Issue comments                                                                  |

Then:

1. Generate a private key and note the App ID and webhook secret.
2. Add the three GitHub variables to Vercel (and `.env` for local dev). Store the PEM on one quoted line with literal `\n` separators.
3. **Install the App** on each repository you want IgzPatch to fix: _Only select repositories_ > choose repos > _Install_.

Optional on Vercel: set `IGZPATCH_ALLOW_PUBLIC_FIX_COMMANDS="true"` to let any GitHub user run the configured fix command.

### 4. Enable each target repository

For every repository the agent will be used:

1. Confirm the GitHub App is installed on that repository (step 2).
2. Copy [`config/igzpatch.example.yml`](config/igzpatch.example.yml) to the repository root as `.igzpatch.yml`.
3. Set `enabled: true` and configure triggers, provider, model, setup commands, required checks, allowed paths, and limits.
4. **Commit and merge** `.igzpatch.yml` to the default branch. The control plane reads it from there on every webhook.

If setup commands download dependencies (for example `pnpm install`), set `sandbox.setup_network: enabled` in `.igzpatch.yml` and `IGZPATCH_ALLOW_SETUP_NETWORK="true"` on the worker host.

### 5. Configure and run the worker

The worker runs separately from Vercel on an always-on Docker host. Set agent credentials on the worker (see `.env.example`):

- **codex** - `CODEX_API_KEY`; run `npm run docker:build-agent` once before starting the worker.
- **openai** - `OPENAI_API_KEY`.
- **ollama** - start Ollama on the worker host and pull a tool-calling model; set `IGZPATCH_OLLAMA_BASE_URL` (default `http://127.0.0.1:11434`). `OLLAMA_API_KEY` is available for authenticated endpoints.

Each target repository selects its provider and model in `.igzpatch.yml`. Override worker-wide with `IGZPATCH_AGENT_PROVIDER` and `IGZPATCH_AGENT_MODEL`. If the worker itself runs in Docker, use a host-reachable Ollama URL such as `http://host.docker.internal:11434`.

### 6. Start the worker:

```bash
npm run worker
```

### 7. Trigger agent

Add the configured label (default: `igz:fix`) to an issue, or comment `@IgzPatch fix`.

For local control-plane development, run `npm run dev`. The run dashboard uses HTTP Basic auth: username `igzpatch`, password `IGZPATCH_DASHBOARD_PASSWORD`.

## Links

- [GitHub App](https://github.com/apps/igzpatch)
- [Run dashboard](https://igz-patch.vercel.app/) — requires HTTP Basic authentication
- [Demo repository](https://github.com/igorizviekov/igzpatch-demo) — seeded logic and responsive-CSS issues
- [Source repository](https://github.com/igorizviekov/igz-patch)

## License

Licensed under the [Apache License 2.0](LICENSE). Attribution notices are provided in [NOTICE](NOTICE).
