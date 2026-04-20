import fs from "node:fs";
import { getDb, markResyncComplete, needsResync } from "../db/schema.js";
import { updateSessionMessageCounts } from "../db/store.js";
import { rebuildIntentClaimsFromScanner } from "../intent/asserters/from_scanner.js";
import { reconcileLandedClaimsFromDisk } from "../intent/asserters/landed_from_disk.js";
import { rebuildIntentProjection } from "../intent/project.js";
// Import targets so they self-register before we iterate the registry
import "../targets/claude.js";
import "../targets/codex.js";
import "../targets/gemini.js";
import { getArchiveBackend } from "../archive/index.js";
import { log } from "../log.js";
import { generateSummariesOnce } from "../summary/index.js";
import { allTargets } from "../targets/registry.js";
import type { ParseResult } from "../targets/types.js";
import type { SavedSyncIds } from "./store.js";
import {
  getMaxOrdinal,
  getTurnCount,
  insertMessages,
  insertScannerEvents,
  insertTurns,
  linkSubagentSessions,
  readArchivedSize,
  readFileWatermark,
  resetFileForReparse,
  restoreSyncIds,
  updateSessionTotals,
  upsertSession,
  writeArchivedSize,
  writeFileWatermark,
} from "./store.js";
import type { ScannerHandle, ScannerOptions } from "./types.js";

const DEFAULT_IDLE_MS = 60_000;
const DEFAULT_CATCHUP_MS = 5_000;

export function scanOnce(): {
  filesScanned: number;
  newTurns: number;
  touchedSessions: string[];
} {
  getDb(); // ensure DB is accessible

  let filesScanned = 0;
  let newTurns = 0;
  const touchedSessions = new Set<string>();

  for (const target of allTargets()) {
    if (!target.scanner) continue;
    const source = target.id;

    for (const { filePath } of target.scanner.discover()) {
      let offset = readFileWatermark(filePath);
      let result = target.scanner.parseFile(filePath, offset);
      if (!result) continue;

      // If incremental parse detected a DAG fork, reset watermark
      // and reparse from byte 0 so fork detection runs on the full file.
      let savedSyncIds: SavedSyncIds | undefined;
      if (result.needsFullReparse && offset > 0) {
        savedSyncIds = resetFileForReparse(filePath, result.meta?.sessionId);
        offset = 0;
        result = target.scanner.parseFile(filePath, 0);
        if (!result) continue;
        log.scanner.info(`Reparsing ${filePath} from start (fork detected)`);
      }

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
        // Re-index message ordinals for incremental reads
        if (result.messages.length > 0) {
          const maxOrd = getMaxOrdinal(result.meta.sessionId);
          reindexMessages(result, maxOrd + 1);
        }
      }

      if (!result.meta?.sessionId) {
        writeFileWatermark(filePath, result.newByteOffset);
        continue;
      }

      // Wrap all per-file DB writes in a single transaction so that
      // a crash can't leave messages inserted without watermark advancement
      // (which would cause tool_call duplication on retry).
      const sessionId = result.meta.sessionId;
      const fileMeta = result.meta;
      const fileResult = result;
      const db = getDb();
      db.transaction(() => {
        upsertSession(fileMeta, filePath, source);

        if (fileResult.turns.length > 0) {
          insertTurns(fileResult.turns, source);
          updateSessionTotals(sessionId);
        }

        if (fileResult.events.length > 0) {
          insertScannerEvents(fileResult.events, source);
        }

        if (
          fileResult.messages.length > 0 ||
          fileResult.orphanedToolResults?.size
        ) {
          insertMessages(fileResult.messages, fileResult.orphanedToolResults);
          updateSessionMessageCounts(sessionId);
        }

        writeFileWatermark(filePath, fileResult.newByteOffset);
      })();
      touchedSessions.add(sessionId);

      newTurns += result.turns.length;

      // Process fork results (additional sessions from DAG analysis)
      if (result.forks) {
        for (const fork of result.forks) {
          if (!fork.meta?.sessionId) continue;
          const forkSessionId = fork.meta.sessionId;
          const forkMeta = fork.meta;
          db.transaction(() => {
            upsertSession(forkMeta, filePath, source);
            if (fork.turns.length > 0) {
              insertTurns(fork.turns, source);
              updateSessionTotals(forkSessionId);
            }
            if (fork.events.length > 0) {
              insertScannerEvents(fork.events, source);
            }
            if (fork.messages.length > 0 || fork.orphanedToolResults?.size) {
              insertMessages(fork.messages, fork.orphanedToolResults);
              updateSessionMessageCounts(forkSessionId);
            }
            // No watermark — shared file, one watermark for the whole file
          })();
          touchedSessions.add(forkSessionId);
          newTurns += fork.turns.length;
        }
      }

      // Restore sync_ids after all data for this file has been re-inserted
      if (savedSyncIds) {
        restoreSyncIds(savedSyncIds);
      }

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
        log.scanner.warn(
          `Archive error for ${filePath}: ${archiveErr instanceof Error ? archiveErr.message : archiveErr}`,
        );
      }
    }
  }

  // Link subagent sessions to parents after all files are processed
  if (filesScanned > 0) {
    if (touchedSessions.size > 0) {
      for (const sessionId of touchedSessions) {
        rebuildIntentClaimsFromScanner({ sessionId });
      }
      for (const sessionId of touchedSessions) {
        reconcileLandedClaimsFromDisk({ sessionId });
      }
      for (const sessionId of touchedSessions) {
        rebuildIntentProjection({ sessionId });
      }
    }
    const linked = linkSubagentSessions();
    if (linked > 0) {
      log.scanner.info(
        `Linked ${linked} subagent session${linked > 1 ? "s" : ""}`,
      );
    }
    log.scanner.info(`Scanned ${filesScanned} files, ${newTurns} new turns`);
  }

  return { filesScanned, newTurns, touchedSessions: [...touchedSessions] };
}

