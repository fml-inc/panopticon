import { spawn } from "node:child_process";
import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { config, ensureDataDir } from "./config.js";
import { logPaths, openLogFd } from "./log.js";

export interface PidFileStatus {
  exists: boolean;
  valid: boolean;
  running: boolean;
  pid: number | null;
}

export interface ServerHealth {
  ok: boolean;
  pid: number | null;
  port: number;
}

export interface ServerStatus {
  running: boolean;
  health: ServerHealth;
  pidFile: PidFileStatus;
}

export interface ServerStartBackoffStatus {
  exists: boolean;
  active: boolean;
  attempts: number;
  lastFailureAtMs: number | null;
  nextAllowedAtMs: number | null;
  lastError: string | null;
}

export type StartServerResult =
  | { status: "already_running"; pid: number | null; port: number }
  | { status: "started"; pid: number | null; port: number };

export type StopServerResult =
  | { status: "not_running" }
  | { status: "permission_denied"; pid: number }
  | { status: "stale_pid_removed"; pid: number | null }
  | { status: "stopped"; pid: number }
  | { status: "killed"; pid: number }
  | { status: "signal_sent"; pid: number };

export function healthCheckHost(host = config.host): string {
  if (host === "::") return "::1";
  return host && host !== "0.0.0.0" ? host : "127.0.0.1";
}

function hasErrnoCode(err: unknown, code: string): boolean {
  return (err as NodeJS.ErrnoException)?.code === code;
}

function truncateStartFailure(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  const logSuffix = `. Log: ${logPaths.server}`;
  const cleaned = message.endsWith(logSuffix)
    ? message.slice(0, -logSuffix.length)
    : message;
  return cleaned.length > 500 ? `${cleaned.slice(0, 497)}...` : cleaned;
}

function startBackoffDelayMs(
  attempts: number,
  scheduleMs: readonly number[] = config.serverStartBackoffScheduleMs,
): number {
  if (scheduleMs.length === 0) return 0;
  const index = Math.min(Math.max(attempts - 1, 0), scheduleMs.length - 1);
  return scheduleMs[index];
}

function emptyServerStartBackoffStatus(): ServerStartBackoffStatus {
  return {
    exists: false,
    active: false,
    attempts: 0,
    lastFailureAtMs: null,
    nextAllowedAtMs: null,
    lastError: null,
  };
}

export function readServerStartBackoffStatus(opts?: {
  backoffFile?: string;
  nowMs?: number;
}): ServerStartBackoffStatus {
  const backoffFile = opts?.backoffFile ?? config.serverStartBackoffFile;
  const nowMs = opts?.nowMs ?? Date.now();

  let raw: unknown;
  try {
    raw = JSON.parse(fs.readFileSync(backoffFile, "utf-8"));
  } catch {
    return emptyServerStartBackoffStatus();
  }

  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    return emptyServerStartBackoffStatus();
  }

  const record = raw as Record<string, unknown>;
  const attempts =
    typeof record.attempts === "number" && record.attempts > 0
      ? Math.floor(record.attempts)
      : 0;
  const lastFailureAtMs =
    typeof record.lastFailureAtMs === "number" && record.lastFailureAtMs > 0
      ? record.lastFailureAtMs
      : null;
  const nextAllowedAtMs =
    typeof record.nextAllowedAtMs === "number" && record.nextAllowedAtMs > 0
      ? record.nextAllowedAtMs
      : null;
  const lastError =
    typeof record.lastError === "string" && record.lastError.length > 0
      ? record.lastError
      : null;

  return {
    exists: true,
    active: nextAllowedAtMs != null && nextAllowedAtMs > nowMs,
    attempts,
    lastFailureAtMs,
    nextAllowedAtMs,
    lastError,
  };
}

export function clearServerStartBackoff(
  backoffFile = config.serverStartBackoffFile,
): void {
  try {
    fs.unlinkSync(backoffFile);
  } catch {}
}

export function recordServerStartFailure(
  error: unknown,
  opts?: {
    backoffFile?: string;
    nowMs?: number;
    scheduleMs?: readonly number[];
  },
): void {
  const backoffFile = opts?.backoffFile ?? config.serverStartBackoffFile;
  const nowMs = opts?.nowMs ?? Date.now();
  const previous = readServerStartBackoffStatus({ backoffFile, nowMs });
  const attempts = previous.attempts + 1;
  const delayMs = startBackoffDelayMs(
    attempts,
    opts?.scheduleMs ?? config.serverStartBackoffScheduleMs,
  );
  const record = {
    attempts,
    lastFailureAtMs: nowMs,
    nextAllowedAtMs: nowMs + delayMs,
    lastError: truncateStartFailure(error),
  };

  fs.mkdirSync(path.dirname(backoffFile), { recursive: true });
  fs.writeFileSync(backoffFile, `${JSON.stringify(record, null, 2)}\n`);
}

