import { describe, expect, it } from "vitest";
import { invalidSessionSummaryEnrichmentReason } from "./enrichment-quality.js";
import { buildSessionSummaryPreview } from "./preview.js";

describe("session summary preview", () => {
  it("falls back to deterministic text when llm enrichment reports missing session data", () => {
    const preview = buildSessionSummaryPreview({
      session_id: "session-1",
      target: "codex",
      status: "landed",
      summary_text:
        "Implemented recent-history context injection and verified the focused tests.",
      summary_source: "deterministic",
      enriched_summary_text:
        "No code changed because the session details could not be loaded: the Panopticon MCP request for the exact session was cancelled.",
      enrichment_source: "llm",
    });

    expect(preview.summary).toBe(
      "Implemented recent-history context injection and verified the focused tests.",
    );
    expect(preview.summary_source).toBe("deterministic");
  });

  it("keeps valid dirty llm enrichment and marks it stale", () => {
    const preview = buildSessionSummaryPreview({
      session_id: "session-1",
      target: "codex",
      status: "mixed",
      summary_text:
        "Mixed: 4 intents, 6/8 edits landed. Top files: src/hooks/session-context.ts.",
      summary_source: "deterministic",
      enriched_summary_text:
        "Implemented an older version of the recent-history context injection.",
      enrichment_source: "llm",
      enrichment_dirty: true,
    });

    expect(preview.summary).toBe(
      "Implemented an older version of the recent-history context injection.",
    );
    expect(preview.summary_source).toBe("llm");
    expect(preview.summary_stale).toBe(true);
    expect(preview.summary_stale_reasons).toEqual(["dirty"]);
  });

  it("keeps valid old-version llm enrichment and marks it stale", () => {
    const preview = buildSessionSummaryPreview({
      session_id: "session-1",
      target: "codex",
      status: "mixed",
      summary_text:
        "Mixed: 4 intents, 6/8 edits landed. Top files: src/hooks/session-context.ts.",
      summary_source: "deterministic",
      enriched_summary_text:
        "Implemented an older version of the recent-history context injection.",
      enrichment_source: "llm",
      enrichment_summary_version: 1,
    });

    expect(preview.summary).toBe(
      "Implemented an older version of the recent-history context injection.",
    );
    expect(preview.summary_source).toBe("llm");
    expect(preview.summary_stale).toBe(true);
    expect(preview.summary_stale_reasons).toEqual(["summary_version_changed"]);
  });

  it("does not reject legitimate no-code summaries", () => {
    expect(
      invalidSessionSummaryEnrichmentReason(
        "No code changed; the session reviewed the proposed design and settled on deterministic classification only.",
      ),
    ).toBeNull();
  });
});
