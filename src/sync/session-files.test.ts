import fs from "node:fs";
import path from "node:path";
import { gunzipSync } from "node:zlib";
import { afterAll, beforeEach, describe, expect, it, vi } from "vitest";

const testPaths = vi.hoisted(() => {
  const dataDir = `${process.env.TMPDIR ?? "/tmp"}/panopticon-session-file-sync-${process.pid}`;
  return {
    dataDir,
    dbPath: `${dataDir}/data.db`,
  };
});

vi.mock("../config.js", () => ({
  config: {
    dataDir: testPaths.dataDir,
    dbPath: testPaths.dbPath,
  },
  ensureDataDir: () => fs.mkdirSync(testPaths.dataDir, { recursive: true }),
}));

import { LocalArchiveBackend } from "../archive/local.js";
import { closeDb, getDb } from "../db/schema.js";
import type { postSessionFile } from "./post.js";
import { syncArchivedSessionFiles } from "./session-files.js";
import { resetWatermarks } from "./watermark.js";

type PostSessionFile = typeof postSessionFile;

function resetDb(): void {
  closeDb();
  fs.rmSync(testPaths.dataDir, { recursive: true, force: true });
  fs.mkdirSync(testPaths.dataDir, { recursive: true });
}

function confirmSessionForTarget(sessionId: string, target = "remote"): void {
  const db = getDb();
  db.prepare("INSERT OR IGNORE INTO sessions (session_id) VALUES (?)").run(
    sessionId,
  );
  db.prepare(
    `INSERT INTO target_session_sync (session_id, target, confirmed)
     VALUES (?, ?, 1)`,
  ).run(sessionId, target);
}

describe("syncArchivedSessionFiles", () => {
  beforeEach(resetDb);

  afterAll(() => {
    closeDb();
    fs.rmSync(testPaths.dataDir, { recursive: true, force: true });
  });

  it("multipart-uploads confirmed archived session files without storing content in the DB", async () => {
    const archive = new LocalArchiveBackend(
      path.join(testPaths.dataDir, "archive"),
    );
    archive.putSync("session-1", "claude", Buffer.from("raw transcript"));
    confirmSessionForTarget("session-1");

    const post = vi.fn<PostSessionFile>(async () => ({}));

    const hasMore = await syncArchivedSessionFiles(
      { name: "remote", url: "https://sync.example" },
      { Authorization: "Bearer test" },
      { archive, post, nowMs: () => 123 },
    );

    expect(hasMore).toBe(false);
    expect(post).toHaveBeenCalledTimes(1);
    const [url, metadata, content, headers] = post.mock.calls[0];
    expect(url).toBe("https://sync.example/v1/sync/session-file");
    expect(metadata).toMatchObject({
      sessionId: "session-1",
      source: "claude",
      fileName: "claude.jsonl.gz",
      contentEncoding: "gzip",
      contentType: "application/gzip",
      sizeBytes: content.length,
    });
    expect(metadata.contentHash).toMatch(/^[a-f0-9]{64}$/);
    expect(gunzipSync(content).toString("utf-8")).toBe("raw transcript");
    expect(headers).toEqual({ Authorization: "Bearer test" });
  });

  it("skips already-uploaded content hashes and uploads changed archive files", async () => {
    const archive = new LocalArchiveBackend(
      path.join(testPaths.dataDir, "archive"),
    );
    archive.putSync("session-1", "codex", Buffer.from("first transcript"));
    confirmSessionForTarget("session-1");

    const post = vi.fn<PostSessionFile>(async () => ({}));
    const target = { name: "remote", url: "https://sync.example" };

    await syncArchivedSessionFiles(target, {}, { archive, post });
    await syncArchivedSessionFiles(target, {}, { archive, post });
    expect(post).toHaveBeenCalledTimes(1);

    archive.putSync("session-1", "codex", Buffer.from("second transcript"));
    await syncArchivedSessionFiles(target, {}, { archive, post });

    expect(post).toHaveBeenCalledTimes(2);
    expect(gunzipSync(post.mock.calls[1][2]).toString("utf-8")).toBe(
      "second transcript",
    );

    const watermarkRows = getDb()
      .prepare(
        `SELECT key FROM watermarks
         WHERE key LIKE 'session-file-upload:remote:session-1:codex:%'
           AND instr(key, ':meta:') = 0
         ORDER BY key`,
      )
      .all() as Array<{ key: string }>;
    expect(watermarkRows).toHaveLength(1);
  });

  it("short-circuits unchanged archive files using metadata before reading content", async () => {
    const archive = new LocalArchiveBackend(
      path.join(testPaths.dataDir, "archive"),
    );
    archive.putSync("session-1", "codex", Buffer.from("raw transcript"));
    confirmSessionForTarget("session-1");

    const post = vi.fn<PostSessionFile>(async () => ({}));
    const target = { name: "remote", url: "https://sync.example" };

    await syncArchivedSessionFiles(target, {}, { archive, post });
    const readSpy = vi.spyOn(archive, "getStoredFileSync");
    await syncArchivedSessionFiles(target, {}, { archive, post });

    expect(post).toHaveBeenCalledTimes(1);
    expect(readSpy).not.toHaveBeenCalled();
  });

  it("continues uploading later files after one file upload fails", async () => {
    const archive = new LocalArchiveBackend(
      path.join(testPaths.dataDir, "archive"),
    );
    archive.putSync("session-1", "codex", Buffer.from("first transcript"));
    archive.putSync("session-2", "claude", Buffer.from("second transcript"));
    confirmSessionForTarget("session-1");
    confirmSessionForTarget("session-2");

    const post = vi
      .fn<PostSessionFile>()
      .mockRejectedValueOnce(new Error("first upload failed"))
      .mockResolvedValue({});

    await syncArchivedSessionFiles(
      { name: "remote", url: "https://sync.example" },
      {},
      { archive, post, limit: 10 },
    );

    expect(post).toHaveBeenCalledTimes(2);
    expect(post.mock.calls[0][1].sessionId).toBe("session-1");
    expect(post.mock.calls[1][1].sessionId).toBe("session-2");

    const uploadedSecond = getDb()
      .prepare(
        `SELECT COUNT(*) AS count FROM watermarks
         WHERE key LIKE 'session-file-upload:remote:session-2:claude:%'
           AND instr(key, ':meta:') = 0`,
      )
      .get() as { count: number };
    expect(uploadedSecond.count).toBe(1);
  });

  it("re-uploads archived session files after resetting the target watermarks", async () => {
    const archive = new LocalArchiveBackend(
      path.join(testPaths.dataDir, "archive"),
    );
    archive.putSync("session-1", "claude", Buffer.from("raw transcript"));
    confirmSessionForTarget("session-1");

    const post = vi.fn<PostSessionFile>(async () => ({}));
    const target = { name: "remote", url: "https://sync.example" };

    await syncArchivedSessionFiles(target, {}, { archive, post });
    resetWatermarks("remote");
    confirmSessionForTarget("session-1");
    await syncArchivedSessionFiles(target, {}, { archive, post });

    expect(post).toHaveBeenCalledTimes(2);
  });

  it("does not upload archives for sessions the target has not confirmed", async () => {
    const archive = new LocalArchiveBackend(
      path.join(testPaths.dataDir, "archive"),
    );
    archive.putSync("session-1", "gemini", Buffer.from("raw transcript"));

    const post = vi.fn<PostSessionFile>(async () => ({}));

    await syncArchivedSessionFiles(
      { name: "remote", url: "https://sync.example" },
      {},
      { archive, post },
    );

    expect(post).not.toHaveBeenCalled();
  });
});
