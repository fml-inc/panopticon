export interface ScannerOptions {
  idleIntervalMs?: number;
  catchUpIntervalMs?: number;
  log?: (msg: string) => void;
  keepAlive?: boolean;
}

export interface ScannerHandle {
  start: () => void;
  stop: () => void;
}
