import { BlockedRunError } from "@/lib/agent/diff";
import { redactText } from "@/lib/redaction";

const protectedEnvironmentNames = [
  "CODEX_API_KEY",
  "OPENAI_API_KEY",
  "OLLAMA_API_KEY",
  "GITHUB_PRIVATE_KEY",
  "GITHUB_WEBHOOK_SECRET",
  "DATABASE_URL",
  "IGZPATCH_DASHBOARD_PASSWORD",
] as const;

export function assertNoSecretExposure(
  value: string,
  redactPatterns: string[],
  env: Record<string, string | undefined> = process.env,
): void {
  if (redactText(value, redactPatterns) !== value) {
    throw new BlockedRunError("Generated output contains secret-like material and cannot be published.");
  }

  for (const name of protectedEnvironmentNames) {
    const secret = env[name];
    if (secret && secret.length >= 8 && value.includes(secret)) {
      throw new BlockedRunError(`Generated output contains protected worker credential material (${name}).`);
    }
  }
}
