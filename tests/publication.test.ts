import assert from "node:assert/strict";
import test from "node:test";

import { deriveChangeSummary, renderPublicationTitle } from "@/lib/agent/publication";

test("publication metadata uses the final provider change marker", () => {
  const summary = [
    "Implemented the responsive CSS patch.",
    "CHANGE_SUMMARY: Make filter toolbar responsive on small screens.",
  ].join("\n");

  assert.equal(
    deriveChangeSummary(summary, "Filter toolbar is clipped"),
    "Make filter toolbar responsive on small screens",
  );
});

test("publication titles are concise and legacy templates fall back safely", () => {
  const changeSummary = deriveChangeSummary("No marker", "Fix\nissue #5: toolbar clipping");
  assert.equal(changeSummary, "Fix issue 5: toolbar clipping");
  assert.equal(
    renderPublicationTitle("IgzPatch: #{change_summary}", changeSummary, 5),
    "IgzPatch: Fix issue 5: toolbar clipping",
  );
  assert.equal(
    renderPublicationTitle("IgzPatch demo: fix issue #{issue_number}", changeSummary, 5),
    changeSummary,
  );
});
