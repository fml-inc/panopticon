/**
 * Server-side API route handler.
 *
 * Two endpoints:
 *   POST /api/tool  — read-only query dispatch (CLI + MCP)
 *   POST /api/exec  — write command dispatch (CLI only)
 */
import type http from "node:http";
import { refreshPricing } from "../db/pricing.js";
import { pruneEstimate, pruneExecute } from "../db/prune.js";
import {
  activitySummary,
  costBreakdown,
  dbStats,
  listPlans,
  listSessions,
  print,
  rawQuery,
  search,
  sessionTimeline,
} from "../db/query.js";
import { getDb } from "../db/schema.js";
import { log } from "../log.js";
import { addTarget, listTargets, removeTarget } from "../sync/config.js";
import { TABLE_SYNC_REGISTRY } from "../sync/registry.js";
import type { SyncTarget } from "../sync/types.js";
import {
  readWatermark,
  resetWatermarks,
  watermarkKey,
  writeWatermark,
} from "../sync/watermark.js";

// ── Tool dispatch ────────────────────────────────────────────────────────────

type ToolFn = (params: Record<string, unknown>) => unknown;

const TOOLS: Record<string, ToolFn> = {
  sessions: (p) => listSessions(p as Parameters<typeof listSessions>[0]),
  timeline: (p) => sessionTimeline(p as Parameters<typeof sessionTimeline>[0]),
  costs: (p) => costBreakdown(p as Parameters<typeof costBreakdown>[0]),
  summary: (p) => activitySummary(p as Parameters<typeof activitySummary>[0]),
  plans: (p) => listPlans(p as Parameters<typeof listPlans>[0]),
  search: (p) => search(p as Parameters<typeof search>[0]),
  get: (p) => print(p as Parameters<typeof print>[0]),
  query: (p) => rawQuery((p as { sql: string }).sql),
  status: () => dbStats(),
};

// ── Exec dispatch ────────────────────────────────────────────────────────────

type ExecFn = (params: Record<string, unknown>) => unknown;

