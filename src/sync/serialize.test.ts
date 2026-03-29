import { describe, expect, it } from "vitest";
import {
  mapToKvList,
  serializeHookEvents,
  serializeMetrics,
  serializeOtelLogs,
  toAnyValue,
} from "./serialize.js";
import type { HookEventRecord, MetricRow, OtelLogRecord } from "./types.js";

// ── toAnyValue ───────────────────────────────────────────────────────────────

describe("toAnyValue", () => {
  it("encodes strings", () => {
    expect(toAnyValue("hello")).toEqual({ stringValue: "hello" });
  });

  it("encodes integers as intValue strings", () => {
    expect(toAnyValue(42)).toEqual({ intValue: "42" });
  });

  it("encodes floats as doubleValue", () => {
    expect(toAnyValue(3.14)).toEqual({ doubleValue: 3.14 });
  });

  it("encodes booleans", () => {
    expect(toAnyValue(true)).toEqual({ boolValue: true });
  });

  it("encodes null as empty string", () => {
    expect(toAnyValue(null)).toEqual({ stringValue: "" });
  });

  it("encodes arrays", () => {
    expect(toAnyValue(["a", 1])).toEqual({
      arrayValue: {
        values: [{ stringValue: "a" }, { intValue: "1" }],
      },
    });
  });

  it("encodes objects as kvlist", () => {
    expect(toAnyValue({ foo: "bar" })).toEqual({
      kvlistValue: {
        values: [{ key: "foo", value: { stringValue: "bar" } }],
      },
    });
  });
});

// ── mapToKvList ──────────────────────────────────────────────────────────────

describe("mapToKvList", () => {
  it("converts object to OtlpKeyValue array", () => {
    const result = mapToKvList({ name: "test", count: 5 });
    expect(result).toEqual([
      { key: "name", value: { stringValue: "test" } },
      { key: "count", value: { intValue: "5" } },
    ]);
  });

  it("returns empty array for null", () => {
    expect(mapToKvList(null)).toEqual([]);
  });

  it("returns empty array for undefined", () => {
    expect(mapToKvList(undefined)).toEqual([]);
  });
});

// ── serializeHookEvents ──────────────────────────────────────────────────────

function makeEvent(overrides: Partial<HookEventRecord> = {}): HookEventRecord {
  return {
    hookId: 1,
    sessionId: "sess-1",
    eventType: "PostToolUse",
    timestampMs: 1700000000000,
    cwd: "/work",
    repository: "org/repo",
    toolName: "Bash",
    payload: { command: "ls" },
    userPrompt: null,
    filePath: null,
    command: "ls",
    toolResult: null,
    target: null,
    ...overrides,
  };
}

describe("serializeHookEvents", () => {
  it("produces valid OTLP resourceLogs structure", () => {
    const result = serializeHookEvents([makeEvent()]);

    expect(result.resourceLogs).toHaveLength(1);
    const rl = result.resourceLogs[0];
    expect(rl.resource.attributes).toEqual(
      expect.arrayContaining([
        { key: "service.name", value: { stringValue: "panopticon" } },
        { key: "session.id", value: { stringValue: "sess-1" } },
        { key: "repository.full_name", value: { stringValue: "org/repo" } },
      ]),
    );
    expect(rl.scopeLogs).toHaveLength(1);
    expect(rl.scopeLogs[0].logRecords).toHaveLength(1);
  });

  it("sets timeUnixNano as nanosecond string", () => {
    const result = serializeHookEvents([
      makeEvent({ timestampMs: 1700000000000 }),
    ]);
    const record = result.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(record.timeUnixNano).toBe("1700000000000000000");
  });

  it("sets body to event type", () => {
    const result = serializeHookEvents([
      makeEvent({ eventType: "PreToolUse" }),
    ]);
    const record = result.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(record.body).toEqual({ stringValue: "PreToolUse" });
  });

  it("includes tool_name and cwd in attributes", () => {
    const result = serializeHookEvents([makeEvent()]);
    const attrs = result.resourceLogs[0].scopeLogs[0].logRecords[0].attributes;
    const keys = attrs.map((a) => a.key);
    expect(keys).toContain("tool_name");
    expect(keys).toContain("cwd");
    expect(keys).toContain("event_type");
  });

  it("groups events by session+repository", () => {
    const result = serializeHookEvents([
      makeEvent({ sessionId: "s1", repository: "org/a" }),
      makeEvent({ hookId: 2, sessionId: "s1", repository: "org/a" }),
      makeEvent({ hookId: 3, sessionId: "s2", repository: "org/b" }),
    ]);
    expect(result.resourceLogs).toHaveLength(2);
    const counts = result.resourceLogs.map(
      (rl) => rl.scopeLogs[0].logRecords.length,
    );
    expect(counts.sort()).toEqual([1, 2]);
  });
});

