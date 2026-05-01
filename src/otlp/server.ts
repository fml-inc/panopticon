import http from "node:http";
import { config } from "../config.js";
import { refreshIfStale } from "../db/pricing.js";
import {
  insertOtelLogs,
  insertOtelMetrics,
  insertOtelSpans,
  upsertSession,
} from "../db/store.js";
import { log } from "../log.js";
import { captureException } from "../sentry.js";
import { allTargets } from "../targets/index.js";
import { decodeLogs } from "./decode-logs.js";
import { decodeMetrics } from "./decode-metrics.js";
import { decodeTraces } from "./decode-traces.js";
import {
  ExportLogsServiceResponse,
  ExportMetricsServiceResponse,
  ExportTracesServiceResponse,
} from "./proto.js";

function collectBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

/** Map from OTel service.name to target ID, built lazily from target registry. */
let _serviceNameMap: Map<string, string> | null = null;
function serviceNameMap(): Map<string, string> {
  if (!_serviceNameMap) {
    _serviceNameMap = new Map();
    for (const t of allTargets()) {
      if (t.otel?.serviceName) {
        _serviceNameMap.set(t.otel.serviceName, t.id);
      }
    }
  }
  return _serviceNameMap;
}

/**
 * Create/enrich session rows from OTLP data. Derives:
 * - target from service.name mapping
 * - started_at_ms from earliest timestamp in the batch
 * - otel_* token columns from token metric values
 * - model from metric attributes
 */
function ensureSessionsFromOtel(
  rows: Array<{
    session_id?: string;
    timestamp_ns?: number;
    resource_attributes?: Record<string, unknown>;
    name?: string;
    value?: number;
    attributes?: Record<string, unknown>;
  }>,
): void {
  const sessions = new Map<
    string,
    {
      target?: string;
      minTimestampMs?: number;
      model?: string;
      otelInput: number;
      otelOutput: number;
      otelCacheRead: number;
      otelCacheCreation: number;
    }
  >();

  for (const row of rows) {
    const sid = row.session_id;
    if (!sid) continue;

    if (!sessions.has(sid)) {
      const serviceName = row.resource_attributes?.["service.name"];
      const target =
        typeof serviceName === "string"
          ? serviceNameMap().get(serviceName)
          : undefined;
      sessions.set(sid, {
        target,
        otelInput: 0,
        otelOutput: 0,
        otelCacheRead: 0,
        otelCacheCreation: 0,
      });
    }

    const sess = sessions.get(sid)!;

    // Derive timing from earliest timestamp
    if (row.timestamp_ns && row.timestamp_ns > 0) {
      const ms = Math.floor(row.timestamp_ns / 1_000_000);
      if (!sess.minTimestampMs || ms < sess.minTimestampMs) {
        sess.minTimestampMs = ms;
      }
    }

    // Extract model from attributes
    if (!sess.model && row.attributes) {
      const m = row.attributes.model ?? row.attributes["gen_ai.response.model"];
      if (typeof m === "string") sess.model = m;
    }

    // Aggregate token metrics
    if (
      row.name &&
      typeof row.value === "number" &&
      row.name.includes("token")
    ) {
      const tokenType =
        (row.attributes?.type as string) ??
        (row.attributes?.["gen_ai.token.type"] as string) ??
        (row.attributes?.token_type as string);
      if (tokenType === "input") sess.otelInput += row.value;
      else if (tokenType === "output") sess.otelOutput += row.value;
      else if (tokenType === "cacheRead" || tokenType === "cache_read")
        sess.otelCacheRead += row.value;
      else if (tokenType === "cacheCreation" || tokenType === "cache_write")
        sess.otelCacheCreation += row.value;
    }
  }

  for (const [sessionId, sess] of sessions) {
    if (!sess.target) continue;
    upsertSession({
      session_id: sessionId,
      target: sess.target,
      started_at_ms: sess.minTimestampMs,
      model: sess.model,
      otel_input_tokens: sess.otelInput || undefined,
      otel_output_tokens: sess.otelOutput || undefined,
      otel_cache_read_tokens: sess.otelCacheRead || undefined,
      otel_cache_creation_tokens: sess.otelCacheCreation || undefined,
      has_otel: 1,
    });
  }
}

