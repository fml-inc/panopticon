// Mission Control client. Seeds state from /api/tool, then live-updates over the
// SSE stream (/api/events). Runs unchanged in a browser tab or Electron renderer.

const boot = window.__PANOPTICON__ ?? { token: "", port: null };
/** Snapshot mode: read pre-baked JSON instead of the live server (no auth, no
 *  SSE, no write paths) and replay the day on a virtual clock. Set by the
 *  static-site export. */
const STATIC = !!boot.static;

/** Virtual clock — Date.now() live, the replay cursor in snapshot mode. Used
 *  anywhere "now" feeds the UI (e.g. session age). */
let virtualNow = null;
function nowMs() {
  return virtualNow ?? Date.now();
}

async function fetchJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}

/** In snapshot mode, map a tool call to its baked JSON file. */
async function staticTool(name, params) {
  switch (name) {
    case "instances":
      return fetchJson("data/instances.json");
    case "sessions":
      return fetchJson("data/sessions.json");
    case "timeline":
      return fetchJson(`data/timeline/${params.sessionId}.json`);
    default:
      throw new Error(`static: unsupported tool ${name}`);
  }
}

/** POST a read-only Panopticon tool and return its JSON result. */
async function tool(name, params = {}) {
  if (STATIC) return staticTool(name, params);
  const res = await fetch("/api/tool", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${boot.token}`,
    },
    body: JSON.stringify({ name, params }),
  });
  if (!res.ok) throw new Error(`${name} -> ${res.status}`);
  return res.json();
}

/** POST a write command (e.g. bus-send) to the exec dispatch. */
async function exec(command, params = {}) {
  if (STATIC) throw new Error("read-only snapshot");
  const res = await fetch("/api/exec", {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${boot.token}`,
    },
    body: JSON.stringify({ command, params }),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`${command} -> ${res.status} ${txt}`.trim());
  }
  return res.json();
}

/** Recent bus messages: baked JSON in snapshot mode, SQL otherwise. */
async function loadBusMessages() {
  if (STATIC) {
    const rows = await fetchJson("data/messages.json");
    return Array.isArray(rows) ? rows : [];
  }
  const rows = await tool("query", {
    sql: "SELECT id, room, from_session, to_session, kind, body, subject, ref_path, source, created_at_ms, delivered_at_ms FROM agent_messages ORDER BY id DESC LIMIT 50",
  });
  return Array.isArray(rows) ? rows : [];
}

// ---- Roster -----------------------------------------------------------------

/** session_id -> instance view */
const instances = new Map();

/** session_id -> session row from the `sessions` tool (title, model, cost…). */
const sessionMeta = new Map();
/** parent session_id -> count of child (subagent) sessions, for topology. */
const childCount = new Map();
/** Fleet burn-rate state. Per-session prev cost/tokens so window churn (a
 *  session entering/leaving the 100-row `sessions` page) can't spike the rate. */
const prevById = new Map(); // sessionId -> { cost, tok }
let prevTs = null;
let burnPerHr = null;
let tokPerMin = null;

const rosterEl = document.getElementById("roster");
const countsEl = document.getElementById("counts");
const missionbarEl = document.getElementById("missionbar");
const toggleExitedEl = document.getElementById("toggle-exited");

/** Whether exited sessions are shown in the roster. */
let showExited = true;
toggleExitedEl?.addEventListener("click", () => {
  showExited = !showExited;
  renderRoster();
});

/** session_id of the roster member whose detail drawer is open, or null. */
let selectedSession = null;

// Open the session visualization when a roster row is clicked (delegated, since
// the list is re-rendered on every presence update).
rosterEl.addEventListener("click", (e) => {
  const li = e.target.closest("li.inst");
  if (li?.dataset.session) openDetail(li.dataset.session);
});

function shortId(id) {
  return id ? id.slice(0, 8) : "—";
}

/** "claude-opus-4-8" -> "opus 4.8"; strips date-stamped suffixes. */
function modelShort(m) {
  if (!m) return "";
  const base = m.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const parts = base.split("-");
  const name = parts.shift();
  const ver = parts.join(".");
  return ver ? `${name} ${ver}` : name;
}

function fmtCost(c) {
  if (!c || c <= 0) return null;
  return `$${c.toFixed(2)}`;
}

