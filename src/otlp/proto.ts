import protobuf from "protobufjs";

// Define OTLP proto types inline using protobufjs JSON descriptors.
// This avoids needing to vendor .proto files.

const root = protobuf.Root.fromJSON({
  nested: {
    opentelemetry: {
      nested: {
        proto: {
          nested: {
            common: {
              nested: {
                v1: {
                  nested: {
                    AnyValue: {
                      oneofs: {
                        value: {
                          oneof: [
                            "stringValue",
                            "boolValue",
                            "intValue",
                            "doubleValue",
                            "arrayValue",
                            "kvlistValue",
                            "bytesValue",
                          ],
                        },
                      },
                      fields: {
                        stringValue: { type: "string", id: 1 },
                        boolValue: { type: "bool", id: 2 },
                        intValue: { type: "int64", id: 3 },
                        doubleValue: { type: "double", id: 4 },
                        arrayValue: {
                          type: "ArrayValue",
                          id: 5,
                        },
                        kvlistValue: {
                          type: "KeyValueList",
                          id: 6,
                        },
                        bytesValue: { type: "bytes", id: 7 },
                      },
                    },
                    ArrayValue: {
                      fields: {
                        values: {
                          rule: "repeated",
                          type: "AnyValue",
                          id: 1,
                        },
                      },
                    },
                    KeyValueList: {
                      fields: {
                        values: {
                          rule: "repeated",
                          type: "KeyValue",
                          id: 1,
                        },
                      },
                    },
                    KeyValue: {
                      fields: {
                        key: { type: "string", id: 1 },
                        value: { type: "AnyValue", id: 2 },
                      },
                    },
                    InstrumentationScope: {
                      fields: {
                        name: { type: "string", id: 1 },
                        version: { type: "string", id: 2 },
                        attributes: {
                          rule: "repeated",
                          type: "KeyValue",
                          id: 3,
                        },
                      },
                    },
                  },
                },
              },
            },
            resource: {
              nested: {
                v1: {
                  nested: {
                    Resource: {
                      fields: {
                        attributes: {
                          rule: "repeated",
                          type: "opentelemetry.proto.common.v1.KeyValue",
                          id: 1,
                        },
                        droppedAttributesCount: {
                          type: "uint32",
                          id: 2,
                        },
                      },
                    },
                  },
                },
              },
            },
            logs: {
              nested: {
                v1: {
                  nested: {
                    ExportLogsServiceRequest: {
                      fields: {
                        resourceLogs: {
                          rule: "repeated",
                          type: "ResourceLogs",
                          id: 1,
                        },
                      },
                    },
                    ResourceLogs: {
                      fields: {
                        resource: {
                          type: "opentelemetry.proto.resource.v1.Resource",
                          id: 1,
                        },
                        scopeLogs: {
                          rule: "repeated",
                          type: "ScopeLogs",
                          id: 2,
                        },
                        schemaUrl: { type: "string", id: 3 },
                      },
                    },
                    ScopeLogs: {
                      fields: {
                        scope: {
                          type: "opentelemetry.proto.common.v1.InstrumentationScope",
                          id: 1,
                        },
                        logRecords: {
                          rule: "repeated",
                          type: "LogRecord",
                          id: 2,
                        },
                        schemaUrl: { type: "string", id: 3 },
                      },
                    },
                    LogRecord: {
                      fields: {
                        timeUnixNano: {
                          type: "fixed64",
                          id: 1,
                        },
                        severityNumber: { type: "int32", id: 2 },
                        severityText: { type: "string", id: 3 },
                        body: {
                          type: "opentelemetry.proto.common.v1.AnyValue",
                          id: 5,
                        },
                        attributes: {
                          rule: "repeated",
                          type: "opentelemetry.proto.common.v1.KeyValue",
                          id: 6,
                        },
                        droppedAttributesCount: {
                          type: "uint32",
                          id: 7,
                        },
                        flags: { type: "fixed32", id: 8 },
                        traceId: { type: "bytes", id: 9 },
                        spanId: { type: "bytes", id: 10 },
                        observedTimeUnixNano: {
                          type: "fixed64",
                          id: 11,
                        },
                      },
                    },
                  },
                },
              },
            },
            metrics: {
              nested: {
                v1: {
                  nested: {
                    ExportMetricsServiceRequest: {
                      fields: {
                        resourceMetrics: {
                          rule: "repeated",
                          type: "ResourceMetrics",
                          id: 1,
                        },
                      },
                    },
                    ResourceMetrics: {
                      fields: {
                        resource: {
                          type: "opentelemetry.proto.resource.v1.Resource",
                          id: 1,
                        },
                        scopeMetrics: {
                          rule: "repeated",
                          type: "ScopeMetrics",
                          id: 2,
                        },
                        schemaUrl: { type: "string", id: 3 },
                      },
                    },
                    ScopeMetrics: {
                      fields: {
                        scope: {
                          type: "opentelemetry.proto.common.v1.InstrumentationScope",
                          id: 1,
                        },
                        metrics: {
                          rule: "repeated",
                          type: "Metric",
                          id: 2,
                        },
                        schemaUrl: { type: "string", id: 3 },
                      },
                    },
                    Metric: {
                      oneofs: {
                        data: {
                          oneof: ["gauge", "sum", "histogram"],
                        },
                      },
                      fields: {
                        name: { type: "string", id: 1 },
                        description: { type: "string", id: 2 },
                        unit: { type: "string", id: 3 },
                        gauge: { type: "Gauge", id: 5 },
                        sum: { type: "Sum", id: 7 },
                        histogram: { type: "Histogram", id: 9 },
                      },
                    },
                    Gauge: {
                      fields: {
                        dataPoints: {
                          rule: "repeated",
                          type: "NumberDataPoint",
                          id: 1,
                        },
                      },
                    },
                    Sum: {
                      fields: {
                        dataPoints: {
                          rule: "repeated",
                          type: "NumberDataPoint",
                          id: 1,
                        },
                        aggregationTemporality: {
                          type: "int32",
                          id: 2,
                        },
                        isMonotonic: { type: "bool", id: 3 },
                      },
                    },
                    Histogram: {
                      fields: {
                        dataPoints: {
                          rule: "repeated",
                          type: "HistogramDataPoint",
                          id: 1,
                        },
                        aggregationTemporality: {
                          type: "int32",
                          id: 2,
                        },
                      },
                    },
                    NumberDataPoint: {
                      oneofs: {
                        value: {
                          oneof: ["asDouble", "asInt"],
                        },
                      },
                      fields: {
                        attributes: {
                          rule: "repeated",
                          type: "opentelemetry.proto.common.v1.KeyValue",
                          id: 7,
                        },
                        startTimeUnixNano: {
                          type: "fixed64",
                          id: 2,
                        },
                        timeUnixNano: {
                          type: "fixed64",
                          id: 3,
                        },
                        asDouble: { type: "double", id: 4 },
                        asInt: { type: "sfixed64", id: 6 },
                      },
                    },
                    HistogramDataPoint: {
                      fields: {
                        attributes: {
                          rule: "repeated",
                          type: "opentelemetry.proto.common.v1.KeyValue",
                          id: 9,
                        },
                        startTimeUnixNano: {
                          type: "fixed64",
                          id: 2,
                        },
                        timeUnixNano: {
                          type: "fixed64",
                          id: 3,
                        },
                        count: { type: "fixed64", id: 4 },
                        sum: { type: "double", id: 5 },
                        bucketCounts: {
                          rule: "repeated",
                          type: "fixed64",
                          id: 6,
                          options: { packed: true },
                        },
                        explicitBounds: {
                          rule: "repeated",
                          type: "double",
                          id: 7,
                          options: { packed: true },
                        },
                        min: { type: "double", id: 11 },
                        max: { type: "double", id: 12 },
                      },
                    },
                  },
                },
              },
            },
            trace: {
              nested: {
                v1: {
                  nested: {
                    Span: {
                      fields: {
                        traceId: { type: "bytes", id: 1 },
                        spanId: { type: "bytes", id: 2 },
                        traceState: { type: "string", id: 3 },
                        parentSpanId: { type: "bytes", id: 4 },
                        name: { type: "string", id: 5 },
                        kind: { type: "int32", id: 6 },
                        startTimeUnixNano: {
                          type: "fixed64",
                          id: 7,
                        },
                        endTimeUnixNano: {
                          type: "fixed64",
                          id: 8,
                        },
                        attributes: {
                          rule: "repeated",
                          type: "opentelemetry.proto.common.v1.KeyValue",
                          id: 9,
                        },
                        status: { type: "Status", id: 15 },
                      },
                    },
                    Status: {
                      fields: {
                        message: { type: "string", id: 2 },
                        code: { type: "int32", id: 3 },
                      },
                    },
                    ResourceSpans: {
                      fields: {
                        resource: {
                          type: "opentelemetry.proto.resource.v1.Resource",
                          id: 1,
                        },
                        scopeSpans: {
                          rule: "repeated",
                          type: "ScopeSpans",
                          id: 2,
                        },
                        schemaUrl: { type: "string", id: 3 },
                      },
                    },
                    ScopeSpans: {
                      fields: {
                        scope: {
                          type: "opentelemetry.proto.common.v1.InstrumentationScope",
                          id: 1,
                        },
                        spans: {
                          rule: "repeated",
                          type: "Span",
                          id: 2,
                        },
                        schemaUrl: { type: "string", id: 3 },
                      },
                    },
                  },
                },
              },
            },
            collector: {
              nested: {
                logs: {
                  nested: {
                    v1: {
                      nested: {
                        ExportLogsServiceRequest: {
                          fields: {
                            resourceLogs: {
                              rule: "repeated",
                              type: "opentelemetry.proto.logs.v1.ResourceLogs",
                              id: 1,
                            },
                          },
                        },
                        ExportLogsServiceResponse: {
                          fields: {},
                        },
                      },
                    },
                  },
                },
                metrics: {
                  nested: {
                    v1: {
                      nested: {
                        ExportMetricsServiceRequest: {
                          fields: {
                            resourceMetrics: {
                              rule: "repeated",
                              type: "opentelemetry.proto.metrics.v1.ResourceMetrics",
                              id: 1,
                            },
                          },
                        },
                        ExportMetricsServiceResponse: {
                          fields: {},
                        },
                      },
                    },
                  },
                },
                trace: {
                  nested: {
                    v1: {
                      nested: {
                        ExportTracesServiceRequest: {
                          fields: {
                            resourceSpans: {
                              rule: "repeated",
                              type: "opentelemetry.proto.trace.v1.ResourceSpans",
                              id: 1,
                            },
                          },
                        },
                        ExportTracesServiceResponse: {
                          fields: {},
                        },
                      },
                    },
                  },
                },
              },
            },
          },
        },
      },
    },
  },
});

