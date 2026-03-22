import { spawn } from "node:child_process";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const hookHandlerPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  "..",
  "hooks",
  "handler.js",
);

export interface HookInput {
  session_id: string;
  hook_event_name: string;
  cwd?: string;
  tool_name?: string;
  tool_input?: Record<string, unknown>;
  prompt?: string;
  [key: string]: unknown;
}

/** Spawn bin/hook-handler with JSON on stdin, same as Claude Code does. */
export function emitHookEvent(event: HookInput): Promise<string> {
  return new Promise((resolve, reject) => {
    const child = spawn("node", [hookHandlerPath], {
      stdio: ["pipe", "pipe", "pipe"],
    });

    const chunks: Buffer[] = [];
    child.stdout.on("data", (chunk: Buffer) => chunks.push(chunk));

    let stderr = "";
    child.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    child.on("close", (code) => {
      const output = Buffer.concat(chunks).toString("utf-8");
      if (code === 0) {
        resolve(output);
      } else {
        reject(new Error(`hook-handler exited ${code}: ${stderr}`));
      }
    });

    child.on("error", reject);

    child.stdin.write(JSON.stringify(event));
    child.stdin.end();
  });
}

/** Fire and forget — log errors but don't block. */
export function emitHookEventAsync(event: HookInput): void {
  emitHookEvent(event).catch((err) => {
    if (process.env.PANOPTICON_DEBUG) {
      console.error("proxy hook emit error:", err);
    }
  });
}

export interface OtelMetricPayload {
  name: string;
  value: number;
  unit?: string;
  attributes?: Record<string, unknown>;
  sessionId?: string;
}

/** POST OTel metrics to the existing OTLP receiver using JSON OTLP format. */
export function emitOtelMetrics(metrics: OtelMetricPayload[]): void {
  if (metrics.length === 0) return;

  const now = String(Date.now() * 1_000_000); // ms → ns as string

  const dataPoints = metrics.map((m) => ({
    timeUnixNano: now,
    asDouble: m.value,
    attributes: Object.entries(m.attributes ?? {}).map(([key, value]) => ({
      key,
      value:
        typeof value === "string"
          ? { stringValue: value }
          : typeof value === "number"
            ? { doubleValue: value }
            : { stringValue: String(value) },
    })),
  }));

  // Group metrics by name for proper OTLP structure
  const byName = new Map<string, typeof dataPoints>();
  for (let i = 0; i < metrics.length; i++) {
    const name = metrics[i].name;
    const arr = byName.get(name) ?? [];
    arr.push(dataPoints[i]);
    byName.set(name, arr);
  }

  const otlpMetrics = [...byName.entries()].map(([name, dps]) => ({
    name,
    unit: metrics.find((m) => m.name === name)?.unit,
    gauge: { dataPoints: dps },
  }));

  const resourceAttrs: { key: string; value: { stringValue: string } }[] = [];
  const sessionId = metrics[0].sessionId;
  if (sessionId) {
    resourceAttrs.push({
      key: "session.id",
      value: { stringValue: sessionId },
    });
  }

  const body = JSON.stringify({
    resourceMetrics: [
      {
        resource: { attributes: resourceAttrs },
        scopeMetrics: [{ metrics: otlpMetrics }],
      },
    ],
  });

  const req = http.request(
    {
      hostname: "127.0.0.1",
      port: config.otlpPort,
      path: "/v1/metrics",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    (res) => {
      res.resume(); // drain
    },
  );

  req.on("error", (err) => {
    if (process.env.PANOPTICON_DEBUG) {
      console.error("proxy OTel metric emit error:", err);
    }
  });

  req.write(body);
  req.end();
}

/** POST OTel log events to the existing OTLP receiver. */
export function emitOtelLogs(
  logs: {
    body: string;
    attributes?: Record<string, unknown>;
    sessionId?: string;
    severityText?: string;
  }[],
): void {
  if (logs.length === 0) return;

  const now = String(Date.now() * 1_000_000);

  const logRecords = logs.map((l) => ({
    timeUnixNano: now,
    severityText: l.severityText ?? "INFO",
    body: { stringValue: l.body },
    attributes: Object.entries(l.attributes ?? {}).map(([key, value]) => ({
      key,
      value:
        typeof value === "string"
          ? { stringValue: value }
          : typeof value === "number"
            ? { doubleValue: value }
            : { stringValue: String(value) },
    })),
  }));

  const resourceAttrs: { key: string; value: { stringValue: string } }[] = [];
  const sessionId = logs[0].sessionId;
  if (sessionId) {
    resourceAttrs.push({
      key: "session.id",
      value: { stringValue: sessionId },
    });
  }

  const body = JSON.stringify({
    resourceLogs: [
      {
        resource: { attributes: resourceAttrs },
        scopeLogs: [{ logRecords }],
      },
    ],
  });

  const req = http.request(
    {
      hostname: "127.0.0.1",
      port: config.otlpPort,
      path: "/v1/logs",
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Content-Length": Buffer.byteLength(body),
      },
    },
    (res) => {
      res.resume();
    },
  );

  req.on("error", (err) => {
    if (process.env.PANOPTICON_DEBUG) {
      console.error("proxy OTel log emit error:", err);
    }
  });

  req.write(body);
  req.end();
}