function isProtobuf(req: http.IncomingMessage): boolean {
  const ct = req.headers["content-type"] ?? "";
  return (
    ct.includes("application/x-protobuf") || ct.includes("application/protobuf")
  );
}

function isJson(req: http.IncomingMessage): boolean {
  const ct = req.headers["content-type"] ?? "";
  return ct.includes("application/json");
}

type Signal = "logs" | "metrics" | "traces";

function detectSignal(url: string): Signal | null {
  if (url.includes("/logs")) return "logs";
  if (url.includes("/metrics")) return "metrics";
  if (url.includes("/traces")) return "traces";
  return null;
}

/**
 * Gemini CLI sends all signals to "/" because it passes the base endpoint
 * as the full URL. Sniff the body to determine the signal type.
 */
function sniffSignalFromBody(body: Buffer, protobuf: boolean): Signal | null {
  if (protobuf) {
    // Try decoding as each type — first successful one wins
    try {
      const rows = decodeLogs(body);
      if (rows.length > 0) return "logs";
    } catch {}
    try {
      const rows = decodeMetrics(body);
      if (rows.length > 0) return "metrics";
    } catch {}
    try {
      const rows = decodeTraces(body);
      if (rows.length > 0) return "traces";
    } catch {}
    return null;
  }
  // JSON: check top-level keys
  try {
    const data = JSON.parse(body.toString("utf-8"));
    if (data.resourceLogs) return "logs";
    if (data.resourceMetrics) return "metrics";
    if (data.resourceSpans) return "traces";
  } catch {}
  return null;
}

