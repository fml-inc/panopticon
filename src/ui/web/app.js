// Mission Control client. Seeds state from /api/tool, then live-updates over the
// SSE stream (/api/events). Runs unchanged in a browser tab or Electron renderer.

const boot = window.__PANOPTICON__ ?? { token: "", port: null };

/** POST a read-only Panopticon tool and return its JSON result. */
async function tool(name, params = {}) {
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

// ---- Roster -----------------------------------------------------------------

/** session_id -> instance view */
const instances = new Map();

/** session_id -> session row from the `sessions` tool (title, model, cost…). */
const sessionMeta = new Map();
/** parent session_id -> count of child (subagent) sessions, for topology. */
const childCount = new Map();
/** Fleet burn-rate state, recomputed from session-cost deltas each poll. */
let prevAgg = null; // { ts, cost, tokens }
let burnPerHr = null;
let tokPerMin = null;
let totalSpend = 0;

const rosterEl = document.getElementById("roster");
const countsEl = document.getElementById("counts");
const missionbarEl = document.getElementById("missionbar");

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
  const s = Math.round((Date.now() - ms) / 1000);
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
    renderRoster();
  }, delay);
}

const STATUS_RANK = { active: 0, idle: 1, exited: 2 };

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

  if (rows.length === 0) {
    rosterEl.innerHTML = `<li class="empty">No instances yet.</li>`;
    return;
  }

  // Group by room (repo) — surfaces the fleet topology. Rooms keep the global
  // status sort within each group.
  const byRoom = new Map();
  for (const i of rows) {
    const key = roomKey(i);
    if (!byRoom.has(key)) byRoom.set(key, []);
    byRoom.get(key).push(i);
  }

  rosterEl.innerHTML = [...byRoom.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
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

/** Aggregate burn-rate header across the fleet. */
function renderMissionBar() {
  if (!missionbarEl) return;
  const active = [...instances.values()].filter(
    (i) => i.status === "active",
  ).length;
  const tile = (label, value) =>
    `<div class="mtile"><span class="mval">${value}</span><span class="mlabel">${label}</span></div>`;
  missionbarEl.innerHTML =
    tile("active", active) +
    tile("burn", burnPerHr == null ? "—" : `$${burnPerHr.toFixed(2)}/hr`) +
    tile(
      "tokens",
      tokPerMin == null ? "—" : `${fmtNum(Math.round(tokPerMin))}/min`,
    ) +
    tile("spend", `$${totalSpend.toFixed(2)}`);
}

function applyInstance(view) {
  if (!view || !view.session_id) return;
  instances.set(view.session_id, view);
  scheduleRender();
  // Keep the open drawer's live status chip in sync with presence (immediate —
  // it's a single element, not the whole list).
  if (view.session_id === selectedSession) updateDetailStatus(view);
}

// ---- Bus feed ---------------------------------------------------------------

const feedEl = document.getElementById("feed");
const feedMetaEl = document.getElementById("feed-meta");
let messageCount = 0;

function timeStr(ms) {
  if (!ms) return "";
  const d = new Date(ms);
  return d.toLocaleTimeString([], { hour12: false });
}

function applyMessage(msg) {
  if (!msg) return;
  if (messageCount === 0) feedEl.innerHTML = "";
  messageCount += 1;
  feedMetaEl.textContent = `${messageCount} msg`;

  const kind = msg.kind ?? "activity";
  const from = shortId(msg.from_session);
  const to = msg.to_session ? `→ ${shortId(msg.to_session)}` : "→ room";
  const li = document.createElement("li");
  li.className = `msg kind-${kind}`;
  li.innerHTML = `
    <div class="msg-head">
      <span class="msg-kind">${escapeHtml(kind)}</span>
      <span>${from} ${to}</span>
      <span>${timeStr(msg.created_at_ms)}</span>
    </div>
    <div class="msg-body">${escapeHtml(msg.body ?? "")}</div>
    ${msg.ref_path ? `<div class="msg-ref">${escapeHtml(msg.ref_path)}</div>` : ""}
  `;
  feedEl.prepend(li);

  // Bubble challenges to any host shell (Electron) for native notification.
  if (kind === "challenge" && window.__PANOPTICON_HOST__?.onChallenge) {
    window.__PANOPTICON_HOST__.onChallenge(msg);
  }
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
  es.onopen = () => setConn("live", "live");
  es.onerror = () => setConn("down", "reconnecting…");
  es.addEventListener("instance", (e) => applyInstance(JSON.parse(e.data)));
  es.addEventListener("message", (e) => applyMessage(JSON.parse(e.data)));
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

    // Burn rate: delta of fleet cost/tokens since the last poll.
    let sumCost = 0;
    let sumTok = 0;
    for (const s of sessionMeta.values()) {
      sumCost += s.totalCost ?? 0;
      sumTok += s.totalOutputTokens ?? 0;
    }
    totalSpend = sumCost;
    const now = Date.now();
    if (prevAgg) {
      const dtHr = (now - prevAgg.ts) / 3_600_000;
      const dtMin = (now - prevAgg.ts) / 60_000;
      if (dtHr > 0) burnPerHr = Math.max(0, (sumCost - prevAgg.cost) / dtHr);
      if (dtMin > 0) tokPerMin = Math.max(0, (sumTok - prevAgg.tokens) / dtMin);
    }
    prevAgg = { ts: now, cost: sumCost, tokens: sumTok };

    scheduleRender();
  } catch (err) {
    console.error("session meta refresh failed", err);
  }
}

async function seed() {
  try {
    const res = await tool("instances", { includeEnded: true });
    for (const i of res.instances ?? []) instances.set(i.session_id, i);
    renderRoster();
  } catch (err) {
    console.error("roster seed failed", err);
  }

  await refreshSessionMeta();
  setInterval(refreshSessionMeta, 15000);

  // Seed recent bus messages across all rooms via SQL (the bus_read tool is
  // room-scoped; the dashboard wants the whole fleet). Live updates arrive over
  // the SSE `message` stream.
  try {
    const rows = await tool("query", {
      sql: "SELECT id, room, from_session, to_session, kind, body, subject, ref_path, source, created_at_ms FROM agent_messages ORDER BY id DESC LIMIT 50",
    });
    for (const m of (Array.isArray(rows) ? rows : []).reverse())
      applyMessage(m);
  } catch (err) {
    console.error("bus seed failed", err);
  }
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

/** Best-effort one-line hint of what a tool call did, from its input JSON. */
function toolHint(tc) {
  try {
    const input = JSON.parse(tc.inputJson ?? "{}");
    const hint =
      input.file_path ??
      input.path ??
      input.command ??
      input.pattern ??
      input.description ??
      input.query ??
      "";
    return String(hint).slice(0, 90);
  } catch {
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

    <div class="drawer-section console">
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
    </div>
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

seed();
connectStream();