export const ExportLogsServiceRequest = root.lookupType(
  "opentelemetry.proto.collector.logs.v1.ExportLogsServiceRequest",
);
export const ExportMetricsServiceRequest = root.lookupType(
  "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceRequest",
);
export const ExportLogsServiceResponse = root.lookupType(
  "opentelemetry.proto.collector.logs.v1.ExportLogsServiceResponse",
);
export const ExportMetricsServiceResponse = root.lookupType(
  "opentelemetry.proto.collector.metrics.v1.ExportMetricsServiceResponse",
);
export const ExportTracesServiceRequest = root.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTracesServiceRequest",
);
export const ExportTracesServiceResponse = root.lookupType(
  "opentelemetry.proto.collector.trace.v1.ExportTracesServiceResponse",
);

// Helper: extract a scalar value from a protobuf AnyValue
export function extractAnyValue(v: any): string | number | boolean | null {
  if (!v) return null;
  if (v.stringValue != null) return v.stringValue;
  if (v.intValue != null) {
    return typeof v.intValue === "object" && v.intValue.toNumber
      ? v.intValue.toNumber()
      : Number(v.intValue);
  }
  if (v.doubleValue != null) return v.doubleValue;
  if (v.boolValue != null) return v.boolValue;
  if (v.bytesValue != null) return Buffer.from(v.bytesValue).toString("hex");
  if (v.arrayValue?.values)
    return v.arrayValue.values.map(extractAnyValue) as any;
  if (v.kvlistValue?.values) return attrsToMap(v.kvlistValue.values) as any;
  return null;
}

// Helper: convert repeated KeyValue to a plain object
export function attrsToMap(
  kvs: any[] | null | undefined,
): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  if (!kvs) return out;
  for (const kv of kvs) {
    if (kv.key) {
      out[kv.key] = extractAnyValue(kv.value);
    }
  }
  return out;
}

// Helper: convert Long-like fixed64 to number
export function longToNumber(val: any): number {
  if (val == null) return 0;
  if (typeof val === "number") return val;
  if (typeof val === "bigint") return Number(val);
  if (typeof val.toNumber === "function") return val.toNumber();
  return Number(val);
}

// Helper: convert bytes to hex string
export function bytesToHex(val: any): string {
  if (!val || val.length === 0) return "";
  return Buffer.from(val).toString("hex");
}