export function assertServerStartBackoffInactive(opts?: {
  backoffFile?: string;
  nowMs?: number;
}): void {
  const backoff = readServerStartBackoffStatus(opts);
  if (!backoff.active) return;

  const nextAllowed =
    backoff.nextAllowedAtMs != null
      ? new Date(backoff.nextAllowedAtMs).toISOString()
      : "later";
  const lastError = backoff.lastError
    ? ` Last error: ${backoff.lastError}`
    : "";
  throw new Error(
    `Panopticon server start backoff active until ${nextAllowed} after ${backoff.attempts} failed start attempt${backoff.attempts === 1 ? "" : "s"}.${lastError} Log: ${logPaths.server}`,
  );
}

function recordServerStartFailureAndThrow(error: Error): never {
  recordServerStartFailure(error);
  throw error;
}

export function isPidRunning(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (hasErrnoCode(err, "EPERM")) return true;
    return false;
  }
}

export function readPidFileStatus(
  pidFile = config.serverPidFile,
): PidFileStatus {
  if (!fs.existsSync(pidFile)) {
    return { exists: false, valid: false, running: false, pid: null };
  }

  const raw = fs.readFileSync(pidFile, "utf-8").trim();
  if (!/^\d+$/.test(raw)) {
    return { exists: true, valid: false, running: false, pid: null };
  }

  const pid = parseInt(raw, 10);
  return {
    exists: true,
    valid: true,
    running: isPidRunning(pid),
    pid,
  };
}

export function removePidFileIfOwned(
  pid: number,
  pidFile = config.serverPidFile,
): void {
  const status = readPidFileStatus(pidFile);
  if (!status.exists || status.pid !== pid) return;
  try {
    fs.unlinkSync(pidFile);
  } catch {}
}

export function writeOwnPidFile(pid = process.pid): void {
  ensureDataDir();
  fs.writeFileSync(config.serverPidFile, `${pid}\n`);
}

function repairPidFileFromHealth(
  health: ServerHealth,
  pidFile: PidFileStatus,
): void {
  if (!health.ok || health.pid == null) return;
  if (pidFile.running && pidFile.pid === health.pid) return;
  writeOwnPidFile(health.pid);
}

export function checkServerHealth(opts?: {
  host?: string;
  port?: number;
  timeoutMs?: number;
}): Promise<ServerHealth> {
  const port = opts?.port ?? config.port;
  return new Promise((resolve) => {
    const req = http.request(
      {
        hostname: healthCheckHost(opts?.host ?? config.host),
        port,
        path: "/health",
        method: "GET",
        timeout: opts?.timeoutMs ?? 1500,
      },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (chunk: Buffer) => chunks.push(chunk));
        res.on("end", () => {
          if (res.statusCode !== 200) {
            resolve({ ok: false, pid: null, port });
            return;
          }
          try {
            const body = JSON.parse(Buffer.concat(chunks).toString("utf-8"));
            if (body?.status !== "ok") {
              resolve({ ok: false, pid: null, port });
              return;
            }
            resolve({
              ok: true,
              pid: typeof body?.pid === "number" ? body.pid : null,
              port,
            });
          } catch {
            resolve({ ok: false, pid: null, port });
          }
        });
      },
    );
    req.on("error", () => resolve({ ok: false, pid: null, port }));
    req.on("timeout", () => {
      req.destroy();
      resolve({ ok: false, pid: null, port });
    });
    req.end();
  });
}

export async function readServerStatus(opts?: {
  host?: string;
  port?: number;
}): Promise<ServerStatus> {
  const pidFile = readPidFileStatus();
  const health = await checkServerHealth(opts);
  return {
    running: health.ok || pidFile.running,
    health,
    pidFile,
  };
}

export async function waitForServerHealth(opts?: {
  host?: string;
  port?: number;
  timeoutMs?: number;
  intervalMs?: number;
}): Promise<ServerHealth> {
  const startedAt = Date.now();
  const timeoutMs = opts?.timeoutMs ?? 5000;
  const intervalMs = opts?.intervalMs ?? 50;
  let lastHealth: ServerHealth = {
    ok: false,
    pid: null,
    port: opts?.port ?? config.port,
  };

  while (Date.now() - startedAt < timeoutMs) {
    lastHealth = await checkServerHealth({
      host: opts?.host,
      port: opts?.port,
      timeoutMs: Math.min(500, timeoutMs),
    });
    if (lastHealth.ok) return lastHealth;
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }

  return lastHealth;
}

