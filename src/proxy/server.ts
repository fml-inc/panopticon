import http from "node:http";
import https from "node:https";
import { config } from "../config.js";
import { emitHookEventAsync, emitOtelLogs, emitOtelMetrics } from "./emit.js";
import { anthropicParser } from "./formats/anthropic.js";
import { openaiParser } from "./formats/openai.js";
import type { ApiFormatParser, CapturedExchange } from "./formats/types.js";
import { SessionTracker } from "./sessions.js";
import {
  createAnthropicAccumulator,
  createOpenaiAccumulator,
  isStreamingRequest,
} from "./streaming.js";

const UPSTREAM_ROUTES: Record<string, string> = {
  anthropic: "api.anthropic.com",
  openai: "api.openai.com",
  google: "generativelanguage.googleapis.com",
};

const FORMAT_PARSERS: ApiFormatParser[] = [anthropicParser, openaiParser];

const sessions = new SessionTracker();

interface Route {
  vendor: string;
  upstream: string;
  path: string;
}

function parseRoute(url: string): Route | null {
  // Match /vendor/rest-of-path
  const match = url.match(/^\/([^/]+)(\/.*)?$/);
  if (!match) return null;

  const vendor = match[1];
  const upstream = UPSTREAM_ROUTES[vendor];
  if (!upstream) return null;

  return { vendor, upstream, path: match[2] ?? "/" };
}

function collectBody(req: http.IncomingMessage): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on("data", (chunk: Buffer) => chunks.push(chunk));
    req.on("end", () => resolve(Buffer.concat(chunks)));
    req.on("error", reject);
  });
}

function processCapture(capture: CapturedExchange): void {
  for (const parser of FORMAT_PARSERS) {
    if (!parser.matches(capture.request.path)) continue;

    const hookEvents = parser.extractEvents(capture);
    for (const event of hookEvents) {
      event.source = "proxy";
      event.vendor = capture.vendor;
      emitHookEventAsync(event);
    }

    const metrics = parser.extractMetrics(capture);
    for (const metric of metrics) {
      metric.attributes = { ...metric.attributes, source: "proxy" };
    }
    if (metrics.length > 0) {
      emitOtelMetrics(metrics);
    }

    const logs = parser.extractLogs(capture);
    for (const log of logs) {
      log.attributes = { ...log.attributes, source: "proxy" };
    }
    if (logs.length > 0) {
      emitOtelLogs(logs);
    }

    return; // Only use first matching parser
  }
}

function forwardNonStreaming(
  route: Route,
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  requestBody: Buffer,
  parsedReqBody: unknown,
): void {
  const startMs = Date.now();
  const { sessionId, isNew } = sessions.getOrCreateSession(
    route.vendor,
    parsedReqBody,
  );

  if (isNew) {
    emitHookEventAsync({
      session_id: sessionId,
      hook_event_name: "SessionStart",
      source: "proxy",
      vendor: route.vendor,
    });
  }

  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(clientReq.headers)) {
    if (value !== undefined && key !== "host") {
      headers[key] = value;
    }
  }

  const upstreamReq = https.request(
    {
      hostname: route.upstream,
      port: 443,
      path: route.path,
      method: clientReq.method,
      headers,
    },
    (upstreamRes) => {
      const chunks: Buffer[] = [];
      upstreamRes.on("data", (chunk: Buffer) => chunks.push(chunk));
      upstreamRes.on("end", () => {
        const responseBody = Buffer.concat(chunks);
        const duration_ms = Date.now() - startMs;

        // Forward response to client
        clientRes.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);
        clientRes.end(responseBody);

        // Capture and process
        let parsedResBody: unknown;
        try {
          parsedResBody = JSON.parse(responseBody.toString("utf-8"));
        } catch {
          parsedResBody = {};
        }

        const capture: CapturedExchange = {
          vendor: route.vendor,
          sessionId,
          timestamp_ms: startMs,
          request: {
            path: route.path,
            headers: flattenHeaders(clientReq.headers),
            body: parsedReqBody,
          },
          response: {
            status: upstreamRes.statusCode ?? 0,
            body: parsedResBody,
          },
          duration_ms,
        };

        processCapture(capture);
      });
    },
  );

  upstreamReq.on("error", (err) => {
    console.error(`Upstream error (${route.vendor}):`, err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502);
      clientRes.end(
        JSON.stringify({ error: "upstream_error", message: err.message }),
      );
    }
  });

  upstreamReq.write(requestBody);
  upstreamReq.end();
}

