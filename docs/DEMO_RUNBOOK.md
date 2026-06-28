# IgzPatch End-to-End Demo Runbook

This runbook takes IgzPatch from the current source repositories to a complete demonstration:

```text
GitHub issue labeled igz:fix
  -> GitHub App webhook
  -> Vercel control plane
  -> Postgres queued run
  -> local worker claims run
  -> Docker sandbox runs Codex and checks
  -> GitHub draft pull request
```

The public control plane runs on Vercel. The long-running worker runs on your Mac and polls the same Postgres database. The worker does not need an inbound port, tunnel, or public URL.

## 1. Current Project Inputs

Main application:

- Local checkout: `/Users/igorizviekov/Desktop/,/igz-patch/igz-patch`
- GitHub: `https://github.com/igorizviekov/igz-patch`
- Completed feature branch: `codex/complete-igzpatch-mvp`

Demo repository:

- Local checkout: `/Users/igorizviekov/Desktop/,/igz-patch/igzpatch-demo`
- GitHub: `https://github.com/igorizviekov/igzpatch-demo`
- Seeded issues: `#1` through `#5`
- Trigger label: `igz:fix`

Do not put credentials, database URLs, webhook secrets, or private keys in either Git repository.

## 2. Merge the Main Application Branch

Vercel should deploy the completed application from the repository's production branch, not from a temporary feature branch.

1. Open:

   `https://github.com/igorizviekov/igz-patch/compare/main...codex/complete-igzpatch-mvp`

2. Create a pull request.
3. Confirm the checks pass.
4. Merge it into `main`.
5. Update the local checkout:

   ```bash
   cd '/Users/igorizviekov/Desktop/,/igz-patch/igz-patch'
   git switch main
   git pull --ff-only origin main
   npm install
   npm run typecheck
   npm test
   npm run build
   ```

Checkpoint: `git status -sb` should show a clean `main` branch tracking `origin/main`.

## 3. Prepare Accounts and Credentials

You need:

- Owner/admin access to `igorizviekov/igz-patch` and `igorizviekov/igzpatch-demo`.
- A Vercel account connected to GitHub.
- A Supabase account.
- Docker Desktop running on the worker Mac.
- An OpenAI Platform API key for the default Codex provider.

Create the OpenAI API key in the OpenAI Platform dashboard and keep it in a password manager. The key will be stored only on the worker host as `CODEX_API_KEY`; it does not belong in Vercel because Vercel does not run the coding agent.

## 4. Provision Supabase Postgres

IgzPatch uses plain Postgres tables as its durable queue and audit store.

1. In Supabase, create a project named `igzpatch`.
2. Choose a region reasonably close to both the Vercel deployment and the worker Mac.
3. Generate and save a strong database password.
4. Wait until the database is ready.
5. Open **SQL Editor** in the Supabase dashboard.
6. Copy the entire contents of `db/schema.sql` into a new query and run it.
7. Verify the tables:

   ```sql
   select
     to_regclass('public.igz_runs') as runs,
     to_regclass('public.igz_run_events') as events;
   ```

   Both columns should return table names, not `null`.

8. Click **Connect** and copy the **Session pooler** connection string on port `5432`.

For the current MVP, use the Session pooler URL for both Vercel and the worker. The code uses Postgres.js prepared statements, while Supabase transaction-pooler mode on port `6543` requires prepared statements to be disabled. Session mode avoids that mismatch and is sufficient for this low-volume demo.

The value should resemble:

```text
postgres://postgres.<project-ref>:<encoded-password>@aws-<region>.pooler.supabase.com:5432/postgres?sslmode=require
```

If the password contains reserved URL characters, use the URL-encoded connection string supplied by Supabase.

Checkpoint: save this value as `DATABASE_URL` in your password manager. Do not commit it.

## 5. Create the Initial Vercel Deployment

The initial deployment provides the stable HTTPS URL needed for the GitHub App webhook.

### Dashboard path

1. In Vercel, select **Add New -> Project**.
2. Import `igorizviekov/igz-patch`.
3. Confirm:
   - Framework preset: **Next.js**
   - Production branch: `main`
   - Root directory: repository root
   - Install command: default
   - Build command: `npm run build`
4. Add `DATABASE_URL` as a **Production** environment variable.
5. Deploy the project.
6. Record the production URL, for example:

   ```text
   https://igz-patch.vercel.app
   ```

The exact hostname may differ.

### CLI alternative

If you prefer the CLI:

```bash
npm install --global vercel
vercel login
cd '/Users/igorizviekov/Desktop/,/igz-patch/igz-patch'
vercel link
vercel env add DATABASE_URL production
vercel --prod
```

Checkpoint: opening the production URL should display the IgzPatch dashboard. With the schema connected and no triggers yet, it should say **No runs yet** rather than **Database not connected**.

