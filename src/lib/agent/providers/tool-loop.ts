import type {
  AgentModelSession,
  AgentToolDefinition,
  ModelInput,
} from "@/lib/agent/providers/types";
import type { AgentToolbox } from "@/lib/agent/providers/tools";

export async function runToolAgent({
  session,
  prompt,
  toolbox,
  maxIterations,
  readOnlyFirstPass,
}: {
  session: AgentModelSession;
  prompt: string;
  toolbox: AgentToolbox;
  maxIterations: number;
  readOnlyFirstPass: boolean;
}): Promise<string> {
  let inputs: ModelInput[] = [{ type: "user", content: prompt }];
  let lastContent = "";

  for (let iteration = 0; iteration < maxIterations; iteration += 1) {
    const readOnly = readOnlyFirstPass && iteration === 0;
    const tools = filterTools(toolbox.definitions, readOnly);
    const turn = await session.next(inputs, tools);
    lastContent = turn.content.trim() || lastContent;

    if (turn.toolCalls.length === 0) {
      if (toolbox.mutationCount > 0) return lastContent || "Patch completed.";
      inputs = [
        {
          type: "user",
          content:
            "No repository changes have been made. Inspect the repository with tools, then implement the requested patch before finishing.",
        },
      ];
      continue;
    }

    inputs = [];
    for (const call of turn.toolCalls) {
      try {
        const output = await toolbox.execute(call.name, call.arguments);
        inputs.push({ type: "tool_result", callId: call.id, name: call.name, output });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        inputs.push({
          type: "tool_result",
          callId: call.id,
          name: call.name,
          output: JSON.stringify({ ok: false, error: message }),
        });
      }
    }
  }

  if (toolbox.mutationCount === 0) {
    throw new Error(`Agent exhausted ${maxIterations} iterations without changing repository files.`);
  }

  return lastContent || "Patch completed.";
}

function filterTools(tools: AgentToolDefinition[], readOnly: boolean): AgentToolDefinition[] {
  return readOnly ? tools.filter((tool) => tool.readOnly) : tools;
}
