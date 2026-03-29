import type { OtelSpanRow } from "../db/store.js";
import {
  attrsToMap,
  bytesToHex,
  ExportTracesServiceRequest,
  longToNumber,
} from "./proto.js";

export function decodeTraces(buf: Uint8Array): OtelSpanRow[] {
  const message = ExportTracesServiceRequest.decode(buf) as any;
  const rows: OtelSpanRow[] = [];

  for (const resourceSpan of message.resourceSpans ?? []) {
    const resourceAttrs = attrsToMap(resourceSpan.resource?.attributes);
    const resourceSessionId =
      (resourceAttrs["session.id"] as string) ??
      (resourceAttrs["conversation.id"] as string) ??
      (resourceAttrs["service.instance.id"] as string) ??
      undefined;

    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        const attrs = attrsToMap(span.attributes);

        rows.push({
          trace_id: bytesToHex(span.traceId),
          span_id: bytesToHex(span.spanId),
          parent_span_id: bytesToHex(span.parentSpanId) || undefined,
          name: span.name ?? "",
          kind: span.kind ?? undefined,
          start_time_ns: longToNumber(span.startTimeUnixNano),
          end_time_ns: longToNumber(span.endTimeUnixNano),
          status_code: span.status?.code ?? undefined,
          status_message: span.status?.message || undefined,
          attributes: Object.keys(attrs).length > 0 ? attrs : undefined,
          resource_attributes:
            Object.keys(resourceAttrs).length > 0 ? resourceAttrs : undefined,
          session_id:
            (attrs["session.id"] as string) ??
            (attrs["conversation.id"] as string) ??
            resourceSessionId,
        });
      }
    }
  }

  return rows;
}
