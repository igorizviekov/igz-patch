# igz-patch

Thoughtful patching for focused experiments.

IgzPatch turns a labeled GitHub issue into a bounded draft pull request. A Next.js control plane queues runs, and a long-running worker clones the target repository, invokes a configurable coding agent, runs deterministic checks, enforces diff policy, and opens the PR.

## Agent providers

Choose the default provider and model in the target repository's `.igzpatch.yml`:

```yaml
routing:
  primary:
    provider: codex # codex | openai | ollama
    model: gpt-5.4
```

The worker can override both values with `IGZPATCH_AGENT_PROVIDER` and `IGZPATCH_AGENT_MODEL`.

| Provider | Runtime requirement | Authentication |
| --- | --- | --- |
| `codex` | Codex CLI available as `codex`, or `IGZPATCH_CODEX_BIN` | Saved Codex login or `CODEX_API_KEY` |
| `openai` | Network access to the OpenAI Responses API | `OPENAI_API_KEY` |
| `ollama` | Ollama server and the configured model | None for local `http://localhost:11434` |

The OpenAI and Ollama adapters share a bounded tool loop for file discovery, reads, exact replacements, writes, diffs, and configured checks. Write tools enforce `paths.allowed` and `paths.blocked`; check execution receives a secret-free environment. Codex runs non-interactively in `workspace-write` mode and keeps secrets out of model-proposed subprocesses through its shell environment policy.

## Development

Requires Node.js 20.9 or newer.

```bash
npm install
cp .env.example .env
npm run typecheck
npm test
npm run worker:once
```

See `SPEC.md` for architecture and `config/igzpatch.example.yml` for the full repository contract.
