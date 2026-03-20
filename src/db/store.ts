import { gzipSync } from "node:zlib";
import { detectAccountTypeFromAttributes } from "../account.js";
import { getDb } from "./schema.js";

export interface OtelLogRow {
  timestamp_ns: number;
  observed_timestamp_ns?: number;
  severity_number?: number;
  severity_text?: string;
  body?: string;
  attributes?: Record<string, unknown>;
  resource_attributes?: Record<string, unknown>;
  session_id?: string;
  prompt_id?: string;
  trace_id?: string;
  span_id?: string;
}

export interface OtelMetricRow {
  timestamp_ns: number;
  name: string;
  value: number;
  metric_type?: string;
  unit?: string;
  attributes?: Record<string, unknown>;
  resource_attributes?: Record<string, unknown>;
  session_id?: string;
}

export interface HookEventRow {
  session_id: string;
  event_type: string;
  timestamp_ms: number;
  cwd?: string;
  repository?: string;
  tool_name?: string;
  payload: unknown;
}

const INSERT_LOG_SQL = `
  INSERT INTO otel_logs (timestamp_ns, observed_timestamp_ns, severity_number, severity_text, body, attributes, resource_attributes, session_id, prompt_id, trace_id, span_id)
  VALUES (@timestamp_ns, @observed_timestamp_ns, @severity_number, @severity_text, @body, @attributes, @resource_attributes, @session_id, @prompt_id, @trace_id, @span_id)
`;

const INSERT_METRIC_SQL = `
  INSERT INTO otel_metrics (timestamp_ns, name, value, metric_type, unit, attributes, resource_attributes, session_id)
  VALUES (@timestamp_ns, @name, @value, @metric_type, @unit, @attributes, @resource_attributes, @session_id)
`;

const INSERT_HOOK_SQL = `
  INSERT INTO hook_events (session_id, event_type, timestamp_ms, cwd, repository, tool_name, payload)
  VALUES (@session_id, @event_type, @timestamp_ms, @cwd, @repository, @tool_name, @payload)
`;

/** Check OTel rows for account-type hints in resource_attributes and upsert if found. */
function detectAccountFromOtelRows(
  rows: {
    session_id?: string;
    resource_attributes?: Record<string, unknown>;
  }[],
): void {
  const seen = new Set<string>();
  for (const row of rows) {
    if (!row.session_id || seen.has(row.session_id)) continue;
    seen.add(row.session_id);
    const detected = detectAccountTypeFromAttributes(row.resource_attributes);
    if (detected && detected !== "unknown") {
      upsertSessionAccountType(
        row.session_id,
        detected,
        "resource_attributes",
        Date.now(),
      );
    }
  }
}

export function insertOtelLogs(rows: OtelLogRow[]): void {
  const db = getDb();
  const stmt = db.prepare(INSERT_LOG_SQL);
  const insertMany = db.transaction((rows: OtelLogRow[]) => {
    for (const row of rows) {
      stmt.run({
        timestamp_ns: row.timestamp_ns,
        observed_timestamp_ns: row.observed_timestamp_ns ?? null,
        severity_number: row.severity_number ?? null,
        severity_text: row.severity_text ?? null,
        body: row.body ?? null,
        attributes: row.attributes ? JSON.stringify(row.attributes) : null,
        resource_attributes: row.resource_attributes
          ? JSON.stringify(row.resource_attributes)
          : null,
        session_id: row.session_id ?? null,
        prompt_id: row.prompt_id ?? null,
        trace_id: row.trace_id ?? null,
        span_id: row.span_id ?? null,
      });
    }
  });
  insertMany(rows);
  detectAccountFromOtelRows(rows);
}

export function insertOtelMetrics(rows: OtelMetricRow[]): void {
  const db = getDb();
  const stmt = db.prepare(INSERT_METRIC_SQL);
  const insertMany = db.transaction((rows: OtelMetricRow[]) => {
    for (const row of rows) {
      stmt.run({
        timestamp_ns: row.timestamp_ns,
        name: row.name,
        value: row.value,
        metric_type: row.metric_type ?? null,
        unit: row.unit ?? null,
        attributes: row.attributes ? JSON.stringify(row.attributes) : null,
        resource_attributes: row.resource_attributes
          ? JSON.stringify(row.resource_attributes)
          : null,
        session_id: row.session_id ?? null,
      });
    }
  });
  insertMany(rows);
  detectAccountFromOtelRows(rows);
}

export function upsertSessionRepository(
  sessionId: string,
  repository: string,
  timestampMs: number,
): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO session_repositories (session_id, repository, first_seen_ms) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  ).run(sessionId, repository, timestampMs);
}

export function upsertSessionCwd(
  sessionId: string,
  cwd: string,
  timestampMs: number,
): void {
  const db = getDb();
  db.prepare(
    "INSERT INTO session_cwds (session_id, cwd, first_seen_ms) VALUES (?, ?, ?) ON CONFLICT DO NOTHING",
  ).run(sessionId, cwd, timestampMs);
}

export function upsertSessionAccountType(
  sessionId: string,
  accountType: string,
  detectedFrom: string,
  timestampMs: number,
): void {
  const db = getDb();
  // Only update if the new detection is more specific (not 'unknown')
  // or if no row exists yet
  db.prepare(
    `INSERT INTO session_metadata (session_id, account_type, detected_from, detected_at_ms)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(session_id) DO UPDATE SET
       account_type = CASE
         WHEN excluded.account_type != 'unknown' THEN excluded.account_type
         ELSE session_metadata.account_type
       END,
       detected_from = CASE
         WHEN excluded.account_type != 'unknown' THEN excluded.detected_from
         ELSE session_metadata.detected_from
       END,
       detected_at_ms = CASE
         WHEN excluded.account_type != 'unknown' THEN excluded.detected_at_ms
         ELSE session_metadata.detected_at_ms
       END`,
  ).run(sessionId, accountType, detectedFrom, timestampMs);
}

export function insertHookEvent(row: HookEventRow): void {
  const db = getDb();
  const json = JSON.stringify(row.payload);
  const insertWithFts = db.transaction(() => {
    db.prepare(INSERT_HOOK_SQL).run({
      session_id: row.session_id,
      event_type: row.event_type,
      timestamp_ms: row.timestamp_ms,
      cwd: row.cwd ?? null,
      repository: row.repository ?? null,
      tool_name: row.tool_name ?? null,
      payload: gzipSync(Buffer.from(json)),
    });
    const { id } = db.prepare("SELECT last_insert_rowid() as id").get() as {
      id: number;
    };
    db.prepare("INSERT INTO hook_events_fts(rowid, payload) VALUES (?, ?)").run(
      id,
      json,
    );
  });
  insertWithFts();
}