export function formatServerStatus(server: ServerStatus): string {
  const { pidFile, health } = server;
  if (health.ok) {
    const pid = health.pid ?? (pidFile.running ? pidFile.pid : null);
    const pidText = pid != null ? `PID ${pid}, ` : "";
    if (pidFile.running && (health.pid == null || health.pid === pidFile.pid)) {
      return `running (${pidText}port ${health.port})`;
    }
    if (pidFile.exists && pidFile.valid && pidFile.pid != null) {
      return `running (${pidText}port ${health.port}; stale PID file ${pidFile.pid})`;
    }
    if (pidFile.exists && !pidFile.valid) {
      return `running (${pidText}port ${health.port}; invalid PID file)`;
    }
    return `running (${pidText}port ${health.port}; no PID file)`;
  }

  if (pidFile.running && pidFile.pid != null) {
    return `process running (PID ${pidFile.pid}) but health check failed on port ${health.port}`;
  }
  if (pidFile.exists && pidFile.valid && pidFile.pid != null) {
    return `stopped (stale PID file ${pidFile.pid})`;
  }
  if (pidFile.exists && !pidFile.valid) return "stopped (invalid PID file)";
  return "stopped";
}

function unlinkPidFile(pidFile: string): void {
  try {
    fs.unlinkSync(pidFile);
  } catch {}
}

export function stopLegacyDaemons(): number[] {
  const stopped: number[] = [];
  for (const pidFile of [config.pidFile, config.proxyPidFile]) {
    if (!fs.existsSync(pidFile)) continue;
    try {
      const pid = parseInt(fs.readFileSync(pidFile, "utf-8").trim(), 10);
      if (Number.isInteger(pid) && pid > 0) {
        try {
          process.kill(pid, "SIGTERM");
          stopped.push(pid);
        } catch {}
      }
    } catch {}
    unlinkPidFile(pidFile);
  }
  return stopped;
}

async function waitForStopped(
  pid: number,
  timeoutMs: number,
  opts?: { host?: string; port?: number },
): Promise<boolean> {
  const startedAt = Date.now();
  while (Date.now() - startedAt < timeoutMs) {
    const health = await checkServerHealth({
      host: opts?.host,
      port: opts?.port,
      timeoutMs: 300,
    });
    if (!isPidRunning(pid) && (!health.ok || health.pid !== pid)) return true;
    await new Promise((resolve) => setTimeout(resolve, 100));
  }
  return false;
}

async function stopSpawnedChildAfterFailedStart(
  pid: number | undefined,
  opts?: { host?: string; port?: number },
): Promise<void> {
  if (pid == null) return;
  try {
    process.kill(pid, "SIGTERM");
  } catch {
    removePidFileIfOwned(pid);
    return;
  }

  const stopped = await waitForStopped(pid, 2000, opts);
  if (!stopped) {
    try {
      process.kill(pid, "SIGKILL");
      await waitForStopped(pid, 1000, opts);
    } catch {}
  }
  removePidFileIfOwned(pid);
}

export async function stopServer(opts?: {
  forceKill?: boolean;
  host?: string;
  includeLegacy?: boolean;
  killTimeoutMs?: number;
  port?: number;
  timeoutMs?: number;
}): Promise<StopServerResult> {
  if (opts?.includeLegacy) stopLegacyDaemons();

  const status = await readServerStatus({ host: opts?.host, port: opts?.port });
  const pid =
    status.health.pid ?? (status.pidFile.running ? status.pidFile.pid : null);

  if (pid != null) {
    try {
      process.kill(pid, "SIGTERM");
    } catch (err) {
      if (hasErrnoCode(err, "EPERM")) {
        return { status: "permission_denied", pid };
      }
      removePidFileIfOwned(pid);
      return { status: "stale_pid_removed", pid };
    }

    const stopped = await waitForStopped(pid, opts?.timeoutMs ?? 5000, {
      host: opts?.host,
      port: opts?.port,
    });
    if (stopped) {
      removePidFileIfOwned(pid);
      return { status: "stopped", pid };
    }

    if (opts?.forceKill !== false) {
      try {
        process.kill(pid, "SIGKILL");
      } catch (err) {
        if (hasErrnoCode(err, "EPERM")) {
          return { status: "permission_denied", pid };
        }
        removePidFileIfOwned(pid);
        return { status: "stale_pid_removed", pid };
      }

      const killed = await waitForStopped(pid, opts?.killTimeoutMs ?? 2000, {
        host: opts?.host,
        port: opts?.port,
      });
      if (killed) {
        removePidFileIfOwned(pid);
        return { status: "killed", pid };
      }
    }

    return { status: "signal_sent", pid };
  }

  if (status.pidFile.exists) {
    unlinkPidFile(config.serverPidFile);
    return { status: "stale_pid_removed", pid: status.pidFile.pid };
  }

  return { status: "not_running" };
}

