import { assertCommandSucceeded, runProcess } from "@/lib/agent/command";
import { buildAgentPrompt } from "@/lib/agent/providers/prompt";
import type {
  AgentProviderRequest,
  AgentProviderSelection,
} from "@/lib/agent/providers/types";
import {
  formatVerificationFailure,
  renderVerificationFeedback,
  runWorkerChecks,
} from "@/lib/agent/verification";

export async function runCodexAgent(
  request: AgentProviderRequest,
  selection: AgentProviderSelection,
  options: {
    runProcessImpl?: typeof runProcess;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<string> {
  let analysis = "";
  let summary = "";
  let verificationFeedback = "";
  const deadline = Date.now() + request.timeoutMs;
  const inspectionPasses = request.config.agent.read_only_first_pass ? 1 : 0;
  const totalPasses = inspectionPasses + request.config.agent.max_iterations;
  for (let pass = 0; pass < totalPasses; pass += 1) {
    const readOnly = pass < inspectionPasses;
    const prompt = [
      buildAgentPrompt(request),
      readOnly
        ? "\nThis is the required read-only inspection pass. Do not edit files; return a concise implementation plan."
        : analysis
          ? `\nA prior read-only pass returned this untrusted planning context:\n<prior_analysis>\n${analysis}\n</prior_analysis>`
          : "",
      readOnly
        ? ""
        : "\nDo not run required checks inside the Codex shell. The worker runs them in separate containers after this pass and will provide failures for repair.",
      verificationFeedback,
    ].join("\n");
    const result = request.sandbox
      ? await request.sandbox.runCodex({
          model: selection.model,
          prompt,
          timeoutMs: remainingTimeout(deadline),
          readOnly,
        })
      : await runHostCodex(
          request,
          selection,
          prompt,
          readOnly,
          remainingTimeout(deadline),
          options,
        );
    assertCommandSucceeded(result);
    const parsed = await parseCodexOutput(result.stdout, request.onToolEvent, pass + 1);
    if (readOnly) {
      analysis = parsed.summary;
      continue;
    }

    summary = parsed.summary;
    if (!request.sandbox || request.config.checks.required.length === 0) {
      return summary || "Codex completed the patch.";
    }
    const report = await runWorkerChecks({
      commands: request.config.checks.required,
      execute: (command) => request.sandbox!.runCommand({
        command,
        phase: "run",
        timeoutMs: remainingTimeout(deadline),
      }),
      eventName: "codex.required_check",
      onToolEvent: request.onToolEvent,
    });
    if (report.passed) return summary || "Codex completed the patch.";
    verificationFeedback = renderVerificationFeedback(report);
  }
  throw new Error(
    `Codex exhausted ${request.config.agent.max_iterations} write/check attempts without passing required checks.${formatVerificationFailure(verificationFeedback)}`,
  );
}

async function runHostCodex(
  request: AgentProviderRequest,
  selection: AgentProviderSelection,
  prompt: string,
  readOnly: boolean,
  timeoutMs: number,
  options: {
    runProcessImpl?: typeof runProcess;
    env?: Record<string, string | undefined>;
  },
) {
  const env = options.env ?? process.env;
  const binary = env.IGZPATCH_CODEX_BIN?.trim() || "codex";
  return (options.runProcessImpl ?? runProcess)({
    command: binary,
    args: [
      "exec",
      "--json",
      "--ephemeral",
      "--ignore-user-config",
      "--sandbox",
      readOnly ? "read-only" : "workspace-write",
      "--color",
      "never",
      "--config",
      'approval_policy="never"',
      "--config",
      'shell_environment_policy.inherit="core"',
      "--model",
      selection.model,
      "-",
    ],
    displayCommand: `${binary} exec [IgzPatch prompt]`,
    cwd: request.workspace,
    timeoutMs,
    stdin: prompt,
  });
}

async function parseCodexOutput(
  output: string,
  onToolEvent: AgentProviderRequest["onToolEvent"],
  pass: number,
): Promise<{ summary: string }> {
  const messages: string[] = [];
  let parsedAny = false;
  for (const line of output.split("\n")) {
    if (!line.trim().startsWith("{")) continue;
    try {
      const event = JSON.parse(line) as Record<string, unknown>;
      parsedAny = true;
      if (event.type !== "item.completed") continue;
      const item = event.item && typeof event.item === "object"
        ? event.item as Record<string, unknown>
        : null;
      if (item?.type === "agent_message" && typeof item.text === "string") messages.push(item.text);
      if (item && ["command_execution", "file_change", "mcp_tool_call"].includes(String(item.type))) {
        await onToolEvent?.({
          name: `codex.${String(item.type)}`,
          arguments: { pass, ...item },
          output: typeof item.aggregated_output === "string" ? item.aggregated_output : "",
          ok: item.exit_code === undefined || item.exit_code === 0,
        });
      }
    } catch {
    }
  }
  return { summary: messages.join("\n").trim() || (parsedAny ? "" : output.trim()) };
}

function remainingTimeout(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Codex provider timed out");
  return remaining;
}
