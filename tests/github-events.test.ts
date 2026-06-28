import assert from "node:assert/strict";
import test from "node:test";

import {
  configuredIssueCommand,
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

test("issue commands require a maintainer association", () => {
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
