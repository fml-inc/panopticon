import { createHash } from "node:crypto";
import type { ArchiveBackend } from "../archive/index.js";
import { getArchiveBackend } from "../archive/index.js";
import { getDb } from "../db/schema.js";
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
  let uploaded = 0;

  const entries = archive.list().sort((a, b) => {
    const sessionCmp = a.sessionId.localeCompare(b.sessionId);
    return sessionCmp !== 0 ? sessionCmp : a.source.localeCompare(b.source);
  });

  for (const entry of entries) {
    if (uploaded >= limit) return true;
    if (!isConfirmedForTarget(entry.sessionId, target.name)) continue;

    const storedFile = archive.getStoredFileSync(entry.sessionId, entry.source);
    if (!storedFile) continue;

    const contentHash = sha256Hex(storedFile.content);
    const watermarkKey = sessionFileUploadWatermarkKey(
      target.name,
      entry.sessionId,
      entry.source,
      contentHash,
    );
    if (readWatermark(watermarkKey) > 0) continue;

    const metadata: SessionFileUploadMetadata = {
      sessionId: entry.sessionId,
      source: entry.source,
      fileName: storedFile.fileName,
      contentType: storedFile.contentType,
      contentEncoding: storedFile.contentEncoding,
      sizeBytes: storedFile.content.length,
      contentHash,
    };

    await post(uploadUrl, metadata, storedFile.content, headers);
    writeWatermark(watermarkKey, nowMs());
    uploaded += 1;
  }

  return false;
}
