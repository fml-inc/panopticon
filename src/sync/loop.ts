import { getDb } from "../db/schema.js";
import { chunk, postOtlp } from "./post.js";
import { readHookEvents, readMetrics, readOtelLogs } from "./reader.js";
import {
  serializeHookEvents,
  serializeMetrics,
  serializeOtelLogs,
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
    if (target.token) {
      headers.Authorization = `Bearer ${target.token}`;
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

  async function runOnce(): Promise<boolean> {
    let hasMore = false;

    for (const target of opts.targets) {
      try {
        for (let i = 0; i < MAX_ITERATIONS_PER_TABLE; i++) {
          if (!(await syncHookEvents(target))) break;
          hasMore = true;
        }
        for (let i = 0; i < MAX_ITERATIONS_PER_TABLE; i++) {
          if (!(await syncOtelLogs(target))) break;
          hasMore = true;
        }
        for (let i = 0; i < MAX_ITERATIONS_PER_TABLE; i++) {
          if (!(await syncMetrics(target))) break;
          hasMore = true;
        }
      } catch (err) {
        log(
          `Error syncing to ${target.name}: ${err instanceof Error ? err.message : err}`,
        );
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
