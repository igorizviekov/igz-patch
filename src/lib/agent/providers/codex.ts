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
  if (request.sandbox) {
    const result = await request.sandbox.runCodex({
      model: selection.model,
      prompt: buildAgentPrompt(request),
      timeoutMs: request.timeoutMs,
    });
    assertCommandSucceeded(result);
    return result.stdout.trim() || "Codex completed the patch.";
  }

  const env = options.env ?? process.env;
  const binary = env.IGZPATCH_CODEX_BIN?.trim() || "codex";
  const result = await (options.runProcessImpl ?? runProcess)({
    command: binary,
    args: [
      "exec",
      "--ephemeral",
      "--ignore-user-config",
      "--sandbox",
      "workspace-write",
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
    timeoutMs: request.timeoutMs,
    stdin: buildAgentPrompt(request),
  });
  assertCommandSucceeded(result);
  return result.stdout.trim() || "Codex completed the patch.";
}
