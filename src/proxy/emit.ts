import type { OtelLogRow, OtelMetricRow } from "../db/store.js";
import { insertOtelLogs, insertOtelMetrics } from "../db/store.js";
import { processHookEvent } from "../hooks/ingest.js";

export interface HookInput {
  session_id: string;
  hook_event_name: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  prompt?: string;
  source?: string;
  target?: string;
  [key: string]: unknown;
}

/** Process a hook event in-process (no subprocess spawn). */
export function emitHookEvent(event: HookInput): Record<string, unknown> {
  return processHookEvent(event);
}

/** Fire and forget — log errors but don't block. */
export function emitHookEventAsync(event: HookInput): void {
  try {
    processHookEvent(event);
  } catch (err) {
    if (process.env.PANOPTICON_DEBUG) {
      console.error("proxy hook emit error:", err);
    }
  }
}

export interface OtelMetricPayload {
  name: string;
  value: number;
  unit?: string;
  attributes?: Record<string, unknown>;
  sessionId?: string;
}

/** Write OTel metrics directly to DB (no HTTP round-trip). */
export function emitOtelMetrics(metrics: OtelMetricPayload[]): void {
  if (metrics.length === 0) return;

  const now = Date.now() * 1_000_000; // ms → ns

  try {
    const rows: OtelMetricRow[] = metrics.map((m) => ({
      timestamp_ns: now,
      name: m.name,
      value: m.value,
      metric_type: "gauge",
      unit: m.unit,
      attributes: m.attributes,
      resource_attributes: m.sessionId
        ? { "session.id": m.sessionId }
        : undefined,
      session_id: m.sessionId,
    }));
    insertOtelMetrics(rows);
  } catch (err) {
    if (process.env.PANOPTICON_DEBUG) {
      console.error("proxy OTel metric emit error:", err);
    }
  }
}

/** Write OTel log events directly to DB (no HTTP round-trip). */
export function emitOtelLogs(
  logs: {
    body: string;
    attributes?: Record<string, unknown>;
    sessionId?: string;
    severityText?: string;
  }[],
): void {
  if (logs.length === 0) return;

  const now = Date.now() * 1_000_000;

  try {
    const rows: OtelLogRow[] = logs.map((l) => ({
      timestamp_ns: now,
      severity_text: l.severityText ?? "INFO",
      body: l.body,
      attributes: l.attributes,
      resource_attributes: l.sessionId
        ? { "session.id": l.sessionId }
        : undefined,
      session_id: l.sessionId,
    }));
    insertOtelLogs(rows);
  } catch (err) {
    if (process.env.PANOPTICON_DEBUG) {
      console.error("proxy OTel log emit error:", err);
    }
  }
}
