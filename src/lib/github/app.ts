import { App } from "@octokit/app";
import { Octokit } from "@octokit/rest";

import { requiredEnv } from "@/lib/env";

let app: App | null = null;

export function getGitHubApp(): App {
  if (!app) {
    app = new App({
      appId: requiredEnv("GITHUB_APP_ID"),
      privateKey: requiredEnv("GITHUB_PRIVATE_KEY").replace(/\\n/g, "\n"),
    });
  }
  return app;
}

export async function getInstallationOctokit(installationId: number) {
  return new Octokit({ auth: await getInstallationToken(installationId) });
}

export async function getInstallationToken(installationId: number): Promise<string> {
  const auth = await getGitHubApp().octokit.auth({
    type: "installation",
    installationId,
  }) as { token?: unknown };

  if (!("token" in auth) || typeof auth.token !== "string") {
    throw new Error("GitHub App auth did not return an installation token");
  }

  return auth.token;
}
