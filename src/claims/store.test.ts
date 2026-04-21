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
import { runIntegrityCheck } from "./integrity.js";
import { assertClaim } from "./store.js";

beforeAll(() => {
  getDb();
});

afterAll(() => {
  closeDb();
});

beforeEach(() => {
  const db = getDb();
  db.prepare("DELETE FROM claim_evidence").run();
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
      asserterVersion: "1",
      evidence: [{ key: "hook_event:hook-sync-1", role: "origin" as const }],
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
      asserterVersion: "1",
      evidence: [{ key: "hook_event:hook-sync-1", role: "origin" }],
    });
    assertClaim({
      predicate: "intent/prompt-ts-ms",
      subjectKind: "intent",
      subject: "intent:test",
      value: 999,
      observedAtMs: 999,
      sourceType: "scanner",
      asserter: "test",
      asserterVersion: "1",
      evidence: [{ key: "msg:msg-sync-1", role: "origin" }],
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
      asserterVersion: "1",
      evidence: [{ key: "fs_snapshot:/tmp/file:a", role: "origin" }],
    });
    assertClaim({
      predicate: "edit/landed-status",
      subjectKind: "edit",
      subject: "edit:test",
      value: "landed",
      observedAtMs: 2000,
      sourceType: "git_disk",
      asserter: "test",
      asserterVersion: "1",
      evidence: [{ key: "fs_snapshot:/tmp/file:b", role: "origin" }],
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

  it("materializes canonical evidence_refs for legacy evidence keys", () => {
    const result = assertClaim({
      predicate: "edit/landed-status",
      subjectKind: "edit",
      subject: "edit:test",
      value: "landed",
      observedAtMs: 1000,
      sourceType: "git_disk",
      asserter: "test",
      asserterVersion: "1",
      evidence: [{ key: "fs_snapshot:/tmp/file.txt:abc123", role: "origin" }],
    });

    const db = getDb();
    const cols = db
      .prepare("PRAGMA table_info(claim_evidence)")
      .all() as Array<{ name: string }>;
    const row = db
      .prepare(
        `SELECT ce.evidence_ref_id, er.ref_key, er.kind, er.file_path
         FROM claim_evidence ce
         JOIN evidence_refs er ON er.id = ce.evidence_ref_id
         WHERE ce.claim_id = ?`,
      )
      .get(result.claimId) as {
      evidence_ref_id: number;
      ref_key: string;
      kind: string;
      file_path: string | null;
    };

    expect(cols.map((col) => col.name)).not.toContain("evidence_key");
    expect(row.evidence_ref_id).toBeGreaterThan(0);
    expect(row.ref_key).toBe("file_snapshot:/tmp/file.txt:abc123");
    expect(row.kind).toBe("file_snapshot");
    expect(row.file_path).toBe("/tmp/file.txt");
  });

  it("canonicalizes legacy and typed evidence keys to the same observation", () => {
    const first = assertClaim({
      predicate: "edit/landed-status",
      subjectKind: "edit",
      subject: "edit:test",
      value: "landed",
      observedAtMs: 1000,
      sourceType: "git_disk",
      asserter: "test",
      asserterVersion: "1",
      evidence: [{ key: "fs_snapshot:/tmp/file.txt:abc123", role: "origin" }],
    });
    const second = assertClaim({
      predicate: "edit/landed-status",
      subjectKind: "edit",
      subject: "edit:test",
      value: "landed",
      observedAtMs: 1000,
      sourceType: "git_disk",
      asserter: "test",
      asserterVersion: "1",
      evidence: [{ key: "file_snapshot:/tmp/file.txt:abc123", role: "origin" }],
    });

    expect(first.inserted).toBe(true);
    expect(second.inserted).toBe(false);
    expect(second.claimId).toBe(first.claimId);
    expect(runIntegrityCheck()).toEqual({
      total: 1,
      dangling: 0,
      examples: [],
    });
  });
});
