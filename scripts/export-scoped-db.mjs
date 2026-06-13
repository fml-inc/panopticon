#!/usr/bin/env node

// Export a SCOPED, read-only SQLite copy for the public snapshot.
//
// Same allowlist as the JSON export (today's panopticon effort + subagents) is
// the privacy boundary: only allowlisted sessions' rows are copied, so nothing
// outside that set ships. Content is NOT redacted.
//
// Output: apps/static-site/db/panopticon.db — a small DB the Vercel serverless
// /api function (and the local serve-snapshot.mjs) opens read-only, so the
// public dashboard is fully queryable (every session/timeline + arbitrary query)
// over a copy of the database rather than pre-baked JSON.
//
// Usage: node scripts/export-scoped-db.mjs [--repo <repo>] [--since <ISO>]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

const args = process.argv.slice(2);
function arg(name, def) {
  const i = args.indexOf(`--${name}`);
  return i >= 0 && args[i + 1] ? args[i + 1] : def;
}
const REPO = arg("repo", "fml-inc/panopticon");
const startOfToday = new Date();
startOfToday.setHours(0, 0, 0, 0);
const SINCE_MS = arg("since")
  ? Date.parse(arg("since"))
  : startOfToday.getTime();

function dataDir() {
  if (process.env.PANOPTICON_DATA_DIR) return process.env.PANOPTICON_DATA_DIR;
  if (process.platform === "darwin")
    return path.join(
      os.homedir(),
      "Library",
      "Application Support",
      "panopticon",
    );
  if (process.platform === "win32")
    return path.join(
      process.env.APPDATA ?? path.join(os.homedir(), "AppData", "Roaming"),
      "panopticon",
    );
  return path.join(os.homedir(), ".local", "share", "panopticon");
}

const ROOT = path.resolve(import.meta.dirname, "..");
const SRC = path.join(dataDir(), "panopticon.db");
const OUTDIR = path.join(ROOT, "apps", "static-site", "db");
const DST = path.join(OUTDIR, "panopticon.db");

// Tables copied scoped by session_id. (FTS shadow tables, intent/claim/
// provenance, config snapshots, and sync bookkeeping are deliberately omitted.)
const SESSION_TABLES = [
  "sessions",
  "session_summaries",
  "session_repositories",
  "session_cwds",
  "panopticon_instances",
  "agent_message_deliveries",
  "messages",
  "tool_calls",
  "otel_logs",
  "otel_metrics",
  "otel_spans",
];
// Copied whole (small / global, needed for cost + schema sanity).
const WHOLE_TABLES = ["model_pricing", "schema_migrations", "data_versions"];

const src = new Database(SRC, { readonly: true });

function ddl(t) {
  return src
    .prepare("SELECT sql FROM sqlite_master WHERE type='table' AND name=?")
    .get(t)?.sql;
}
function exists(t) {
  return !!ddl(t);
}

// ---- allowlist --------------------------------------------------------------
console.log(`Scope: repo=${REPO} since=${new Date(SINCE_MS).toISOString()}`);
const allow = new Set(
  src
    .prepare(
      "SELECT session_id FROM sessions WHERE project = ? AND started_at_ms >= ?",
    )
    .all(REPO, SINCE_MS)
    .map((r) => r.session_id),
);
const parents = src
  .prepare(
    "SELECT session_id, parent_session_id FROM sessions WHERE parent_session_id IS NOT NULL",
  )
  .all();
for (let changed = true; changed; ) {
  changed = false;
  for (const p of parents) {
    if (allow.has(p.parent_session_id) && !allow.has(p.session_id)) {
      allow.add(p.session_id);
      changed = true;
    }
  }
}
const ids = [...allow];
console.log(`In scope: ${ids.length} sessions`);
if (ids.length === 0) {
  console.error("Nothing in scope — aborting.");
  process.exit(1);
}

// ---- build the scoped copy --------------------------------------------------
fs.rmSync(OUTDIR, { recursive: true, force: true });
fs.mkdirSync(OUTDIR, { recursive: true });

const dst = new Database(DST);
dst.prepare("ATTACH DATABASE ? AS src").run(SRC);
dst.exec("CREATE TEMP TABLE _allow(session_id TEXT PRIMARY KEY)");
const insAllow = dst.prepare("INSERT OR IGNORE INTO _allow VALUES (?)");
dst.transaction(() => ids.forEach((id) => insAllow.run(id)))();

function copy(table, whereSql) {
  if (!exists(table)) {
    console.warn(`  (skip ${table}: not in source)`);
    return 0;
  }
  dst.exec(ddl(table)); // CREATE TABLE (no triggers/indexes → no FTS coupling)
  dst.exec(`INSERT INTO main.${table} SELECT * FROM src.${table} ${whereSql}`);
  return dst.prepare(`SELECT COUNT(*) AS c FROM main.${table}`).get().c;
}

const inAllow = "WHERE session_id IN (SELECT session_id FROM _allow)";
let totalRows = 0;
for (const t of SESSION_TABLES) {
  const n = copy(t, inAllow);
  totalRows += n;
  console.log(`  ${t}: ${n}`);
}
// Bus: room-scoped within the window.
{
  const where = `WHERE room = '${REPO.replace(/'/g, "''")}' AND created_at_ms >= ${SINCE_MS}`;
  const n = copy("agent_messages", where);
  totalRows += n;
  console.log(`  agent_messages: ${n}`);
}
for (const t of WHOLE_TABLES) {
  const n = copy(t, "");
  totalRows += n;
  console.log(`  ${t}: ${n} (whole)`);
}

dst.exec("DROP TABLE _allow");
dst.prepare("DETACH DATABASE src").run();
dst.exec("VACUUM");
dst.close();
src.close();

// ---- emit the dashboard assets (source="api") -------------------------------
const WEB = path.join(ROOT, "src", "ui", "web");
const SITE = path.join(ROOT, "apps", "static-site");
fs.copyFileSync(path.join(WEB, "app.js"), path.join(SITE, "app.js"));
fs.copyFileSync(path.join(WEB, "style.css"), path.join(SITE, "style.css"));
const snapshotAt = new Date().toISOString().slice(0, 10);
const html = fs
  .readFileSync(path.join(WEB, "index.html"), "utf-8")
  .replace(
    "<!--PANOPTICON_BOOTSTRAP-->",
    `<script>window.__PANOPTICON__=${JSON.stringify({ static: true, source: "api", snapshotAt })};</script>`,
  )
  .replaceAll("/ui/style.css", "style.css")
  .replaceAll("/ui/app.js", "app.js");
fs.writeFileSync(path.join(SITE, "index.html"), html);

const sizeMb = (fs.statSync(DST).size / 1e6).toFixed(1);
console.log(
  `\n✅ Scoped DB → ${path.relative(ROOT, DST)}  (${ids.length} sessions, ${totalRows} rows, ${sizeMb} MB)`,
);
console.log(`   Assets → ${path.relative(ROOT, SITE)} (index.html source=api)`);
console.log("   Preview: node scripts/serve-snapshot.mjs");
console.log("   Deploy:  vercel deploy --prod");
