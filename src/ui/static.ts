/**
 * Static file server for the Mission Control web app (`GET /ui`, `GET /ui/*`).
 *
 * Serves the vanilla HTML/JS/CSS in ./web. The page needs the bearer token to
 * call `/api/tool` and open the SSE stream, so `index.html` is templated at
 * serve time: a `<!--PANOPTICON_BOOTSTRAP-->` marker is replaced with the token
 * and port. This is localhost-only, matching the server's auth model.
 *
 * The same page is framework-agnostic and runs unchanged in a browser tab or an
 * Electron renderer; only the server-side contract (this + SSE + /api/tool) is
 * the durable surface.
 */

import fs from "node:fs";
import type http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { config } from "../config.js";

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".ico": "image/x-icon",
  ".json": "application/json; charset=utf-8",
};

/**
 * Locate the web asset dir. In production it is copied to `dist/ui/web` by the
 * build (see scripts/copy-ui-assets.mjs); in dev (tsx) it sits at `src/ui/web`.
 * tsup may bundle this module into a chunk, so resolve by walking up from the
 * module dir and probing both layouts rather than assuming a fixed relative path.
 */
function resolveWebDir(): string {
  let dir = path.dirname(fileURLToPath(import.meta.url));
  for (let i = 0; i < 6; i++) {
    const candidates = [
      path.join(dir, "web"),
      path.join(dir, "dist", "ui", "web"),
      path.join(dir, "src", "ui", "web"),
    ];
    for (const candidate of candidates) {
      if (fs.existsSync(candidate)) return candidate;
    }
    dir = path.dirname(dir);
  }
  // Fall back to the source layout relative to this file.
  return path.join(path.dirname(fileURLToPath(import.meta.url)), "web");
}

const WEB_DIR = resolveWebDir();

function send(
  res: http.ServerResponse,
  status: number,
  contentType: string,
  body: string | Buffer,
): void {
  res.writeHead(status, { "Content-Type": contentType });
  res.end(body);
}

export function handleUiRequest(
  req: http.IncomingMessage,
  res: http.ServerResponse,
  authToken: string,
): void {
  const url = new URL(req.url ?? "", "http://127.0.0.1");
  // Strip the /ui prefix; "/ui" and "/ui/" both serve index.html.
  let rel = url.pathname.replace(/^\/ui\/?/, "");
  if (rel === "" || rel === "/") rel = "index.html";

  // Resolve within WEB_DIR and guard against path traversal.
  const target = path.resolve(WEB_DIR, rel);
  if (target !== WEB_DIR && !target.startsWith(WEB_DIR + path.sep)) {
    send(res, 403, "application/json", JSON.stringify({ error: "forbidden" }));
    return;
  }

  let data: Buffer;
  try {
    data = fs.readFileSync(target);
  } catch {
    send(res, 404, "application/json", JSON.stringify({ error: "not_found" }));
    return;
  }

  const ext = path.extname(target).toLowerCase();
  const contentType = CONTENT_TYPES[ext] ?? "application/octet-stream";

  // Inject the bootstrap (token + port) into the HTML shell so the page can
  // authenticate without a separate token-fetch round trip.
  if (ext === ".html") {
    const bootstrap = `<script>window.__PANOPTICON__=${JSON.stringify({
      token: authToken,
      port: config.port,
    })};</script>`;
    const html = data
      .toString("utf-8")
      .replace("<!--PANOPTICON_BOOTSTRAP-->", bootstrap);
    send(res, 200, contentType, html);
    return;
  }

  send(res, 200, contentType, data);
}
