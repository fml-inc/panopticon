import { describe, expect, it } from "vitest";
import { decodeTraces } from "./decode-traces.js";
import { ExportTracesServiceRequest } from "./proto.js";

function encodeTraces(resourceSpans: any[]): Uint8Array {
  const msg = ExportTracesServiceRequest.create({ resourceSpans });
  return ExportTracesServiceRequest.encode(msg).finish();
}

describe("decodeTraces", () => {
  it("decodes a single span", () => {
    const buf = encodeTraces([
      {
        resource: {
          attributes: [
            {
              key: "session.id",
              value: { stringValue: "sess-1" },
            },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: Buffer.from("0123456789abcdef", "hex"),
                spanId: Buffer.from("fedcba98", "hex"),
                name: "LLM call",
                kind: 2,
                startTimeUnixNano: 1700000000000000000,
                endTimeUnixNano: 1700000001000000000,
                attributes: [{ key: "model", value: { stringValue: "gpt-4" } }],
                status: { code: 1, message: "OK" },
              },
            ],
          },
        ],
      },
    ]);

    const rows = decodeTraces(buf);
    expect(rows).toHaveLength(1);

    const row = rows[0];
    expect(row.trace_id).toBe("0123456789abcdef");
    expect(row.span_id).toBe("fedcba98");
    expect(row.name).toBe("LLM call");
    expect(row.kind).toBe(2);
    expect(row.status_code).toBe(1);
    expect(row.status_message).toBe("OK");
    expect(row.session_id).toBe("sess-1");
    expect(row.attributes).toEqual({ model: "gpt-4" });
  });

  it("extracts session_id from span attributes over resource", () => {
    const buf = encodeTraces([
      {
        resource: {
          attributes: [
            {
              key: "session.id",
              value: { stringValue: "resource-session" },
            },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: Buffer.from("aa", "hex"),
                spanId: Buffer.from("bb", "hex"),
                name: "test",
                startTimeUnixNano: 1000,
                endTimeUnixNano: 2000,
                attributes: [
                  {
                    key: "session.id",
                    value: { stringValue: "span-session" },
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);

    const rows = decodeTraces(buf);
    expect(rows[0].session_id).toBe("span-session");
  });

  it("falls back to conversation.id for session", () => {
    const buf = encodeTraces([
      {
        resource: {
          attributes: [
            {
              key: "conversation.id",
              value: { stringValue: "conv-1" },
            },
          ],
        },
        scopeSpans: [
          {
            spans: [
              {
                traceId: Buffer.from("aa", "hex"),
                spanId: Buffer.from("bb", "hex"),
                name: "test",
                startTimeUnixNano: 1000,
                endTimeUnixNano: 2000,
              },
            ],
          },
        ],
      },
    ]);

    const rows = decodeTraces(buf);
    expect(rows[0].session_id).toBe("conv-1");
  });

  it("handles parent_span_id", () => {
    const buf = encodeTraces([
      {
        scopeSpans: [
          {
            spans: [
              {
                traceId: Buffer.from("aa", "hex"),
                spanId: Buffer.from("bb", "hex"),
                parentSpanId: Buffer.from("cc", "hex"),
                name: "child",
                startTimeUnixNano: 1000,
                endTimeUnixNano: 2000,
              },
            ],
          },
        ],
      },
    ]);

    const rows = decodeTraces(buf);
    expect(rows[0].parent_span_id).toBe("cc");
  });

  it("returns empty array for empty input", () => {
    const buf = encodeTraces([]);
    expect(decodeTraces(buf)).toEqual([]);
  });
});
