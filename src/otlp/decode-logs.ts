import type { OtelLogRow } from "../db/store.js";
import {
  attrsToMap,
  bytesToHex,
  ExportLogsServiceRequest,
  extractAnyValue,
  longToNumber,
} from "./proto.js";

export function decodeLogs(buf: Uint8Array): OtelLogRow[] {
  const message = ExportLogsServiceRequest.decode(buf) as any;
  const rows: OtelLogRow[] = [];

  for (const resourceLog of message.resourceLogs ?? []) {
    const resourceAttrs = attrsToMap(resourceLog.resource?.attributes);
    // session.id may be in resource_attributes or per-record attributes
    const resourceSessionId =
      (resourceAttrs["session.id"] as string) ??
      (resourceAttrs["conversation.id"] as string) ??
      (resourceAttrs["service.instance.id"] as string) ??
      undefined;

    for (const scopeLog of resourceLog.scopeLogs ?? []) {
      for (const record of scopeLog.logRecords ?? []) {
        const attrs = attrsToMap(record.attributes);
        const rawBody = extractAnyValue(record.body);

        // Codex sends event name in attrs["event.name"] with an empty body
        const body =
          typeof rawBody === "string"
            ? rawBody
            : rawBody != null
              ? JSON.stringify(rawBody)
              : ((attrs["event.name"] as string) ?? undefined);

        // Codex sends timestamp_ns=0 with real time in attrs["event.timestamp"]
        let timestamp_ns = longToNumber(record.timeUnixNano);
        if (!timestamp_ns && typeof attrs["event.timestamp"] === "string") {
          timestamp_ns =
            new Date(attrs["event.timestamp"] as string).getTime() * 1_000_000;
        }

        rows.push({
          timestamp_ns,
          observed_timestamp_ns:
            longToNumber(record.observedTimeUnixNano) || undefined,
          severity_number: record.severityNumber ?? undefined,
          severity_text: record.severityText || undefined,
          body,
          attributes: Object.keys(attrs).length > 0 ? attrs : undefined,
          resource_attributes:
            Object.keys(resourceAttrs).length > 0 ? resourceAttrs : undefined,
          session_id:
            (attrs["session.id"] as string) ??
            (attrs["conversation.id"] as string) ??
            resourceSessionId,
          prompt_id: (attrs["prompt.id"] ?? attrs.prompt_id) as
            | string
            | undefined,
          trace_id: bytesToHex(record.traceId) || undefined,
          span_id: bytesToHex(record.spanId) || undefined,
        });
      }
    }
  }

  return rows;
}
