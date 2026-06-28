import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

import {
  defaultRepoConfig,
  parseRepoConfig,
  type RepoConfig,
} from "@/lib/agent/repo-config";

export function loadRepoConfig(workspace: string): RepoConfig {
  const configPath =
    [".igzpatch.yml", ".igzpatch.yaml"].map((name) => join(workspace, name)).find(existsSync) ??
    null;

  if (!configPath) return defaultRepoConfig;

  return parseRepoConfig(readFileSync(configPath, "utf8"));
}
