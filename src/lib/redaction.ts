const secretSuffix = "[A-Za-z0-9_./+=-]{4,}";

export function redactText(value: string, prefixes: string[]): string {
  let redacted = value;
  for (const prefix of [...new Set(["sk-", "ghp_", "gho_", "ghu_", "ghs_", "ghr_", "github_pat_", ...prefixes])].filter(Boolean)) {
    const pattern = new RegExp(`${escapeRegExp(prefix)}${secretSuffix}`, "gi");
    redacted = redacted.replace(pattern, `${prefix}[REDACTED]`);
  }
  redacted = redacted.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED PRIVATE KEY]",
  );
  redacted = redacted
    .replace(/(authorization\s*:\s*(?:basic|bearer)\s+)[^\s,;]+/gi, "$1[REDACTED]")
    .replace(/(https?:\/\/)[^\s/@:]+:[^\s/@]+@/gi, "$1[REDACTED]@")
    .replace(/\b(postgres(?:ql)?|mysql|mongodb(?:\+srv)?|redis):\/\/[^\s]+/gi, "$1://[REDACTED]")
    .replace(/\b(?:api[_-]?key|access[_-]?token|client[_-]?secret|password)\s*[=:]\s*[^\s,;]+/gi, (match) => {
      const separator = match.includes("=") ? "=" : ":";
      return `${match.slice(0, match.indexOf(separator) + 1)}[REDACTED]`;
    });
  return redacted;
}

export function truncateText(value: string, maximum = 4_000): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n...[truncated]`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
