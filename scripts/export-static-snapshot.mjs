#!/usr/bin/env node
// Export a static, replayable Mission Control snapshot.
//
// Scopes strictly to today's panopticon effort (repo fml-inc/panopticon, started
// today) PLUS those sessions' subagents — that allowlist is the privacy control:
// nothing outside it is ever written, so other repos / other days / other
// people's sessions can't leak. Content itself is NOT redacted.
//
// Output: apps/static-site/ (index.html, app.js, style.css, data/*.json),
// deployable as a plain static site (e.g. `vercel deploy apps/static-site`).
//
// Usage:
//   node scripts/export-static-snapshot.mjs [--repo <repo>] [--since <ISO>]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

// ---- config / args ----------------------------------------------------------
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
function port() {
  const env = process.env.PANOPTICON_PORT ?? process.env.PANOPTICON_OTLP_PORT;
  if (env) return Number.parseInt(env, 10);
  return 4318 + ((process.getuid?.() ?? 0) % 100);
}
const TOKEN =
  process.env.PANOPTICON_AUTH_TOKEN ??
  fs.readFileSync(path.join(dataDir(), "auth-token"), "utf-8").trim();
const BASE = `http://127.0.0.1:${port()}`;
const auth = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

const ROOT = path.resolve(import.meta.dirname, "..");
const OUT = path.join(ROOT, "apps", "static-site");
const DATA = path.join(OUT, "data");
const WEB = path.join(ROOT, "src", "ui", "web");

async function tool(name, params = {}) {
  const r = await fetch(`${BASE}/api/tool`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name, params }),
  });
  if (!r.ok) throw new Error(`tool ${name} -> ${r.status}`);
  return r.json();
}

function sessionRepo(s) {
  return (
    s.project ||
    s.sessionSummary?.repository ||
    s.repositories?.[0]?.name ||
    null
  );
}

// ---- scope: build the allowlist ---------------------------------------------
console.log(`Scope: repo=${REPO} since=${new Date(SINCE_MS).toISOString()}`);

const all = (await tool("sessions", { limit: 2000 })).sessions ?? [];

const allow = new Set();
for (const s of all) {
  const started = s.startedAt ? Date.parse(s.startedAt) : 0;
  if (sessionRepo(s) === REPO && started >= SINCE_MS) allow.add(s.sessionId);
}
// Pull in descendants (subagents) of in-scope sessions, transitively.
for (let changed = true; changed; ) {
  changed = false;
  for (const s of all) {
    if (
      s.parentSessionId &&
      allow.has(s.parentSessionId) &&
      !allow.has(s.sessionId)
    ) {
      allow.add(s.sessionId);
      changed = true;
    }
  }
}
console.log(`In scope: ${allow.size} sessions (of ${all.length} total)`);
if (allow.size === 0) {
  console.error(
    "Nothing in scope — aborting (refusing to write an empty/unsafe snapshot).",
  );
  process.exit(1);
}

// ---- write data -------------------------------------------------------------
fs.rmSync(DATA, { recursive: true, force: true });
fs.mkdirSync(path.join(DATA, "timeline"), { recursive: true });

const write = (rel, obj) =>
  fs.writeFileSync(path.join(DATA, rel), JSON.stringify(obj));

// sessions.json — only in-scope rows.
const sessions = all.filter((s) => allow.has(s.sessionId));
write("sessions.json", { sessions });

// instances.json — only in-scope rows; recompute counts.
const instAll =
  (await tool("instances", { includeEnded: true })).instances ?? [];
const instances = instAll.filter((i) => allow.has(i.session_id));
const counts = { active: 0, idle: 0, exited: 0, total: instances.length };
for (const i of instances) counts[i.status] = (counts[i.status] ?? 0) + 1;
write("instances.json", { now_ms: Date.now(), room: REPO, counts, instances });

// messages.json — bus messages in the room, scoped to the window. Drop any
// referencing a session outside the allowlist (belt-and-suspenders).
const msgs = (
  await tool("query", {
    sql: `SELECT id, room, from_session, to_session, kind, body, subject, ref_path, source, created_at_ms, delivered_at_ms
            FROM agent_messages
           WHERE room = '${REPO.replace(/'/g, "''")}' AND created_at_ms >= ${SINCE_MS}
           ORDER BY id DESC`,
  })
).filter(
  (m) =>
    (!m.from_session ||
      allow.has(m.from_session) ||
      m.from_session === "mission-control") &&
    (!m.to_session || allow.has(m.to_session)),
);
write("messages.json", msgs);

// timeline/<id>.json — only for roster members (the clickable rows).
let tlCount = 0;
for (const i of instances) {
  try {
    const tl = await tool("timeline", { sessionId: i.session_id, limit: 500 });
    write(`timeline/${i.session_id}.json`, tl);
    tlCount += 1;
  } catch (err) {
    console.warn(`  timeline ${i.session_id} skipped: ${err.message}`);
  }
}

// ---- copy + template the web assets -----------------------------------------
fs.copyFileSync(path.join(WEB, "app.js"), path.join(OUT, "app.js"));
fs.copyFileSync(path.join(WEB, "style.css"), path.join(OUT, "style.css"));

const snapshotAt = new Date().toISOString().slice(0, 10);
const html = fs
  .readFileSync(path.join(WEB, "index.html"), "utf-8")
  .replace(
    "<!--PANOPTICON_BOOTSTRAP-->",
    `<script>window.__PANOPTICON__=${JSON.stringify({ static: true, snapshotAt })};</script>`,
  )
  .replaceAll("/ui/style.css", "style.css")
  .replaceAll("/ui/app.js", "app.js");
fs.writeFileSync(path.join(OUT, "index.html"), html);

console.log(
  `\n✅ Snapshot → ${path.relative(ROOT, OUT)}  (${sessions.length} sessions, ${instances.length} roster, ${msgs.length} messages, ${tlCount} timelines)`,
);
console.log(`   Preview: npx serve ${path.relative(ROOT, OUT)}`);
console.log(`   Deploy:  vercel deploy ${path.relative(ROOT, OUT)} --prod`);
