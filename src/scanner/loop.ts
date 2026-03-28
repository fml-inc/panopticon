import { getDb } from "../db/schema.js";
// Import targets so they self-register before we iterate the registry
import "../targets/claude.js";
import "../targets/codex.js";
import "../targets/gemini.js";
import { allTargets } from "../targets/registry.js";
import type { ScannerParseResult } from "../targets/types.js";
import {
  getTurnCount,
  insertTurns,
  readFileWatermark,
  updateSessionTotals,
  upsertSession,
  writeFileWatermark,
} from "./store.js";
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
      // re-index from existing turn count.
      if (offset > 0 && result.meta?.sessionId) {
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

      writeFileWatermark(filePath, result.newByteOffset);
    }
  }

  if (filesScanned > 0) {
    log(`Scanned ${filesScanned} files, ${newTurns} new turns`);
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
