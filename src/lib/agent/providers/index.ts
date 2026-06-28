import { runCodexAgent } from "@/lib/agent/providers/codex";
import { runOllamaAgent } from "@/lib/agent/providers/ollama";
import { runOpenAiAgent } from "@/lib/agent/providers/openai";
import { agentProviderSchema } from "@/lib/agent/repo-config";
import type {
  AgentProviderRequest,
  AgentProviderResult,
  AgentProviderSelection,
} from "@/lib/agent/providers/types";

export async function runConfiguredAgent(
  request: AgentProviderRequest,
): Promise<AgentProviderResult> {
  const selection = resolveAgentProvider(request);
  let summary: string;

  switch (selection.provider) {
    case "codex":
      summary = await runCodexAgent(request, selection);
      break;
    case "openai":
      summary = await runOpenAiAgent(request, selection);
      break;
    case "ollama":
      summary = await runOllamaAgent(request, selection);
      break;
  }

  return { ...selection, summary };
}

export function resolveAgentProvider(
  request: Pick<AgentProviderRequest, "config">,
  env: Record<string, string | undefined> = process.env,
): AgentProviderSelection {
  const configuredProvider = env.IGZPATCH_AGENT_PROVIDER ?? request.config.routing.primary.provider;
  const provider = agentProviderSchema.parse(configuredProvider);
  const model = (env.IGZPATCH_AGENT_MODEL ?? request.config.routing.primary.model).trim();
  if (!model) throw new Error("Agent model must not be empty");
  return { provider, model };
}

export type {
  AgentProviderRequest,
  AgentProviderResult,
  AgentProviderSelection,
} from "@/lib/agent/providers/types";
