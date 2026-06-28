import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCodexAgent } from "@/lib/agent/providers/codex";
import { readDiffSummary } from "@/lib/agent/diff";
import { resolveAgentProvider } from "@/lib/agent/providers";
import { runOllamaAgent } from "@/lib/agent/providers/ollama";
import { runOpenAiAgent } from "@/lib/agent/providers/openai";
import { createAgentToolbox } from "@/lib/agent/providers/tools";
import type { AgentProviderRequest } from "@/lib/agent/providers/types";
import { defaultRepoConfig, loadRepoConfig, type RepoConfig } from "@/lib/agent/repo-config";

test("repo config validates supported providers", () => {
  withWorkspace((workspace) => {
    writeFileSync(
      join(workspace, ".igzpatch.yml"),
      [
        "version: 1",
        "routing:",
        "  primary:",
        "    provider: ollama",
        "    model: qwen3-coder",
      ].join("\n"),
    );

    const config = loadRepoConfig(workspace);
    assert.deepEqual(config.routing.primary, { provider: "ollama", model: "qwen3-coder" });
    assert.equal(config.routing.fallback.provider, "openai");
  });
});

test("repo config rejects an unknown provider", () => {
  withWorkspace((workspace) => {
    writeFileSync(
      join(workspace, ".igzpatch.yml"),
      [
        "version: 1",
        "routing:",
        "  primary:",
        "    provider: mystery",
        "    model: unknown",
      ].join("\n"),
    );

    assert.throws(() => loadRepoConfig(workspace), /Invalid enum value/);
  });
});

test("worker environment can override repository provider routing", () => {
  const config = makeConfig({ provider: "codex", model: "gpt-5.4" });
  assert.deepEqual(
    resolveAgentProvider(
      { config },
      { IGZPATCH_AGENT_PROVIDER: "ollama", IGZPATCH_AGENT_MODEL: "qwen3-coder" },
    ),
    { provider: "ollama", model: "qwen3-coder" },
  );
  assert.throws(
    () => resolveAgentProvider({ config }, { IGZPATCH_AGENT_PROVIDER: "invalid" }),
    /Invalid enum value/,
  );
});

test("toolbox enforces writable and blocked path policies", async () => {
  await withWorkspaceAsync(async (workspace) => {
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "value.ts"), "export const value = 1;\n");
    writeFileSync(join(workspace, ".env"), "SECRET=hidden\n");
    const toolbox = createAgentToolbox({
      workspace,
      config: makeConfig({ provider: "openai", model: "gpt-5.4" }),
      timeoutMs: 5_000,
    });

    await toolbox.execute("replace_in_file", {
      path: "src/value.ts",
      old_text: "value = 1",
      new_text: "value = 2",
    });
    assert.match(readFileSync(join(workspace, "src", "value.ts"), "utf8"), /value = 2/);
    assert.equal(toolbox.mutationCount, 1);
    await assert.rejects(
      toolbox.execute("write_file", { path: "README.md", content: "not allowed" }),
      /outside paths.allowed/,
    );
    await assert.rejects(
      toolbox.execute("read_file", { path: ".env" }),
      /sensitive path/,
    );
    await assert.rejects(
      toolbox.execute("write_file", { path: "../escape.ts", content: "no" }),
      /escapes workspace/,
    );
  });
});

test("diff summary includes newly created files and paths containing spaces", async () => {
  await withWorkspaceAsync(async (workspace) => {
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "new file.ts"), "export const value = 1;\n");

    const summary = await readDiffSummary(workspace);
    assert.deepEqual(summary.changedFiles, ["src/new file.ts"]);
    assert.equal(summary.addedLines, 1);
    assert.equal(summary.deletedLines, 0);
  });
});

test("OpenAI provider performs a read-only pass then edits through Responses API tools", async () => {
  await withWorkspaceAsync(async (workspace) => {
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "value.ts"), "export const value = 1;\n");
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      openAiResponse("resp-1", "call-read", "read_file", { path: "src/value.ts" }),
      openAiResponse("resp-2", "call-edit", "replace_in_file", {
        path: "src/value.ts",
        old_text: "value = 1",
        new_text: "value = 2",
      }),
      new Response(
        JSON.stringify({
          id: "resp-3",
          output_text: "Implemented the focused fix.",
          output: [],
        }),
        { status: 200 },
      ),
    ];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected OpenAI request");
      return response;
    }) as typeof fetch;

    const summary = await runOpenAiAgent(
      makeRequest(workspace, { provider: "openai", model: "gpt-5.4" }),
      { provider: "openai", model: "gpt-5.4" },
      { fetchImpl, env: { OPENAI_API_KEY: "test-key" } },
    );

    assert.equal(summary, "Implemented the focused fix.");
    assert.match(readFileSync(join(workspace, "src", "value.ts"), "utf8"), /value = 2/);
    assert.deepEqual(toolNames(requests[0]), ["get_diff", "list_files", "read_file", "search_files"]);
    assert.ok(toolNames(requests[1]).includes("replace_in_file"));
    assert.equal(requests[1]?.previous_response_id, "resp-1");
  });
});

