import type { RunRecord } from "@/lib/db/runs";
import type { AgentProvider, RepoConfig } from "@/lib/agent/repo-config";
import type { AgentSandbox } from "@/lib/agent/sandbox";

export interface AgentProviderRequest {
  workspace: string;
  run: Pick<
    RunRecord,
    | "id"
    | "repository_full_name"
    | "issue_number"
    | "issue_title"
    | "issue_body"
    | "issue_url"
  >;
  config: RepoConfig;
  timeoutMs: number;
  sandbox?: AgentSandbox;
  onToolEvent?: (event: AgentToolEvent) => Promise<void>;
}

export interface AgentToolEvent {
  name: string;
  arguments: unknown;
  output: string;
  ok: boolean;
}

export interface AgentProviderSelection {
  provider: AgentProvider;
  model: string;
}

export interface AgentProviderResult extends AgentProviderSelection {
  summary: string;
}

export interface AgentToolDefinition {
  name: string;
  description: string;
  parameters: Record<string, unknown>;
  readOnly: boolean;
}

export interface AgentToolCall {
  id: string;
  name: string;
  arguments: unknown;
}

export type ModelInput =
  | { type: "user"; content: string }
  | { type: "tool_result"; callId: string; name: string; output: string };

export interface ModelTurn {
  content: string;
  toolCalls: AgentToolCall[];
}

export interface AgentModelSession {
  next(inputs: ModelInput[], tools: AgentToolDefinition[]): Promise<ModelTurn>;
}
