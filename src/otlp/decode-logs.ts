import type { OtelLogRow } from "../db/store.js";
import {
  isQueryableLogRecord,
  normalizeLogBody,
  normalizeLogSessionId,
  normalizeLogTimestampNs,
} from "./log-normalize.js";
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

        // Codex sends event name in attrs["event.name"] with an empty body.
        const body = normalizeLogBody(rawBody, attrs["event.name"]);

        const observedTimestampNs =
          longToNumber(record.observedTimeUnixNano) || undefined;

        const sessionId = normalizeLogSessionId(
          attrs["session.id"],
          attrs["conversation.id"],
          resourceSessionId,
        );

        // Drop records that cannot be queried or correlated. Clients sometimes
        // emit probe/partial-flush records with only attributes or a tiny
        // placeholder timestamp; storing those only pollutes session-centric
        // views and data-hygiene checks.
        if (!isQueryableLogRecord(body, sessionId)) continue;

        rows.push({
          timestamp_ns: normalizeLogTimestampNs(
            longToNumber(record.timeUnixNano),
            attrs["event.timestamp"],
            observedTimestampNs,
          ),
          observed_timestamp_ns: observedTimestampNs,
          severity_number: record.severityNumber ?? undefined,
          severity_text: record.severityText || undefined,
          body,
          attributes: Object.keys(attrs).length > 0 ? attrs : undefined,
          resource_attributes:
            Object.keys(resourceAttrs).length > 0 ? resourceAttrs : undefined,
          session_id: sessionId,
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