/** Compact "age since last activity": 5s / 2m / 1h. */
function ageStr(ms) {
  if (!ms) return "";
  const s = Math.round((nowMs() - ms) / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m`;
  return `${Math.floor(m / 60)}h`;
}

// Coalesce bursty presence updates into one render. Without this the list
// re-renders on every hook event from every session and visibly thrashes.
let renderTimer = null;
function scheduleRender(delay = 700) {
  if (renderTimer) return;
  renderTimer = setTimeout(() => {
    renderTimer = null;
    renderView();
  }, delay);
}

const STATUS_RANK = { active: 0, idle: 1, exited: 2 };

// Feather-style eye / eye-off icons for the exited-sessions toggle.
const EYE_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>`;
const EYE_OFF_SVG = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/><line x1="1" y1="1" x2="23" y2="23"/></svg>`;

/** One roster row. */
function instRowHtml(i) {
  const meta = sessionMeta.get(i.session_id) ?? {};
  const ss = meta.sessionSummary ?? {};
  const isFrenemy = i.role === "frenemy";
  const roleBadge = isFrenemy
    ? `<span class="badge frenemy">frenemy</span>`
    : i.role
      ? `<span class="badge">${escapeHtml(i.role)}</span>`
      : "";
  const kids = childCount.get(i.session_id) ?? 0;
  const agentBadge = kids ? `<span class="badge agents">⊕${kids}</span>` : "";
  const selected = i.session_id === selectedSession ? " selected" : "";

  const title =
    (ss.title || meta.firstPrompt || "").trim() ||
    `${i.target ?? "agent"} · ${shortId(i.session_id)}`;

  // Sub-line: model · branch · messages · age — cost gets its own column.
  const branch = ss.branch || i.branch;
  const sub = [
    modelShort(meta.model),
    branch ? escapeHtml(branch) : "",
    meta.messageCount ? `${fmtNum(meta.messageCount)} msg` : "",
    ageStr(i.last_seen_ms),
  ]
    .filter(Boolean)
    .join(" · ");
  const cost = fmtCost(meta.totalCost);

  return `
    <li class="inst status-${i.status}${selected}" data-session="${escapeHtml(i.session_id)}">
      <span class="dot"></span>
      <div class="inst-main">
        <div class="inst-line">
          <span class="inst-title">${escapeHtml(title)}</span>
          ${roleBadge}${agentBadge}
        </div>
        <div class="inst-sub">${sub}</div>
      </div>
      <div class="inst-right">
        ${cost ? `<div class="inst-cost">${cost}</div>` : ""}
        <div class="inst-status">${i.status}${
          i.ended_reason ? `<br/>${escapeHtml(i.ended_reason)}` : ""
        }</div>
      </div>
    </li>`;
}

function roomKey(i) {
  return (
    i.room ||
    sessionMeta.get(i.session_id)?.sessionSummary?.repository ||
    "(no room)"
  );
}

function renderRoster() {
  renderMissionBar();

  // Sort by status, then by first-seen so a row holds a stable position instead
  // of jumping to the top every time its heartbeat ticks.
  const rows = [...instances.values()].sort((a, b) => {
    const r = (STATUS_RANK[a.status] ?? 9) - (STATUS_RANK[b.status] ?? 9);
    return r !== 0 ? r : (a.first_seen_ms ?? 0) - (b.first_seen_ms ?? 0);
  });

  const counts = { active: 0, idle: 0, exited: 0 };
  for (const i of rows) counts[i.status] = (counts[i.status] ?? 0) + 1;
  countsEl.innerHTML =
    `<span class="c-active">●${counts.active}</span>` +
    `<span class="c-idle">●${counts.idle}</span>` +
    `<span class="c-exited">●${counts.exited}</span>`;

  // Exited-sessions toggle: eye icon shows the action (eye-off = hide, eye =
  // show), title carries the count; hidden when there are none to toggle.
  if (toggleExitedEl) {
    toggleExitedEl.hidden = counts.exited === 0;
    toggleExitedEl.innerHTML = showExited ? EYE_OFF_SVG : EYE_SVG;
    toggleExitedEl.title = showExited
      ? `Hide exited (${counts.exited})`
      : `Show exited (${counts.exited})`;
  }

  const visible = showExited ? rows : rows.filter((i) => i.status !== "exited");
  if (visible.length === 0) {
    rosterEl.innerHTML = `<li class="empty">No instances ${
      rows.length ? "shown" : "yet"
    }.</li>`;
    return;
  }

  // Group by room (repo) — surfaces the fleet topology. Rooms keep the global
  // status sort within each group; the catch-all "(no room)" group sorts last.
  const byRoom = new Map();
  for (const i of visible) {
    const key = roomKey(i);
    if (!byRoom.has(key)) byRoom.set(key, []);
    byRoom.get(key).push(i);
  }

  const NO_ROOM = "(no room)";
  rosterEl.innerHTML = [...byRoom.entries()]
    .sort((a, b) => {
      if (a[0] === NO_ROOM) return 1;
      if (b[0] === NO_ROOM) return -1;
      return a[0].localeCompare(b[0]);
    })
    .map(([room, members]) => {
      const active = members.filter((m) => m.status === "active").length;
      return (
        `<li class="room-head"><span class="room-name">${escapeHtml(room)}</span>` +
        `<span class="room-count">${active}/${members.length}</span></li>` +
        members.map(instRowHtml).join("")
      );
    })
    .join("");
}

/** Aggregate header across the fleet. Active + spend come from the sessions
 *  currently present in the roster (so they accumulate during replay); burn /
 *  tokens are live-poll rates (— in snapshot mode). */
function renderMissionBar() {
  if (!missionbarEl) return;
  let active = 0;
  let spend = 0;
  for (const i of instances.values()) {
    if (i.status === "active") active += 1;
    spend += sessionMeta.get(i.session_id)?.totalCost ?? 0;
  }
  const tile = (label, value) =>
    `<div class="mtile"><span class="mval">${value}</span><span class="mlabel">${label}</span></div>`;
  missionbarEl.innerHTML =
    tile("active", active) +
    tile("burn", burnPerHr == null ? "—" : `$${burnPerHr.toFixed(2)}/hr`) +
    tile(
      "tokens",
      tokPerMin == null ? "—" : `${fmtNum(Math.round(tokPerMin))}/min`,
    ) +
    tile("spend", `$${spend.toFixed(2)}`);
}

// ---- Source of truth + as-of-T view ----------------------------------------
// Hold raw timestamped rows; render the dashboard "as of" a time T. Live pins T
// to now (SSE appends rows); the timeline scrubber moves T into the past. One
// code path drives live, scrubbed, and the static snapshot.

const ACTIVE_WINDOW_MS = 30_000;
const allInstances = new Map(); // session_id -> latest raw instance row
let allMessages = []; // raw message rows
let asOfT = null; // null => follow live (now)
let following = true; // tracking now vs scrubbed into the past

function currentT() {
  return asOfT ?? Date.now();
}

/** Reconstruct a session's status at time T from its presence timestamps. */
function statusAsOf(i, T) {
  if (i.ended_at_ms != null && i.ended_at_ms <= T) return "exited";
  if (T - (i.last_seen_ms ?? 0) < ACTIVE_WINDOW_MS) return "active";
  return "idle";
}

function applyInstance(view) {
  if (!view?.session_id) return;
  allInstances.set(view.session_id, view);
  if (following) scheduleRender();
  if (view.session_id === selectedSession) updateDetailStatus(view);
}

function applyMessage(msg) {
  if (!msg) return;
  allMessages.push(msg);
  // Notify a host shell (Electron) only for genuinely-new live challenges.
  if (
    following &&
    msg.kind === "challenge" &&
    window.__PANOPTICON_HOST__?.onChallenge
  ) {
    window.__PANOPTICON_HOST__.onChallenge(msg);
  }
  if (following) scheduleRender();
}

function applyDelivery(payload) {
  for (const id of payload?.ids ?? []) {
    const m = allMessages.find((x) => x.id === id);
    if (m) m.delivered_at_ms = payload.delivered_at_ms ?? Date.now();
  }
  if (following) scheduleRender();
}

/** Rebuild roster + feed + header for the current time T. */
function renderView() {
  const T = currentT();
  virtualNow = asOfT; // ageStr uses T when scrubbed, Date.now() when live

  instances.clear();
  for (const i of allInstances.values()) {
    if ((i.first_seen_ms ?? 0) > T) continue; // hasn't appeared yet at T
    instances.set(i.session_id, { ...i, status: statusAsOf(i, T) });
  }
  renderRoster();
  renderFeed(T);
  updateTimelineUI();
}

// ---- Bus feed ---------------------------------------------------------------

const feedEl = document.getElementById("feed");
const feedMetaEl = document.getElementById("feed-meta");

function timeStr(ms) {
  if (!ms) return "";
  return new Date(ms).toLocaleTimeString([], { hour12: false });
}

/** Delivery chip for a challenge, evaluated as of T. */
function delivChip(msg, T) {
  if (msg.kind !== "challenge") return "";
  const done = msg.delivered_at_ms != null && msg.delivered_at_ms <= T;
  return done
    ? `<span class="msg-deliv delivered">delivered ✓</span>`
    : `<span class="msg-deliv pending">pending</span>`;
}

function messageRow(msg, T) {
  const kind = msg.kind ?? "activity";
  const from = shortId(msg.from_session);
  const to = msg.to_session ? `→ ${shortId(msg.to_session)}` : "→ room";
  const li = document.createElement("li");
  li.className = `msg kind-${kind}`;
  li.innerHTML = `
    <div class="msg-head">
      <span class="msg-kind">${escapeHtml(kind)}</span>
      <span>${from} ${to}</span>
      ${delivChip(msg, T)}
      <span class="msg-time">${timeStr(msg.created_at_ms)}</span>
    </div>
    <div class="msg-body">${escapeHtml(msg.body ?? "")}</div>
    ${msg.subject ? `<div class="msg-subject">${escapeHtml(msg.subject)}</div>` : ""}
    ${msg.ref_path ? `<div class="msg-ref">${escapeHtml(msg.ref_path)}</div>` : ""}
  `;
  return li;
}

function renderFeed(T) {
  const msgs = allMessages
    .filter((m) => (m.created_at_ms ?? 0) <= T)
    .sort((a, b) => (a.created_at_ms ?? 0) - (b.created_at_ms ?? 0));
  if (msgs.length === 0) {
    feedEl.innerHTML = `<li class="empty">No bus activity ${asOfT == null ? "yet" : "at this point"}.</li>`;
    feedMetaEl.textContent = "";
    return;
  }
  feedEl.innerHTML = "";
  for (const m of msgs) feedEl.prepend(messageRow(m, T)); // oldest→newest, newest on top
  feedMetaEl.textContent = `${msgs.length} msg`;
}

// ---- Live stream ------------------------------------------------------------

const connEl = document.getElementById("conn");
const connLabel = document.getElementById("conn-label");

function setConn(state, label) {
  connEl.classList.toggle("live", state === "live");
  connLabel.textContent = label;
}

function connectStream() {
  const es = new EventSource(
    `/api/events?token=${encodeURIComponent(boot.token)}`,
  );
  es.onopen = () => setConn("live", following ? "live" : "paused");
  es.onerror = () => setConn("down", "reconnecting…");
  es.addEventListener("instance", (e) => applyInstance(JSON.parse(e.data)));
  es.addEventListener("message", (e) => applyMessage(JSON.parse(e.data)));
  es.addEventListener("delivery", (e) => applyDelivery(JSON.parse(e.data)));
}

// ---- Boot -------------------------------------------------------------------

// Pull per-session metadata (title, model, message count, cost) and re-render so
// roster rows show what each session is actually doing, not just an id. Counts
// and cost lag slightly for in-flight sessions, so refresh on an interval.
async function refreshSessionMeta() {
  try {
    const res = await tool("sessions", { limit: 100 });
    const list = res.sessions ?? [];
    for (const s of list) sessionMeta.set(s.sessionId, s);

    // Topology: count subagents per parent.
    childCount.clear();
    for (const s of list) {
      if (s.parentSessionId) {
        childCount.set(
          s.parentSessionId,
          (childCount.get(s.parentSessionId) ?? 0) + 1,
        );
      }
    }

    // Burn rate = sum of per-session cost/token deltas since the last poll, over
    // sessions seen in BOTH polls. A session newly entering the window only sets
    // a baseline (its historical cost isn't attributed to one 15s tick), which
    // avoids spikes from window churn. NOTE: the `sessions` page is limited to
    // 100 rows, so this is a glanceable fleet rate, not exact accounting.
    let dCost = 0;
    let dTok = 0;
    for (const s of sessionMeta.values()) {
      const cost = s.totalCost ?? 0;
      const tok = s.totalOutputTokens ?? 0;
      const prev = prevById.get(s.sessionId);
      if (prev) {
        dCost += Math.max(0, cost - prev.cost);
        dTok += Math.max(0, tok - prev.tok);
      }
      prevById.set(s.sessionId, { cost, tok });
    }
    const now = Date.now();
    if (prevTs) {
      const dtHr = (now - prevTs) / 3_600_000;
      const dtMin = (now - prevTs) / 60_000;
      if (dtHr > 0) burnPerHr = dCost / dtHr;
      if (dtMin > 0) tokPerMin = dTok / dtMin;
    }
    prevTs = now;

    scheduleRender();
  } catch (err) {
    console.error("session meta refresh failed", err);
  }
}

/** Load session metadata + presence + messages into the source maps. Shared by
 *  live seed and the static snapshot boot. */
async function loadSource() {
  await refreshSessionMeta();
  try {
    const res = await tool("instances", { includeEnded: true });
    for (const i of res.instances ?? []) allInstances.set(i.session_id, i);
  } catch (err) {
    console.error("instances load failed", err);
  }
  try {
    allMessages = await loadBusMessages();
  } catch (err) {
    console.error("messages load failed", err);
  }
}

async function seed() {
  await loadSource();
  if (!STATIC) setInterval(refreshSessionMeta, 15000);
  setupTimeline();
  following = true;
  asOfT = null;
  renderView();
}

function escapeHtml(s) {
  return String(s).replace(
    /[&<>"']/g,
    (c) =>
      ({
        "&": "&amp;",
        "<": "&lt;",
        ">": "&gt;",
        '"': "&quot;",
        "'": "&#39;",
      })[c],
  );
}

// ---- Session detail drawer --------------------------------------------------

const drawerEl = document.getElementById("drawer");
const backdropEl = document.getElementById("backdrop");

backdropEl.addEventListener("click", closeDetail);
document.addEventListener("keydown", (e) => {
  if (e.key === "Escape") closeDetail();
});

function closeDetail() {
  selectedSession = null;
  drawerEl.hidden = true;
  backdropEl.hidden = true;
  renderRoster();
}

// How many recent messages to pull for the activity list + tool bars. Counts in
// the stat tiles come from authoritative session meta, not this window.
const TIMELINE_WINDOW = 500;

async function openDetail(sessionId) {
  selectedSession = sessionId;
  renderRoster();
  backdropEl.hidden = false;
  drawerEl.hidden = false;
  drawerEl.innerHTML = `<div class="drawer-loading">Loading session…</div>`;

  try {
    const data = await tool("timeline", { sessionId, limit: TIMELINE_WINDOW });
    // Guard against a race where the user clicked another row meanwhile.
    if (selectedSession !== sessionId) return;
    renderDetail(sessionId, data);
  } catch (err) {
    if (selectedSession !== sessionId) return;
    drawerEl.innerHTML = `<div class="drawer-loading">Failed to load: ${escapeHtml(
      String(err),
    )}</div>`;
  }
}

function fmtDuration(ms) {
  if (!ms || ms < 0) return "—";
  const s = Math.round(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  if (m < 60) return `${m}m ${s % 60}s`;
  const h = Math.floor(m / 60);
  return `${h}h ${m % 60}m`;
}

function fmtNum(n) {
  if (n == null) return "0";
  if (n >= 1000) return `${(n / 1000).toFixed(1)}k`;
  return String(n);
}

const HINT_KEYS = [
  "file_path",
  "path",
  "command",
  "pattern",
  "description",
  "query",
];

/**
 * Best-effort one-line hint of what a tool call did, from its input JSON. The
 * timeline is fetched without fullPayloads, so inputJson is server-truncated to
 * ~500 chars and JSON.parse can throw — fall back to a regex pull so hints don't
 * silently vanish for tool calls with large inputs.
 */
function toolHint(tc) {
  const raw = tc.inputJson ?? "";
  try {
    const input = JSON.parse(raw || "{}");
    for (const k of HINT_KEYS) {
      if (input[k]) return String(input[k]).slice(0, 90);
    }
    return "";
  } catch {
    for (const k of HINT_KEYS) {
      const m = raw.match(new RegExp(`"${k}"\\s*:\\s*"((?:[^"\\\\]|\\\\.)*)"`));
      if (m) return m[1].slice(0, 90);
    }
    return "";
  }
}

