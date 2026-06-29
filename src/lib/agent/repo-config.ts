import YAML from "yaml";
import { z } from "zod";

import type { getInstallationOctokit } from "@/lib/github/app";

export const agentProviderSchema = z.enum(["codex", "openai"]);
export type AgentProvider = z.infer<typeof agentProviderSchema>;

export class RepoConfigValidationError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "RepoConfigValidationError";
  }
}

const repoConfigSchema = z.object({
  version: z.literal(1),
  enabled: z.boolean(),
  triggers: z.object({
    labels: z.array(z.string()).min(1),
    commands: z.array(z.string()).default([]),
  }).strict(),
  repo: z
    .object({
      default_branch: z.string().default("main"),
      language: z.string().default("typescript"),
    }).strict()
    .default({}),
  branch: z
    .object({
      prefix: z.string().regex(/^[A-Za-z0-9._/-]+$/).default("igzpatch"),
    }).strict()
    .default({}),
  pull_request: z
    .object({
      draft: z.literal(true).default(true),
      title_template: z.string().default("#{change_summary}"),
      body_policy: z.enum(["evidence_summary"]).default("evidence_summary"),
    }).strict()
    .default({}),
  sandbox: z.object({
    image: z.string().default("node:22-bookworm"),
    setup_network: z.enum(["enabled", "disabled"]).default("enabled"),
    run_network: z.enum(["enabled", "disabled"]).default("disabled"),
    cpu_limit: z.number().positive().default(2),
    memory_mb: z.number().int().positive().default(4096),
    timeout_minutes: z.number().int().positive().default(20),
    setup: z.array(z.string()).default([]),
  }).strict(),
  checks: z.object({
    required: z.array(z.string()).default([]),
    optional: z.array(z.string()).default([]),
  }).strict(),
  paths: z.object({
    allowed: z.array(z.string()).min(1),
    blocked: z.array(z.string()).default([]),
  }).strict(),
  issue_scope: z.object({
    max_files_changed: z.number().int().positive().default(6),
    max_diff_lines: z.number().int().positive().default(300),
    max_file_bytes: z.number().int().positive().default(1_000_000),
    max_patch_bytes: z.number().int().positive().default(2_000_000),
    requires_acceptance_criteria: z.boolean().default(true),
  }).strict(),
  agent: z
    .object({
      max_iterations: z.number().int().positive().default(3),
      max_read_turns: z.number().int().positive().default(12),
      read_only_first_pass: z.boolean().default(true),
      open_pr_as_draft: z.literal(true).default(true),
      require_manual_merge: z.literal(true).default(true),
    }).strict(),
  routing: z.object({
    primary: z.object({
      provider: agentProviderSchema,
      model: z.string().min(1),
    }).strict(),
  }).strict(),
  audit: z.object({
    comment_strategy: z.literal("marker_backed_single_comment"),
    store_tool_calls: z.boolean().default(true),
    store_command_logs: z.boolean().default(true),
    redact_patterns: z.array(z.string()).default(["sk-", "ghp_", "github_pat_"]),
  }).strict(),
}).strict().superRefine((config, context) => {
  if (config.enabled && config.checks.required.length === 0) {
    context.addIssue({
      code: z.ZodIssueCode.custom,
      message: "At least one required check is needed when IgzPatch is enabled",
      path: ["checks", "required"],
    });
  }
});

export type RepoConfig = z.infer<typeof repoConfigSchema>;

export const defaultRepoConfig: RepoConfig = {
  version: 1,
  enabled: false,
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
    title_template: "#{change_summary}",
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
    max_file_bytes: 1_000_000,
    max_patch_bytes: 2_000_000,
    requires_acceptance_criteria: true,
  },
  agent: {
    max_iterations: 3,
    max_read_turns: 12,
    read_only_first_pass: true,
    open_pr_as_draft: true,
    require_manual_merge: true,
  },
  routing: {
    primary: {
      provider: "codex",
      model: "gpt-5.4",
    },
  },
  audit: {
    comment_strategy: "marker_backed_single_comment",
    store_tool_calls: true,
    store_command_logs: true,
    redact_patterns: ["sk-", "ghp_", "github_pat_"],
  },
};

