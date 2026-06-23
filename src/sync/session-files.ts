import { createHash } from "node:crypto";
import type { ArchiveBackend } from "../archive/index.js";
import { getArchiveBackend } from "../archive/index.js";
import { getDb } from "../db/schema.js";
import { log } from "../log.js";
import type { SessionFileUploadMetadata } from "./post.js";
import { postSessionFile } from "./post.js";
import type { SyncTarget } from "./types.js";
import { readWatermark, writeWatermark } from "./watermark.js";

const DEFAULT_SESSION_FILE_UPLOAD_LIMIT = 10;

export interface SessionFileSyncOptions {
  archive?: ArchiveBackend;
  limit?: number;
  nowMs?: () => number;
  post?: typeof postSessionFile;
}

function sha256Hex(content: Buffer): string {
  return createHash("sha256").update(content).digest("hex");
}

function sessionFileUploadWatermarkKey(
  targetName: string,
  sessionId: string,
  source: string,
  contentHash: string,
): string {
  return `session-file-upload:${targetName}:${sessionId}:${source}:${contentHash}`;
}

function sessionFileUploadWatermarkPrefix(
  targetName: string,
  sessionId: string,
  source: string,
): string {
  return `session-file-upload:${targetName}:${sessionId}:${source}:`;
}

function sessionFileUploadMetadataWatermarkKey(
  targetName: string,
  sessionId: string,
  source: string,
  field: "mtimeMs" | "sizeBytes",
): string {
  return `${sessionFileUploadWatermarkPrefix(targetName, sessionId, source)}meta:${field}`;
}

function hasContentHashWatermark(
  targetName: string,
  sessionId: string,
  source: string,
): boolean {
  const prefix = sessionFileUploadWatermarkPrefix(
    targetName,
    sessionId,
    source,
  );
  const row = getDb()
    .prepare(
      `SELECT 1
       FROM watermarks
       WHERE substr(key, 1, ?) = ?
         AND instr(key, ':meta:') = 0
       LIMIT 1`,
    )
    .get(prefix.length, prefix);
  return Boolean(row);
}

function hasCurrentMetadataWatermarks(
  targetName: string,
  entry: {
    sessionId: string;
    source: string;
    sizeBytes: number;
    mtimeMs?: number;
  },
): boolean {
  if (entry.mtimeMs === undefined) return false;
  if (!hasContentHashWatermark(targetName, entry.sessionId, entry.source)) {
    return false;
  }
  return (
    readWatermark(
      sessionFileUploadMetadataWatermarkKey(
        targetName,
        entry.sessionId,
        entry.source,
        "sizeBytes",
      ),
    ) === entry.sizeBytes &&
    readWatermark(
      sessionFileUploadMetadataWatermarkKey(
        targetName,
        entry.sessionId,
        entry.source,
        "mtimeMs",
      ),
    ) === Math.floor(entry.mtimeMs)
  );
}

function writeSessionFileUploadMetadataWatermarks(
  targetName: string,
  entry: {
    sessionId: string;
    source: string;
    sizeBytes: number;
    mtimeMs?: number;
  },
): void {
  if (entry.mtimeMs === undefined) return;
  writeWatermark(
    sessionFileUploadMetadataWatermarkKey(
      targetName,
      entry.sessionId,
      entry.source,
      "sizeBytes",
    ),
    entry.sizeBytes,
  );
  writeWatermark(
    sessionFileUploadMetadataWatermarkKey(
      targetName,
      entry.sessionId,
      entry.source,
      "mtimeMs",
    ),
    Math.floor(entry.mtimeMs),
  );
}

function pruneOldContentHashWatermarks(
  targetName: string,
  sessionId: string,
  source: string,
  currentKey: string,
): void {
  const prefix = sessionFileUploadWatermarkPrefix(
    targetName,
    sessionId,
    source,
  );
  getDb()
    .prepare(
      `DELETE FROM watermarks
       WHERE substr(key, 1, ?) = ?
         AND instr(key, ':meta:') = 0
         AND key <> ?`,
    )
    .run(prefix.length, prefix, currentKey);
}

function isConfirmedForTarget(sessionId: string, targetName: string): boolean {
  const row = getDb()
    .prepare(
      `SELECT 1
       FROM target_session_sync
       WHERE session_id = ?
         AND target = ?
         AND confirmed = 1`,
    )
    .get(sessionId, targetName);
  return Boolean(row);
}

export async function syncArchivedSessionFiles(
  target: SyncTarget,
  headers: Record<string, string>,
  opts: SessionFileSyncOptions = {},
): Promise<boolean> {
  const archive = opts.archive ?? getArchiveBackend();
  const limit = opts.limit ?? DEFAULT_SESSION_FILE_UPLOAD_LIMIT;
  const nowMs = opts.nowMs ?? Date.now;
  const post = opts.post ?? postSessionFile;
  const uploadUrl = `${target.url}/v1/sync/session-file`;
  let attempted = 0;

  const entries = archive.list().sort((a, b) => {
    const sessionCmp = a.sessionId.localeCompare(b.sessionId);
    return sessionCmp !== 0 ? sessionCmp : a.source.localeCompare(b.source);
  });

  for (const entry of entries) {
    if (attempted >= limit) return true;
    if (!isConfirmedForTarget(entry.sessionId, target.name)) continue;
    if (hasCurrentMetadataWatermarks(target.name, entry)) continue;

    const storedFile = archive.getStoredFileSync(entry.sessionId, entry.source);
    if (!storedFile) continue;

    const contentHash = sha256Hex(storedFile.content);
    const watermarkKey = sessionFileUploadWatermarkKey(
      target.name,
      entry.sessionId,
      entry.source,
      contentHash,
    );
    if (readWatermark(watermarkKey) > 0) {
      writeSessionFileUploadMetadataWatermarks(target.name, entry);
      continue;
    }

    const metadata: SessionFileUploadMetadata = {
      sessionId: entry.sessionId,
      source: entry.source,
      fileName: storedFile.fileName,
      contentType: storedFile.contentType,
      contentEncoding: storedFile.contentEncoding,
      sizeBytes: storedFile.content.length,
      contentHash,
    };

    attempted += 1;
    try {
      await post(uploadUrl, metadata, storedFile.content, headers);
      pruneOldContentHashWatermarks(
        target.name,
        entry.sessionId,
        entry.source,
        watermarkKey,
      );
      writeWatermark(watermarkKey, nowMs());
      writeSessionFileUploadMetadataWatermarks(target.name, entry);
    } catch (err) {
      log.sync.warn(
        `session-file-upload: failed ${entry.sessionId}/${entry.source} to ${target.name}: ${err instanceof Error ? err.message : err}`,
      );
    }
  }

  return false;
}