const EXEC: Record<string, ExecFn> = {
  prune: (p) => {
    const cutoffMs = p.cutoffMs as number;
    if (typeof cutoffMs !== "number") {
      throw new Error("cutoffMs is required and must be a number");
    }
    if (p.dryRun) {
      return pruneEstimate(cutoffMs);
    }
    const result = pruneExecute(cutoffMs);
    if (p.vacuum) {
      const db = getDb();
      db.pragma("wal_checkpoint(TRUNCATE)");
      db.exec("VACUUM");
    }
    return result;
  },
  "refresh-pricing": () => refreshPricing(),
  "sync-reset": (p) => {
    const target = p.target as string | undefined;
    resetWatermarks(target);
    return { ok: true, target: target ?? "all" };
  },
  "sync-watermark-get": (p) => {
    const target = p.target as string;
    if (!target) throw new Error("target is required");
    const table = p.table as string | undefined;
    if (table) {
      return {
        key: watermarkKey(table, target),
        value: readWatermark(watermarkKey(table, target)),
      };
    }
    // Return all watermarks for this target
    const watermarks: Record<string, number> = {};
    for (const desc of TABLE_SYNC_REGISTRY) {
      const key = watermarkKey(desc.table, target);
      watermarks[desc.table] = readWatermark(key);
    }
    return { target, watermarks };
  },
  "sync-watermark-set": (p) => {
    const target = p.target as string;
    const table = p.table as string;
    const value = p.value as number;
    if (!target) throw new Error("target is required");
    if (!table) throw new Error("table is required");
    if (typeof value !== "number") throw new Error("value must be a number");
    const key = watermarkKey(table, target);
    writeWatermark(key, value);
    return { key, value };
  },
  "sync-pending": (p) => {
    const target = p.target as string;
    if (!target) throw new Error("target is required");
    const db = getDb();

    /** Maps table name → wm column in target_session_sync. */
    const WM_COLUMNS: Record<string, string> = {
      messages: "wm_messages",
      tool_calls: "wm_tool_calls",
      scanner_turns: "wm_scanner_turns",
      scanner_events: "wm_scanner_events",
      hook_events: "wm_hook_events",
      otel_logs: "wm_otel_logs",
      otel_metrics: "wm_otel_metrics",
      otel_spans: "wm_otel_spans",
    };

    const pending: Record<
      string,
      { total: number; synced: number; pending: number }
    > = {};
    for (const desc of TABLE_SYNC_REGISTRY) {
      const wmCol = WM_COLUMNS[desc.table];
      if (desc.sessionLinked && wmCol) {
        // Session-linked tables: count rows beyond each session's per-session watermark,
        // plus rows belonging to sessions not yet tracked in target_session_sync.
        const total =
          (
            db.prepare(`SELECT COUNT(*) as c FROM ${desc.table}`).get() as {
              c: number;
            }
          )?.c ?? 0;
        const pendingCount =
          (
            db
              .prepare(
                `SELECT COUNT(*) as c FROM ${desc.table} t
               LEFT JOIN target_session_sync tss
                 ON tss.session_id = t.session_id AND tss.target = ?
               WHERE tss.${wmCol} IS NULL OR t.id > tss.${wmCol}`,
              )
              .get(target) as { c: number }
          )?.c ?? 0;
        if (pendingCount > 0) {
          pending[desc.table] = {
            total,
            synced: total - pendingCount,
            pending: pendingCount,
          };
        }
      } else {
        // Sessions table and non-session-linked tables: use global watermark.
        const key = watermarkKey(desc.table, target);
        const wm = readWatermark(key);
        const maxId =
          (
            db
              .prepare(
                `SELECT MAX(${desc.table === "sessions" ? "sync_seq" : "id"}) as m FROM ${desc.table}`,
              )
              .get() as { m: number | null }
          )?.m ?? 0;
        const count = Math.max(0, maxId - wm);
        if (count > 0) {
          pending[desc.table] = { total: maxId, synced: wm, pending: count };
        }
      }
    }
    const totalPending = Object.values(pending).reduce(
      (s, v) => s + v.pending,
      0,
    );
    return { target, totalPending, tables: pending };
  },
  "sync-target-list": () => {
    return { targets: listTargets() };
  },
  "sync-target-add": (p) => {
    const target = p as unknown as SyncTarget;
    if (!target.name) throw new Error("name is required");
    if (!target.url) throw new Error("url is required");
    addTarget(target);
    return { ok: true, name: target.name, url: target.url };
  },
  "sync-target-remove": (p) => {
    const name = p.name as string;
    if (!name) throw new Error("name is required");
    const removed = removeTarget(name);
    return { ok: removed, name };
  },
};

// ── Request handler ──────────────────────────────────────────────────────────

function collectBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

export async function handleApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = req.url ?? "";

  let body: Record<string, unknown>;
  try {
    const raw = await collectBody(req);
    body = raw.length > 0 ? JSON.parse(raw.toString("utf-8")) : {};
  } catch {
    jsonResponse(res, 400, { error: "Invalid JSON body" });
    return;
  }

  if (url === "/api/tool") {
    const name = body.name as string | undefined;
    if (!name || !(name in TOOLS)) {
      jsonResponse(res, 404, {
        error: `Unknown tool: ${name}`,
        available: Object.keys(TOOLS),
      });
      return;
    }
    try {
      const params = (body.params as Record<string, unknown>) ?? {};
      const result = TOOLS[name](params);
      jsonResponse(res, 200, result);
    } catch (err) {
      log.server.error(`API tool "${name}" error:`, err);
      jsonResponse(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (url === "/api/exec") {
    const command = body.command as string | undefined;
    if (!command || !(command in EXEC)) {
      jsonResponse(res, 404, {
        error: `Unknown command: ${command}`,
        available: Object.keys(EXEC),
      });
      return;
    }
    try {
      const params = (body.params as Record<string, unknown>) ?? {};
      const result = await EXEC[command](params);
      jsonResponse(res, 200, result ?? { ok: true });
    } catch (err) {
      log.server.error(`API exec "${command}" error:`, err);
      jsonResponse(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  jsonResponse(res, 404, { error: "Unknown API endpoint", url });
}