function updateDetailStatus(view) {
  const el = document.getElementById("detail-status");
  if (!el) return;
  el.textContent = view.status;
  el.className = `detail-status status-${view.status}`;
}

function renderDetail(sessionId, data) {
  const inst = instances.get(sessionId) ?? {};
  const meta = sessionMeta.get(sessionId) ?? {};
  const session = data.session ?? {};
  const messages = data.messages ?? [];

  // Authoritative totals come from the `sessions` aggregate, NOT the fetched
  // timeline window (which is capped at TIMELINE_WINDOW). Using the window for
  // counts is the bug that made everything read 250.
  const totalMessages = meta.messageCount ?? messages.length;
  const totalOutputTokens = meta.totalOutputTokens ?? 0;
  const truncated = messages.length < totalMessages;

  // Tool usage / output tokens here are over the loaded window only.
  const toolCounts = new Map();
  let toolTotal = 0;
  for (const m of messages) {
    for (const tc of m.toolCalls ?? []) {
      toolCounts.set(tc.toolName, (toolCounts.get(tc.toolName) ?? 0) + 1);
      toolTotal += 1;
    }
  }
  const tools = [...toolCounts.entries()].sort((a, b) => b[1] - a[1]);
  const toolMax = tools.length ? tools[0][1] : 1;

  const first = messages[0]?.timestampMs;
  const last = messages[messages.length - 1]?.timestampMs;
  const children = session.childSessions ?? [];

  const isFrenemy = inst.role === "frenemy";
  const status = inst.status ?? "—";

  // Build a chronological activity list (newest first), capped.
  const events = [];
  for (const m of messages) {
    if (m.role === "user" && !m.isSystem && m.content) {
      events.push({
        ts: m.timestampMs,
        kind: "prompt",
        text: m.content,
      });
    }
    for (const tc of m.toolCalls ?? []) {
      events.push({
        ts: m.timestampMs,
        kind: "tool",
        tool: tc.toolName,
        category: tc.category,
        hint: toolHint(tc),
        durationMs: tc.durationMs,
      });
    }
  }
  events.reverse();
  const shown = events.slice(0, 80);

  drawerEl.innerHTML = `
    <div class="drawer-head">
      <div class="drawer-title">
        <span class="dot dot-${status}"></span>
        <span class="dt-target">${escapeHtml(session.target ?? inst.target ?? "agent")}</span>
        ${isFrenemy ? `<span class="badge frenemy">frenemy</span>` : ""}
        <span id="detail-status" class="detail-status status-${status}">${escapeHtml(status)}</span>
      </div>
      <button class="drawer-close" id="drawer-close" aria-label="Close">✕</button>
    </div>
    <div class="drawer-sub">
      ${escapeHtml(session.model ?? "")} · ${escapeHtml(inst.branch ?? "—")} · ${escapeHtml(session.project ?? inst.room ?? "")}
      <br/><span class="mono-dim">${escapeHtml(sessionId)}</span>
    </div>

    <div class="stats">
      <div class="stat"><div class="stat-n">${fmtNum(totalMessages)}</div><div class="stat-l">messages</div></div>
      <div class="stat"><div class="stat-n">${fmtNum(toolTotal)}${truncated ? "+" : ""}</div><div class="stat-l">tool calls${truncated ? " (recent)" : ""}</div></div>
      <div class="stat"><div class="stat-n">${fmtNum(children.length)}</div><div class="stat-l">subagents</div></div>
      <div class="stat"><div class="stat-n">${fmtNum(totalOutputTokens)}</div><div class="stat-l">out tok</div></div>
      <div class="stat"><div class="stat-n">${fmtCost(meta.totalCost) ?? "—"}</div><div class="stat-l">cost</div></div>
      <div class="stat"><div class="stat-n">${fmtDuration(last - first)}</div><div class="stat-l">span${truncated ? " (recent)" : ""}</div></div>
    </div>

    ${
      tools.length
        ? `<div class="drawer-section">
        <h3>Tool usage</h3>
        <div class="bars">
          ${tools
            .map(
              ([name, n]) => `
            <div class="bar-row">
              <span class="bar-label">${escapeHtml(name)}</span>
              <span class="bar-track"><span class="bar-fill" style="width:${(n / toolMax) * 100}%"></span></span>
              <span class="bar-n">${n}</span>
            </div>`,
            )
            .join("")}
        </div>
      </div>`
        : ""
    }

    ${
      children.length
        ? `<div class="drawer-section">
        <h3>Subagents</h3>
        <ul class="children">
          ${children
            .map(
              (c) => `<li>
                <span class="child-rel">${escapeHtml(c.relationshipType ?? "agent")}</span>
                <span class="child-model">${escapeHtml(c.model ?? "—")}</span>
                <div class="child-prompt">${escapeHtml((c.firstPrompt ?? "").slice(0, 120) || "(no prompt captured)")}</div>
              </li>`,
            )
            .join("")}
        </ul>
      </div>`
        : ""
    }

    <div class="drawer-section">
      <h3>Activity <span class="mono-dim">newest first</span></h3>
      <ul class="tl">
        ${
          shown.length
            ? shown
                .map((ev) =>
                  ev.kind === "prompt"
                    ? `<li class="tl-item tl-prompt">
                        <span class="tl-tag">prompt</span>
                        <div class="tl-body">${escapeHtml(ev.text.slice(0, 240))}</div>
                      </li>`
                    : `<li class="tl-item tl-tool">
                        <span class="tl-tag">${escapeHtml(ev.tool)}</span>
                        <div class="tl-body">
                          ${ev.hint ? `<span class="tl-hint">${escapeHtml(ev.hint)}</span>` : `<span class="mono-dim">${escapeHtml(ev.category ?? "")}</span>`}
                          ${ev.durationMs ? `<span class="tl-dur">${fmtDuration(ev.durationMs)}</span>` : ""}
                        </div>
                      </li>`,
                )
                .join("")
            : `<li class="empty">No activity captured.</li>`
        }
      </ul>
    </div>

    ${
      STATIC
        ? ""
        : `<div class="drawer-section console">
      <h3>Send to this session</h3>
      <div class="console-box">
        <select id="op-kind" class="op-kind">
          <option value="chat">chat</option>
          <option value="challenge">challenge</option>
        </select>
        <textarea id="op-body" class="op-body" rows="2"
          placeholder="Message ${escapeHtml(shortId(sessionId))} over the bus…"></textarea>
        <div class="console-actions">
          <span id="op-status" class="op-status"></span>
          <button id="op-send" class="op-send">Send</button>
        </div>
      </div>
    </div>`
    }
  `;

  document
    .getElementById("drawer-close")
    ?.addEventListener("click", closeDetail);

  // Operator console: send a bus message/challenge to this session. Room comes
  // from the instance row (falls back to the session's repository).
  const sendBtn = document.getElementById("op-send");
  sendBtn?.addEventListener("click", async () => {
    const bodyEl = document.getElementById("op-body");
    const statusEl = document.getElementById("op-status");
    const body = bodyEl.value.trim();
    if (!body) return;
    const room = inst.room || meta.sessionSummary?.repository;
    sendBtn.disabled = true;
    statusEl.textContent = "sending…";
    try {
      await exec("bus-send", {
        room,
        from: "mission-control",
        to: sessionId,
        kind: document.getElementById("op-kind").value,
        body,
      });
      bodyEl.value = "";
      statusEl.textContent = "sent ✓";
    } catch (err) {
      statusEl.textContent = String(err).slice(0, 140);
    } finally {
      sendBtn.disabled = false;
    }
  });
}

