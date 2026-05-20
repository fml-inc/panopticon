import { describe, expect, it } from "vitest";
import { decodeLogs } from "./decode-logs.js";
import { ExportLogsServiceRequest } from "./proto.js";

function encodeLogs(resourceLogs: any[]): Uint8Array {
  const msg = ExportLogsServiceRequest.create({ resourceLogs });
  return ExportLogsServiceRequest.encode(msg).finish();
}

describe("decodeLogs", () => {
  it("drops log records without a body or session id", () => {
    const buf = encodeLogs([
      {
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: 1,
                attributes: [
                  {
                    key: "probe",
                    value: { stringValue: "partial-flush" },
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);

    expect(decodeLogs(buf)).toEqual([]);
  });

  it("uses event.name for empty Codex bodies and normalizes bad timestamps", () => {
    const buf = encodeLogs([
      {
        resource: {
          attributes: [
            {
              key: "conversation.id",
              value: { stringValue: "codex-session" },
            },
          ],
        },
        scopeLogs: [
          {
            logRecords: [
              {
                timeUnixNano: 1,
                body: { stringValue: "" },
                observedTimeUnixNano: 1_713_670_100_000_000_000,
                attributes: [
                  {
                    key: "event.name",
                    value: { stringValue: "model_response" },
                  },
                ],
              },
            ],
          },
        ],
      },
    ]);

    const rows = decodeLogs(buf);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toMatchObject({
      body: "model_response",
      session_id: "codex-session",
      timestamp_ns: 1_713_670_100_000_000_000,
    });
  });
});