// ── serializeOtelLogs ────────────────────────────────────────────────────────

function makeLog(overrides: Partial<OtelLogRecord> = {}): OtelLogRecord {
  return {
    id: 1,
    timestampNs: 1700000000000000000,
    body: "claude_code.api_request",
    attributes: { model: "claude-opus-4-6", cost_usd: 0.12 },
    resourceAttributes: null,
    severityText: "INFO",
    sessionId: "sess-1",
    promptId: "p-1",
    traceId: "t-1",
    spanId: "s-1",
    ...overrides,
  };
}

describe("serializeOtelLogs", () => {
  it("produces valid OTLP resourceLogs", () => {
    const result = serializeOtelLogs([makeLog()]);
    expect(result.resourceLogs).toHaveLength(1);
    const record = result.resourceLogs[0].scopeLogs[0].logRecords[0];
    expect(record.body).toEqual({ stringValue: "claude_code.api_request" });
    expect(record.severityText).toBe("INFO");
    expect(record.traceId).toBe("t-1");
    expect(record.spanId).toBe("s-1");
  });

  it("includes prompt.id in attributes", () => {
    const result = serializeOtelLogs([makeLog()]);
    const keys =
      result.resourceLogs[0].scopeLogs[0].logRecords[0].attributes.map(
        (a) => a.key,
      );
    expect(keys).toContain("prompt.id");
  });
});

// ── serializeMetrics ─────────────────────────────────────────────────────────

function makeMetric(overrides: Partial<MetricRow> = {}): MetricRow {
  return {
    id: 1,
    timestampNs: 1700000000000000000,
    name: "claude_code.token.usage",
    value: 1500,
    metricType: "sum",
    unit: "tokens",
    attributes: { type: "input", model: "claude-opus-4-6" },
    resourceAttributes: null,
    sessionId: "sess-1",
    ...overrides,
  };
}

describe("serializeMetrics", () => {
  it("produces valid OTLP resourceMetrics", () => {
    const result = serializeMetrics([makeMetric()]);
    expect(result.resourceMetrics).toHaveLength(1);
    const metrics = result.resourceMetrics[0].scopeMetrics[0].metrics;
    expect(metrics).toHaveLength(1);
    expect(metrics[0].name).toBe("claude_code.token.usage");
    expect(metrics[0].unit).toBe("tokens");
  });

  it("uses gauge for all metrics", () => {
    const result = serializeMetrics([makeMetric({ metricType: "sum" })]);
    const metric = result.resourceMetrics[0].scopeMetrics[0].metrics[0];
    expect(metric.gauge).toBeDefined();
    expect(metric.sum).toBeUndefined();
  });

  it("sets dataPoint value and timestamp", () => {
    const result = serializeMetrics([makeMetric()]);
    const dp =
      result.resourceMetrics[0].scopeMetrics[0].metrics[0].gauge!.dataPoints[0];
    expect(dp.asDouble).toBe(1500);
    expect(dp.timeUnixNano).toBe("1700000000000000000");
  });

  it("groups by session and metric name", () => {
    const result = serializeMetrics([
      makeMetric({ name: "a", value: 1 }),
      makeMetric({ id: 2, name: "a", value: 2 }),
      makeMetric({ id: 3, name: "b", value: 3 }),
    ]);
    const metrics = result.resourceMetrics[0].scopeMetrics[0].metrics;
    expect(metrics).toHaveLength(2);
    const metricA = metrics.find((m) => m.name === "a")!;
    expect(metricA.gauge!.dataPoints).toHaveLength(2);
  });

  it("includes attributes on datapoints", () => {
    const result = serializeMetrics([makeMetric()]);
    const dp =
      result.resourceMetrics[0].scopeMetrics[0].metrics[0].gauge!.dataPoints[0];
    const keys = dp.attributes.map((a) => a.key);
    expect(keys).toContain("type");
    expect(keys).toContain("model");
  });
});
