import { runToolAgent } from "@/lib/agent/providers/tool-loop";
import { createAgentToolbox } from "@/lib/agent/providers/tools";
import type {
  AgentModelSession,
  AgentProviderRequest,
  AgentProviderSelection,
  AgentToolCall,
  AgentToolDefinition,
  ModelInput,
  ModelTurn,
} from "@/lib/agent/providers/types";
import { buildAgentPrompt } from "@/lib/agent/providers/prompt";

interface OpenAiOutputItem extends Record<string, unknown> {
  type?: string;
  call_id?: string;
  name?: string;
  arguments?: string;
  content?: Array<{ type?: string; text?: string }>;
}

interface OpenAiResponse {
  id?: string;
  output_text?: string;
  output?: OpenAiOutputItem[];
  error?: { message?: string };
}

export async function runOpenAiAgent(
  request: AgentProviderRequest,
  selection: AgentProviderSelection,
  options: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const deadline = Date.now() + request.timeoutMs;
  const session = createOpenAiSession({
    apiKey: requiredEnvFrom(env, "OPENAI_API_KEY"),
    baseUrl: env.IGZPATCH_OPENAI_BASE_URL ?? env.OPENAI_BASE_URL ?? "https://api.openai.com/v1",
    model: selection.model,
    deadline,
    fetchImpl: options.fetchImpl ?? fetch,
    organization: env.OPENAI_ORG_ID,
    project: env.OPENAI_PROJECT_ID,
  });
  const toolbox = createAgentToolbox({
    workspace: request.workspace,
    config: request.config,
    timeoutMs: request.timeoutMs,
    deadline,
    runCheck: request.sandbox
      ? (command, timeoutMs) => request.sandbox!.runCommand({ command, phase: "run", timeoutMs })
      : undefined,
    runTool: request.sandbox
      ? (name, input, timeoutMs) => request.sandbox!.runTool({ name, arguments: input, timeoutMs })
      : undefined,
  });

  return runToolAgent({
    session,
    prompt: buildAgentPrompt(request),
    toolbox,
    maxIterations: request.config.agent.max_iterations,
    maxReadTurns: request.config.agent.max_read_turns,
    readOnlyFirstPass: request.config.agent.read_only_first_pass,
    onToolEvent: request.onToolEvent,
  });
}

export function createOpenAiSession({
  apiKey,
  baseUrl,
  model,
  deadline,
  fetchImpl,
  organization,
  project,
}: {
  apiKey: string;
  baseUrl: string;
  model: string;
  deadline: number;
  fetchImpl: typeof fetch;
  organization?: string;
  project?: string;
}): AgentModelSession {
  let conversationItems: Array<Record<string, unknown>> = [];

  return {
    async next(inputs, tools) {
      const currentInputs = inputs.map(toOpenAiInput);
      const requestInput = [...conversationItems, ...currentInputs];
      const response = await fetchImpl(`${trimTrailingSlash(baseUrl)}/responses`, {
        method: "POST",
        headers: {
          Authorization: `Bearer ${apiKey}`,
          "Content-Type": "application/json",
          ...(organization ? { "OpenAI-Organization": organization } : {}),
          ...(project ? { "OpenAI-Project": project } : {}),
        },
        body: JSON.stringify({
          model,
          input: requestInput,
          tools: tools.map(toOpenAiTool),
          parallel_tool_calls: false,
          store: false,
          include: ["reasoning.encrypted_content"],
        }),
        signal: AbortSignal.timeout(remainingTimeout(deadline)),
      });

      const rawBody = await response.text();
      const body = parseJson<OpenAiResponse>(rawBody, "OpenAI response");
      if (!response.ok) {
        throw new Error(
          `OpenAI API request failed (${response.status}): ${body.error?.message ?? rawBody.slice(0, 500)}`,
        );
      }
      conversationItems = [...requestInput, ...(body.output ?? [])];
      return parseOpenAiTurn(body);
    },
  };
}

function toOpenAiInput(input: ModelInput): Record<string, unknown> {
  if (input.type === "tool_result") {
    return { type: "function_call_output", call_id: input.callId, output: input.output };
  }
  return {
    role: "user",
    content: [{ type: "input_text", text: input.content }],
  };
}

function toOpenAiTool(tool: AgentToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    name: tool.name,
    description: tool.description,
    parameters: tool.parameters,
    strict: false,
  };
}

function parseOpenAiTurn(body: OpenAiResponse): ModelTurn {
  const toolCalls: AgentToolCall[] = [];
  const content: string[] = [];

  for (const item of body.output ?? []) {
    if (item.type === "function_call") {
      if (!item.call_id || !item.name) throw new Error("OpenAI returned an incomplete function call");
      toolCalls.push({
        id: item.call_id,
        name: item.name,
        arguments: parseToolArguments(item.arguments),
      });
    }
    if (item.type === "message") {
      for (const part of item.content ?? []) {
        if (part.type === "output_text" && part.text) content.push(part.text);
      }
    }
  }

  return { content: body.output_text ?? content.join("\n"), toolCalls };
}

function parseToolArguments(value: string | undefined): unknown {
  if (!value) return {};
  return parseJson<unknown>(value, "OpenAI tool arguments");
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${label} was not valid JSON`);
  }
}

function trimTrailingSlash(value: string): string {
  return value.replace(/\/+$/, "");
}

function remainingTimeout(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("OpenAI provider timed out");
  return remaining;
}

function requiredEnvFrom(env: Record<string, string | undefined>, name: string): string {
  const value = env[name];
  if (!value || value.trim() === "") {
    throw new Error(`Missing required environment variable: ${name}`);
  }
  return value;
}
