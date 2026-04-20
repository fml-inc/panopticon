import fs from "node:fs";
import { performance } from "node:perf_hooks";
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
import type {
  DiscoveredFile,
  ParseResult,
  TargetScannerSpec,
} from "../targets/types.js";
import { clearScannerStatus, writeScannerStatus } from "./status.js";
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
const SCAN_STATUS_EVERY_MS = 5_000;
const MAX_PROFILE_DETAILS = 5;
const SLOW_SCAN_DETAIL_MS = 250;

interface ScanTargetProfile {
  source: string;
  filesDiscovered: number;
  filesScanned: number;
  turns: number;
  touchedSessions: number;
  reparses: number;
  parseMs: number;
  dbWriteMs: number;
  archiveMs: number;
}

interface ScanFileProfile {
  source: string;
  filePath: string;
  parseMs: number;
  dbWriteMs: number;
  archiveMs: number;
  totalMs: number;
  turns: number;
  messages: number;
  events: number;
  forks: number;
  sessionsTouched: number;
  reparsedFromStart: boolean;
}

interface ScanSessionProfile {
  sessionId: string;
  scannerMs: number;
  scannerIntents: number;
  scannerEdits: number;
  reconcileMs: number;
  reconciledEdits: number;
  reconcileActiveLoadMs: number;
  reconcileActiveIntentsLoaded: number;
  reconcileActiveEditsLoaded: number;
  projectionMs: number;
  projectedIntents: number;
  projectedEdits: number;
  projectedSessionSummaries: number;
  memberships: number;
  provenance: number;
  projectionActiveLoadMs: number;
  projectionActiveIntentsLoaded: number;
  projectionActiveEditsLoaded: number;
  totalMs: number;
}

interface ScanProfile {
  totalMs: number;
  parseMs: number;
  dbWriteMs: number;
  archiveMs: number;
  rebuildScannerMs: number;
  reconcileMs: number;
  projectionMs: number;
  linkMs: number;
  linkedSessions: number;
  targets: ScanTargetProfile[];
  files: ScanFileProfile[];
  sessions: ScanSessionProfile[];
}

interface ScanOnceOptions {
  profileLabel?: string;
  logDetails?: boolean;
  progressEveryMs?: number;
  onProgress?: (progress: ScanProgress) => void;
}

interface ScanOnceResult {
  filesScanned: number;
  newTurns: number;
  touchedSessions: string[];
  profile: ScanProfile;
}

interface ScanProgress {
  label: string;
  elapsedMs: number;
  phase: "files" | "sessions";
  processedFiles: number;
  discoveredFiles: number;
  filesScanned: number;
  newTurns: number;
  touchedSessions: number;
  currentSource?: string;
  processedSessions?: number;
  totalSessions?: number;
  currentSessionId?: string;
}

function formatMs(ms: number): string {
  if (ms >= 1000) return `${(ms / 1000).toFixed(2)}s`;
  if (ms >= 100) return `${Math.round(ms)}ms`;
  return `${ms.toFixed(1)}ms`;
}

function sortByDurationDesc<T extends { totalMs: number }>(rows: T[]): T[] {
  return [...rows].sort((a, b) => b.totalMs - a.totalMs);
}

