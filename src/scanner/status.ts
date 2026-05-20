import fs from "node:fs";
import { config, ensureDataDir } from "../config.js";

export type ScannerRuntimePhase =
  | "startup_scan"
  | "startup_process"
  | "incremental_scan"
  | "incremental_process"
  | "claims_rebuild_init"
  | "claims_rebuild_claims"
  | "claims_rebuild_projection"
  | "claims_rebuild_finalize"
  | "claims_rebuild_error"
  | "reparse_init"
  | "reparse_scan"
  | "reparse_process"
  | "reparse_copy"
  | "reparse_derive"
  | "reparse_finalize"
  | "reparse_error";

export interface ScannerRuntimeStatus {
  pid: number;
  phase: ScannerRuntimePhase;
  message: string;
  startedAtMs: number;
  updatedAtMs: number;
  elapsedMs: number;
  processedFiles?: number;
  discoveredFiles?: number;
  filesScanned?: number;
  newTurns?: number;
  touchedSessions?: number;
  currentSource?: string;
  processedSessions?: number;
  totalSessions?: number;
  currentSessionId?: string;
}

const FRESH_STATUS_MAX_AGE_MS = 120_000;

const DATABASE_REBUILD_PHASES = new Set<ScannerRuntimePhase>([
  "claims_rebuild_init",
  "claims_rebuild_claims",
  "claims_rebuild_projection",
  "claims_rebuild_finalize",
  "reparse_init",
  "reparse_scan",
  "reparse_process",
  "reparse_copy",
  "reparse_derive",
  "reparse_finalize",
]);

export function writeScannerStatus(
  status: Omit<ScannerRuntimeStatus, "updatedAtMs"> & { updatedAtMs?: number },
): void {
  ensureDataDir();
  const filePath = config.scannerStatusFile;
  const tempPath = `${filePath}.tmp`;
  const payload: ScannerRuntimeStatus = {
    ...status,
    updatedAtMs: status.updatedAtMs ?? Date.now(),
  };
  fs.writeFileSync(tempPath, `${JSON.stringify(payload, null, 2)}\n`);
  fs.renameSync(tempPath, filePath);
}

export function readScannerStatus(): ScannerRuntimeStatus | null {
  try {
    const raw = JSON.parse(fs.readFileSync(config.scannerStatusFile, "utf-8"));
    if (!raw || typeof raw !== "object") return null;
    if (typeof raw.pid !== "number") return null;
    if (typeof raw.phase !== "string") return null;
    if (typeof raw.message !== "string") return null;
    if (typeof raw.startedAtMs !== "number") return null;
    if (typeof raw.updatedAtMs !== "number") return null;
    if (typeof raw.elapsedMs !== "number") return null;
    return raw as ScannerRuntimeStatus;
  } catch {
    return null;
  }
}

function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    return (err as NodeJS.ErrnoException).code !== "ESRCH";
  }
}

export function readFreshScannerStatus(
  maxAgeMs = FRESH_STATUS_MAX_AGE_MS,
): ScannerRuntimeStatus | null {
  const status = readScannerStatus();
  if (!status) return null;
  if (
    Date.now() - status.updatedAtMs > maxAgeMs &&
    !isProcessAlive(status.pid)
  ) {
    return null;
  }
  return status;
}

export function isDatabaseRebuildPhase(
  phase: string | null | undefined,
): boolean {
  return DATABASE_REBUILD_PHASES.has(phase as ScannerRuntimePhase);
}

export function readDatabaseRebuildStatus(): ScannerRuntimeStatus | null {
  const status = readFreshScannerStatus();
  return isDatabaseRebuildPhase(status?.phase) ? status : null;
}

export function clearScannerStatus(): void {
  for (const filePath of [
    config.scannerStatusFile,
    `${config.scannerStatusFile}.tmp`,
  ]) {
    try {
      fs.unlinkSync(filePath);
    } catch {}
  }
}
