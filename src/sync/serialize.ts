import type {
  HookEventRecord,
  MetricRow,
  OtelLogRecord,
  OtlpAnyValue,
  OtlpKeyValue,
  OtlpLogRecord,
  OtlpMetric,
  OtlpNumberDataPoint,
  OtlpResourceLogs,
  OtlpResourceMetrics,
} from "./types.js";

// ── AnyValue encoding ────────────────────────────────────────────────────────

export function toAnyValue(val: unknown): OtlpAnyValue {
  if (typeof val === "string") return { stringValue: val };
  if (typeof val === "boolean") return { boolValue: val };
  if (typeof val === "number") {
    return Number.isInteger(val)
      ? { intValue: String(val) }
      : { doubleValue: val };
  }
  if (val == null) return { stringValue: "" };
  if (Array.isArray(val)) {
    return { arrayValue: { values: val.map(toAnyValue) } };
  }
  if (typeof val === "object") {
    return {
      kvlistValue: {
        values: Object.entries(val as Record<string, unknown>).map(
          ([k, v]) => ({ key: k, value: toAnyValue(v) }),
        ),
      },
    };
  }
  return { stringValue: String(val) };
}

export function mapToKvList(
  obj: Record<string, unknown> | null | undefined,
): OtlpKeyValue[] {
  if (!obj) return [];
  return Object.entries(obj).map(([key, val]) => ({
    key,
    value: toAnyValue(val),
  }));
}

function kv(key: string, val: unknown): OtlpKeyValue {
  return { key, value: toAnyValue(val) };
}

// ── Resource grouping ────────────────────────────────────────────────────────

function resourceKey(sessionId: string, repository: string | null): string {
  return `${sessionId}:${repository ?? ""}`;
}

function resourceAttributes(
  sessionId: string,
  repository: string | null,
): OtlpKeyValue[] {
  const attrs: OtlpKeyValue[] = [
    kv("service.name", "panopticon"),
    kv("session.id", sessionId),
  ];
  if (repository) attrs.push(kv("repository.full_name", repository));
  return attrs;
}

// ── Hook events → OTLP logs ─────────────────────────────────────────────────

function hookEventToLogRecord(event: HookEventRecord): OtlpLogRecord {
  const attrs: OtlpKeyValue[] = [kv("event_type", event.eventType)];

  if (event.toolName) attrs.push(kv("tool_name", event.toolName));
  if (event.cwd) attrs.push(kv("cwd", event.cwd));
  if (event.userPrompt) attrs.push(kv("prompt", event.userPrompt));
  if (event.filePath) attrs.push(kv("file_path", event.filePath));
  if (event.command) attrs.push(kv("command", event.command));
  if (event.payload) attrs.push(kv("hook.payload", event.payload));

  return {
    timeUnixNano: String(event.timestampMs * 1_000_000),
    body: { stringValue: event.eventType },
    attributes: attrs,
  };
}

export function serializeHookEvents(
  events: HookEventRecord[],
): OtlpResourceLogs {
  const groups = new Map<
    string,
    { attrs: OtlpKeyValue[]; records: OtlpLogRecord[] }
  >();

  for (const event of events) {
    const key = resourceKey(event.sessionId, event.repository);
    if (!groups.has(key)) {
      groups.set(key, {
        attrs: resourceAttributes(event.sessionId, event.repository),
        records: [],
      });
    }
    groups.get(key)!.records.push(hookEventToLogRecord(event));
  }

  return {
    resourceLogs: Array.from(groups.values()).map((g) => ({
      resource: { attributes: g.attrs },
      scopeLogs: [{ logRecords: g.records }],
    })),
  };
}

// ── OTLP logs → OTLP logs ───────────────────────────────────────────────────

function otelLogToRecord(log: OtelLogRecord): OtlpLogRecord {
  const record: OtlpLogRecord = {
    timeUnixNano: String(log.timestampNs),
    body: { stringValue: log.body ?? "" },
    attributes: mapToKvList(log.attributes),
  };

  if (log.severityText) record.severityText = log.severityText;
  if (log.traceId) record.traceId = log.traceId;
  if (log.spanId) record.spanId = log.spanId;
  if (log.promptId) {
    record.attributes.push(kv("prompt.id", log.promptId));
  }

  return record;
}

export function serializeOtelLogs(logs: OtelLogRecord[]): OtlpResourceLogs {
  const groups = new Map<
    string,
    { attrs: OtlpKeyValue[]; records: OtlpLogRecord[] }
  >();

  for (const log of logs) {
    const sessionId = log.sessionId ?? "unknown";
    const repo =
      (log.resourceAttributes?.["repository.full_name"] as string) ?? null;
    const key = resourceKey(sessionId, repo);
    if (!groups.has(key)) {
      groups.set(key, {
        attrs: resourceAttributes(sessionId, repo),
        records: [],
      });
    }
    groups.get(key)!.records.push(otelLogToRecord(log));
  }

  return {
    resourceLogs: Array.from(groups.values()).map((g) => ({
      resource: { attributes: g.attrs },
      scopeLogs: [{ logRecords: g.records }],
    })),
  };
}

// ── Metrics → OTLP metrics ──────────────────────────────────────────────────

export function serializeMetrics(metrics: MetricRow[]): OtlpResourceMetrics {
  const sessions = new Map<
    string,
    {
      attrs: OtlpKeyValue[];
      metrics: Map<
        string,
        {
          unit: string | null;
          metricType: string | null;
          points: OtlpNumberDataPoint[];
        }
      >;
    }
  >();

  for (const m of metrics) {
    const sessionId = m.sessionId ?? "unknown";
    if (!sessions.has(sessionId)) {
      sessions.set(sessionId, {
        attrs: resourceAttributes(sessionId, null),
        metrics: new Map(),
      });
    }
    const session = sessions.get(sessionId)!;
    if (!session.metrics.has(m.name)) {
      session.metrics.set(m.name, {
        unit: m.unit,
        metricType: m.metricType,
        points: [],
      });
    }
    session.metrics.get(m.name)!.points.push({
      timeUnixNano: String(m.timestampNs),
      asDouble: m.value,
      attributes: mapToKvList(m.attributes),
    });
  }

  return {
    resourceMetrics: Array.from(sessions.values()).map((s) => ({
      resource: { attributes: s.attrs },
      scopeMetrics: [
        {
          metrics: Array.from(s.metrics.entries()).map(
            ([name, { unit, points }]): OtlpMetric => ({
              name,
              ...(unit ? { unit } : {}),
              gauge: { dataPoints: points },
            }),
          ),
        },
      ],
    })),
  };
}