function logScanProfile(
  result: ScanOnceResult,
  opts: ScanOnceOptions | undefined,
): void {
  const label = opts?.profileLabel ?? "scan";
  const prefix = `${label} profile`;
  const { profile } = result;
  log.scanner.info(
    `${prefix}: total=${formatMs(profile.totalMs)} files=${result.filesScanned} turns=${result.newTurns} touched_sessions=${result.touchedSessions.length} phases(parse=${formatMs(profile.parseMs)} db=${formatMs(profile.dbWriteMs)} archive=${formatMs(profile.archiveMs)} claims=${formatMs(profile.rebuildScannerMs)} landed=${formatMs(profile.reconcileMs)} projection=${formatMs(profile.projectionMs)} link=${formatMs(profile.linkMs)})`,
  );

  const shouldLogDetails =
    opts?.logDetails === true || profile.totalMs >= SLOW_SCAN_DETAIL_MS;
  if (!shouldLogDetails) return;

  for (const target of profile.targets) {
    log.scanner.info(
      `${prefix} target: source=${target.source} discovered=${target.filesDiscovered} scanned=${target.filesScanned} turns=${target.turns} touched_sessions=${target.touchedSessions} reparses=${target.reparses} parse=${formatMs(target.parseMs)} db=${formatMs(target.dbWriteMs)} archive=${formatMs(target.archiveMs)}`,
    );
  }

  for (const file of sortByDurationDesc(profile.files).slice(
    0,
    MAX_PROFILE_DETAILS,
  )) {
    log.scanner.info(
      `${prefix} file: total=${formatMs(file.totalMs)} source=${file.source} turns=${file.turns} messages=${file.messages} events=${file.events} forks=${file.forks} touched_sessions=${file.sessionsTouched} parse=${formatMs(file.parseMs)} db=${formatMs(file.dbWriteMs)} archive=${formatMs(file.archiveMs)} reparsed=${file.reparsedFromStart ? "yes" : "no"} path=${file.filePath}`,
    );
  }

  for (const session of sortByDurationDesc(profile.sessions).slice(
    0,
    MAX_PROFILE_DETAILS,
  )) {
    log.scanner.info(
      `${prefix} session: total=${formatMs(session.totalMs)} session=${session.sessionId} claims=${formatMs(session.scannerMs)} intents=${session.scannerIntents} edits=${session.scannerEdits} landed=${formatMs(session.reconcileMs)} checked=${session.reconciledEdits} active_load=${formatMs(session.reconcileActiveLoadMs)} active_intents=${session.reconcileActiveIntentsLoaded} active_edits=${session.reconcileActiveEditsLoaded} projection=${formatMs(session.projectionMs)} projected_intents=${session.projectedIntents} projected_edits=${session.projectedEdits} summaries=${session.projectedSessionSummaries} memberships=${session.memberships} provenance=${session.provenance} projection_active_load=${formatMs(session.projectionActiveLoadMs)} projection_active_intents=${session.projectionActiveIntentsLoaded} projection_active_edits=${session.projectionActiveEditsLoaded}`,
    );
  }
}

function writeActiveScanStatus(
  startedAtMs: number,
  isStartupScan: boolean,
  progress?: ScanProgress,
): void {
  const filesPhase = isStartupScan ? "startup_scan" : "incremental_scan";
  const sessionsPhase = isStartupScan
    ? "startup_process"
    : "incremental_process";
  const phase = progress?.phase === "sessions" ? sessionsPhase : filesPhase;
  const message =
    progress?.phase === "sessions"
      ? isStartupScan
        ? "Processing touched sessions from startup scan..."
        : "Processing touched sessions..."
      : isStartupScan
        ? "Running startup scan..."
        : "Scanning session files...";

  writeScannerStatus({
    pid: process.pid,
    phase,
    message,
    startedAtMs,
    elapsedMs: progress?.elapsedMs ?? Date.now() - startedAtMs,
    processedFiles: progress?.processedFiles,
    discoveredFiles: progress?.discoveredFiles,
    filesScanned: progress?.filesScanned,
    newTurns: progress?.newTurns,
    touchedSessions: progress?.touchedSessions,
    currentSource: progress?.currentSource,
    processedSessions: progress?.processedSessions,
    totalSessions: progress?.totalSessions,
    currentSessionId: progress?.currentSessionId,
  });
}

