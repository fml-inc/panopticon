import fs from "node:fs";
import { getDb } from "../db/schema.js";
// Import targets so they self-register before we iterate the registry
import "../targets/claude.js";
import "../targets/codex.js";
import "../targets/gemini.js";
import { getArchiveBackend } from "../archive/index.js";
import { generateSummariesOnce } from "../summary/index.js";
import { allTargets } from "../targets/registry.js";
import type { ScannerParseResult } from "../targets/types.js";
import {
  getTurnCount,
  getTurnsWithoutSummary,
  insertScannerEvents,
  insertTurns,
  readArchivedSize,
  readFileWatermark,
  updateSessionTotals,
  updateTurnSummary,
  upsertSession,
  writeArchivedSize,
  writeFileWatermark,
} from "./store.js";
import { summarizeTurn } from "./summarize.js";
import type { ScannerHandle, ScannerOptions } from "./types.js";

const DEFAULT_IDLE_MS = 60_000;
const DEFAULT_CATCHUP_MS = 5_000;

export function scanOnce(log: (msg: string) => void = () => {}): {
  filesScanned: number;
  newTurns: number;
} {
  getDb(); // ensure DB is accessible

  let filesScanned = 0;
  let newTurns = 0;

  for (const target of allTargets()) {
    if (!target.scanner) continue;
    const source = target.id;

    for (const { filePath } of target.scanner.discover()) {
      const offset = readFileWatermark(filePath);
      const result = target.scanner.parseFile(filePath, offset);
      if (!result) continue;

      filesScanned++;

      // When reading from byte 0 (full file), turn indices start at 0 so
      // INSERT OR IGNORE deduplicates. When incremental (offset > 0),
      // re-index from existing turn count — unless the parser produces
      // absolute indices (e.g. Gemini re-reads the full JSON file).
      if (offset > 0 && result.meta?.sessionId && !result.absoluteIndices) {
        const existingCount = getTurnCount(result.meta.sessionId, source);
        if (existingCount > 0) {
          reindexTurns(result, existingCount);
        }
      }

      if (!result.meta?.sessionId) {
        writeFileWatermark(filePath, result.newByteOffset);
        continue;
      }

      upsertSession(result.meta, filePath, source);

      if (result.turns.length > 0) {
        insertTurns(result.turns, source);
        newTurns += result.turns.length;
        updateSessionTotals(result.meta.sessionId);
      }

      if (result.events.length > 0) {
        insertScannerEvents(result.events, source);
      }

      writeFileWatermark(filePath, result.newByteOffset);

      // Archive raw file for 100% recall
      try {
        const fileSize = fs.statSync(filePath).size;
        const archivedSize = readArchivedSize(filePath);
        if (fileSize > archivedSize) {
          const rawContent = fs.readFileSync(filePath);
          getArchiveBackend().putSync(
            result.meta.sessionId,
            source,
            rawContent,
          );
          writeArchivedSize(filePath, fileSize);
        }
      } catch (archiveErr) {
        // Archive failure is non-fatal
        log(
          `Archive error for ${filePath}: ${archiveErr instanceof Error ? archiveErr.message : archiveErr}`,
        );
      }

      // Generate deterministic summaries for new turns
      if (result.turns.length > 0) {
        try {
          const unsummarized = getTurnsWithoutSummary(
            result.meta.sessionId,
            source,
            100,
          );
          for (const turn of unsummarized) {
            const { summary } = summarizeTurn({
              role: turn.role,
              contentPreview: turn.content_preview,
            });
            updateTurnSummary(turn.id, summary);
          }
        } catch (summaryErr) {
          log(
            `Summary error: ${summaryErr instanceof Error ? summaryErr.message : summaryErr}`,
          );
        }
      }
    }
  }

  if (filesScanned > 0) {
    log(`Scanned ${filesScanned} files, ${newTurns} new turns`);
  }

  // Generate session summaries for sessions with enough new turns
  if (newTurns > 0) {
    try {
      generateSummariesOnce(log);
    } catch (err) {
      log(`Session summary error: ${err instanceof Error ? err.message : err}`);
    }
  }

  return { filesScanned, newTurns };
}

function reindexTurns(result: ScannerParseResult, startIndex: number): void {
  for (let i = 0; i < result.turns.length; i++) {
    result.turns[i].turnIndex = startIndex + i;
  }
}

export function createScannerLoop(opts: ScannerOptions): ScannerHandle {
  const idleMs = opts.idleIntervalMs ?? DEFAULT_IDLE_MS;
  const catchUpMs = opts.catchUpIntervalMs ?? DEFAULT_CATCHUP_MS;
  const log =
    opts.log ?? ((msg: string) => console.error(`[panopticon-scanner] ${msg}`));

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;

  function scheduleNext(hadWork: boolean): void {
    if (stopping) return;
    const delay = hadWork ? catchUpMs : idleMs;
    timer = setTimeout(() => tick(), delay);
    if (!opts.keepAlive && timer.unref) {
      timer.unref();
    }
  }

  function tick(): void {
    if (stopping) return;
    let hadWork = false;
    try {
      const { newTurns } = scanOnce(log);
      hadWork = newTurns > 0;
    } catch (err) {
      log(`Scan error: ${err instanceof Error ? err.message : err}`);
    }
    if (!stopping) {
      scheduleNext(hadWork);
    }
  }

  return {
    start() {
      if (timer) return;
      stopping = false;
      log("Starting scanner");
      tick();
    },
    stop() {
      stopping = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
        log("Stopped scanner");
      }
    },
  };
}