function forwardStreaming(
  route: Route,
  clientReq: http.IncomingMessage,
  clientRes: http.ServerResponse,
  requestBody: Buffer,
  parsedReqBody: unknown,
): void {
  const startMs = Date.now();
  const { sessionId, isNew } = sessions.getOrCreateSession(
    route.vendor,
    parsedReqBody,
  );

  if (isNew) {
    emitHookEventAsync({
      session_id: sessionId,
      hook_event_name: "SessionStart",
      source: "proxy",
      vendor: route.vendor,
    });
  }

  const accumulator =
    route.vendor === "anthropic"
      ? createAnthropicAccumulator()
      : createOpenaiAccumulator();

  const headers: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(clientReq.headers)) {
    if (value !== undefined && key !== "host") {
      headers[key] = value;
    }
  }

  const upstreamReq = https.request(
    {
      hostname: route.upstream,
      port: 443,
      path: route.path,
      method: clientReq.method,
      headers,
    },
    (upstreamRes) => {
      // Forward headers immediately
      clientRes.writeHead(upstreamRes.statusCode ?? 200, upstreamRes.headers);

      // Stream chunks through: forward to client + accumulate for capture
      upstreamRes.on("data", (chunk: Buffer) => {
        accumulator.push(chunk);
        clientRes.write(chunk);
      });

      upstreamRes.on("end", () => {
        clientRes.end();

        const duration_ms = Date.now() - startMs;
        const reconstructed = accumulator.finish();

        const capture: CapturedExchange = {
          vendor: route.vendor,
          sessionId,
          timestamp_ms: startMs,
          request: {
            path: route.path,
            headers: flattenHeaders(clientReq.headers),
            body: parsedReqBody,
          },
          response: {
            status: upstreamRes.statusCode ?? 0,
            body: reconstructed,
          },
          duration_ms,
        };

        processCapture(capture);
      });
    },
  );

  upstreamReq.on("error", (err) => {
    console.error(`Upstream error (${route.vendor}):`, err.message);
    if (!clientRes.headersSent) {
      clientRes.writeHead(502);
      clientRes.end(
        JSON.stringify({ error: "upstream_error", message: err.message }),
      );
    }
  });

  upstreamReq.write(requestBody);
  upstreamReq.end();
}

function flattenHeaders(
  headers: http.IncomingHttpHeaders,
): Record<string, string> {
  const flat: Record<string, string> = {};
  for (const [key, value] of Object.entries(headers)) {
    if (value !== undefined) {
      flat[key] = Array.isArray(value) ? value.join(", ") : value;
    }
  }
  return flat;
}

export function createProxyServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    const method = req.method ?? "";

    // Health check
    if (url === "/health" && method === "GET") {
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ status: "ok", port: config.proxyPort }));
      return;
    }

    if (method !== "POST") {
      res.writeHead(405);
      res.end();
      return;
    }

    const route = parseRoute(url);
    if (!route) {
      res.writeHead(404, { "Content-Type": "application/json" });
      res.end(
        JSON.stringify({
          error: "unknown_route",
          message: `Unknown path prefix. Use /anthropic/*, /openai/*, or /google/*`,
        }),
      );
      return;
    }

    try {
      const requestBody = await collectBody(req);

      // Parse request body once — used for streaming detection and session tracking
      let parsedReqBody: unknown;
      let streaming = false;
      try {
        parsedReqBody = JSON.parse(requestBody.toString("utf-8"));
        streaming = isStreamingRequest(parsedReqBody);
      } catch {
        parsedReqBody = {};
      }

      if (streaming) {
        forwardStreaming(route, req, res, requestBody, parsedReqBody);
      } else {
        forwardNonStreaming(route, req, res, requestBody, parsedReqBody);
      }
    } catch (err) {
      console.error("Proxy error:", err);
      if (!res.headersSent) {
        res.writeHead(500);
        res.end();
      }
    }
  });

  return server;
}

// When run directly, start the server
const entryScript = process.argv[1]?.replaceAll("\\", "/") ?? "";
if (
  entryScript.endsWith("/proxy/server.js") ||
  entryScript.endsWith("/proxy/server.ts")
) {
  const server = createProxyServer();
  server.listen(config.proxyPort, config.proxyHost, () => {
    console.log(
      `Panopticon proxy listening on ${config.proxyHost}:${config.proxyPort}`,
    );
    console.log("Routes:");
    for (const [prefix, host] of Object.entries(UPSTREAM_ROUTES)) {
      console.log(`  /${prefix}/* → https://${host}/*`);
    }
  });

  const shutdown = () => {
    server.close();
    process.exit(0);
  };
  process.on("SIGTERM", shutdown);
  process.on("SIGINT", shutdown);
  process.on("SIGHUP", shutdown);
}
