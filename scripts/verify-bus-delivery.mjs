#!/usr/bin/env node
// End-to-end verification of the agent-to-agent delivery loop that Mission
// Control visualizes:
//
//   bus-send (a challenge) -> pending -> the target agent's next PreToolUse hook
//   drains it into additionalContext -> the message flips to delivered.
//
// It registers a synthetic "primary" via a hook event (so the server resolves
// and records its room), sends a challenge to that room, then replays the
// primary's PreToolUse hook and asserts the challenge came back in the hook
// response and that delivered_at_ms was set.
//
// Requires the server running with PANOPTICON_ENABLE_BUS_DELIVERY=1.
//
// Usage: node scripts/verify-bus-delivery.mjs [cwd]

import fs from "node:fs";
import os from "node:os";
import path from "node:path";

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
const CWD = process.argv[2] ?? "/Users/gus/workspace/panopticon";

const auth = {
  Authorization: `Bearer ${TOKEN}`,
  "Content-Type": "application/json",
};

async function tool(name, params) {
  const r = await fetch(`${BASE}/api/tool`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ name, params }),
  });
  if (!r.ok) throw new Error(`tool ${name} -> ${r.status}`);
  return r.json();
}
async function exec(command, params) {
  const r = await fetch(`${BASE}/api/exec`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify({ command, params }),
  });
  if (!r.ok)
    throw new Error(`exec ${command} -> ${r.status} ${await r.text()}`);
  return r.json();
}
async function hook(body) {
  const r = await fetch(`${BASE}/hooks`, {
    method: "POST",
    headers: auth,
    body: JSON.stringify(body),
  });
  if (!r.ok) throw new Error(`hook -> ${r.status}`);
  return r.json();
}

function fail(msg) {
  console.error(`\n❌ FAIL: ${msg}`);
  process.exit(1);
}

const stamp = `${Date.now()}-${Math.floor(process.hrtime()[1] % 100000)}`;
const primary = `verify-primary-${stamp}`;
const marker = `VERIFY-${stamp}: root-cause the flake, don't delete the test`;
const preToolUse = {
  hook_event_name: "PreToolUse",
  session_id: primary,
  tool_name: "Edit",
  target: "claude",
  cwd: CWD,
};

console.log(`Server   ${BASE}`);
console.log(`Primary  ${primary}`);

// 1) Register the synthetic primary so the server resolves + records its room.
await hook(preToolUse);
const rows = await tool("query", {
  sql: `SELECT room FROM panopticon_instances WHERE session_id = '${primary}'`,
});
const room = rows[0]?.room;
if (!room) fail(`no room resolved for ${primary} (cwd ${CWD} not a repo?)`);
console.log(`Room     ${room}`);

// 2) Send a challenge to that room, addressed to the primary.
const sent = await exec("bus-send", {
  room,
  from: "verify-frenemy",
  to: primary,
  kind: "challenge",
  body: marker,
});
console.log(`Sent     message id ${sent.id}`);

// 3) It must be pending (not yet delivered).
const before = await tool("query", {
  sql: `SELECT delivered_at_ms FROM agent_messages WHERE id = ${sent.id}`,
});
if (before[0]?.delivered_at_ms != null)
  fail("message was delivered before any drain");
console.log("Pending  delivered_at_ms = null ✓");

// 4) Replay the primary's next PreToolUse hook — this should drain the challenge.
const resp = await hook(preToolUse);
const respStr = JSON.stringify(resp);
if (!respStr.includes(marker)) {
  fail(
    "challenge not present in hook response additionalContext.\n" +
      "  Is the server running with PANOPTICON_ENABLE_BUS_DELIVERY=1?\n" +
      `  response: ${respStr.slice(0, 300)}`,
  );
}
console.log("Drained  challenge returned in hook additionalContext ✓");

// 5) The message must now be marked delivered.
const after = await tool("query", {
  sql: `SELECT delivered_at_ms FROM agent_messages WHERE id = ${sent.id}`,
});
if (after[0]?.delivered_at_ms == null)
  fail("delivered_at_ms still null after drain");
console.log(`Delivered delivered_at_ms = ${after[0].delivered_at_ms} ✓`);

console.log("\n✅ PASS — bus delivery round-trips end to end.");
