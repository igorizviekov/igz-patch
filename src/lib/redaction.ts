const secretSuffix = "[A-Za-z0-9_./+=-]{4,}";

export function redactText(value: string, prefixes: string[]): string {
  let redacted = value;
  for (const prefix of prefixes.filter(Boolean)) {
    const pattern = new RegExp(`${escapeRegExp(prefix)}${secretSuffix}`, "gi");
    redacted = redacted.replace(pattern, `${prefix}[REDACTED]`);
  }
  redacted = redacted.replace(
    /-----BEGIN [A-Z ]*PRIVATE KEY-----[\s\S]*?-----END [A-Z ]*PRIVATE KEY-----/g,
    "[REDACTED PRIVATE KEY]",
  );
  return redacted;
}

export function truncateText(value: string, maximum = 4_000): string {
  return value.length <= maximum ? value : `${value.slice(0, maximum)}\n...[truncated]`;
}

function escapeRegExp(value: string): string {
  return value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}
