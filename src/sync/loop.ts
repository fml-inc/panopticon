import { execSync } from "node:child_process";
import { getDb } from "../db/schema.js";
import { captureException } from "../sentry.js";
import { chunk, postOtlp } from "./post.js";
import {
  readHookEvents,
  readMetrics,
  readOtelLogs,
  readOtelSpans,
  readScannerEvents,
  readScannerTurns,
} from "./reader.js";
import {
  serializeHookEvents,
  serializeMetrics,
  serializeOtelLogs,
  serializeOtelSpans,
  serializeScannerEvents,
  serializeScannerTurns,
} from "./serialize.js";
import type { SyncHandle, SyncOptions, SyncTarget } from "./types.js";
import {
  closeWatermarkDb,
  readWatermark,
  watermarkKey,
  writeWatermark,
} from "./watermark.js";

const DEFAULT_BATCH_SIZE = 2000;
const DEFAULT_POST_BATCH_SIZE = 25;
const DEFAULT_IDLE_MS = 30_000;
const DEFAULT_CATCHUP_MS = 1_000;
const MAX_ITERATIONS_PER_TABLE = 50;

function matchesGlob(value: string, pattern: string): boolean {
  if (pattern === "*/*") return true;
  if (pattern.endsWith("/*")) {
    return value.startsWith(pattern.slice(0, -1));
  }
  return value === pattern;
}

function shouldSync(
  repository: string | null | undefined,
  opts: SyncOptions,
): boolean {
  if (!opts.filter) return true;
  if (!repository) return !opts.filter.includeRepos?.length;

  if (opts.filter.excludeRepos?.some((p) => matchesGlob(repository, p))) {
    return false;
  }
  if (opts.filter.includeRepos?.length) {
    return opts.filter.includeRepos.some((p) => matchesGlob(repository, p));
  }
  return true;
}

const TOKEN_CACHE_TTL_MS = 5 * 60 * 1000;

const tokenCache = new Map<string, { token: string; expiresAt: number }>();

