# IgzPatch

Bounded, auditable issue-to-draft-PR automation.

IgzPatch turns an explicitly labeled GitHub issue into a small draft pull request. A Next.js control plane verifies webhooks and queues durable runs; a long-running worker leases each run, clones the target repository, invokes a configurable coding agent inside Docker, runs deterministic checks, enforces repository policy, and opens a draft PR.

## Safety Model

- Repositories opt in with `enabled: true` in `.igzpatch.yml`; missing config is disabled.
- GitHub access uses short-lived installation tokens and refreshes the token before push.
- Setup, provider tools, and checks run in disposable Docker containers with CPU, memory, process, capability, filesystem, output, and timeout limits; Git metadata is mounted read-only.
- Setup network access and run network access are configured separately; run commands default to no network.
- Allowed paths, blocked paths, changed-file count, diff-line, file-byte, patch-byte, image, and worker resource limits are enforced before push.
- Untrusted work is transported as a bounded binary patch into a fresh checkout; only that trusted checkout can commit or receive GitHub credentials.
- Every claim has a unique lease token, and worker writes fail atomically after lease expiry or reassignment.
- The run dashboard requires HTTP Basic authentication through `IGZPATCH_DASHBOARD_PASSWORD`.
- At least one deterministic required check is mandatory for enabled repositories.
- Pull requests are always drafts and always require human merge.

## Agent Providers

Choose one provider and model in the target repository:

```yaml
routing:
  primary:
    provider: codex # codex | openai | ollama
    model: gpt-5.4
```

The worker can override both values with `IGZPATCH_AGENT_PROVIDER` and `IGZPATCH_AGENT_MODEL`.

| Provider | Runtime requirement | Authentication |
| --- | --- | --- |
| `codex` | Built `IGZPATCH_CODEX_IMAGE` | `CODEX_API_KEY` |
| `openai` | Network access to the Responses API | `OPENAI_API_KEY` |
| `ollama` | Reachable Ollama server and model | Optional `OLLAMA_API_KEY` |

OpenAI and Ollama use the same bounded file/check tool loop. Codex runs non-interactively in `workspace-write` mode; model-generated shell commands have network disabled even though the Codex process can reach the API. Provider fallback is intentionally deferred.

## Local Setup

Requires Node.js 20.9+, Docker, Postgres, and a GitHub App.

```bash
npm install
cp .env.example .env
npm run db:init
npm run docker:build-agent
npm run typecheck
npm test
```

Run the web control plane and worker as separate processes:

```bash
npm run dev
npm run worker
```

The worker can run on this machine, a Mac Mini, or a small always-on host. It pulls this repository like any Node service, loads `.env`, needs Docker and outbound GitHub/provider access, and polls the shared Postgres database. It does not need a separate code repository.

## Repository Contract

Copy `config/igzpatch.example.yml` to the target repository as `.igzpatch.yml`, then narrow its paths and checks. Configuration is validated fail-closed, including unknown fields. Maintainer-only issue commands are `@IgzPatch fix`, `@IgzPatch status`, and `@IgzPatch stop`.

The worker accepts only images in `IGZPATCH_ALLOWED_SANDBOX_IMAGES` and only package-manager setup/check command forms. Repository policy can tighten worker limits but cannot raise them.

The companion [`igzpatch-demo`](https://github.com/igorizviekov/igzpatch-demo) repository is a small incident-response dashboard with five independently seeded logic and responsive-CSS failures. Its main branch remains green; each `igzpatch/issue-<number>-...` branch activates the matching deterministic regression test.

See `SPEC.md` for architecture and rollout details.
