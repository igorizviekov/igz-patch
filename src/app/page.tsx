import { listRecentRuns } from "@/lib/db/runs";

export default async function Home() {
  let runs: Awaited<ReturnType<typeof listRecentRuns>> = [];
  let setupMessage: string | null = null;

  try {
    runs = await listRecentRuns(20);
  } catch {
    setupMessage = "The run database is currently unavailable.";
  }

  return (
    <main className="shell">
      <section className="hero">
        <p className="eyebrow">IgzPatch</p>
        <h1>Auditable issue-to-draft-PR automation.</h1>
        <p className="lede">
          A conservative GitHub App that turns explicitly labeled issues into bounded,
          reviewable draft pull requests with durable run state.
        </p>
      </section>

      <section className="panel">
        <div className="panelHeader">
          <div>
            <h2>Recent Runs</h2>
            <p>Webhook intake, worker leases, blocked states, and draft PR links.</p>
          </div>
        </div>

        {setupMessage ? (
          <div className="empty">
            <strong>Database not connected.</strong>
            <span>{setupMessage}</span>
          </div>
        ) : runs.length === 0 ? (
          <div className="empty">
            <strong>No runs yet.</strong>
            <span>Install the GitHub App on the demo repo and add the trigger label.</span>
          </div>
        ) : (
          <div className="tableWrap">
            <table>
              <thead>
                <tr>
                  <th>Status</th>
                  <th>Repository</th>
                  <th>Issue</th>
                  <th>Attempts</th>
                  <th>PR</th>
                  <th>Created</th>
                </tr>
              </thead>
              <tbody>
                {runs.map((run) => (
                  <tr key={run.id}>
                    <td>
                      <span className={`badge ${run.status}`}>{run.status}</span>
                    </td>
                    <td>{run.repository_full_name}</td>
                    <td>
                      <a href={run.issue_url}>#{run.issue_number}</a>
                    </td>
                    <td>{run.attempts}</td>
                    <td>
                      {run.pull_request_url ? <a href={run.pull_request_url}>draft PR</a> : "none"}
                    </td>
                    <td>{new Date(run.created_at).toLocaleString()}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        )}
      </section>
    </main>
  );
}
