export interface DatabaseRebuildGateStatus {
  source: "parent_gate";
  token: number;
  pid: number;
  phase: string;
  message: string;
  startedAtMs: number;
  updatedAtMs: number;
  elapsedMs: number;
}

export interface DatabaseRebuildGateHandle {
  update: (status: { phase?: string; message?: string }) => void;
  release: () => void;
}

let activeGate: DatabaseRebuildGateStatus | null = null;
let nextToken = 1;

export function beginDatabaseRebuildGate(status: {
  phase: string;
  message: string;
}): DatabaseRebuildGateHandle {
  const now = Date.now();
  const token = nextToken++;
  activeGate = {
    source: "parent_gate",
    token,
    pid: process.pid,
    phase: status.phase,
    message: status.message,
    startedAtMs: now,
    updatedAtMs: now,
    elapsedMs: 0,
  };

  return {
    update(next) {
      if (activeGate?.token !== token) return;
      activeGate = {
        ...activeGate,
        phase: next.phase ?? activeGate.phase,
        message: next.message ?? activeGate.message,
        updatedAtMs: Date.now(),
      };
    },
    release() {
      if (activeGate?.token === token) activeGate = null;
    },
  };
}

export function readDatabaseRebuildGateStatus(): DatabaseRebuildGateStatus | null {
  if (!activeGate) return null;
  return {
    ...activeGate,
    elapsedMs: Date.now() - activeGate.startedAtMs,
  };
}