export async function startServerDetached(opts: {
  serverScript: string;
  env?: NodeJS.ProcessEnv;
  host?: string;
  ignoreStartBackoff?: boolean;
  port?: number;
  stopExisting?: boolean;
  timeoutMs?: number;
}): Promise<StartServerResult> {
  ensureDataDir();
  const port = opts.port ?? config.port;

  if (opts.stopExisting) {
    const stopped = await stopServer({
      includeLegacy: true,
      port,
      timeoutMs: 3000,
    });
    if (stopped.status === "signal_sent") {
      recordServerStartFailureAndThrow(
        new Error(
          `Panopticon server did not stop after SIGTERM/SIGKILL (PID ${stopped.pid}). Log: ${logPaths.server}`,
        ),
      );
    }
    if (stopped.status === "permission_denied") {
      recordServerStartFailureAndThrow(
        new Error(
          `Panopticon server could not be stopped because permission was denied (PID ${stopped.pid}). Log: ${logPaths.server}`,
        ),
      );
    }
  }

  let current = await readServerStatus({ host: opts.host, port });
  if (current.health.ok) {
    repairPidFileFromHealth(current.health, current.pidFile);
    clearServerStartBackoff();
    return {
      status: "already_running",
      pid: current.health.pid ?? current.pidFile.pid,
      port: current.health.port,
    };
  }

  if (current.pidFile.running && current.pidFile.pid != null) {
    if (!opts.ignoreStartBackoff) assertServerStartBackoffInactive();

    const stopped = await stopServer({
      host: opts.host,
      port,
      timeoutMs: 3000,
    });
    if (stopped.status === "signal_sent") {
      recordServerStartFailureAndThrow(
        new Error(
          `Panopticon server process is running but unhealthy and stop returned signal_sent (PID ${stopped.pid}). Log: ${logPaths.server}`,
        ),
      );
    }
    if (stopped.status === "permission_denied") {
      recordServerStartFailureAndThrow(
        new Error(
          `Panopticon server process is running but unhealthy and stop returned permission_denied (PID ${stopped.pid}). Log: ${logPaths.server}`,
        ),
      );
    }

    current = await readServerStatus({ host: opts.host, port });
    if (current.health.ok) {
      repairPidFileFromHealth(current.health, current.pidFile);
      clearServerStartBackoff();
      return {
        status: "already_running",
        pid: current.health.pid ?? current.pidFile.pid,
        port: current.health.port,
      };
    }
    if (current.pidFile.running && current.pidFile.pid != null) {
      recordServerStartFailureAndThrow(
        new Error(
          `Panopticon server process is still running but unhealthy after stop status ${stopped.status} (PID ${current.pidFile.pid}). Log: ${logPaths.server}`,
        ),
      );
    }
  }

  if (current.pidFile.exists && !current.pidFile.running) {
    unlinkPidFile(config.serverPidFile);
  }

  if (!opts.ignoreStartBackoff) assertServerStartBackoffInactive();

  const logFd = openLogFd("server");
  const child = spawn(process.execPath, [opts.serverScript], {
    detached: true,
    windowsHide: true,
    stdio: ["ignore", logFd, logFd],
    env: {
      ...process.env,
      ...opts.env,
      PANOPTICON_PORT: String(port),
    },
  });

  const childState: {
    exit?: { code: number | null; signal: NodeJS.Signals | null };
    spawnError?: Error;
  } = {};
  child.once("error", (err) => {
    childState.spawnError = err;
  });
  child.once("exit", (code, signal) => {
    childState.exit = { code, signal };
  });

  child.unref();
  fs.closeSync(logFd);

  const health = await waitForServerHealth({
    port,
    timeoutMs: opts.timeoutMs ?? 8000,
  });
  if (childState.spawnError) {
    const error = new Error(
      `Failed to start panopticon server: ${childState.spawnError.message}`,
    );
    recordServerStartFailure(error);
    throw error;
  }
  if (!health.ok) {
    const exitText = childState.exit
      ? ` (process exited code=${childState.exit.code ?? "null"} signal=${childState.exit.signal ?? "null"})`
      : "";
    const error = new Error(
      `Panopticon server did not become healthy on port ${port}${exitText}. Log: ${logPaths.server}`,
    );
    if (!childState.exit) {
      await stopSpawnedChildAfterFailedStart(child.pid, {
        host: opts.host,
        port,
      });
    }
    recordServerStartFailure(error);
    throw error;
  }

  clearServerStartBackoff();
  return {
    status: "started",
    pid: health.pid ?? child.pid ?? null,
    port: health.port,
  };
}
