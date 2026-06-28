import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import YAML from "yaml";
import { z } from "zod";

export const agentProviderSchema = z.enum(["codex", "openai", "ollama"]);
export type AgentProvider = z.infer<typeof agentProviderSchema>;

const repoConfigSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  triggers: z.object({
    labels: z.array(z.string()).min(1),
    commands: z.array(z.string()).default([]),
  }),
  repo: z
    .object({
      default_branch: z.string().default("main"),
      language: z.string().default("typescript"),
    })
    .default({}),
  branch: z
    .object({
      prefix: z.string().regex(/^[A-Za-z0-9._/-]+$/).default("igzpatch"),
    })
    .default({}),
  pull_request: z
    .object({
      draft: z.boolean().default(true),
      title_template: z.string().default("IgzPatch: fix issue #{issue_number}"),
      body_policy: z.enum(["evidence_summary"]).default("evidence_summary"),
    })
    .default({}),
  sandbox: z.object({
    image: z.string().default("node:22-bookworm"),
    setup_network: z.enum(["enabled", "disabled"]).default("enabled"),
    run_network: z.enum(["enabled", "disabled"]).default("disabled"),
    cpu_limit: z.number().positive().default(2),
    memory_mb: z.number().int().positive().default(4096),
    timeout_minutes: z.number().int().positive().default(20),
    setup: z.array(z.string()).default([]),
  }),
  checks: z.object({
    required: z.array(z.string()).default([]),
    optional: z.array(z.string()).default([]),
  }),
  paths: z.object({
    allowed: z.array(z.string()).min(1),
    blocked: z.array(z.string()).default([]),
  }),
  issue_scope: z.object({
    max_files_changed: z.number().int().positive().default(6),
    max_diff_lines: z.number().int().positive().default(300),
    requires_acceptance_criteria: z.boolean().default(true),
  }),
  agent: z
    .object({
      max_iterations: z.number().int().positive().default(3),
      read_only_first_pass: z.boolean().default(true),
      open_pr_as_draft: z.boolean().default(true),
      require_manual_merge: z.boolean().default(true),
    })
    .refine((agent) => !agent.read_only_first_pass || agent.max_iterations >= 2, {
      message: "max_iterations must be at least 2 when read_only_first_pass is enabled",
      path: ["max_iterations"],
    }),
  routing: z.object({
    primary: z.object({
      provider: agentProviderSchema,
      model: z.string().min(1),
    }),
    fallback: z
      .object({
        enabled: z.boolean().default(false),
        provider: agentProviderSchema.default("openai"),
        model: z.string().min(1).default("gpt-5.4"),
        conditions: z.array(z.string()).default([]),
      })
      .default({}),
  }),
  audit: z.object({
    comment_strategy: z.literal("marker_backed_single_comment"),
    store_tool_calls: z.boolean().default(true),
    store_command_logs: z.boolean().default(true),
    redact_patterns: z.array(z.string()).default(["sk-", "ghp_", "github_pat_"]),
  }),
});

export type RepoConfig = z.infer<typeof repoConfigSchema>;

export const defaultRepoConfig: RepoConfig = {
  version: 1,
  enabled: true,
  triggers: {
    labels: ["igz:fix"],
    commands: ["@IgzPatch fix", "@IgzPatch status", "@IgzPatch stop"],
  },
  repo: {
    default_branch: "main",
    language: "typescript",
  },
  branch: {
    prefix: "igzpatch",
  },
  pull_request: {
    draft: true,
    title_template: "IgzPatch: fix issue #{issue_number}",
    body_policy: "evidence_summary",
  },
  sandbox: {
    image: "node:22-bookworm",
    setup_network: "enabled",
    run_network: "disabled",
    cpu_limit: 2,
    memory_mb: 4096,
    timeout_minutes: 20,
    setup: [],
  },
  checks: {
    required: [],
    optional: [],
  },
  paths: {
    allowed: ["app/**", "src/**", "tests/**"],
    blocked: [".env*", ".github/workflows/**"],
  },
  issue_scope: {
    max_files_changed: 6,
    max_diff_lines: 300,
    requires_acceptance_criteria: true,
  },
  agent: {
    max_iterations: 3,
    read_only_first_pass: true,
    open_pr_as_draft: true,
    require_manual_merge: true,
  },
  routing: {
    primary: {
      provider: "codex",
      model: "gpt-5.4",
    },
    fallback: {
      enabled: false,
      provider: "openai",
      model: "gpt-5.4",
      conditions: [],
    },
  },
  audit: {
    comment_strategy: "marker_backed_single_comment",
    store_tool_calls: true,
    store_command_logs: true,
    redact_patterns: ["sk-", "ghp_", "github_pat_"],
  },
};

export function loadRepoConfig(workspace: string): RepoConfig {
  const configPath =
    [".igzpatch.yml", ".igzpatch.yaml"].map((name) => join(workspace, name)).find(existsSync) ??
    null;

  if (!configPath) return defaultRepoConfig;

  const parsed = YAML.parse(readFileSync(configPath, "utf8")) as unknown;
  const merged = deepMerge(defaultRepoConfig, parsed);
  return repoConfigSchema.parse(merged);
}

function deepMerge<T>(base: T, override: unknown): T {
  if (!isPlainObject(base) || !isPlainObject(override)) {
    return (override === undefined ? base : override) as T;
  }

  const result: Record<string, unknown> = { ...base };
  for (const [key, value] of Object.entries(override)) {
    result[key] = key in result ? deepMerge(result[key], value) : value;
  }
  return result as T;
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === "object" && !Array.isArray(value);
}