## 6. Generate a Webhook Secret

Generate a high-entropy value and save it in a password manager:

```bash
openssl rand -hex 32
```

This exact value must be used in both places:

- GitHub App webhook secret
- Vercel `GITHUB_WEBHOOK_SECRET`

Do not regenerate it between those steps.

## 7. Create the GitHub App

1. Open GitHub **Settings -> Developer settings -> GitHub Apps**.
2. Select **New GitHub App**.
3. Configure the general fields:

   | Field | Value |
   | --- | --- |
   | GitHub App name | A globally unique name such as `IgzPatch Igor Demo` |
   | Homepage URL | `https://github.com/igorizviekov/igz-patch` |
   | Callback URL | Leave empty |
   | Request user authorization during installation | Disabled |
   | Device Flow | Disabled |
   | Webhook | Active |
   | Webhook URL | `https://<your-vercel-domain>/api/github/webhook` |
   | Webhook secret | The value generated in step 6 |
   | SSL verification | Enabled |
   | Installation visibility | Only on this account |

4. Set repository permissions:

   | Permission | Access |
   | --- | --- |
   | Metadata | Read-only; GitHub grants this automatically |
   | Contents | Read and write |
   | Issues | Read and write |
   | Pull requests | Read and write |
   | Checks | Read-only |

5. Subscribe to these webhook events:

   - Issues
   - Issue comment
   - Installation
   - Installation repositories

6. Create the app.
7. On the app's **General** page, record the numeric **App ID**. Do not confuse it with the Client ID.
8. Under **Private keys**, select **Generate a private key** and securely save the downloaded `.pem` file.

Do not install the app yet. First configure Vercel so the installation webhook has a working receiver.

## 8. Configure Vercel Secrets and Redeploy

In the Vercel project, open **Settings -> Environment Variables** and add these Production variables:

| Variable | Value |
| --- | --- |
| `DATABASE_URL` | Supabase Session pooler URL from step 4 |
| `GITHUB_WEBHOOK_SECRET` | Secret from step 6 |
| `GITHUB_APP_ID` | Numeric App ID from step 7 |
| `GITHUB_PRIVATE_KEY` | Full contents of the downloaded `.pem` file |

Paste the private key as a multiline secret, including the `BEGIN` and `END` lines. Vercel supports multiline environment-variable values.

Do **not** add `CODEX_API_KEY`, `OPENAI_API_KEY`, or Ollama credentials to Vercel. Those credentials belong only on the worker host.

After adding or changing Vercel environment variables, create a new production deployment because environment changes apply to subsequent deployments:

```bash
vercel --prod
```

Or use **Deployments -> Redeploy** in the Vercel dashboard.

Checkpoint: the redeployed dashboard loads and still shows **No runs yet**.

## 9. Install the GitHub App Only on the Demo Repo

1. Return to GitHub **Settings -> Developer settings -> GitHub Apps**.
2. Open the IgzPatch app.
3. Select **Install App**.
4. Select your personal GitHub account.
5. Choose **Only select repositories**.
6. Select only `igzpatch-demo`.
7. Select **Install**.

Do not install the app on all repositories for this MVP.

Verify delivery:

1. Open the GitHub App settings.
2. Select **Advanced**.
3. Open the newest installation-related webhook delivery.
4. Confirm GitHub received a `2xx` response from the Vercel webhook.

The route intentionally ignores installation events after verifying their signature, so an accepted/ignored JSON response is normal.

## 10. Configure the Local Worker Environment

The worker must use the same Supabase database and GitHub App identity as Vercel.

```bash
cd '/Users/igorizviekov/Desktop/,/igz-patch/igz-patch'
cp .env.example .env
```

Edit `.env` and replace the placeholders:

```dotenv
DATABASE_URL="<Supabase Session pooler URL>"
GITHUB_WEBHOOK_SECRET="<same webhook secret used by GitHub and Vercel>"
GITHUB_APP_ID="<numeric GitHub App ID>"
GITHUB_PRIVATE_KEY="-----BEGIN RSA PRIVATE KEY-----\n...\n-----END RSA PRIVATE KEY-----"

IGZPATCH_AGENT_PROVIDER="codex"
IGZPATCH_AGENT_MODEL="gpt-5.4"
IGZPATCH_CODEX_IMAGE="igzpatch/codex-agent:0.1.0"
CODEX_API_KEY="<OpenAI Platform API key>"

IGZPATCH_DOCKER_BIN="docker"
IGZPATCH_WORKER_ID="local-worker"
IGZPATCH_POLL_INTERVAL_MS="5000"
IGZPATCH_LEASE_MS="600000"
```

For the local `.env` file, store the private key on one quoted line with literal `\n` separators, as shown in `.env.example`. The application converts those separators back to real newlines.

Security checks:

```bash
git check-ignore .env
git status --short
```

