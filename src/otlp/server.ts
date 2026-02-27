import http from "node:http";
import { config } from "../config.js";
import { insertOtelLogs, insertOtelMetrics } from "../db/store.js";
import { decodeLogs } from "./decode-logs.js";
import { decodeMetrics } from "./decode-metrics.js";
import {
  ExportLogsServiceResponse,
  ExportMetricsServiceResponse,
} from "./proto.js";

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
  return ct.includes("application/x-protobuf") || ct.includes("application/protobuf");
}

function isJson(req: http.IncomingMessage): boolean {
  const ct = req.headers["content-type"] ?? "";
  return ct.includes("application/json");
}

export function createOtlpServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    const method = req.method ?? "";

    // Health check
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

    try {
      const body = await collectBody(req);

      if (url === "/v1/logs") {
        if (isProtobuf(req)) {
          const rows = decodeLogs(body);
          if (rows.length > 0) insertOtelLogs(rows);
          const respBytes = ExportLogsServiceResponse.encode(
            ExportLogsServiceResponse.create({})
          ).finish();
          res.writeHead(200, { "Content-Type": "application/x-protobuf" });
          res.end(Buffer.from(respBytes));
        } else if (isJson(req)) {
          // JSON OTLP format — store raw for now
          const data = JSON.parse(body.toString("utf-8"));
          const rows = jsonLogsToRows(data);
          if (rows.length > 0) insertOtelLogs(rows);
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end("{}");
        } else {
          res.writeHead(415);
          res.end();
        }
      } else if (url === "/v1/metrics") {
        if (isProtobuf(req)) {
          const rows = decodeMetrics(body);
          if (rows.length > 0) insertOtelMetrics(rows);
          const respBytes = ExportMetricsServiceResponse.encode(
            ExportMetricsServiceResponse.create({})
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
      } else if (url === "/v1/traces") {
        // Accept but ignore traces for now
        res.writeHead(200, { "Content-Type": "application/json" });
        res.end("{}");
      } else {
        res.writeHead(404);
        res.end();
      }
    } catch (err) {
      console.error("OTLP handler error:", err);
      res.writeHead(500);
      res.end();
    }
  });

  return server;
}

// Minimal JSON OTLP log parsing (fallback for JSON content-type)
function jsonLogsToRows(data: any): import("../db/store.js").OtelLogRow[] {
  const rows: import("../db/store.js").OtelLogRow[] = [];

  for (const rl of data.resourceLogs ?? []) {
    const resourceAttrs = kvListToMap(rl.resource?.attributes);
    const resourceSessionId =
      resourceAttrs["session.id"] ?? resourceAttrs["service.instance.id"];

    for (const sl of rl.scopeLogs ?? []) {
      for (const lr of sl.logRecords ?? []) {
        const attrs = kvListToMap(lr.attributes);
        rows.push({
          timestamp_ns: parseInt(lr.timeUnixNano ?? "0"),
          observed_timestamp_ns: lr.observedTimeUnixNano
            ? parseInt(lr.observedTimeUnixNano)
            : undefined,
          severity_number: lr.severityNumber,
          severity_text: lr.severityText,
          body: extractJsonAnyValue(lr.body),
          attributes: Object.keys(attrs).length > 0 ? attrs : undefined,
          resource_attributes:
            Object.keys(resourceAttrs).length > 0 ? resourceAttrs : undefined,
          session_id: (attrs["session.id"] ?? resourceSessionId) as string | undefined,
          prompt_id: (attrs["prompt.id"] ?? attrs["prompt_id"]) as
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
  data: any
): import("../db/store.js").OtelMetricRow[] {
  const rows: import("../db/store.js").OtelMetricRow[] = [];

  for (const rm of data.resourceMetrics ?? []) {
    const resourceAttrs = kvListToMap(rm.resource?.attributes);
    const resourceSessionId =
      resourceAttrs["session.id"] ?? resourceAttrs["service.instance.id"];

    for (const sm of rm.scopeMetrics ?? []) {
      for (const m of sm.metrics ?? []) {
        const dps =
          m.gauge?.dataPoints ?? m.sum?.dataPoints ?? m.histogram?.dataPoints ?? [];
        const metricType = m.gauge
          ? "gauge"
          : m.sum
            ? "sum"
            : m.histogram
              ? "histogram"
              : undefined;

        for (const dp of dps) {
          const attrs = kvListToMap(dp.attributes);
          const value =
            dp.asDouble ?? dp.asInt ?? dp.sum ?? dp.count ?? 0;

          rows.push({
            timestamp_ns: parseInt(dp.timeUnixNano ?? "0"),
            name: m.name,
            value: Number(value),
            metric_type: metricType,
            unit: m.unit || undefined,
            attributes: Object.keys(attrs).length > 0 ? attrs : undefined,
            resource_attributes:
              Object.keys(resourceAttrs).length > 0
                ? resourceAttrs
                : undefined,
            session_id: (attrs["session.id"] ?? resourceSessionId) as string | undefined,
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
if (
  process.argv[1] &&
  (process.argv[1].endsWith("/otlp/server.js") ||
    process.argv[1].endsWith("/otlp/server.ts"))
) {
  const server = createOtlpServer();
  server.listen(config.otlpPort, () => {
    console.log(`Panopticon OTLP receiver listening on :${config.otlpPort}`);
  });

  process.on("SIGTERM", () => {
    server.close();
    process.exit(0);
  });
  process.on("SIGINT", () => {
    server.close();
    process.exit(0);
  });
}
