import type { OtelSpanRow } from "../db/store.js";
import {
  attrsToMap,
  bytesToHex,
  ExportTracesServiceRequest,
  longToNumber,
} from "./proto.js";

/**
 * Extract conversation ID from gen_ai.prompt.name attribute.
 * Gemini CLI sets this to "{conversation-uuid}########{turn}", where the
 * conversation UUID matches the session file ID — distinct from the OTel
 * session.id which is a process-level ID that persists across /clear.
 */
function extractConversationId(promptName: unknown): string | undefined {
  if (typeof promptName !== "string") return undefined;
  const sep = promptName.indexOf("########");
  if (sep === -1) return undefined;
  const uuid = promptName.slice(0, sep);
  // Basic UUID format check (8-4-4-4-12)
  if (uuid.length === 36 && uuid[8] === "-") return uuid;
  return undefined;
}

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

    // First pass: build trace_id → conversation_id map from spans that
    // carry gen_ai.prompt.name (Gemini llm_call spans). This lets us
    // assign the correct conversation-level session_id to all spans in
    // the same trace, even those without the attribute.
    const traceConversation = new Map<string, string>();
    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        const attrs = attrsToMap(span.attributes);
        const convId = extractConversationId(attrs["gen_ai.prompt.name"]);
        if (convId) {
          traceConversation.set(bytesToHex(span.traceId), convId);
        }
      }
    }

    for (const scopeSpan of resourceSpan.scopeSpans ?? []) {
      for (const span of scopeSpan.spans ?? []) {
        const attrs = attrsToMap(span.attributes);
        const traceId = bytesToHex(span.traceId);

        // Prefer conversation ID (matches session file) over OTel session.id
        const conversationId = traceConversation.get(traceId);

        rows.push({
          trace_id: traceId,
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
            conversationId ??
            (attrs["session.id"] as string) ??
            (attrs["conversation.id"] as string) ??
            resourceSessionId,
        });
      }
    }
  }

  return rows;
}