/** Handle an OTLP ingest request (logs, metrics, traces). */
export async function handleOtlpRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = req.url ?? "";

  try {
    const body = await collectBody(req);

    // Detect signal from URL path, or sniff body for Gemini CLI (sends to "/")
    let signal = detectSignal(url);
    if (!signal && (url === "/" || url === "")) {
      signal = sniffSignalFromBody(body, isProtobuf(req));
    }

    if (signal === "logs") {
      if (isProtobuf(req)) {
        const rows = decodeLogs(body);
        if (rows.length > 0) {
          insertOtelLogs(rows);
          ensureSessionsFromOtel(rows);
        }
        const respBytes = ExportLogsServiceResponse.encode(
          ExportLogsServiceResponse.create({}),
        ).finish();
        res.writeHead(200, { "Content-Type": "application/x-protobuf" });
        res.end(Buffer.from(respBytes));
      } else if (isJson(req)) {
        const data = JSON.parse(body.toString("utf-8"));
        const rows = jsonLogsToRows(data);
        if (rows.length > 0) {
          insertOtelLogs(rows);
          ensureSessionsFromOtel(rows);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      } else {
        res.writeHead(415);
        res.end();
      }
    } else if (signal === "metrics") {
      // Metrics carry token data that needs pricing for cost queries
      refreshIfStale().catch(() => {});

      if (isProtobuf(req)) {
        const rows = decodeMetrics(body);
        if (rows.length > 0) {
          insertOtelMetrics(rows);
          ensureSessionsFromOtel(rows);
        }
        const respBytes = ExportMetricsServiceResponse.encode(
          ExportMetricsServiceResponse.create({}),
        ).finish();
        res.writeHead(200, { "Content-Type": "application/x-protobuf" });
        res.end(Buffer.from(respBytes));
      } else if (isJson(req)) {
        const data = JSON.parse(body.toString("utf-8"));
        const rows = jsonMetricsToRows(data);
        if (rows.length > 0) {
          insertOtelMetrics(rows);
          ensureSessionsFromOtel(rows);
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      } else {
        res.writeHead(415);
        res.end();
      }
    } else if (signal === "traces") {
      if (isProtobuf(req)) {
        const rows = decodeTraces(body);
        if (rows.length > 0) {
          insertOtelSpans(rows);
          ensureSessionsFromOtel(
            rows.map((r) => ({
              session_id: r.session_id,
              timestamp_ns: r.start_time_ns,
              resource_attributes: r.resource_attributes,
              attributes: r.attributes,
            })),
          );
        }
        const respBytes = ExportTracesServiceResponse.encode(
          ExportTracesServiceResponse.create({}),
        ).finish();
        res.writeHead(200, { "Content-Type": "application/x-protobuf" });
        res.end(Buffer.from(respBytes));
      } else if (isJson(req)) {
        const data = JSON.parse(body.toString("utf-8"));
        const rows = jsonTracesToRows(data);
        if (rows.length > 0) {
          insertOtelSpans(rows);
          ensureSessionsFromOtel(
            rows.map((r) => ({
              session_id: r.session_id,
              timestamp_ns: r.start_time_ns,
              resource_attributes: r.resource_attributes,
              attributes: r.attributes,
            })),
          );
        }
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      } else {
        res.writeHead(415);
        res.end();
      }
    } else {
      res.writeHead(404);
      res.end();
    }
  } catch (err) {
    log.otlp.error("OTLP handler error:", err);
    captureException(err, { component: "otlp", url });
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

export function createOtlpServer(): http.Server {
  return http.createServer(async (req, res) => {
    const url = req.url ?? "";
    const method = req.method ?? "";

    if (url === "/health" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok" }));
      return;
    }

    if (method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }

    await handleOtlpRequest(req, res);
  });
}

// Minimal JSON OTLP log parsing (fallback for JSON content-type)
function jsonLogsToRows(data: any): import("../db/store.js").OtelLogRow[] {
  const rows: import("../db/store.js").OtelLogRow[] = [];

  for (const rl of data.resourceLogs ?? []) {
    const resourceAttrs = kvListToMap(rl.resource?.attributes);
    const resourceSessionId =
      resourceAttrs["session.id"] ??
      resourceAttrs["conversation.id"] ??
      resourceAttrs["service.instance.id"];

    for (const sl of rl.scopeLogs ?? []) {
      for (const lr of sl.logRecords ?? []) {
        const attrs = kvListToMap(lr.attributes);

        // Codex sends event name in attrs["event.name"] with an empty body
        const rawBody = extractJsonAnyValue(lr.body);
        const body = rawBody ?? (attrs["event.name"] as string) ?? undefined;

        // Codex sends timeUnixNano=0 with real time in attrs["event.timestamp"]
        let timestamp_ns = parseInt(lr.timeUnixNano ?? "0", 10);
        if (!timestamp_ns && typeof attrs["event.timestamp"] === "string") {
          timestamp_ns =
            new Date(attrs["event.timestamp"] as string).getTime() * 1_000_000;
        }

        const sessionId = (attrs["session.id"] ??
          attrs["conversation.id"] ??
          resourceSessionId) as string | undefined;

        // Drop empty records — see decode-logs.ts for rationale.
        if (!body && !sessionId && !timestamp_ns) continue;

        rows.push({
          timestamp_ns,
          observed_timestamp_ns: lr.observedTimeUnixNano
            ? parseInt(lr.observedTimeUnixNano, 10)
            : undefined,
          severity_number: lr.severityNumber,
          severity_text: lr.severityText,
          body,
          attributes: Object.keys(attrs).length > 0 ? attrs : undefined,
          resource_attributes:
            Object.keys(resourceAttrs).length > 0 ? resourceAttrs : undefined,
          session_id: sessionId,
          prompt_id: (attrs["prompt.id"] ?? attrs.prompt_id) as
            | string
            | undefined,
          trace_id: lr.traceId,
          span_id: lr.spanId,
        });
      }
    }
  }
  return rows;
}

function jsonMetricsToRows(
  data: any,
): import("../db/store.js").OtelMetricRow[] {
  const rows: import("../db/store.js").OtelMetricRow[] = [];

  for (const rm of data.resourceMetrics ?? []) {
    const resourceAttrs = kvListToMap(rm.resource?.attributes);
    const resourceSessionId =
      resourceAttrs["session.id"] ??
      resourceAttrs["conversation.id"] ??
      resourceAttrs["service.instance.id"];

    for (const sm of rm.scopeMetrics ?? []) {
      for (const m of sm.metrics ?? []) {
        const dps =
          m.gauge?.dataPoints ??
          m.sum?.dataPoints ??
          m.histogram?.dataPoints ??
          [];
        const metricType = m.gauge
          ? "gauge"
          : m.sum
            ? "sum"
            : m.histogram
              ? "histogram"
              : undefined;

        for (const dp of dps) {
          const attrs = kvListToMap(dp.attributes);
          const value = dp.asDouble ?? dp.asInt ?? dp.sum ?? dp.count ?? 0;

          rows.push({
            timestamp_ns: parseInt(dp.timeUnixNano ?? "0", 10),
            name: m.name,
            value: Number(value),
            metric_type: metricType,
            unit: m.unit || undefined,
            attributes: Object.keys(attrs).length > 0 ? attrs : undefined,
            resource_attributes:
              Object.keys(resourceAttrs).length > 0 ? resourceAttrs : undefined,
            session_id: (attrs["session.id"] ??
              attrs["conversation.id"] ??
              resourceSessionId) as string | undefined,
          });
        }
      }
    }
  }
  return rows;
}

function extractJsonConversationId(promptName: unknown): string | undefined {
  if (typeof promptName !== "string") return undefined;
  const sep = promptName.indexOf("########");
  if (sep === -1) return undefined;
  const uuid = promptName.slice(0, sep);
  if (uuid.length === 36 && uuid[8] === "-") return uuid;
  return undefined;
}

function jsonTracesToRows(data: any): import("../db/store.js").OtelSpanRow[] {
  const rows: import("../db/store.js").OtelSpanRow[] = [];

  for (const rs of data.resourceSpans ?? []) {
    const resourceAttrs = kvListToMap(rs.resource?.attributes);
    const resourceSessionId =
      resourceAttrs["session.id"] ??
      resourceAttrs["conversation.id"] ??
      resourceAttrs["service.instance.id"];

    // Build trace_id → conversation_id map from gen_ai.prompt.name
    const traceConversation = new Map<string, string>();
    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const attrs = kvListToMap(span.attributes);
        const convId = extractJsonConversationId(attrs["gen_ai.prompt.name"]);
        if (convId && span.traceId) {
          traceConversation.set(span.traceId, convId);
        }
      }
    }

    for (const ss of rs.scopeSpans ?? []) {
      for (const span of ss.spans ?? []) {
        const attrs = kvListToMap(span.attributes);
        const conversationId = traceConversation.get(span.traceId ?? "");

        rows.push({
          trace_id: span.traceId ?? "",
          span_id: span.spanId ?? "",
          parent_span_id: span.parentSpanId || undefined,
          name: span.name ?? "",
          kind: span.kind ?? undefined,
          start_time_ns: parseInt(span.startTimeUnixNano ?? "0", 10),
          end_time_ns: parseInt(span.endTimeUnixNano ?? "0", 10),
          status_code: span.status?.code ?? undefined,
          status_message: span.status?.message || undefined,
          attributes: Object.keys(attrs).length > 0 ? attrs : undefined,
          resource_attributes:
            Object.keys(resourceAttrs).length > 0 ? resourceAttrs : undefined,
          session_id: (conversationId ??
            attrs["session.id"] ??
            attrs["conversation.id"] ??
            resourceSessionId) as string | undefined,
        });
      }
    }
  }
  return rows;
}

function kvListToMap(kvs: any[] | undefined): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!kvs) return out;
  for (const kv of kvs) {
    out[kv.key] = extractJsonAnyValue(kv.value);
  }
  return out;
}

function extractJsonAnyValue(v: any): any {
  if (!v) return null;
  if (v.stringValue !== undefined) return v.stringValue;
  if (v.intValue !== undefined) return Number(v.intValue);
  if (v.doubleValue !== undefined) return v.doubleValue;
  if (v.boolValue !== undefined) return v.boolValue;
  return JSON.stringify(v);
}

// When run directly, start the server
// Use normalized separators so this works on both Unix (/) and Windows (\)
const entryScript = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  entryScript.endsWith("/otlp/server.js") ||
  entryScript.endsWith("/otlp/server.ts")
) {
  const server = createOtlpServer();
  server.listen(config.otlpPort, config.otlpHost, () => {
    log.otlp.info(`Listening on ${config.otlpHost}:${config.otlpPort}`);
  });

  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", shutdown);
}
