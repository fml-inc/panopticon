import http from "node:http";
import https from "node:https";
import { config } from "../config.js";
import { addBreadcrumb, captureException } from "../sentry.js";
import { allTargets, getTarget } from "../targets/index.js";
import { emitHookEventAsync, emitOtelLogs, emitOtelMetrics } from "./emit.js";
import { anthropicParser } from "./formats/anthropic.js";
import { openaiParser } from "./formats/openai.js";
import { openaiResponsesParser } from "./formats/openai-responses.js";
import type { ApiFormatParser, CapturedExchange } from "./formats/types.js";
import { SessionTracker } from "./sessions.js";
import {
  createAnthropicAccumulator,
  createOpenaiAccumulator,
  isStreamingRequest,
} from "./streaming.js";
import { WebSocketMessageExtractor } from "./ws-capture.js";

// Build upstream route table from target adapters that have proxy specs,
// plus static entries for targets without full adapters (e.g. openai, google)
function buildUpstreamRoutes(): Record<string, string> {
  const routes: Record<string, string> = {};
  for (const v of allTargets()) {
    if (v.proxy && typeof v.proxy.upstreamHost === "string") {
      routes[v.id] = v.proxy.upstreamHost;
    }
  }
  // Static routes for API-only targets (not CLI tools with full adapters)
  if (!routes.openai) routes.openai = "api.openai.com";
  if (!routes.google) routes.google = "generativelanguage.googleapis.com";
  // Alias: Claude adapter registers as "claude" but ANTHROPIC_BASE_URL uses /proxy/anthropic
  if (!routes.anthropic) routes.anthropic = "api.anthropic.com";
  return routes;
}

const UPSTREAM_ROUTES = buildUpstreamRoutes();

// Pre-compute known route prefixes for error messages
const KNOWN_ROUTES_MSG = [
  ...Object.keys(UPSTREAM_ROUTES),
  ...allTargets()
    .filter((v) => v.proxy && typeof v.proxy.upstreamHost === "function")
    .map((v) => v.id),
]
  .filter((v, i, a) => a.indexOf(v) === i)
  .map((v) => `/${v}/*`)
  .join(", ");

const FORMAT_PARSERS: ApiFormatParser[] = [
  anthropicParser,
  openaiParser,
  openaiResponsesParser,
];

const sessions = new SessionTracker();

interface Route {
  vendor: string;
  upstream: string;
  path: string;
}