test("Ollama provider performs the same bounded tool loop", async () => {
  await withWorkspaceAsync(async (workspace) => {
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "value.ts"), "export const value = 1;\n");
    const urls: string[] = [];
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      ollamaResponse("read_file", { path: "src/value.ts" }),
      ollamaResponse("replace_in_file", {
        path: "src/value.ts",
        old_text: "value = 1",
        new_text: "value = 3",
      }),
      new Response(JSON.stringify({ message: { role: "assistant", content: "Done." } }), {
        status: 200,
      }),
    ];
    const fetchImpl = (async (input: string | URL | Request, init?: RequestInit) => {
      urls.push(String(input));
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected Ollama request");
      return response;
    }) as typeof fetch;

    const summary = await runOllamaAgent(
      makeRequest(workspace, { provider: "ollama", model: "qwen3-coder" }),
      { provider: "ollama", model: "qwen3-coder" },
      { fetchImpl, env: { OLLAMA_BASE_URL: "http://localhost:11434" } },
    );

    assert.equal(summary, "Done.");
    assert.equal(urls[0], "http://localhost:11434/api/chat");
    assert.match(readFileSync(join(workspace, "src", "value.ts"), "utf8"), /value = 3/);
    assert.deepEqual(toolNames(requests[0], true), [
      "get_diff",
      "list_files",
      "read_file",
      "search_files",
    ]);
    assert.ok(toolNames(requests[1], true).includes("write_file"));
  });
});

test("Codex provider invokes non-interactive workspace-write mode with prompt on stdin", async () => {
  await withWorkspaceAsync(async (workspace) => {
    let invocation: Parameters<typeof import("@/lib/agent/command").runProcess>[0] | undefined;
    const summary = await runCodexAgent(
      makeRequest(workspace, { provider: "codex", model: "gpt-5.4" }),
      { provider: "codex", model: "gpt-5.4" },
      {
        env: { IGZPATCH_CODEX_BIN: "/opt/codex" },
        runProcessImpl: async (options) => {
          invocation = options;
          return {
            command: "/opt/codex exec [IgzPatch prompt]",
            exitCode: 0,
            stdout: "Patch complete.\n",
            stderr: "",
            timedOut: false,
          };
        },
      },
    );

    assert.equal(summary, "Patch complete.");
    assert.equal(invocation?.command, "/opt/codex");
    assert.ok(invocation?.args?.includes("workspace-write"));
    assert.ok(invocation?.args?.includes("gpt-5.4"));
    assert.match(invocation?.stdin ?? "", /Issue: #42 Fix the value/);
  });
});

function makeRequest(
  workspace: string,
  primary: RepoConfig["routing"]["primary"],
): AgentProviderRequest {
  return {
    workspace,
    config: makeConfig(primary),
    timeoutMs: 5_000,
    run: {
      id: "run-123",
      repository_full_name: "example/demo",
      issue_number: 42,
      issue_title: "Fix the value",
      issue_body: "Acceptance criteria: the exported value is updated.",
      issue_url: "https://github.com/example/demo/issues/42",
    },
  };
}

function makeConfig(primary: RepoConfig["routing"]["primary"]): RepoConfig {
  const config = structuredClone(defaultRepoConfig);
  config.routing.primary = primary;
  config.paths.allowed = ["src/**", "tests/**"];
  config.paths.blocked = [".env*", "src/blocked/**"];
  config.agent.max_iterations = 3;
  config.agent.read_only_first_pass = true;
  return config;
}

function openAiResponse(
  id: string,
  callId: string,
  name: string,
  args: Record<string, unknown>,
): Response {
  return new Response(
    JSON.stringify({
      id,
      output: [
        {
          type: "function_call",
          call_id: callId,
          name,
          arguments: JSON.stringify(args),
        },
      ],
    }),
    { status: 200 },
  );
}

function ollamaResponse(name: string, args: Record<string, unknown>): Response {
  return new Response(
    JSON.stringify({
      message: {
        role: "assistant",
        content: "",
        tool_calls: [{ function: { name, arguments: args } }],
      },
    }),
    { status: 200 },
  );
}

function toolNames(body: Record<string, unknown> | undefined, ollama = false): string[] {
  const tools = (body?.tools ?? []) as Array<Record<string, unknown>>;
  return tools
    .map((tool) =>
      ollama
        ? String((tool.function as Record<string, unknown> | undefined)?.name)
        : String(tool.name),
    )
    .sort();
}

function withWorkspace(callback: (workspace: string) => void): void {
  const workspace = mkdtempSync(join(tmpdir(), "igzpatch-provider-test-"));
  try {
    callback(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}

async function withWorkspaceAsync(callback: (workspace: string) => Promise<void>): Promise<void> {
  const workspace = mkdtempSync(join(tmpdir(), "igzpatch-provider-test-"));
  try {
    await callback(workspace);
  } finally {
    rmSync(workspace, { recursive: true, force: true });
  }
}
