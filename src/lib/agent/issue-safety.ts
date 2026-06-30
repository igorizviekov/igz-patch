import { BlockedRunError } from "@/lib/agent/diff";
import { matchesPathGlob } from "@/lib/agent/path-policy";
import type { RepoConfig } from "@/lib/agent/repo-config";

export interface UnsafeIssueFinding {
  kind: "protected_path" | "verification_bypass" | "policy_override" | "credential_access";
  reason: string;
}

const mutationVerbPattern = /\b(?:change|edit|modify|write|create|delete|remove|replace|overwrite|rewrite|disable|weaken|update|patch)\b/gi;
const pathReferencePattern = /(?:^|[\s("'`])((?:\.{0,2}\/)?(?:[A-Za-z0-9_.-]+\/)+[A-Za-z0-9_.*?-]+|package(?:-lock)?\.json|pnpm-lock\.yaml|yarn\.lock|bun\.lockb?|Dockerfile|vercel\.json|\.igzpatch\.ya?ml|\.env(?:\.[A-Za-z0-9_.-]+)?)(?=$|[\s)"'`,:;])/gi;

const unsafeIntentRules: Array<{
  kind: UnsafeIssueFinding["kind"];
  pattern: RegExp;
  reason: string;
}> = [
  {
    kind: "policy_override",
    pattern: /(?:\b(?:ignore|disregard)\b.{0,50}\b(?:previous|prior)\b.{0,50}\b(?:instructions?|rules?|policy|guardrails?)\b|\boverride\b.{0,60}\b(?:system|developer|worker|repository)?\s*(?:instructions?|rules?|policy|guardrails?)\b)/i,
    reason: "attempted to override trusted worker instructions or policy",
  },
  {
    kind: "verification_bypass",
    pattern: /\b(?:bypass|disable|remove|weaken|fake|skip)\b.{0,80}\b(?:tests?|checks?|verification|policy|guardrails?|sandbox)\b/i,
    reason: "requested a verification or safety-policy bypass",
  },
  {
    kind: "verification_bypass",
    pattern: /\b(?:make|force|change)\b.{0,50}\btests?\b.{0,30}\b(?:always\s+)?pass\b/i,
    reason: "requested changing tests to force a passing result",
  },
  {
    kind: "credential_access",
    pattern: /\b(?:reveal|print|dump|copy|send|upload|exfiltrate)\b.{0,120}\b(?:secrets?|tokens?|passwords?|credentials?|private\s+keys?|environment\s+variables?|\.env\b|\/proc\/(?:\d+|self)\/environ)\b/i,
    reason: "requested access to credentials or process environment data",
  },
  {
    kind: "credential_access",
    pattern: /\b(?:read|inspect)\b.{0,120}\b(?:secrets?|passwords?|credentials?|private\s+keys?|environment\s+variables?|\.env\b|\/proc\/(?:\d+|self)\/environ)\b/i,
    reason: "requested access to credentials or process environment data",
  },
  {
    kind: "credential_access",
    pattern: /\b(?:secrets?|tokens?|passwords?|credentials?|private\s+keys?)\b.{0,120}\b(?:send|upload|post|exfiltrate|curl|wget)\b/i,
    reason: "requested publishing or transmitting credential material",
  },
];

export function assertSafeIssueRequest({
  title,
  body,
  config,
}: {
  title: string;
  body: string | null;
  config: RepoConfig;
}): void {
  const finding = detectUnsafeIssueRequest({ title, body, config });
  if (finding) throw new BlockedRunError(`Unsafe issue request detected: ${finding.reason}.`);
}

export function detectUnsafeIssueRequest({
  title,
  body,
  config,
}: {
  title: string;
  body: string | null;
  config: RepoConfig;
}): UnsafeIssueFinding | null {
  const lines = [title, ...(body ?? "").split(/\r?\n/)];
  for (const line of lines) {
    for (const reference of findPathReferences(line)) {
      if (!isBlockedPathReference(reference.path, config.paths.blocked)) continue;
      if (!hasActiveMutationNear(line, reference.index)) continue;
      return {
        kind: "protected_path",
        reason: `requested modifying worker-protected path ${reference.path}`,
      };
    }

  }

  const intentTexts = [...lines, lines.join(" ").replace(/\s+/g, " ")];
  for (const text of intentTexts) {
    for (const rule of unsafeIntentRules) {
      const match = rule.pattern.exec(text);
      if (!match || isNegatedAt(text, match.index)) continue;
      return { kind: rule.kind, reason: rule.reason };
    }
  }
  return null;
}

function findPathReferences(line: string): Array<{ path: string; index: number }> {
  return [...line.matchAll(pathReferencePattern)].flatMap((match) => {
    const path = match[1]?.replace(/^\.\//, "");
    if (!path || match.index === undefined) return [];
    return [{ path, index: match.index + match[0].indexOf(match[1] ?? "") }];
  });
}

function isBlockedPathReference(path: string, blockedPatterns: string[]): boolean {
  return blockedPatterns.some((pattern) => {
    if (matchesPathGlob(path, pattern)) return true;
    const staticPrefix = pattern.split(/[?*\[]/, 1)[0]?.replace(/\/$/, "") ?? "";
    return Boolean(staticPrefix) && (path === staticPrefix || path.startsWith(`${staticPrefix}/`));
  });
}

function hasActiveMutationNear(line: string, pathIndex: number): boolean {
  return [...line.matchAll(mutationVerbPattern)].some((match) => {
    if (match.index === undefined || Math.abs(match.index - pathIndex) > 120) return false;
    return !isNegatedAt(line, match.index);
  });
}

function isNegatedAt(line: string, index: number): boolean {
  const prefix = line.slice(Math.max(0, index - 40), index);
  return /\b(?:do not|don't|never|must not|should not|cannot|can't)\b[^.!?]*$/i.test(prefix);
}