// ---- Timeline (as-of-T scrubber) -------------------------------------------
// One virtual clock T over the data window drives live and snapshot alike:
// LIVE pins T to now and follows new events; scrubbing/playing moves T into the
// past and renderView() reconstructs the dashboard as of that instant.

const replaybarEl = document.getElementById("replaybar");
const rbPlay = document.getElementById("rb-play");
const rbScrub = document.getElementById("rb-scrub");
const rbTime = document.getElementById("rb-time");
const rbSpeed = document.getElementById("rb-speed");
const rbLive = document.getElementById("rb-live");
const rbEnd = document.getElementById("rb-end");

const PLAY_BASE_MS = 120_000; // full window plays in ~2 min at 1×
let tlMin = 0;
let tlMaxStatic = 0;
let playing = false;
let playTimer = null;

/** Upper bound of the timeline: frozen in snapshot mode, "now" when live. */
function tlMax() {
  return STATIC ? tlMaxStatic : Date.now();
}

function computeBounds() {
  let min = Number.POSITIVE_INFINITY;
  let max = 0;
  for (const i of allInstances.values()) {
    if (i.first_seen_ms) min = Math.min(min, i.first_seen_ms);
    max = Math.max(max, i.last_seen_ms ?? 0, i.ended_at_ms ?? 0);
  }
  for (const m of allMessages) {
    if (m.created_at_ms) {
      min = Math.min(min, m.created_at_ms);
      max = Math.max(max, m.created_at_ms, m.delivered_at_ms ?? 0);
    }
  }
  tlMin = Number.isFinite(min) ? min : Date.now();
  tlMaxStatic = Math.max(max, tlMin + 1);
}

