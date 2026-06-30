import assert from "node:assert/strict";
import test from "node:test";

import {
  configuredIssueCommand,
  durableRunCandidate,
  parseWebhookPayload,
  runInputFromWebhook,
  webhookRepositoryContext,
} from "@/lib/github/events";

const basePayload = {
  action: "labeled",
  installation: { id: 12 },
  repository: { id: 34, full_name: "example/demo" },
  issue: {
    number: 56,
    title: "Repair the parser",
    html_url: "https://github.com/example/demo/issues/56",
    body: "Acceptance criteria: parsing succeeds.",
    labels: [{ name: "custom:fix" }],
  },
  label: { name: "custom:fix" },
  sender: { login: "maintainer" },
};

const triggers = {
  labels: ["custom:fix"],
  commands: ["@IgzPatch fix", "@IgzPatch status", "@IgzPatch stop"],
};

test("issue intake honors repository-specific trigger labels", () => {
  const input = runInputFromWebhook({
    eventName: "issues",
    deliveryId: "delivery-1",
    payload: basePayload,
    triggers,
  });

  assert.equal(input?.triggerValue, "custom:fix");
  assert.equal(input?.triggerKind, "issues.labeled");
  assert.equal(input?.repositoryFullName, "example/demo");
});

test("issue comments require a configured command on its own line", () => {
  const payload = {
    ...basePayload,
    action: "created",
    comment: {
      body: "Context first\n@igzpatch FIX\nThanks",
      user: { login: "maintainer" },
      author_association: "MEMBER",
    },
  };
  const input = runInputFromWebhook({
    eventName: "issue_comment",
    deliveryId: "delivery-2",
    payload,
    triggers,
  });
  assert.equal(input?.triggerValue, "@IgzPatch fix");

  const ignored = runInputFromWebhook({
    eventName: "issue_comment",
    deliveryId: "delivery-3",
    payload: {
      ...payload,
      comment: {
        body: "Please maybe @IgzPatch fix this later",
        author_association: "MEMBER",
      },
    },
    triggers,
  });
  assert.equal(ignored, null);
});

test("status and stop commands are classified but do not enqueue fix runs", () => {
  for (const action of ["status", "stop"] as const) {
    const payload = {
      ...basePayload,
      action: "created",
      comment: { body: `@IgzPatch ${action}`, author_association: "OWNER" },
    };
    assert.deepEqual(configuredIssueCommand(payload, triggers.commands), {
      command: `@IgzPatch ${action}`,
      action,
    });
    assert.equal(
      runInputFromWebhook({
        eventName: "issue_comment",
        deliveryId: `delivery-${action}`,
        payload,
        triggers,
      }),
      null,
    );
  }
});

test("public fix commands require an explicit control-plane opt in", () => {
  const payload = {
    ...basePayload,
    action: "created",
    comment: {
      body: "@IgzPatch fix",
      user: { login: "outside-contributor" },
      author_association: "CONTRIBUTOR",
    },
  };

  assert.equal(configuredIssueCommand(payload, triggers.commands), null);
  assert.equal(
    runInputFromWebhook({
      eventName: "issue_comment",
      deliveryId: "delivery-outsider",
      payload,
      triggers,
    }),
    null,
  );
  assert.equal(
    runInputFromWebhook({
      eventName: "issue_comment",
      deliveryId: "delivery-public-fix",
      payload,
      triggers,
      allowPublicFixCommands: true,
    })?.triggerActor,
    "outside-contributor",
  );
  assert.equal(
    durableRunCandidate({
      eventName: "issue_comment",
      deliveryId: "durable-public-fix",
      payload,
      allowPublicFixCommands: true,
    })?.triggerValue,
    "@IgzPatch fix",
  );
});

test("public status and stop commands remain maintainer-only", () => {
  for (const action of ["status", "stop"] as const) {
    const payload = {
      ...basePayload,
      action: "created",
      comment: {
        body: `@IgzPatch ${action}`,
        user: { login: "outside-contributor" },
        author_association: "NONE",
      },
    };
    assert.equal(configuredIssueCommand(payload, triggers.commands), null);
    assert.equal(runInputFromWebhook({
      eventName: "issue_comment",
      deliveryId: `delivery-public-${action}`,
      payload,
      triggers,
      allowPublicFixCommands: true,
    }), null);
  }
});

test("pull request comments and incomplete repository contexts are ignored", () => {
  assert.equal(
    runInputFromWebhook({
      eventName: "issue_comment",
      deliveryId: "delivery-pr",
      payload: {
        ...basePayload,
        action: "created",
        issue: { ...basePayload.issue, pull_request: {} },
        comment: { body: "@IgzPatch fix", author_association: "MEMBER" },
      },
      triggers,
    }),
    null,
  );
  assert.equal(webhookRepositoryContext({ repository: basePayload.repository }), null);
});

test("durable candidates are derived without repository config", () => {
  assert.equal(durableRunCandidate({
    eventName: "issues",
    deliveryId: "durable-label",
    payload: basePayload,
  })?.triggerValue, "custom:fix");
  assert.equal(durableRunCandidate({
    eventName: "issue_comment",
    deliveryId: "durable-command",
    payload: {
      ...basePayload,
      action: "created",
      comment: { body: "@CustomBot fix", author_association: "MEMBER" },
    },
  })?.triggerValue, "@CustomBot fix");
});

test("issue edits do not retrigger runs and malformed payloads are rejected", () => {
  assert.equal(runInputFromWebhook({
    eventName: "issues",
    deliveryId: "delivery-edit",
    payload: { ...basePayload, action: "edited" },
    triggers,
  }), null);
  assert.throws(() => parseWebhookPayload({
    ...basePayload,
    repository: { ...basePayload.repository, full_name: "not-a-repository" },
  }));
  assert.throws(() => parseWebhookPayload({
    ...basePayload,
    issue: { ...basePayload.issue, body: "x".repeat(200_001) },
  }));
});
