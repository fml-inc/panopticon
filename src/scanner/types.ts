export interface ScannerOptions {
  idleIntervalMs?: number;
  catchUpIntervalMs?: number;
  keepAlive?: boolean;
  /** Run startup/resync scanner work off the daemon's HTTP event loop. */
  runInWorker?: boolean;
  /** Called once after initial resync/scan is complete and incremental scanning begins. */
  onReady?: () => void;
}

export interface ScannerHandle {
  start: () => void;
  stop: () => void;
}