`.env` must be ignored and must not appear in `git status`.

## 11. Prepare Docker on the Worker Mac

Install and start Docker Desktop if it is not already running. For this demo, allocate at least 2 CPUs and 4 GB of Docker memory; the demo repository requests 2 CPUs and 2 GB for each sandbox container.

Verify the Docker daemon:

```bash
docker version
```

Pre-pull the target repository image and build the pinned Codex provider image:

```bash
cd '/Users/igorizviekov/Desktop/,/igz-patch/igz-patch'
docker pull node:22-bookworm
npm run docker:build-agent
docker run --rm igzpatch/codex-agent:0.1.0 --version
```

Expected final output:

```text
codex-cli 0.142.3
```

You do not manually start or preserve an IgzPatch container. The worker creates restricted, temporary containers with `docker run --rm` and removes them after each phase.

## 12. Validate Worker Readiness

Run the normal application checks:

```bash
cd '/Users/igorizviekov/Desktop/,/igz-patch/igz-patch'
npm install
npm run typecheck
npm test
npm run build
```

Then perform an empty queue poll:

```bash
npm run worker:once
```

Expected result: the command exits successfully after connecting to Postgres and finding no queued run.

If it reports a missing table, rerun `db/schema.sql` in Supabase. If it reports authentication or DNS errors, verify the Session pooler connection string and encoded database password.

## 13. Start the Worker

For the first demonstration, keep it visible in a terminal:

```bash
cd '/Users/igorizviekov/Desktop/,/igz-patch/igz-patch'
npm run worker
```

On macOS, this variant also prevents the machine from sleeping while the worker is active:

```bash
caffeinate -dimsu npm run worker
```

Leave this terminal running. The worker polls Postgres every five seconds.

## 14. Trigger Demo Issue #1

Issue `#1` is the best first demonstration because it is a small deterministic severity-ordering bug.

Open:

`https://github.com/igorizviekov/igzpatch-demo/issues/1`

Add the `igz:fix` label in the GitHub UI, or run:

```bash
gh issue edit 1 --repo igorizviekov/igzpatch-demo --add-label 'igz:fix'
```

The expected flow is:

1. GitHub sends an `issues.labeled` webhook to Vercel.
2. Vercel verifies the HMAC signature and reads `.igzpatch.yml` from the demo repo.
3. Vercel inserts a queued row into `igz_runs`.
4. The local worker claims the row and creates one marker-backed issue comment.
5. The worker clones `igzpatch-demo` and creates an `igzpatch/issue-1-<run>` branch.
6. Docker runs `npm ci` with setup networking enabled.
7. Docker runs the configured Codex agent with bounded workspace access.
8. Docker runs `npm test`, `npm run typecheck`, and `npm run build` with run networking disabled.
9. IgzPatch verifies changed paths, file count, and diff size.
10. IgzPatch pushes the branch and opens a draft pull request.
11. The issue comment and Vercel dashboard update to `succeeded` with the draft PR link.

Do not merge the first draft PR if you want the seeded bug to remain reusable for demonstrations.

## 15. Observe and Control the Run

Use these surfaces together:

- Worker terminal: process errors and lifecycle.
- GitHub issue: marker-backed status comment.
- Vercel dashboard: queued/running/blocked/succeeded state.
- GitHub draft PR: patch and CI checks.
- Supabase SQL Editor: durable run and event history.

Useful SQL:

```sql
select
  id,
  repository_full_name,
  issue_number,
  status,
  attempts,
  branch_name,
  pull_request_url,
  blocked_reason,
  error_message,
  created_at,
  updated_at
from igz_runs
order by created_at desc
limit 10;
```

```sql
select
  event_type,
  message,
  metadata,
  created_at
from igz_run_events
where run_id = '<run-id>'
order by created_at;
```

Maintainer-only issue commands must appear on their own line:

```text
@IgzPatch status
```

```text
@IgzPatch stop
```

`status` refreshes the issue comment from Postgres. `stop` requests cancellation; an active Docker command may finish before the worker reaches its next cancellation checkpoint.

## 16. Repeat or Reset the Demo

To trigger the same issue again, remove and re-add the label so GitHub emits a new `issues.labeled` delivery:

```bash
gh issue edit 1 --repo igorizviekov/igzpatch-demo --remove-label 'igz:fix'
gh issue edit 1 --repo igorizviekov/igzpatch-demo --add-label 'igz:fix'
```

If a previous draft PR remains open, close it and delete its generated branch before repeating the same scenario. Do not merge generated fixes into demo `main` unless you intentionally want to retire that seeded bug.

Issues `#2` through `#5` exercise metric logic, an SLA boundary, mobile grid overflow, and toolbar clipping.

## 17. Switching Providers

Docker remains required for repository setup and checks regardless of provider.

### OpenAI Responses API

