import { buildAgentPrompt } from "@/lib/agent/providers/prompt";
import { runToolAgent } from "@/lib/agent/providers/tool-loop";
import { createAgentToolbox } from "@/lib/agent/providers/tools";
import type {
  AgentModelSession,
  AgentProviderRequest,
  AgentProviderSelection,
  AgentToolDefinition,
  ModelInput,
} from "@/lib/agent/providers/types";

interface OllamaMessage {
  role: "user" | "assistant" | "tool";
  content: string;
  tool_name?: string;
  tool_calls?: Array<{
    function?: { name?: string; arguments?: unknown };
  }>;
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
    baseUrl: env.OLLAMA_BASE_URL ?? "http://localhost:11434",
    apiKey: env.OLLAMA_API_KEY,
    model: selection.model,
    deadline,
    fetchImpl: options.fetchImpl ?? fetch,
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

export function createOllamaSession({
  baseUrl,
  apiKey,
  model,
  deadline,
  fetchImpl,
}: {
  baseUrl: string;
  apiKey?: string;
  model: string;
  deadline: number;
  fetchImpl: typeof fetch;
}): AgentModelSession {
  const messages: OllamaMessage[] = [];
  let turnNumber = 0;

  return {
    async next(inputs, tools) {
      messages.push(...inputs.map(toOllamaInput));
      const response = await fetchImpl(ollamaChatUrl(baseUrl), {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
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
      if (!response.ok || body.error) {
        throw new Error(
          `Ollama API request failed (${response.status}): ${body.error ?? rawBody.slice(0, 500)}`,
        );
      }
      if (!body.message) throw new Error("Ollama response did not include a message");
      messages.push(body.message);
      turnNumber += 1;

      return {
        content: body.message.content ?? "",
        toolCalls: (body.message.tool_calls ?? []).map((call, index) => {
          const name = call.function?.name;
          if (!name) throw new Error("Ollama returned an incomplete tool call");
          return {
            id: `ollama-${turnNumber}-${index}`,
            name,
            arguments: parseToolArguments(call.function?.arguments),
          };
        }),
      };
    },
  };
}

function toOllamaInput(input: ModelInput): OllamaMessage {
  if (input.type === "tool_result") {
    return { role: "tool", tool_name: input.name, content: input.output };
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

function parseToolArguments(value: unknown): unknown {
  if (typeof value !== "string") return value ?? {};
  return parseJson<unknown>(value, "Ollama tool arguments");
}

function parseJson<T>(value: string, label: string): T {
  try {
    return JSON.parse(value) as T;
  } catch {
    throw new Error(`${label} was not valid JSON`);
  }
}

function ollamaChatUrl(baseUrl: string): string {
  const normalized = baseUrl.replace(/\/+$/, "");
  return normalized.endsWith("/api") ? `${normalized}/chat` : `${normalized}/api/chat`;
}

function remainingTimeout(deadline: number): number {
  const remaining = deadline - Date.now();
  if (remaining <= 0) throw new Error("Ollama provider timed out");
  return remaining;
}