function parseRoute(
  url: string,
  headers?: http.IncomingHttpHeaders,
): Route | null {
  // Match /target/rest-of-path
  const match = url.match(/^\/([^/]+)(\/.*)?$/);
  if (!match) return null;

  const targetId = match[1];
  const requestPath = match[2] ?? "/";

  // Check target adapter for dynamic routing (e.g. Codex JWT auto-detect)
  const targetAdapter = getTarget(targetId);
  if (targetAdapter?.proxy) {
    const { proxy } = targetAdapter;
    const flatHeaders = flattenHeaders(headers ?? {});

    const upstream =
      typeof proxy.upstreamHost === "function"
        ? proxy.upstreamHost(flatHeaders)
        : proxy.upstreamHost;

    const finalPath = proxy.rewritePath
      ? proxy.rewritePath(requestPath, flatHeaders)
      : requestPath;

    return { vendor: targetId, upstream, path: finalPath };
  }

  // Fall back to static route table
  const upstream = UPSTREAM_ROUTES[targetId];
  if (!upstream) return null;

  return { vendor: targetId, upstream, path: requestPath };
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
    addBreadcrumb(
      "proxy",
      `Upstream error: ${route.vendor}`,
      { vendor: route.vendor, upstream: route.upstream, error: err.message },
      "error",
    );
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

  const targetSpec = getTarget(route.vendor);
  const accumulator =
    targetSpec?.proxy?.accumulatorType === "anthropic"
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
    addBreadcrumb(
      "proxy",
      `Upstream error: ${route.vendor}`,
      { vendor: route.vendor, upstream: route.upstream, error: err.message },
      "error",
    );
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

function tunnelWebSocket(
  req: http.IncomingMessage,
  clientSocket: import("node:stream").Duplex,
  head: Buffer,
): void {
  const url = req.url ?? "";
  const route = parseRoute(url, req.headers);

  if (!route) {
    clientSocket.end("HTTP/1.1 404 Not Found\r\n\r\n");
    return;
  }

  // Track session for this target
  const { sessionId, isNew } = sessions.getOrCreateSession(route.vendor, {});
  if (isNew) {
    emitHookEventAsync({
      session_id: sessionId,
      hook_event_name: "SessionStart",
      source: "proxy",
      vendor: route.vendor,
    });
  }

  // Catch client socket errors early (before upstream upgrade completes)
  clientSocket.on("error", (err) => {
    console.error(`WebSocket client error (${route.vendor}):`, err.message);
  });

  // Forward headers, replacing host with upstream.
  // Strip Sec-WebSocket-Extensions to disable permessage-deflate so the
  // frame capture can read uncompressed text payloads.
  const proxyHeaders: Record<string, string | string[]> = {};
  for (const [key, value] of Object.entries(req.headers)) {
    if (
      key !== "host" &&
      key !== "sec-websocket-extensions" &&
      value !== undefined
    ) {
      proxyHeaders[key] = value;
    }
  }
  proxyHeaders.host = route.upstream;

  // Use https.request to perform the upstream WebSocket upgrade.
  // Node's HTTP parser handles the 101 response; we get the raw socket back.
  const proxyReq = https.request({
    hostname: route.upstream,
    port: 443,
    path: route.path,
    method: req.method,
    headers: proxyHeaders,
  });

  proxyReq.on("upgrade", (proxyRes, proxySocket, proxyHead) => {
    // Reconstruct the 101 response for the client
    let response = `HTTP/${proxyRes.httpVersion} ${proxyRes.statusCode} ${proxyRes.statusMessage}\r\n`;
    for (let i = 0; i < proxyRes.rawHeaders.length; i += 2) {
      response += `${proxyRes.rawHeaders[i]}: ${proxyRes.rawHeaders[i + 1]}\r\n`;
    }
    response += "\r\n";

    clientSocket.write(response);
    if (proxyHead.length > 0) clientSocket.write(proxyHead);
    if (head.length > 0) proxySocket.write(head);

    // Tap into WebSocket messages for capture while forwarding bytes unchanged.
    // Client messages contain the request; server "response.completed" has the
    // full response with usage data.
    const clientExtractor = new WebSocketMessageExtractor();
    const serverExtractor = new WebSocketMessageExtractor();
    let pendingRequest: unknown;
    let requestTimestamp = Date.now();

    clientExtractor.onMessage = (msg) => {
      try {
        pendingRequest = JSON.parse(msg);
        requestTimestamp = Date.now();
      } catch {}
    };

    serverExtractor.onMessage = (msg) => {
      try {
        const event = JSON.parse(msg) as Record<string, unknown>;
        if (event.type === "response.completed" && pendingRequest) {
          const capture: CapturedExchange = {
            vendor: route.vendor,
            sessionId,
            timestamp_ms: requestTimestamp,
            request: {
              path: route.path,
              headers: flattenHeaders(req.headers),
              body: pendingRequest,
            },
            response: {
              status: 200,
              body: event.response,
            },
            duration_ms: Date.now() - requestTimestamp,
          };
          processCapture(capture);
          pendingRequest = undefined;
        }
      } catch {}
    };

    proxySocket.on("data", (chunk: Buffer) => {
      serverExtractor.push(chunk);
      clientSocket.write(chunk);
    });
    clientSocket.on("data", (chunk: Buffer) => {
      clientExtractor.push(chunk);
      proxySocket.write(chunk);
    });

    proxySocket.on("error", () => clientSocket.destroy());
    proxySocket.on("close", () => clientSocket.destroy());
    clientSocket.on("close", () => proxySocket.destroy());
  });

  proxyReq.on("error", (err) => {
    console.error(`WebSocket upstream error (${route.vendor}):`, err.message);
    clientSocket.end("HTTP/1.1 502 Bad Gateway\r\n\r\n");
  });

  proxyReq.on("response", (res) => {
    // Upstream rejected the upgrade (non-101 response) — forward as-is
    let response = `HTTP/${res.httpVersion} ${res.statusCode} ${res.statusMessage}\r\n`;
    for (let i = 0; i < res.rawHeaders.length; i += 2) {
      response += `${res.rawHeaders[i]}: ${res.rawHeaders[i + 1]}\r\n`;
    }
    response += "\r\n";
    clientSocket.write(response);
    res.pipe(clientSocket);
  });

  proxyReq.end();
}

/** Handle a proxy API request. Expects the URL to have a target prefix. */
export async function handleProxyRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
): Promise<void> {
  const url = req.url ?? "";

  const route = parseRoute(url, req.headers);
  if (!route) {
    res.writeHead(404, { "Content-Type": "application/json" });
    res.end(
      JSON.stringify({
        error: "unknown_route",
        message: `Unknown target prefix. Known: ${KNOWN_ROUTES_MSG}`,
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
    captureException(err, { component: "proxy", path: url });
    if (!res.headersSent) {
      res.writeHead(500);
      res.end();
    }
  }
}

/** Handle a WebSocket upgrade for proxy tunneling. */
export { tunnelWebSocket };

export function createProxyServer(): http.Server {
  const server = http.createServer(async (req, res) => {
    const url = req.url ?? "";
    const method = req.method ?? "";

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

    await handleProxyRequest(req, res);
  });

  server.on("upgrade", (req, socket, head) => {
    tunnelWebSocket(req, socket, head);
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
  server.on("error", (err: NodeJS.ErrnoException) => {
    if (err.code === "EADDRINUSE") {
      console.log(
        `Proxy already running on ${config.proxyHost}:${config.proxyPort}`,
      );
      process.exit(0);
    }
    throw err;
  });
  server.listen(config.proxyPort, config.proxyHost, () => {
    console.log(
      `Panopticon proxy listening on ${config.proxyHost}:${config.proxyPort}`,
    );
    console.log("Routes:");
    for (const [prefix, host] of Object.entries(UPSTREAM_ROUTES)) {
      console.log(`  /${prefix}/* → https://${host}/*`);
    }
    // Show dynamic-routed targets not in the static table
    for (const v of allTargets()) {
      if (
        v.proxy &&
        typeof v.proxy.upstreamHost === "function" &&
        !UPSTREAM_ROUTES[v.id]
      ) {
        console.log(`  /${v.id}/* → (dynamic)`);
      }
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