export function scanOnce(opts?: ScanOnceOptions): ScanOnceResult {
  const startedAt = performance.now();
  getDb(); // ensure DB is accessible

  const label = opts?.profileLabel ?? "scan";
  const progressEveryMs = opts?.progressEveryMs ?? 15_000;
  let filesScanned = 0;
  let newTurns = 0;
  const touchedSessions = new Set<string>();
  const fileProfiles: ScanFileProfile[] = [];
  const targetProfiles = new Map<string, ScanTargetProfile>();
  const targetTouchedSessions = new Map<string, Set<string>>();
  let parseMs = 0;
  let dbWriteMs = 0;
  let archiveMs = 0;
  let rebuildScannerMs = 0;
  let reconcileMs = 0;
  let projectionMs = 0;
  let linkMs = 0;
  let linkedSessions = 0;
  let processedFiles = 0;
  let discoveredFiles = 0;
  let processedSessions = 0;
  let lastProgressAt = startedAt;
  let lastProgressKey = "";

  const emitProgress = (
    phase: "files" | "sessions",
    force = false,
    currentSource?: string,
    currentSessionId?: string,
  ) => {
    if (!opts?.onProgress) return;
    const now = performance.now();
    const progressKey = `${phase}:${processedFiles}:${processedSessions}`;
    if (!force && now - lastProgressAt < progressEveryMs) return;
    if (force && lastProgressKey === progressKey) return;
    lastProgressAt = now;
    lastProgressKey = progressKey;
    opts.onProgress({
      label,
      elapsedMs: now - startedAt,
      phase,
      processedFiles,
      discoveredFiles,
      filesScanned,
      newTurns,
      touchedSessions: touchedSessions.size,
      currentSource,
      processedSessions: phase === "sessions" ? processedSessions : undefined,
      totalSessions: phase === "sessions" ? touchedSessions.size : undefined,
      currentSessionId,
    });
  };

  const discoveredTargets: Array<{
    source: string;
    scanner: TargetScannerSpec;
    files: DiscoveredFile[];
  }> = [];
  for (const target of allTargets()) {
    if (!target.scanner) continue;
    const files = target.scanner.discover();
    discoveredFiles += files.length;
    discoveredTargets.push({
      source: target.id,
      scanner: target.scanner,
      files,
    });
  }

  if (discoveredFiles > 0) {
    emitProgress("files", true);
  }

  for (const target of discoveredTargets) {
    const source = target.source;
    const targetProfile = targetProfiles.get(source) ?? {
      source,
      filesDiscovered: 0,
      filesScanned: 0,
      turns: 0,
      touchedSessions: 0,
      reparses: 0,
      parseMs: 0,
      dbWriteMs: 0,
      archiveMs: 0,
    };
    targetProfiles.set(source, targetProfile);
    if (!targetTouchedSessions.has(source)) {
      targetTouchedSessions.set(source, new Set<string>());
    }

    targetProfile.filesDiscovered += target.files.length;

    for (const { filePath } of target.files) {
      try {
        const fileStartedAt = performance.now();
        let fileParseMs = 0;
        let fileDbWriteMs = 0;
        let fileArchiveMs = 0;
        let reparsedFromStart = false;
        let offset = readFileWatermark(filePath);
        let parseStartedAt = performance.now();
        let result = target.scanner.parseFile(filePath, offset);
        fileParseMs += performance.now() - parseStartedAt;
        if (!result) {
          parseMs += fileParseMs;
          targetProfile.parseMs += fileParseMs;
          continue;
        }

        // If incremental parse detected a DAG fork, reset watermark
        // and reparse from byte 0 so fork detection runs on the full file.
        let savedSyncIds: SavedSyncIds | undefined;
        if (result.needsFullReparse && offset > 0) {
          reparsedFromStart = true;
          targetProfile.reparses += 1;
          savedSyncIds = resetFileForReparse(filePath, result.meta?.sessionId);
          offset = 0;
          parseStartedAt = performance.now();
          result = target.scanner.parseFile(filePath, 0);
          fileParseMs += performance.now() - parseStartedAt;
          if (!result) {
            parseMs += fileParseMs;
            targetProfile.parseMs += fileParseMs;
            continue;
          }
          log.scanner.info(`Reparsing ${filePath} from start (fork detected)`);
        }

        filesScanned++;
        targetProfile.filesScanned += 1;
        parseMs += fileParseMs;
        targetProfile.parseMs += fileParseMs;

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
        const writeStartedAt = performance.now();
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
        fileDbWriteMs += performance.now() - writeStartedAt;
        dbWriteMs += fileDbWriteMs;
        targetProfile.dbWriteMs += fileDbWriteMs;
        touchedSessions.add(sessionId);
        targetTouchedSessions.get(source)?.add(sessionId);

        newTurns += result.turns.length;
        targetProfile.turns += result.turns.length;

        // Process fork results (additional sessions from DAG analysis)
        if (result.forks) {
          for (const fork of result.forks) {
            if (!fork.meta?.sessionId) continue;
            const forkSessionId = fork.meta.sessionId;
            const forkMeta = fork.meta;
            const forkWriteStartedAt = performance.now();
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
            const forkWriteMs = performance.now() - forkWriteStartedAt;
            fileDbWriteMs += forkWriteMs;
            dbWriteMs += forkWriteMs;
            targetProfile.dbWriteMs += forkWriteMs;
            touchedSessions.add(forkSessionId);
            targetTouchedSessions.get(source)?.add(forkSessionId);
            newTurns += fork.turns.length;
            targetProfile.turns += fork.turns.length;
          }
        }

        // Restore sync_ids after all data for this file has been re-inserted
        if (savedSyncIds) {
          restoreSyncIds(savedSyncIds);
        }

        // Archive raw file for 100% recall
        const archiveStartedAt = performance.now();
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
        } finally {
          fileArchiveMs += performance.now() - archiveStartedAt;
          archiveMs += fileArchiveMs;
          targetProfile.archiveMs += fileArchiveMs;
        }

        fileProfiles.push({
          source,
          filePath,
          parseMs: fileParseMs,
          dbWriteMs: fileDbWriteMs,
          archiveMs: fileArchiveMs,
          totalMs: performance.now() - fileStartedAt,
          turns:
            result.turns.length +
            (result.forks?.reduce((sum, fork) => sum + fork.turns.length, 0) ??
              0),
          messages:
            result.messages.length +
            (result.forks?.reduce(
              (sum, fork) => sum + fork.messages.length,
              0,
            ) ?? 0),
          events:
            result.events.length +
            (result.forks?.reduce((sum, fork) => sum + fork.events.length, 0) ??
              0),
          forks: result.forks?.length ?? 0,
          sessionsTouched: 1 + (result.forks?.length ?? 0),
          reparsedFromStart,
        });
      } finally {
        processedFiles += 1;
        emitProgress("files", false, source);
      }
    }
  }

  if (discoveredFiles > 0) {
    emitProgress("files", true);
  }

  for (const profile of targetProfiles.values()) {
    profile.touchedSessions =
      targetTouchedSessions.get(profile.source)?.size ?? 0;
  }

  const sessionProfiles: ScanSessionProfile[] = [];

  // Link subagent sessions to parents after all files are processed
  if (filesScanned > 0) {
    if (touchedSessions.size > 0) {
      emitProgress("sessions", true);
      for (const sessionId of touchedSessions) {
        const sessionProfile: ScanSessionProfile = {
          sessionId,
          scannerMs: 0,
          scannerIntents: 0,
          scannerEdits: 0,
          reconcileMs: 0,
          reconciledEdits: 0,
          reconcileActiveLoadMs: 0,
          reconcileActiveIntentsLoaded: 0,
          reconcileActiveEditsLoaded: 0,
          projectionMs: 0,
          projectedIntents: 0,
          projectedEdits: 0,
          projectedSessionSummaries: 0,
          memberships: 0,
          provenance: 0,
          projectionActiveLoadMs: 0,
          projectionActiveIntentsLoaded: 0,
          projectionActiveEditsLoaded: 0,
          totalMs: 0,
        };

        let phaseStartedAt = performance.now();
        const scannerResult = rebuildIntentClaimsFromScanner({ sessionId });
        sessionProfile.scannerMs = performance.now() - phaseStartedAt;
        sessionProfile.scannerIntents = scannerResult.intents;
        sessionProfile.scannerEdits = scannerResult.edits;
        rebuildScannerMs += sessionProfile.scannerMs;

        phaseStartedAt = performance.now();
        const landedResult = reconcileLandedClaimsFromDisk({ sessionId });
        sessionProfile.reconcileMs = performance.now() - phaseStartedAt;
        sessionProfile.reconciledEdits = landedResult.checked;
        sessionProfile.reconcileActiveLoadMs = landedResult.activeLoadMs;
        sessionProfile.reconcileActiveIntentsLoaded =
          landedResult.activeIntentsLoaded;
        sessionProfile.reconcileActiveEditsLoaded =
          landedResult.activeEditsLoaded;
        reconcileMs += sessionProfile.reconcileMs;

        phaseStartedAt = performance.now();
        const projectionResult = rebuildIntentProjection({ sessionId });
        sessionProfile.projectionMs = performance.now() - phaseStartedAt;
        sessionProfile.projectedIntents = projectionResult.intents;
        sessionProfile.projectedEdits = projectionResult.edits;
        sessionProfile.projectedSessionSummaries =
          projectionResult.sessionSummaries;
        sessionProfile.memberships = projectionResult.memberships;
        sessionProfile.provenance = projectionResult.provenance;
        sessionProfile.projectionActiveLoadMs = projectionResult.activeLoadMs;
        sessionProfile.projectionActiveIntentsLoaded =
          projectionResult.activeIntentsLoaded;
        sessionProfile.projectionActiveEditsLoaded =
          projectionResult.activeEditsLoaded;
        projectionMs += sessionProfile.projectionMs;

        sessionProfile.totalMs =
          sessionProfile.scannerMs +
          sessionProfile.reconcileMs +
          sessionProfile.projectionMs;
        sessionProfiles.push(sessionProfile);
        processedSessions += 1;
        emitProgress("sessions", false, undefined, sessionId);
      }
      emitProgress("sessions", true);
    }
    const linkStartedAt = performance.now();
    linkedSessions = linkSubagentSessions();
    linkMs += performance.now() - linkStartedAt;
    if (linkedSessions > 0) {
      log.scanner.info(
        `Linked ${linkedSessions} subagent session${linkedSessions > 1 ? "s" : ""}`,
      );
    }
    log.scanner.info(`Scanned ${filesScanned} files, ${newTurns} new turns`);
  }

  const result: ScanOnceResult = {
    filesScanned,
    newTurns,
    touchedSessions: [...touchedSessions],
    profile: {
      totalMs: performance.now() - startedAt,
      parseMs,
      dbWriteMs,
      archiveMs,
      rebuildScannerMs,
      reconcileMs,
      projectionMs,
      linkMs,
      linkedSessions,
      targets: [...targetProfiles.values()],
      files: fileProfiles,
      sessions: sessionProfiles,
    },
  };

  if (filesScanned > 0 || opts?.logDetails === true) {
    logScanProfile(result, opts);
  }

  return result;
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
  let startedAt = 0;

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
              clearScannerStatus();
              if (result.success) {
                markResyncComplete();
              } else {
                log.scanner.error(
                  `Reparse failed: ${result.error ?? "unknown"}`,
                );
              }
            } catch (err) {
              clearScannerStatus();
              log.scanner.error(
                `Reparse error: ${err instanceof Error ? err.message : err}`,
              );
            }
            scheduleNext(true);
          })
          .catch((err) => {
            clearScannerStatus();
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
      const isStartupScan = !ready;
      const scanStatusStartedAtMs = Date.now();
      writeActiveScanStatus(scanStatusStartedAtMs, isStartupScan);
      const { newTurns } = scanOnce({
        profileLabel: isStartupScan ? "startup scan" : "scan",
        logDetails: isStartupScan,
        progressEveryMs: SCAN_STATUS_EVERY_MS,
        onProgress: (progress) => {
          writeActiveScanStatus(scanStatusStartedAtMs, isStartupScan, progress);
        },
      });
      hadWork = newTurns > 0;
      clearScannerStatus();

      if (!ready) {
        ready = true;
        clearScannerStatus();
        log.scanner.info(
          `Scanner ready in ${formatMs(performance.now() - startedAt)}`,
        );
        opts.onReady?.();
      }

      // Only generate summaries when idle and scanner is ready.
      if (!hadWork && ready) {
        try {
          const summaryStartedAt = performance.now();
          const result = generateSummariesOnce((msg) => log.scanner.info(msg));
          log.scanner.info(
            `Session summary pass: updated=${result.updated} total=${formatMs(performance.now() - summaryStartedAt)}`,
          );
        } catch (err) {
          log.scanner.error(
            `Session summary error: ${err instanceof Error ? err.message : err}`,
          );
        }
      }
    } catch (err) {
      clearScannerStatus();
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
      startedAt = performance.now();
      clearScannerStatus();
      log.scanner.info("Starting scanner");
      tick();
    },
    stop() {
      stopping = true;
      clearScannerStatus();
      if (timer) {
        clearTimeout(timer);
        timer = null;
        log.scanner.info("Stopped scanner");
      }
    },
  };
}
