import { updateRun, updateRunWithLease, type RunLease, type RunRecord } from "@/lib/db/runs";
import type { getInstallationOctokit } from "@/lib/github/app";

export function runCommentMarker(runId: string): string {
  return `<!-- igzpatch-run:${runId} -->`;
}

export function renderRunStatusComment({
  run,
  headline,
  details,
}: {
  run: RunRecord;
  headline: string;
  details: string[];
}): string {
  return [
    runCommentMarker(run.id),
    `## IgzPatch: ${headline}`,
    "",
    `- Repository: \`${run.repository_full_name}\``,
    `- Issue: #${run.issue_number} ${run.issue_title}`,
    `- Status: \`${run.status}\``,
    `- Run: \`${run.id}\``,
    ...details.map((detail) => `- ${detail}`),
    "",
    "This comment is edited in place so the issue keeps one durable run trail.",
  ].join("\n");
}

export async function upsertRunStatusComment({
  octokit,
  run,
  headline,
  details,
  lease,
}: {
  octokit: Awaited<ReturnType<typeof getInstallationOctokit>>;
  run: RunRecord;
  headline: string;
  details: string[];
  lease?: RunLease;
}): Promise<RunRecord> {
  const [owner, repo] = run.repository_full_name.split("/");
  if (!owner || !repo) throw new Error(`Invalid repository name: ${run.repository_full_name}`);

  const body = renderRunStatusComment({ run, headline, details });
  const marker = runCommentMarker(run.id);

  let commentId = run.status_comment_id ?? null;
  let commentUrl = run.status_comment_url ?? null;

  if (!commentId) {
    const comments = await octokit.issues.listComments({
      owner,
      repo,
      issue_number: run.issue_number,
      per_page: 100,
    });
    const existing = comments.data.find((comment) => comment.body?.includes(marker));
    commentId = existing?.id ?? null;
    commentUrl = existing?.html_url ?? null;
  }

  if (commentId) {
    const response = await octokit.issues.updateComment({
      owner,
      repo,
      comment_id: commentId,
      body,
    });
    commentUrl = response.data.html_url;
  } else {
    const response = await octokit.issues.createComment({
      owner,
      repo,
      issue_number: run.issue_number,
      body,
    });
    commentId = response.data.id;
    commentUrl = response.data.html_url;
  }

  const fields = {
    status_comment_id: commentId,
    status_comment_url: commentUrl,
  };
  return lease ? updateRunWithLease(run.id, lease, fields) : updateRun(run.id, fields);
}
