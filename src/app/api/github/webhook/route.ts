import { NextResponse, type NextRequest } from "next/server";

import { createRun } from "@/lib/db/runs";
import { requiredEnv } from "@/lib/env";
import { runInputFromWebhook } from "@/lib/github/events";
import { verifyGitHubSignature } from "@/lib/github/signature";

export const runtime = "nodejs";

export async function POST(request: NextRequest) {
  const rawBody = await request.text();
  const signature = request.headers.get("x-hub-signature-256");
  const eventName = request.headers.get("x-github-event") ?? "";
  const deliveryId = request.headers.get("x-github-delivery") ?? "";

  if (!deliveryId) {
    return NextResponse.json({ error: "Missing X-GitHub-Delivery" }, { status: 400 });
  }

  const verified = verifyGitHubSignature({
    body: rawBody,
    signature,
    secret: requiredEnv("GITHUB_WEBHOOK_SECRET"),
  });

  if (!verified) {
    return NextResponse.json({ error: "Invalid GitHub signature" }, { status: 401 });
  }

  const payload = JSON.parse(rawBody) as unknown;
  const input = runInputFromWebhook({
    eventName,
    deliveryId,
    payload: payload as Parameters<typeof runInputFromWebhook>[0]["payload"],
  });

  if (!input) {
    return NextResponse.json({ accepted: false, ignored: true });
  }

  const run = await createRun(input);
  return NextResponse.json({ accepted: true, runId: run.id, status: run.status });
}

