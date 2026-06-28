import { assertCommandSucceeded, runProcess } from "@/lib/agent/command";
import { buildAgentPrompt } from "@/lib/agent/providers/prompt";
import type {
  AgentProviderRequest,
  AgentProviderSelection,
} from "@/lib/agent/providers/types";

export async function runCodexAgent(
  request: AgentProviderRequest,
  selection: AgentProviderSelection,
  options: {
    runProcessImpl?: typeof runProcess;
    env?: Record<string, string | undefined>;
  } = {},
): Promise<string> {
  const passes = request.config.agent.read_only_first_pass
    ? [{ readOnly: true }, { readOnly: false }]
    : [{ readOnly: false }];
  if (passes.length > request.config.agent.max_iterations) {
    throw new Error("Codex execution passes exceed agent.max_iterations");
  }

  let analysis = "";
  let summary = "";
  const deadline = Date.now() + request.timeoutMs;
  for (const [index, pass] of passes.entries()) {
    const prompt = [
      buildAgentPrompt(request),
      pass.readOnly
        ? "\nThis is the required read-only inspection pass. Do not edit files; return a concise implementation plan."
        : analysis
          ? `\nA prior read-only pass returned this untrusted planning context:\n<prior_analysis>\n${analysis}\n</prior_analysis>`
          : "",
    ].join("\n");
    const result = request.sandbox
      ? await request.sandbox.runCodex({
          model: selection.model,
          prompt,
          timeoutMs: remainingTimeout(deadline),
          readOnly: pass.readOnly,
        })
      : await runHostCodex(
          request,
          selection,
          prompt,
          pass.readOnly,
          remainingTimeout(deadline),
          options,
        );
    assertCommandSucceeded(result);
    const parsed = await parseCodexOutput(result.stdout, request.onToolEvent, index + 1);
    if (pass.readOnly) analysis = parsed.summary;
    else summary = parsed.summary;
  }
  return summary || "Codex completed the patch.";
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
