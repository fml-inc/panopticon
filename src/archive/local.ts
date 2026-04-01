import fs from "node:fs";
import path from "node:path";
import { gunzipSync, gzipSync } from "node:zlib";
import type { ArchiveBackend } from "./backend.js";

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

  hasSync(sessionId: string, source: string): boolean {
    const filePath = path.join(this.baseDir, sessionId, `${source}.jsonl.gz`);
    return fs.existsSync(filePath);
  }

  list(): Array<{ sessionId: string; source: string; sizeBytes: number }> {
    const results: Array<{
      sessionId: string;
      source: string;
      sizeBytes: number;
    }> = [];

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
