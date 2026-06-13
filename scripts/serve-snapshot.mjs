#!/usr/bin/env node
// Local preview of the DB-backed snapshot — the same shape the Vercel deploy
// serves: a read-only /api/tool over the scoped SQLite copy, plus the dashboard
// in snapshot source="api" mode. Lets us verify the public build end to end
// without deploying.
//
// Usage: node scripts/serve-snapshot.mjs [port]   (default 8787)
// Requires: pnpm build (for dist/service) and scripts/export-scoped-db.mjs.

import fs from "node:fs";
import http from "node:http";
import path from "node:path";

const ROOT = path.resolve(import.meta.dirname, "..");
const DB_DIR = path.join(ROOT, "apps", "static-site", "db");
const WEB = path.join(ROOT, "src", "ui", "show");
const PORT = Number(process.argv[2] ?? 8787);

// config reads PANOPTICON_DATA_DIR at import — set it before importing service.
process.env.PANOPTICON_DATA_DIR = DB_DIR;
const { dispatchTool, directPanopticonService, isToolName } = await import(
  "../dist/service/index.js"
);

const CT = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
};

function indexHtml() {
  const bootstrap = `<script>window.__PANOPTICON__=${JSON.stringify({
    static: true,
    source: "api",
    snapshotAt: new Date().toISOString().slice(0, 10),
  })};</script>`;
  return fs
    .readFileSync(path.join(WEB, "index.html"), "utf-8")
    .replace("<!--PANOPTICON_BOOTSTRAP-->", bootstrap);
}

const server = http.createServer(async (req, res) => {
  const url = new URL(req.url ?? "/", "http://127.0.0.1");
  const send = (code, type, body) => {
    res.writeHead(code, { "Content-Type": type });
    res.end(body);
  };

  if (url.pathname === "/api/tool" && req.method === "POST") {
    const chunks = [];
    for await (const c of req) chunks.push(c);
    let body;
    try {
      body = JSON.parse(Buffer.concat(chunks).toString() || "{}");
    } catch {
      return send(400, "application/json", '{"error":"bad json"}');
    }
    if (!isToolName(body.name)) {
      return send(404, "application/json", `{"error":"unknown tool"}`);
    }
    try {
      const result = await dispatchTool(
        directPanopticonService,
        body.name,
        body.params ?? {},
      );
      return send(200, "application/json", JSON.stringify(result));
    } catch (err) {
      return send(
        500,
        "application/json",
        JSON.stringify({ error: String(err) }),
      );
    }
  }

  if (url.pathname === "/" || url.pathname === "/index.html") {
    return send(200, CT[".html"], indexHtml());
  }
  if (url.pathname === "/show.js" || url.pathname === "/show.css") {
    const f = path.join(WEB, url.pathname.slice(1));
    return send(200, CT[path.extname(f)], fs.readFileSync(f));
  }
  send(404, "application/json", '{"error":"not_found"}');
});

server.listen(PORT, "127.0.0.1", () => {
  console.log(`Snapshot preview (DB-backed) → http://127.0.0.1:${PORT}/`);
  console.log(`DB: ${path.join(DB_DIR, "panopticon.db")}`);
});
