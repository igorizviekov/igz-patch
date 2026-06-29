const changeSummaryPattern = /^CHANGE_SUMMARY:\s*(.+)$/gim;

export function deriveChangeSummary(summary: string, fallback: string): string {
  const matches = [...summary.matchAll(changeSummaryPattern)];
  const marked = matches.at(-1)?.[1];
  return normalizeSubject(marked || fallback || "Apply focused repository fix");
}

export function renderPublicationTitle(
  template: string,
  changeSummary: string,
  issueNumber: number,
): string {
  if (!template.includes("#{change_summary}")) return changeSummary;
  return normalizeSubject(
    template
      .replaceAll("#{change_summary}", changeSummary)
      .replaceAll("#{issue_number}", String(issueNumber)),
  );
}

function normalizeSubject(value: string): string {
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/g, " ")
    .replace(/[`*_#]+/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/[.!:;,\-]+$/g, "");
  if (!normalized) return "Apply focused repository fix";
  if (normalized.length <= 72) return normalized;
  const shortened = normalized.slice(0, 72);
  const wordBoundary = shortened.lastIndexOf(" ");
  return (wordBoundary >= 48 ? shortened.slice(0, wordBoundary) : shortened).trim();
}