```dotenv
IGZPATCH_AGENT_PROVIDER="openai"
IGZPATCH_AGENT_MODEL="gpt-5.4"
OPENAI_API_KEY="<OpenAI Platform API key>"
```

The OpenAI adapter runs on the worker host and sends the configured model string to the Responses API. The custom Codex image is not used.

### Ollama

Start Ollama and install a tool-capable coding model:

```bash
ollama pull qwen3-coder
ollama serve
```

Configure the worker:

```dotenv
IGZPATCH_AGENT_PROVIDER="ollama"
IGZPATCH_AGENT_MODEL="qwen3-coder"
OLLAMA_BASE_URL="http://localhost:11434"
```

Set provider and model together. IgzPatch does not automatically choose a compatible model or fall back to another provider.

## 18. Troubleshooting

### GitHub webhook returns `401`

- Confirm GitHub and Vercel contain the exact same webhook secret.
- Confirm the URL ends with `/api/github/webhook`.
- In GitHub App settings, inspect **Advanced -> Recent deliveries**.

### GitHub webhook returns `500`

- Confirm `DATABASE_URL`, `GITHUB_APP_ID`, and `GITHUB_PRIVATE_KEY` exist in Vercel Production.
- Redeploy after changing environment variables.
- Inspect Vercel function logs for the webhook request.

### Webhook succeeds but no run appears

- Confirm the app is installed on `igzpatch-demo`.
- Confirm `.igzpatch.yml` has `enabled: true`.
- Confirm the issue received the exact `igz:fix` label.
- Remove and re-add the label to create a fresh `labeled` event.

### Run stays `queued`

- Confirm the local worker is running.
- Confirm Vercel and the worker use the same `DATABASE_URL`.
- Run `npm run worker:once` and inspect its error.

### Docker is unavailable

- Start Docker Desktop.
- Run `docker version` and confirm both Client and Server sections appear.
- Rebuild with `npm run docker:build-agent`.

### Codex fails before editing

- Confirm `CODEX_API_KEY` is present only in the worker `.env`.
- Confirm `IGZPATCH_CODEX_IMAGE` matches the built image tag.
- Confirm the configured model is available to the API key's OpenAI project.
- Verify `docker run --rm igzpatch/codex-agent:0.1.0 --version`.

### Setup or checks fail

- Read the command event in `igz_run_events.metadata`.
- Confirm `node:22-bookworm` can be pulled.
- Confirm the demo lockfile is present.
- Remember that setup has network access, while required checks intentionally do not.

### GitHub API returns `403`

- Confirm the GitHub App has Contents and Pull requests read/write access.
- Confirm the installation is still authorized for `igzpatch-demo`.
- Approve any pending GitHub App permission changes and reinstall if necessary.

## 19. Final Readiness Checklist

- [ ] Main feature branch merged into `igz-patch/main`.
- [ ] Supabase schema applied successfully.
- [ ] Vercel production dashboard loads without a database error.
- [ ] GitHub App webhook uses the Vercel `/api/github/webhook` URL.
- [ ] GitHub App permissions and events match this runbook.
- [ ] GitHub App installed only on `igzpatch-demo`.
- [ ] Vercel secrets configured and production redeployed.
- [ ] Local `.env` contains the shared DB/App values and worker-only provider key.
- [ ] Docker daemon is running.
- [ ] Codex provider image reports `codex-cli 0.142.3`.
- [ ] `npm run worker:once` succeeds.
- [ ] `npm run worker` remains running.
- [ ] Adding `igz:fix` to issue `#1` creates a queued run.
- [ ] The run opens a draft PR and updates the issue comment/dashboard.

## Official References

- [Registering a GitHub App](https://docs.github.com/apps/creating-github-apps/setting-up-a-github-app/creating-a-github-app)
- [Installing your own GitHub App](https://docs.github.com/en/apps/using-github-apps/installing-your-own-github-app)
- [Validating webhook deliveries](https://docs.github.com/en/webhooks/using-webhooks/validating-webhook-deliveries)
- [Viewing GitHub App webhook deliveries](https://docs.github.com/en/webhooks/testing-and-troubleshooting-webhooks/viewing-webhook-deliveries)
- [Supabase Postgres connection modes](https://supabase.com/docs/guides/database/connecting-to-postgres)
- [Supabase Postgres.js guide](https://supabase.com/docs/guides/database/postgres-js)
- [Vercel environment variables](https://vercel.com/docs/environment-variables)
- [Next.js on Vercel](https://vercel.com/docs/frameworks/full-stack/nextjs)
- [Docker Desktop for Mac](https://docs.docker.com/desktop/setup/install/mac-install/)
- [OpenAI API authentication](https://platform.openai.com/docs/api-reference/introduction/api-keys)
- [Codex non-interactive execution](https://developers.openai.com/codex/noninteractive)
