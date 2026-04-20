import fs from "node:fs";
import { config, ensureDataDir } from "../config.js";

export type ScannerRuntimePhase =
  | "reparse_init"
  | "reparse_scan"
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
}

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
