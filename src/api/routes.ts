/**
 * Server-side API route handler.
 *
 * Two endpoints:
 *   POST /api/tool  — read-only query dispatch (CLI + MCP)
 *   POST /api/exec  — write command dispatch (CLI only)
 */
import type http from "node:http";
import { needsResync } from "../db/schema.js";
import { log } from "../log.js";
import { readScannerStatus } from "../scanner/status.js";
import {
  directPanopticonService,
  dispatchExec,
  dispatchTool,
  EXEC_NAMES,
  isExecName,
  isToolName,
  TOOL_NAMES,
} from "../service/index.js";

const TOOLS_REQUIRING_DERIVED_STATE = new Set([
  "intent_for_code",
  "search_intent",
  "outcomes_for_intent",
  "session_summaries",
  "session_summary_detail",
  "why_code",
  "recent_work_on_path",
]);

function collectBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function jsonResponse(
  res: http.ServerResponse,
  status: number,
  data: unknown,
): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function writeResyncPendingResponse(res: http.ServerResponse): void {
  const status = readScannerStatus();
  jsonResponse(res, 503, {
    error:
      "Panopticon is rebuilding derived state. Retry when the rebuild completes.",
    phase: status?.phase ?? null,
    message: status?.message ?? "Derived-state rebuild pending",
  });
}

export async function handleApiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = req.url ?? "";

  let body: Record<string, unknown>;
  try {
    const raw = await collectBody(req);
    body = raw.length > 0 ? JSON.parse(raw.toString("utf-8")) : {};
  } catch {
    jsonResponse(res, 400, { error: "Invalid JSON body" });
    return;
  }

  if (url === "/api/tool") {
    const name = body.name as string | undefined;
    if (!name || !isToolName(name)) {
      jsonResponse(res, 404, {
        error: `Unknown tool: ${name}`,
        available: TOOL_NAMES,
      });
      return;
    }
    if (TOOLS_REQUIRING_DERIVED_STATE.has(name) && needsResync()) {
      writeResyncPendingResponse(res);
      return;
    }
    try {
      const params = (body.params as Record<string, unknown>) ?? {};
      const result = await dispatchTool(directPanopticonService, name, params);
      jsonResponse(res, 200, result);
    } catch (err) {
      log.server.error(`API tool "${name}" error:`, err);
      jsonResponse(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  if (url === "/api/exec") {
    const command = body.command as string | undefined;
    if (!command || !isExecName(command)) {
      jsonResponse(res, 404, {
        error: `Unknown command: ${command}`,
        available: EXEC_NAMES,
      });
      return;
    }
    try {
      const params = (body.params as Record<string, unknown>) ?? {};
      const result = await dispatchExec(
        directPanopticonService,
        command,
        params,
      );
      jsonResponse(res, 200, result ?? { ok: true });
    } catch (err) {
      log.server.error(`API exec "${command}" error:`, err);
      jsonResponse(res, 500, {
        error: err instanceof Error ? err.message : String(err),
      });
    }
    return;
  }

  jsonResponse(res, 404, { error: "Unknown API endpoint", url });
}
