import { execSync } from "node:child_process";
import { getDb } from "../db/schema.js";
import { captureException } from "../sentry.js";
import { chunk, postOtlp } from "./post.js";
import { TABLE_SYNC_REGISTRY } from "./registry.js";
import type {
  ReaderContext,
  SyncCapability,
  SyncHandle,
  SyncOptions,
  SyncTarget,
  TableSyncDescriptor,
} from "./types.js";
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

  const readerCtx: ReaderContext = { hooksInstalled };

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

  function descriptorsForTarget(
    target: SyncTarget,
  ): TableSyncDescriptor<unknown>[] {
    const caps: SyncCapability[] = target.capabilities ?? ["otlp"];
    return TABLE_SYNC_REGISTRY.filter((d) => caps.includes(d.capability));
  }

  /**
   * Sync one table to one target. Returns the synced rows (needed for
   * dirty-flag tables where we must clear flags after all targets succeed).
   */
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  async function syncTable(
    desc: TableSyncDescriptor<any>,
    target: SyncTarget,
  ): Promise<{ hadWork: boolean; rows: unknown[] }> {
    const wm = desc.dirtyFlag
      ? 0
      : readWatermark(watermarkKey(desc.table, target.name));

    const { rows, maxId } = desc.read(wm, batchSize, readerCtx);
    if (rows.length === 0) return { hadWork: false, rows: [] };

    const filtered = desc.extractRepo
      ? rows.filter((r: unknown) => shouldSync(desc.extractRepo!(r), opts))
      : rows;

    log(
      `${desc.table}: ${filtered.length} ${desc.logNoun}${desc.dirtyFlag ? " (dirty)" : ` (watermark ${wm} → ${maxId})`}`,
    );

    for (const batch of chunk(filtered, postBatchSize)) {
      if (batch.length > 0) {
        const payload = desc.serialize(batch);
        await postOtlp(
          `${target.url}${desc.endpoint}`,
          payload,
          resolveHeaders(target),
        );
      }
    }

    if (!desc.dirtyFlag) {
      writeWatermark(watermarkKey(desc.table, target.name), maxId);
    }

    return { hadWork: rows.length === batchSize, rows };
  }

  async function runOnce(): Promise<boolean> {
    let hasMore = false;

    // Collect dirty-flag rows synced to each target so we can clear
    // flags only after ALL targets have received the data.
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const dirtyResults = new Map<
      string,
      { desc: TableSyncDescriptor<any>; rowsByTarget: unknown[][] }
    >();

    for (const target of opts.targets) {
      try {
        const descs = descriptorsForTarget(target);
        // Round-robin: one batch from each table per iteration so all
        // tables make progress together and no single backlog blocks others.
        for (let i = 0; i < MAX_ITERATIONS_PER_TABLE; i++) {
          let anyWork = false;
          for (const desc of descs) {
            const result = await syncTable(desc, target);
            if (result.hadWork) anyWork = true;

            // Track dirty-flag rows per target
            if (desc.dirtyFlag && result.rows.length > 0) {
              let entry = dirtyResults.get(desc.table);
              if (!entry) {
                entry = { desc, rowsByTarget: [] };
                dirtyResults.set(desc.table, entry);
              }
              entry.rowsByTarget.push(result.rows);
            }
          }
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

    // Clear dirty flags for tables that synced to all targets
    for (const [, { desc, rowsByTarget }] of dirtyResults) {
      const targetCount = opts.targets.filter((t) =>
        (t.capabilities ?? ["otlp"]).includes(desc.capability),
      ).length;
      if (rowsByTarget.length >= targetCount && desc.clearDirty) {
        // Use the rows from the first target (they're all the same batch)
        desc.clearDirty(rowsByTarget[0]);
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