function updateTimelineUI() {
  if (!replaybarEl || replaybarEl.hidden) return;
  const span = tlMax() - tlMin || 1;
  const p = Math.min(1, Math.max(0, (currentT() - tlMin) / span));
  if (rbScrub && document.activeElement !== rbScrub) {
    rbScrub.value = String(Math.round(p * 1000));
  }
  if (rbTime) {
    rbTime.textContent = following && !STATIC ? "LIVE" : timeStr(currentT());
  }
  if (rbLive) rbLive.classList.toggle("active", following);
}

/** Move to a past instant (stops following live). */
function seekTo(ts) {
  following = false;
  asOfT = Math.max(tlMin, Math.min(ts, tlMax()));
  renderView();
}

/** Re-pin to now and resume following (live mode). */
function goLive() {
  setPlaying(false);
  following = true;
  asOfT = null;
  renderView();
}

function setPlaying(p) {
  if (playTimer) {
    clearInterval(playTimer);
    playTimer = null;
  }
  playing = p;
  if (rbPlay) rbPlay.textContent = playing ? "⏸" : "▶";
  if (!playing) return;
  // From the start if we're live or already at the end.
  if (following || (asOfT != null && asOfT >= tlMax())) seekTo(tlMin);
  let last = Date.now();
  playTimer = setInterval(() => {
    const now = Date.now();
    const dt = now - last;
    last = now;
    const speed = Number(rbSpeed?.value ?? 1);
    const span = tlMax() - tlMin;
    const next = (asOfT ?? tlMin) + dt * speed * (span / PLAY_BASE_MS);
    if (next >= tlMax()) {
      if (STATIC) {
        seekTo(tlMax());
        setPlaying(false);
      } else {
        goLive(); // caught up to the present → resume live
      }
    } else {
      seekTo(next);
    }
  }, 100);
}

function setupTimeline() {
  computeBounds();
  if (replaybarEl) replaybarEl.hidden = false;
  if (rbLive) rbLive.hidden = STATIC; // LIVE only matters when live
  if (rbEnd) rbEnd.hidden = !STATIC; // jump-to-end only in snapshot

  rbPlay?.addEventListener("click", () => setPlaying(!playing));
  rbScrub?.addEventListener("input", () => {
    setPlaying(false);
    seekTo(tlMin + (Number(rbScrub.value) / 1000) * (tlMax() - tlMin));
  });
  rbLive?.addEventListener("click", goLive);
  rbEnd?.addEventListener("click", () => {
    setPlaying(false);
    seekTo(tlMax());
  });
  document.getElementById("rb-restart")?.addEventListener("click", () => {
    seekTo(tlMin);
    setPlaying(true);
  });
}

async function bootStatic() {
  setConn(
    "snapshot",
    boot.snapshotAt ? `snapshot · ${boot.snapshotAt}` : "snapshot",
  );
  await loadSource();
  setupTimeline();
  seekTo(tlMin);
  setPlaying(true); // autoplay the day
}

// ---- Boot -------------------------------------------------------------------

if (STATIC) {
  bootStatic();
} else {
  seed();
  connectStream();
}