export function parseRepoConfig(source: string): RepoConfig {
  try {
    const parsed = YAML.parse(source) as unknown;
    const merged = deepMerge(defaultRepoConfig, parsed);
    return repoConfigSchema.parse(merged);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    throw new RepoConfigValidationError(message, { cause: error });
  }
}

const workerPolicyLimits = {
  cpu_limit: 4,
  memory_mb: 8192,
  timeout_minutes: 30,
  max_files_changed: 20,
  max_diff_lines: 2_000,
  max_file_bytes: 2_000_000,
  max_patch_bytes: 5_000_000,
} as const;

const defaultAllowedImages = new Set(["node:22-bookworm"]);

export function enforceWorkerRepoPolicy(
  config: RepoConfig,
  env: Record<string, string | undefined> = process.env,
): void {
  const violations = [
    ["sandbox.cpu_limit", config.sandbox.cpu_limit, workerPolicyLimits.cpu_limit],
    ["sandbox.memory_mb", config.sandbox.memory_mb, workerPolicyLimits.memory_mb],
    ["sandbox.timeout_minutes", config.sandbox.timeout_minutes, workerPolicyLimits.timeout_minutes],
    ["issue_scope.max_files_changed", config.issue_scope.max_files_changed, workerPolicyLimits.max_files_changed],
    ["issue_scope.max_diff_lines", config.issue_scope.max_diff_lines, workerPolicyLimits.max_diff_lines],
    ["issue_scope.max_file_bytes", config.issue_scope.max_file_bytes, workerPolicyLimits.max_file_bytes],
    ["issue_scope.max_patch_bytes", config.issue_scope.max_patch_bytes, workerPolicyLimits.max_patch_bytes],
  ] as const;
  for (const [name, value, maximum] of violations) {
    if (value > maximum) throw new RepoConfigValidationError(`${name} exceeds worker maximum ${maximum}`);
  }

  const allowedImages = new Set(
    (env.IGZPATCH_ALLOWED_SANDBOX_IMAGES ?? [...defaultAllowedImages].join(","))
      .split(",")
      .map((value) => value.trim())
      .filter(Boolean),
  );
  if (!allowedImages.has(config.sandbox.image)) {
    throw new RepoConfigValidationError(`sandbox.image is not allowed by this worker: ${config.sandbox.image}`);
  }
  for (const command of config.sandbox.setup) assertAllowedRepoCommand(command, "setup");
  for (const command of [...config.checks.required, ...config.checks.optional]) {
    assertAllowedRepoCommand(command, "check");
  }
}

export function assertAllowedRepoCommand(command: string, phase: "setup" | "check"): void {
  if (!command.trim() || /[\n\r;&|><`()$\\]/.test(command)) {
    throw new RepoConfigValidationError(`${phase} command contains unsupported shell syntax: ${command}`);
  }
  const words = command.trim().split(/\s+/);
  const [binary, subcommand] = words;
  const allowed = phase === "setup"
    ? (binary === "corepack" && subcommand === "enable")
      || (["npm", "pnpm", "yarn"].includes(binary ?? "") && ["ci", "install"].includes(subcommand ?? ""))
    : ["npm", "pnpm", "yarn"].includes(binary ?? "")
      && (subcommand === "test" || subcommand === "run" || subcommand === "exec");
  if (!allowed) throw new RepoConfigValidationError(`${phase} command is not allowlisted: ${command}`);
}

export async function loadRepoConfigFromGitHub({
  octokit,
  owner,
  repo,
}: {
  octokit: Awaited<ReturnType<typeof getInstallationOctokit>>;
  owner: string;
  repo: string;
}): Promise<RepoConfig> {
  for (const path of [".igzpatch.yml", ".igzpatch.yaml"]) {
    try {
      const response = await octokit.repos.getContent({ owner, repo, path });
      const data = response.data;
      if (Array.isArray(data) || data.type !== "file" || !("content" in data)) {
        throw new Error(`${path} is not a regular file`);
      }
      if (data.encoding !== "base64" || typeof data.content !== "string") {
        throw new Error(`${path} must be returned as base64 content`);
      }
      return parseRepoConfig(Buffer.from(data.content, "base64").toString("utf8"));
    } catch (error) {
      if (isNotFoundError(error)) continue;
      throw error;
    }
  }

  return defaultRepoConfig;
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

function isNotFoundError(error: unknown): boolean {
  return Boolean(error) && typeof error === "object" && (error as { status?: unknown }).status === 404;
}