function resolveToken(target: SyncTarget): string | undefined {
  if (target.token) return target.token;
  if (!target.tokenCommand) return undefined;

  const cached = tokenCache.get(target.name);
  if (cached && Date.now() < cached.expiresAt) return cached.token;

  try {
    const token = execSync(target.tokenCommand, {
      encoding: "utf-8",
      timeout: 10_000,
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    if (token) {
      tokenCache.set(target.name, {
        token,
        expiresAt: Date.now() + TOKEN_CACHE_TTL_MS,
      });
    }
    return token || undefined;
  } catch (err) {
    console.error(
      `[panopticon-sync] tokenCommand failed for "${target.name}": ${err instanceof Error ? err.message : err}`,
    );
    return undefined;
  }
}

export function createSyncLoop(opts: SyncOptions): SyncHandle {
  const batchSize = opts.batchSize ?? DEFAULT_BATCH_SIZE;
  const postBatchSize = opts.postBatchSize ?? DEFAULT_POST_BATCH_SIZE;
  const idleMs = opts.idleIntervalMs ?? DEFAULT_IDLE_MS;
  const catchUpMs = opts.catchUpIntervalMs ?? DEFAULT_CATCHUP_MS;
  const hooksInstalled = opts.hooksInstalled ?? false;
  const log =
    opts.log ?? ((msg: string) => console.error(`[panopticon-sync] ${msg}`));

  function resolveHeaders(target: SyncTarget): Record<string, string> {
    const headers: Record<string, string> = { ...target.headers };
    const token = resolveToken(target);
    if (token) {
      headers.Authorization = `Bearer ${token}`;
    }
    return headers;
  }

  let timer: ReturnType<typeof setTimeout> | null = null;
  let syncing = false;
  let stopping = false;

  function scheduleNext(hadWork: boolean): void {
    if (stopping) return;
    const delay = hadWork ? catchUpMs : idleMs;
    timer = setTimeout(() => {
      tick().catch((err) => log(`Tick error: ${err}`));
    }, delay);
    if (!opts.keepAlive && timer.unref) {
      timer.unref();
    }
  }

  async function syncHookEvents(target: SyncTarget): Promise<boolean> {
    const wmKey = watermarkKey("hook_events", target.name);
    const wm = readWatermark(wmKey);

    const { rows, maxId } = readHookEvents(wm, batchSize);
    if (rows.length === 0) return false;

    const filtered = rows.filter((r) => shouldSync(r.repository, opts));
    log(`hook_events: ${filtered.length} events (watermark ${wm} → ${maxId})`);
    const batches = chunk(filtered, postBatchSize);

    for (const batch of batches) {
      if (batch.length > 0) {
        const payload = serializeHookEvents(batch);
        await postOtlp(
          `${target.url}/v1/logs`,
          payload,
          resolveHeaders(target),
        );
      }
    }

    writeWatermark(wmKey, maxId);
    return rows.length === batchSize;
  }

  async function syncOtelLogs(target: SyncTarget): Promise<boolean> {
    const wmKey = watermarkKey("otel_logs", target.name);
    const wm = readWatermark(wmKey);

    const { rows, maxId } = readOtelLogs(wm, batchSize, hooksInstalled);
    if (rows.length === 0) return false;

    log(`otel_logs: ${rows.length} logs (watermark ${wm} → ${maxId})`);
    const filtered = rows.filter((r) => {
      const repo =
        (r.resourceAttributes?.["repository.full_name"] as string) ?? null;
      return shouldSync(repo, opts);
    });
    const batches = chunk(filtered, postBatchSize);

    for (const batch of batches) {
      if (batch.length > 0) {
        const payload = serializeOtelLogs(batch);
        await postOtlp(
          `${target.url}/v1/logs`,
          payload,
          resolveHeaders(target),
        );
      }
    }

    writeWatermark(wmKey, maxId);
    return rows.length === batchSize;
  }

  async function syncMetrics(target: SyncTarget): Promise<boolean> {
    const wmKey = watermarkKey("otel_metrics", target.name);
    const wm = readWatermark(wmKey);

    const { rows, maxId } = readMetrics(wm, batchSize);
    if (rows.length === 0) return false;

    log(`otel_metrics: ${rows.length} metrics (watermark ${wm} → ${maxId})`);
    const filtered = rows.filter((r) => {
      const repo =
        (r.resourceAttributes?.["repository.full_name"] as string) ?? null;
      return shouldSync(repo, opts);
    });
    const batches = chunk(filtered, postBatchSize);

    for (const batch of batches) {
      if (batch.length > 0) {
        const payload = serializeMetrics(batch);
        await postOtlp(
          `${target.url}/v1/metrics`,
          payload,
          resolveHeaders(target),
        );
      }
    }

    writeWatermark(wmKey, maxId);
    return rows.length === batchSize;
  }

  async function syncScannerTurns(target: SyncTarget): Promise<boolean> {
    const wmKey = watermarkKey("scanner_turns", target.name);
    const wm = readWatermark(wmKey);

    const { rows, maxId } = readScannerTurns(wm, batchSize);
    if (rows.length === 0) return false;

    log(`scanner_turns: ${rows.length} turns (watermark ${wm} → ${maxId})`);
    const batches = chunk(rows, postBatchSize);

    for (const batch of batches) {
      if (batch.length > 0) {
        const payload = serializeScannerTurns(batch);
        await postOtlp(
          `${target.url}/v1/logs`,
          payload,
          resolveHeaders(target),
        );
      }
    }

    writeWatermark(wmKey, maxId);
    return rows.length === batchSize;
  }

  async function syncOtelSpans(target: SyncTarget): Promise<boolean> {
    const wmKey = watermarkKey("otel_spans", target.name);
    const wm = readWatermark(wmKey);

    const { rows, maxId } = readOtelSpans(wm, batchSize);
    if (rows.length === 0) return false;

    log(`otel_spans: ${rows.length} spans (watermark ${wm} → ${maxId})`);
    const batches = chunk(rows, postBatchSize);

    for (const batch of batches) {
      if (batch.length > 0) {
        const payload = serializeOtelSpans(batch);
        await postOtlp(
          `${target.url}/v1/traces`,
          payload,
          resolveHeaders(target),
        );
      }
    }

    writeWatermark(wmKey, maxId);
    return rows.length === batchSize;
  }

  async function syncScannerEvents(target: SyncTarget): Promise<boolean> {
    const wmKey = watermarkKey("scanner_events", target.name);
    const wm = readWatermark(wmKey);

    const { rows, maxId } = readScannerEvents(wm, batchSize);
    if (rows.length === 0) return false;

    log(`scanner_events: ${rows.length} events (watermark ${wm} → ${maxId})`);
    const batches = chunk(rows, postBatchSize);

    for (const batch of batches) {
      if (batch.length > 0) {
        const payload = serializeScannerEvents(batch);
        await postOtlp(
          `${target.url}/v1/logs`,
          payload,
          resolveHeaders(target),
        );
      }
    }

    writeWatermark(wmKey, maxId);
    return rows.length === batchSize;
  }

  async function runOnce(): Promise<boolean> {
    let hasMore = false;

    for (const target of opts.targets) {
      try {
        // Round-robin: one batch from each table per iteration so all
        // tables make progress together and no single backlog blocks others.
        for (let i = 0; i < MAX_ITERATIONS_PER_TABLE; i++) {
          let anyWork = false;
          if (await syncHookEvents(target)) anyWork = true;
          if (await syncOtelLogs(target)) anyWork = true;
          if (await syncMetrics(target)) anyWork = true;
          if (await syncScannerTurns(target)) anyWork = true;
          if (await syncScannerEvents(target)) anyWork = true;
          if (await syncOtelSpans(target)) anyWork = true;
          if (!anyWork) break;
          hasMore = true;
        }
      } catch (err) {
        log(
          `Error syncing to ${target.name}: ${err instanceof Error ? err.message : err}`,
        );
        captureException(err, {
          component: "sync",
          target: target.name,
        });
      }
    }

    return hasMore;
  }

  async function tick(): Promise<void> {
    if (syncing || stopping) return;
    syncing = true;
    let hasMore = false;
    try {
      getDb(); // ensure DB is accessible
      hasMore = await runOnce();
    } catch (err) {
      log(
        `Cycle error: ${err instanceof Error ? (err.stack ?? err.message) : err}`,
      );
      captureException(err, { component: "sync" });
    } finally {
      syncing = false;
    }

    if (!stopping) {
      scheduleNext(hasMore);
    }
  }

  return {
    start() {
      if (timer || syncing) return;
      stopping = false;
      log("Starting sync");
      tick().catch((err) => log(`Tick error: ${err}`));
    },
    stop() {
      stopping = true;
      if (timer) {
        clearTimeout(timer);
        timer = null;
        log("Stopped sync");
      }
      closeWatermarkDb();
    },
  };
}
