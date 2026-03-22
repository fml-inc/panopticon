import type { HookInput, OtelMetricPayload } from "../emit.js";

export interface CapturedExchange {
  vendor: string;
  sessionId: string;
  timestamp_ms: number;
  request: {
    path: string;
    headers: Record<string, string>;
    body: unknown;
  };
  response: {
    status: number;
    body: unknown;
  };
  duration_ms: number;
}

export interface ApiFormatParser {
  /** Does this parser handle requests to the given path? */
  matches(path: string): boolean;

  /** Extract hook events from a captured request/response pair. */
  extractEvents(capture: CapturedExchange): HookInput[];

  /** Extract OTel metrics (token usage, etc.) from a captured exchange. */
  extractMetrics(capture: CapturedExchange): OtelMetricPayload[];

  /** Extract OTel log entries from a captured exchange. */
  extractLogs(capture: CapturedExchange): {
    body: string;
    attributes?: Record<string, unknown>;
    sessionId?: string;
    severityText?: string;
  }[];
}
