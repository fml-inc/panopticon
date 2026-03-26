import fs from "node:fs";
import http from "node:http";
import path from "node:path";
import { config } from "../config.js";
import { insertOtelLogs, insertOtelMetrics } from "../db/store.js";
import { captureException } from "../sentry.js";
import { decodeLogs } from "./decode-logs.js";
import { decodeMetrics } from "./decode-metrics.js";
import {
  ExportLogsServiceResponse,
  ExportMetricsServiceRequest,
  ExportMetricsServiceResponse,
} from "./proto.js";

/** Dump raw protobuf to a debug file for inspection. Enabled via PANOPTICON_OTLP_DEBUG=1 */
function debugDumpProtobuf(
  signal: string,
  body: Buffer,
  req: http.IncomingMessage,
): void {
  if (!process.env.PANOPTICON_OTLP_DEBUG) return;
  try {
    const debugDir = path.join(config.dataDir, "otlp-debug");
    fs.mkdirSync(debugDir, { recursive: true });
    const ts = Date.now();

    // Raw bytes
    fs.writeFileSync(path.join(debugDir, `${ts}-${signal}.bin`), body);

    // Decoded JSON (metrics only for now — that's where the mystery is)
    if (signal === "metrics" && isProtobuf(req)) {
      const decoded = ExportMetricsServiceRequest.decode(body);
      fs.writeFileSync(
        path.join(debugDir, `${ts}-${signal}.json`),
        JSON.stringify(decoded, null, 2),
      );
    }
  } catch (err) {
    console.error("OTLP debug dump error:", err);
  }
}

function collectBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
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
    return "traces"; // fallback
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

    debugDumpProtobuf(signal ?? "unknown", body, req);

    if (signal === "logs") {
      if (isProtobuf(req)) {
        const rows = decodeLogs(body);
        if (rows.length > 0) insertOtelLogs(rows);
        const respBytes = ExportLogsServiceResponse.encode(
          ExportLogsServiceResponse.create({}),
        ).finish();
        res.writeHead(200, { "Content-Type": "application/x-protobuf" });
        res.end(Buffer.from(respBytes));
      } else if (isJson(req)) {
        const data = JSON.parse(body.toString("utf-8"));
        const rows = jsonLogsToRows(data);
        if (rows.length > 0) insertOtelLogs(rows);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      } else {
        res.writeHead(415);
        res.end();
      }
    } else if (signal === "metrics") {
      if (isProtobuf(req)) {
        const rows = decodeMetrics(body);
        if (rows.length > 0) insertOtelMetrics(rows);
        const respBytes = ExportMetricsServiceResponse.encode(
          ExportMetricsServiceResponse.create({}),
        ).finish();
        res.writeHead(200, { "Content-Type": "application/x-protobuf" });
        res.end(Buffer.from(respBytes));
      } else if (isJson(req)) {
        const data = JSON.parse(body.toString("utf-8"));
        const rows = jsonMetricsToRows(data);
        if (rows.length > 0) insertOtelMetrics(rows);
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      } else {
        res.writeHead(415);
        res.end();
      }
    } else if (signal === "traces") {
      // Accept but ignore traces for now
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end("{}");
    } else {
      res.writeHead(404);
      res.end();
    }
  } catch (err) {
    console.error("OTLP handler error:", err);
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
          session_id: (attrs["session.id"] ??
            attrs["conversation.id"] ??
            resourceSessionId) as string | undefined,
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
    console.log(
      `Panopticon OTLP receiver listening on ${config.otlpHost}:${config.otlpPort}`,
    );
  });

  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", shutdown);
}
