import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type {
  ArchiveBackend,
  ArchivedSessionFile,
  ArchivedSessionFileContent,
} from "./backend.js";

const ARCHIVE_CONTENT_TYPE = "application/gzip";
const ARCHIVE_CONTENT_ENCODING = "gzip";

export class LocalArchiveBackend implements ArchiveBackend {
  constructor(private baseDir: string) {}

  putSync(sessionId: string, source: string, content: Buffer): void {
    const dir = path.join(this.baseDir, sessionId);
    fs.mkdirSync(dir, { recursive: true });
    const filePath = path.join(dir, `${source}.jsonl.gz`);
    const compressed = gzipSync(content);
    fs.writeFileSync(filePath, compressed);
  }

  getSync(sessionId: string, source: string): Buffer | null {
    const filePath = path.join(this.baseDir, sessionId, `${source}.jsonl.gz`);
    if (!fs.existsSync(filePath)) return null;
    const compressed = fs.readFileSync(filePath);
    return gunzipSync(compressed);
  }

  getStoredFileSync(
    sessionId: string,
    source: string,
  ): ArchivedSessionFileContent | null {
    const fileName = `${source}.jsonl.gz`;
    const filePath = path.join(this.baseDir, sessionId, fileName);
    if (!fs.existsSync(filePath)) return null;
    const content = fs.readFileSync(filePath);
    return {
      sessionId,
      source,
      sizeBytes: content.length,
      fileName,
      contentType: ARCHIVE_CONTENT_TYPE,
      contentEncoding: ARCHIVE_CONTENT_ENCODING,
      content,
    };
  }

  hasSync(sessionId: string, source: string): boolean {
    const filePath = path.join(this.baseDir, sessionId, `${source}.jsonl.gz`);
    return fs.existsSync(filePath);
  }

  list(): ArchivedSessionFile[] {
    const results: ArchivedSessionFile[] = [];

    if (!fs.existsSync(this.baseDir)) return results;

    for (const sessionId of fs.readdirSync(this.baseDir)) {
      const sessionDir = path.join(this.baseDir, sessionId);
      const stat = fs.statSync(sessionDir);
      if (!stat.isDirectory()) continue;

      for (const file of fs.readdirSync(sessionDir)) {
        if (!file.endsWith(".jsonl.gz")) continue;
        const source = file.replace(/\.jsonl\.gz$/, "");
        const fileStat = fs.statSync(path.join(sessionDir, file));
        results.push({
          sessionId,
          source,
          sizeBytes: fileStat.size,
          mtimeMs: Math.floor(fileStat.mtimeMs),
          fileName: file,
          contentType: ARCHIVE_CONTENT_TYPE,
          contentEncoding: ARCHIVE_CONTENT_ENCODING,
        });
      }
    }

    return results;
  }

  stats(): { totalFiles: number; totalBytes: number } {
    const entries = this.list();
    return {
      totalFiles: entries.length,
      totalBytes: entries.reduce((sum, e) => sum + e.sizeBytes, 0),
    };
  }
}
