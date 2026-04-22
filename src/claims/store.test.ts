import {
  afterAll,
  beforeAll,
  beforeEach,
  describe,
  expect,
  it,
  vi,
} from "vitest";

vi.mock("../config.js", () => {
  const _os = require("node:os");
  const _path = require("node:path");
  const _fs = require("node:fs");
  const tmpDir = _path.join(_os.tmpdir(), "pano-claims-test");
  _fs.mkdirSync(tmpDir, { recursive: true });
  return {
    config: {
      dataDir: tmpDir,
      dbPath: _path.join(tmpDir, "panopticon.db"),
      port: 4318,
      host: "127.0.0.1",
      serverPidFile: _path.join(tmpDir, "panopticon.pid"),
    },
    ensureDataDir: () => _fs.mkdirSync(tmpDir, { recursive: true }),
  };
});

import { closeDb, getDb } from "../db/schema.js";
import {
  fileSnapshotEvidenceRef,
  hookEventEvidenceRef,
  messageEvidenceRef,
  toolCallEvidenceRef,
} from "./evidence-refs.js";
import { runIntegrityCheck } from "./integrity.js";
import {
  assertClaim,
  deleteClaimsByAsserter,
  deleteClaimsByAsserterForSession,
} from "./store.js";

beforeAll(() => {
  getDb();
});

afterAll(() => {
  closeDb();
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM claim_evidence").run();
  db.prepare("DELETE FROM evidence_ref_paths").run();
  db.prepare("DELETE FROM evidence_refs").run();
  db.prepare("DELETE FROM active_claims").run();
  db.prepare("DELETE FROM claims").run();
});

