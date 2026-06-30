import { buildAgentInstructions, buildAgentTask } from "@/lib/agent/providers/prompt";
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

interface OllamaToolCall {
  function?: {
    name?: string;
    arguments?: unknown;
  };
}

interface OllamaMessage {
  role: "system" | "user" | "assistant" | "tool";
  content: string;
  tool_name?: string;
  tool_calls?: OllamaToolCall[];
}

interface OllamaResponse {
  message?: OllamaMessage;
  error?: string;
}

export async function runOllamaAgent(
  request: AgentProviderRequest,
  selection: AgentProviderSelection,
  options: { fetchImpl?: typeof fetch; env?: Record<string, string | undefined> } = {},
): Promise<string> {
  const env = options.env ?? process.env;
  const deadline = Date.now() + request.timeoutMs;
  const session = createOllamaSession({
    apiKey: env.OLLAMA_API_KEY,
    baseUrl: env.IGZPATCH_OLLAMA_BASE_URL ?? env.OLLAMA_BASE_URL ?? "http://127.0.0.1:11434",
    model: selection.model,
    deadline,
    fetchImpl: options.fetchImpl ?? fetch,
    instructions: buildAgentInstructions(request.config),
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
    prompt: buildAgentTask(request.run),
    toolbox,
    maxIterations: request.config.agent.max_iterations,
    maxReadTurns: request.config.agent.max_read_turns,
    readOnlyFirstPass: request.config.agent.read_only_first_pass,
    onToolEvent: request.onToolEvent,
  });
}

export function createOllamaSession({
  apiKey,
  baseUrl,
  model,
  deadline,
  fetchImpl,
  instructions,
}: {
  apiKey?: string;
  baseUrl: string;
  model: string;
  deadline: number;
  fetchImpl: typeof fetch;
  instructions: string;
}): AgentModelSession {
  const messages: OllamaMessage[] = [{ role: "system", content: instructions }];
  let turnNumber = 0;

  return {
    async next(inputs, tools) {
      messages.push(...inputs.map(toOllamaInput));
      const response = await fetchImpl(ollamaChatUrl(baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey?.trim() ? { Authorization: `Bearer ${apiKey}` } : {}),
        },
        body: JSON.stringify({
          model,
          messages,
          tools: tools.map(toOllamaTool),
          stream: false,
        }),
        signal: AbortSignal.timeout(remainingTimeout(deadline)),
      });

      const rawBody = await response.text();
      const body = parseJson<OllamaResponse>(rawBody, "Ollama response");
      if (!response.ok) {
        throw new Error(
          `Ollama API request failed (${response.status}): ${body.error ?? rawBody.slice(0, 500)}`,
        );
      }
      if (!body.message) throw new Error("Ollama response did not include a message");

      turnNumber += 1;
      messages.push(body.message);
      return parseOllamaTurn(body.message, turnNumber);
    },
  };
}

function toOllamaInput(input: ModelInput): OllamaMessage {
  if (input.type === "tool_result") {
    return {
      role: "tool",
      tool_name: input.name,
      content: input.output,
    };
  }
  return { role: "user", content: input.content };
}

function toOllamaTool(tool: AgentToolDefinition): Record<string, unknown> {
  return {
    type: "function",
    function: {
      name: tool.name,
      description: tool.description,
      parameters: tool.parameters,
    },
  };
}

function parseOllamaTurn(message: OllamaMessage, turnNumber: number): ModelTurn {
  const toolCalls: AgentToolCall[] = (message.tool_calls ?? []).map((call, index) => {
    if (!call.function?.name) throw new Error("Ollama returned an incomplete function call");
    return {
      id: `ollama-${turnNumber}-${index}`,
      name: call.function.name,
      arguments: parseToolArguments(call.function.arguments),
    };
  });

  return { content: message.content, toolCalls };
}

function parseToolArguments(value: unknown): unknown {
  if (typeof value === "string") return parseJson<unknown>(value, "Ollama tool arguments");
  return value ?? {};
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${label} was not valid JSON`);
  }
}

function ollamaChatUrl(baseUrl: string): string {
  const normalized = baseUrl.trim().replace(/\/+$/, "");
  if (!normalized) throw new Error("Ollama base URL must not be empty");
  if (normalized.endsWith("/api/chat")) return normalized;
  if (normalized.endsWith("/api")) return `${normalized}/chat`;
  return `${normalized}/api/chat`;
}

function remainingTimeout(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Ollama provider timed out");
  return remaining;
}