function reindexTurns(result: ParseResult, startIndex: number): void {
  for (let i = 0; i < result.turns.length; i++) {
    result.turns[i].turnIndex = startIndex + i;
  }
}

function reindexMessages(result: ParseResult, startOrdinal: number): void {
  for (let i = 0; i < result.messages.length; i++) {
    result.messages[i].ordinal = startOrdinal + i;
  }
}

export function createScannerLoop(opts: ScannerOptions): ScannerHandle {
  const idleMs = opts.idleIntervalMs ?? DEFAULT_IDLE_MS;
  const catchUpMs = opts.catchUpIntervalMs ?? DEFAULT_CATCHUP_MS;

  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopping = false;
  let reparseChecked = false;
  let ready = false;

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

    // On first tick, check if data version requires a full reparse
    if (!reparseChecked) {
      reparseChecked = true;
      if (needsResync()) {
        log.scanner.info("Data version outdated — running atomic reparse...");
        import("./reparse.js")
          .then(({ reparseAll }) => {
            try {
              const result = reparseAll((msg) => log.scanner.info(msg));
              if (result.success) {
                markResyncComplete();
              } else {
                log.scanner.error(
                  `Reparse failed: ${result.error ?? "unknown"}`,
                );
              }
            } catch (err) {
              log.scanner.error(
                `Reparse error: ${err instanceof Error ? err.message : err}`,
              );
            }
            scheduleNext(true);
          })
          .catch((err) => {
            log.scanner.error(
              `Reparse import error: ${err instanceof Error ? err.message : err}`,
            );
            scheduleNext(false);
          });
        return;
      }
      // No reparse needed — stamp version if not already set
      markResyncComplete();
    }

    let hadWork = false;
    try {
      const { newTurns } = scanOnce();
      hadWork = newTurns > 0;

      if (!ready) {
        ready = true;
        opts.onReady?.();
      }

      // Only generate summaries when idle and scanner is ready.
      if (!hadWork && ready) {
        try {
          generateSummariesOnce((msg) => log.scanner.info(msg));
        } catch (err) {
          log.scanner.error(
            `Session summary error: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    } catch (err) {
      log.scanner.error(
        `Scan error: ${err instanceof Error ? err.message : err}`,
      );
    }
    if (!stopping) {
      scheduleNext(hadWork);
    }
  }

  return {
    start() {
      if (timer) return;
      stopping = false;
      log.scanner.info("Starting scanner");
      tick();
    },
    stop() {
      stopping = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
        log.scanner.info("Stopped scanner");
      }
    },
  };
}