describe("assertClaim", () => {
  it("deduplicates identical observations and evidence", () => {
    const input = {
      predicate: "intent/prompt-text" as const,
      subjectKind: "intent" as const,
      subject: "intent:test",
      value: "add retries",
      observedAtMs: 1000,
      sourceType: "hook" as const,
      asserter: "test",
      asserterVersion: 1,
      evidence: [
        {
          ref: hookEventEvidenceRef({
            sessionId: "session-hook",
            syncId: "hook-sync-1",
            eventType: "UserPromptSubmit",
            timestampMs: 1000,
          }),
          role: "origin" as const,
        },
      ],
    };

    const first = assertClaim(input);
    const second = assertClaim(input);
    const db = getDb();
    const claimCount = (
      db.prepare("SELECT COUNT(*) AS c FROM claims").get() as { c: number }
    ).c;
    const evidenceCount = (
      db.prepare("SELECT COUNT(*) AS c FROM claim_evidence").get() as {
        c: number;
      }
    ).c;

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.claimId).toBe(first.claimId);
    expect(claimCount).toBe(1);
    expect(evidenceCount).toBe(1);
  });

  it("keeps the higher-ranked hook timestamp active over scanner fallback", () => {
    assertClaim({
      predicate: "intent/prompt-ts-ms",
      subjectKind: "intent",
      subject: "intent:test",
      value: 1000,
      observedAtMs: 1000,
      sourceType: "hook",
      asserter: "test",
      asserterVersion: 1,
      evidence: [
        {
          ref: hookEventEvidenceRef({
            sessionId: "session-hook",
            syncId: "hook-sync-1",
            eventType: "UserPromptSubmit",
            timestampMs: 1000,
          }),
          role: "origin",
        },
      ],
    });
    assertClaim({
      predicate: "intent/prompt-ts-ms",
      subjectKind: "intent",
      subject: "intent:test",
      value: 999,
      observedAtMs: 999,
      sourceType: "scanner",
      asserter: "test",
      asserterVersion: 1,
      evidence: [
        {
          ref: messageEvidenceRef({
            sessionId: "session-msg",
            syncId: "msg-sync-1",
            ordinal: 3,
          }),
          role: "origin",
        },
      ],
    });

    const db = getDb();
    const active = db
      .prepare(
        `SELECT c.value_num, c.source_type
         FROM active_claims ac
         JOIN claims c ON c.id = ac.claim_id
         WHERE ac.head_key = ?`,
      )
      .get("intent/prompt-ts-ms:intent:test") as {
      value_num: number;
      source_type: string;
    };

    expect(active).toEqual({ value_num: 1000, source_type: "hook" });
  });

  it("keeps later timeline facts active for landed status", () => {
    assertClaim({
      predicate: "edit/landed-status",
      subjectKind: "edit",
      subject: "edit:test",
      value: "churned",
      observedAtMs: 1000,
      sourceType: "git_disk",
      asserter: "test",
      asserterVersion: 1,
      evidence: [
        {
          ref: fileSnapshotEvidenceRef({
            filePath: "/tmp/file",
            content: "a",
          }),
          role: "origin",
        },
      ],
    });
    assertClaim({
      predicate: "edit/landed-status",
      subjectKind: "edit",
      subject: "edit:test",
      value: "landed",
      observedAtMs: 2000,
      sourceType: "git_disk",
      asserter: "test",
      asserterVersion: 1,
      evidence: [
        {
          ref: fileSnapshotEvidenceRef({
            filePath: "/tmp/file",
            content: "b",
          }),
          role: "origin",
        },
      ],
    });

    const db = getDb();
    const active = db
      .prepare(
        `SELECT c.value_text, c.observed_at_ms
         FROM active_claims ac
         JOIN claims c ON c.id = ac.claim_id
         WHERE ac.head_key = ?`,
      )
      .get("edit/landed-status:edit:test") as {
      value_text: string;
      observed_at_ms: number;
    };

    expect(active).toEqual({
      value_text: "landed",
      observed_at_ms: 2000,
    });
  });

  it("stores session_id for sync-backed evidence refs", () => {
    const result = assertClaim({
      predicate: "intent/prompt-text",
      subjectKind: "intent",
      subject: "intent:test",
      value: "add retries",
      observedAtMs: 1000,
      sourceType: "hook",
      asserter: "test",
      asserterVersion: 1,
      evidence: [
        {
          ref: hookEventEvidenceRef({
            sessionId: "session-hook",
            syncId: "hook-sync-1",
            eventType: "UserPromptSubmit",
            timestampMs: 1000,
          }),
          role: "origin",
        },
      ],
    });

    const db = getDb();
    const row = db
      .prepare(
        `SELECT ce.evidence_ref_id, er.ref_key, er.kind, er.session_id, er.sync_id
         FROM claim_evidence ce
         JOIN evidence_refs er ON er.id = ce.evidence_ref_id
         WHERE ce.claim_id = ?`,
      )
      .get(result.claimId) as {
      evidence_ref_id: number;
      ref_key: string;
      kind: string;
      session_id: string | null;
      sync_id: string | null;
    };

    expect(row.evidence_ref_id).toBeGreaterThan(0);
    expect(row.ref_key).toBe("hook_event:hook-sync-1");
    expect(row.kind).toBe("hook_event");
    expect(row.session_id).toBe("session-hook");
    expect(row.sync_id).toBe("hook-sync-1");
  });

  it("stores canonical file snapshot refs without a session binding", () => {
    const first = assertClaim({
      predicate: "edit/landed-status",
      subjectKind: "edit",
      subject: "edit:test",
      value: "landed",
      observedAtMs: 1000,
      sourceType: "git_disk",
      asserter: "test",
      asserterVersion: 1,
      evidence: [
        {
          ref: fileSnapshotEvidenceRef({
            filePath: "/tmp/file.txt",
            content: "abc123",
          }),
          role: "origin",
        },
      ],
    });

    const db = getDb();
    const cols = db
      .prepare("PRAGMA table_info(claim_evidence)")
      .all() as Array<{ name: string }>;
    const row = db
      .prepare(
        `SELECT ce.evidence_ref_id, er.ref_key, er.kind, er.file_path, er.session_id
         FROM claim_evidence ce
         JOIN evidence_refs er ON er.id = ce.evidence_ref_id
         WHERE ce.claim_id = ?`,
      )
      .get(first.claimId) as {
      evidence_ref_id: number;
      ref_key: string;
      kind: string;
      file_path: string | null;
      session_id: string | null;
    };

    expect(first.inserted).toBe(true);
    expect(cols.map((col) => col.name)).not.toContain("evidence_key");
    expect(row.evidence_ref_id).toBeGreaterThan(0);
    expect(row.ref_key).toBe(
      fileSnapshotEvidenceRef({
        filePath: "/tmp/file.txt",
        content: "abc123",
      }).refKey,
    );
    expect(row.kind).toBe("file_snapshot");
    expect(row.file_path).toBe("/tmp/file.txt");
    expect(row.session_id).toBeNull();
    expect(runIntegrityCheck()).toEqual({
      total: 1,
      dangling: 0,
      examples: [],
    });
  });

  it("stores normalized path rows for multi-file evidence refs", () => {
    const result = assertClaim({
      predicate: "edit/tool-name",
      subjectKind: "edit",
      subject: "edit:test",
      value: "apply_patch",
      observedAtMs: 1000,
      sourceType: "scanner",
      asserter: "test",
      asserterVersion: 1,
      evidence: [
        {
          ref: toolCallEvidenceRef({
            sessionId: "session-tool",
            syncId: "tool-sync-1",
            toolName: "apply_patch",
            repository: "/tmp/repo",
            filePaths: ["/tmp/b.ts", "/tmp/a.ts", "/tmp/b.ts"],
          }),
          role: "origin",
        },
      ],
    });

    const db = getDb();
    const refRow = db
      .prepare(
        `SELECT ce.evidence_ref_id, er.file_path, er.repository
         FROM claim_evidence ce
         JOIN evidence_refs er ON er.id = ce.evidence_ref_id
         WHERE ce.claim_id = ?`,
      )
      .get(result.claimId) as {
      evidence_ref_id: number;
      file_path: string | null;
      repository: string | null;
    };
    const pathRows = db
      .prepare(
        `SELECT file_path
         FROM evidence_ref_paths
         WHERE evidence_ref_id = ?
         ORDER BY file_path ASC`,
      )
      .all(refRow.evidence_ref_id) as Array<{ file_path: string }>;

    expect(refRow.file_path).toBeNull();
    expect(refRow.repository).toBe("/tmp/repo");
    expect(pathRows).toEqual([
      { file_path: "/tmp/a.ts" },
      { file_path: "/tmp/b.ts" },
    ]);
  });

  it("deletes repository and file subject claims when rebuilding one session", () => {
    assertClaim({
      predicate: "repository/name",
      subjectKind: "repository",
      subject: "repository:/tmp/repo-a",
      value: "/tmp/repo-a",
      observedAtMs: 1000,
      sourceType: "scanner",
      asserter: "test",
      asserterVersion: 1,
      evidence: [
        {
          ref: messageEvidenceRef({
            sessionId: "session-a",
            syncId: "msg-sync-a",
            ordinal: 1,
          }),
          role: "origin",
        },
      ],
    });
    assertClaim({
      predicate: "file/path",
      subjectKind: "file",
      subject: "file:/tmp/repo-a:/tmp/repo-a/src/a.ts",
      value: "/tmp/repo-a/src/a.ts",
      observedAtMs: 1000,
      sourceType: "scanner",
      asserter: "test",
      asserterVersion: 1,
      evidence: [
        {
          ref: toolCallEvidenceRef({
            sessionId: "session-a",
            syncId: "tool-sync-a",
            toolName: "Edit",
            filePaths: ["/tmp/repo-a/src/a.ts"],
          }),
          role: "origin",
        },
      ],
    });
    assertClaim({
      predicate: "repository/name",
      subjectKind: "repository",
      subject: "repository:/tmp/repo-b",
      value: "/tmp/repo-b",
      observedAtMs: 1000,
      sourceType: "scanner",
      asserter: "test",
      asserterVersion: 1,
      evidence: [
        {
          ref: messageEvidenceRef({
            sessionId: "session-b",
            syncId: "msg-sync-b",
            ordinal: 1,
          }),
          role: "origin",
        },
      ],
    });

    const deleted = deleteClaimsByAsserterForSession("test", "session-a");
    const db = getDb();
    const remaining = db
      .prepare(
        `SELECT predicate, subject_kind, subject
         FROM claims
         ORDER BY predicate ASC, subject ASC`,
      )
      .all() as Array<{
      predicate: string;
      subject_kind: string;
      subject: string;
    }>;

    expect(deleted).toBe(2);
    expect(remaining).toEqual([
      {
        predicate: "repository/name",
        subject_kind: "repository",
        subject: "repository:/tmp/repo-b",
      },
    ]);
  });

  it("deletes large session subject sets without variadic subject filters", () => {
    const db = getDb();
    const count = 35_000;
    const sharedHeadKey = "intent/session|shared-head";
    const insert = db.prepare(
      `INSERT INTO claims
       (observation_key, head_key, predicate, subject_kind, subject,
        value_kind, value_text, value_num, value_json,
        source_type, source_rank, confidence, observed_at_ms, asserted_at_ms,
        asserter, asserter_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const seed = db.transaction(() => {
      for (let i = 0; i < count; i++) {
        insert.run(
          `obs-session-${i}`,
          sharedHeadKey,
          "intent/session",
          "intent",
          `intent:${i}`,
          "text",
          "session-a",
          null,
          null,
          "scanner",
          1,
          1,
          1_000 + i,
          2_000 + i,
          "bulk-test",
          1,
        );
      }
      insert.run(
        "obs-other",
        "repository/name|shared-head",
        "repository/name",
        "repository",
        "repository:/tmp/repo-b",
        "text",
        "/tmp/repo-b",
        null,
        null,
        "scanner",
        1,
        1,
        9_999,
        9_999,
        "bulk-test",
        1,
      );
    });
    seed();

    const deleted = deleteClaimsByAsserterForSession("bulk-test", "session-a");
    const remaining = db
      .prepare(
        `SELECT observation_key FROM claims ORDER BY observation_key ASC`,
      )
      .all() as Array<{ observation_key: string }>;

    expect(deleted).toBe(count);
    expect(remaining).toEqual([{ observation_key: "obs-other" }]);
  });

  it("reselects the remaining active repository claim when sessions share a head", () => {
    assertClaim({
      predicate: "repository/name",
      subjectKind: "repository",
      subject: "repository:/tmp/repo-a",
      value: "/tmp/repo-a",
      observedAtMs: 1000,
      sourceType: "scanner",
      asserter: "test",
      asserterVersion: 1,
      evidence: [
        {
          ref: messageEvidenceRef({
            sessionId: "session-a",
            syncId: "msg-sync-a",
            ordinal: 1,
          }),
          role: "origin",
        },
      ],
    });
    assertClaim({
      predicate: "repository/name",
      subjectKind: "repository",
      subject: "repository:/tmp/repo-a",
      value: "/tmp/repo-a",
      observedAtMs: 2000,
      sourceType: "scanner",
      asserter: "test",
      asserterVersion: 1,
      evidence: [
        {
          ref: messageEvidenceRef({
            sessionId: "session-b",
            syncId: "msg-sync-b",
            ordinal: 1,
          }),
          role: "origin",
        },
      ],
    });

    const deleted = deleteClaimsByAsserterForSession("test", "session-b");
    const db = getDb();
    const remainingClaims = db
      .prepare(
        `SELECT observed_at_ms
         FROM claims
         WHERE predicate = 'repository/name'
           AND subject = 'repository:/tmp/repo-a'
         ORDER BY observed_at_ms ASC`,
      )
      .all() as Array<{ observed_at_ms: number }>;
    const active = db
      .prepare(
        `SELECT c.observed_at_ms
         FROM active_claims ac
         JOIN claims c ON c.id = ac.claim_id
         WHERE c.predicate = 'repository/name'
           AND c.subject = 'repository:/tmp/repo-a'`,
      )
      .get() as {
      observed_at_ms: number;
    };

    expect(deleted).toBe(1);
    expect(remainingClaims).toEqual([{ observed_at_ms: 1000 }]);
    expect(active).toEqual({ observed_at_ms: 1000 });
  });
});

describe("deleteClaimsByAsserter", () => {
  it("deletes large claim sets in batches without overflowing the stack", () => {
    const db = getDb();
    const count = 70_000;
    const headKey = "intent/prompt-text|intent:test|text|shared";
    const insert = db.prepare(
      `INSERT INTO claims
       (observation_key, head_key, predicate, subject_kind, subject,
        value_kind, value_text, value_num, value_json,
        source_type, source_rank, confidence, observed_at_ms, asserted_at_ms,
        asserter, asserter_version)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const seed = db.transaction(() => {
      for (let i = 0; i < count; i++) {
        insert.run(
          `obs-${i}`,
          headKey,
          "intent/prompt-text",
          "intent",
          "intent:test",
          "text",
          `prompt ${i}`,
          null,
          null,
          "scanner",
          1,
          1,
          1_000 + i,
          2_000 + i,
          "bulk-test",
          1,
        );
      }
    });
    seed();

    const activeClaim = db
      .prepare(`SELECT id FROM claims WHERE observation_key = ?`)
      .get("obs-0") as { id: number };
    db.prepare(
      `INSERT INTO active_claims (head_key, claim_id, selected_at_ms, selection_reason)
       VALUES (?, ?, ?, ?)`,
    ).run(headKey, activeClaim.id, Date.now(), "test");

    const deleted = deleteClaimsByAsserter("bulk-test");
    const remainingClaims = db
      .prepare(`SELECT COUNT(*) AS c FROM claims WHERE asserter = ?`)
      .get("bulk-test") as { c: number };
    const remainingActive = db
      .prepare(`SELECT COUNT(*) AS c FROM active_claims WHERE head_key = ?`)
      .get(headKey) as { c: number };

    expect(deleted).toBe(count);
    expect(remainingClaims.c).toBe(0);
    expect(remainingActive.c).toBe(0);
  });
});
