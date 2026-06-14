// Panopticon Replay — the "show": a cinematic timeline where each unique session
// slides in when it appears and slides off when it finishes, over a virtual
// clock. Read-only; reads the same snapshot data the dashboard does.

const boot = window.__PANOPTICON__ ?? { static: true, source: "api" };

async function fetchJson(path) {
  const r = await fetch(path);
  if (!r.ok) throw new Error(`${path} -> ${r.status}`);
  return r.json();
}
async function tool(name, params = {}) {
  if (boot.source !== "api") {
    if (name === "instances") return fetchJson("data/instances.json");
    if (name === "sessions") return fetchJson("data/sessions.json");
    throw new Error(`static-json: ${name} unsupported in the show`);
  }
  const r = await fetch("/api/tool", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ name, params }),
  });
  if (!r.ok) throw new Error(`${name} -> ${r.status}`);
  return r.json();
}

// Per-turn cost = tokens × best-matching model_pricing (mirrors SESSION_COST_SQL).
const PER_TURN_COST_SQL = `COALESCE((
  SELECT st.input_tokens * COALESCE(mp.input_per_m,0)/1e6
       + st.output_tokens * COALESCE(mp.output_per_m,0)/1e6
       + st.cache_read_tokens * COALESCE(mp.cache_read_per_m,0)/1e6
       + st.cache_creation_tokens * COALESCE(mp.cache_write_per_m,0)/1e6
    FROM model_pricing mp WHERE st.model LIKE mp.model_id || '%'
    ORDER BY LENGTH(mp.model_id) DESC, mp.updated_ms DESC LIMIT 1),0)`;

// ---- model ------------------------------------------------------------------
/** session_id -> { title, model, parentId, firstTs, lastTs, turns:[ts],
 *   cum:[{ts,cum}], challenges:[ts] } */
const lanes = new Map();
let tlMin = 0;
let tlMax = 0;

function shortId(id) {
  return id ? id.slice(0, 8) : "—";
}
function modelShort(m) {
  if (!m) return "";
  const base = m.replace(/^claude-/, "").replace(/-\d{8}$/, "");
  const [name, ...rest] = base.split("-");
  return rest.length ? `${name} ${rest.join(".")}` : name;
}

async function load() {
  const sess = (await tool("sessions", { limit: 500 })).sessions ?? [];
  const meta = new Map(sess.map((s) => [s.sessionId, s]));

  // Per-turn activity + cost across the (already-scoped) scanner_turns.
  let turns = [];
  try {
    turns = await tool("query", {
      sql: `SELECT st.session_id sid, st.timestamp_ms ts, ${PER_TURN_COST_SQL} cost
              FROM scanner_turns st ORDER BY st.session_id, st.timestamp_ms`,
    });
  } catch (err) {
    console.error("turns query failed", err);
  }

  for (const t of turns) {
    let lane = lanes.get(t.sid);
    if (!lane) {
      const m = meta.get(t.sid) ?? {};
      const ss = m.sessionSummary ?? {};
      lane = {
        id: t.sid,
        title: (
          ss.title ||
          m.firstPrompt ||
          `agent · ${shortId(t.sid)}`
        ).trim(),
        model: modelShort(m.model),
        parentId: m.parentSessionId ?? null,
        firstTs: t.ts,
        lastTs: t.ts,
        turns: [],
        cum: [],
        challenges: [],
      };
      lanes.set(t.sid, lane);
    }
    lane.turns.push(t.ts);
    lane.lastTs = t.ts;
    const prev = lane.cum.length ? lane.cum[lane.cum.length - 1].cum : 0;
    lane.cum.push({ ts: t.ts, cum: prev + (t.cost ?? 0) });
  }

  // Frenemy challenges → real critique text on the addressed lane; track the
  // earliest for the headline milestone. Scoped to frenemy-authored messages so
  // operator/smoke-test challenges don't count.
  let firstChallengeTs = Number.POSITIVE_INFINITY;
  try {
    const msgs = await tool("query", {
      sql: "SELECT to_session sid, created_at_ms ts, body FROM agent_messages WHERE kind='challenge' AND (source='frenemy' OR from_session='frenemy') ORDER BY id",
    });
    for (const m of msgs) {
      firstChallengeTs = Math.min(firstChallengeTs, m.ts);
      if (m.sid) {
        const lane = lanes.get(m.sid);
        if (lane) lane.challenges.push({ ts: m.ts, body: m.body ?? "" });
      }
    }
  } catch {
    /* no bus */
  }

  // The headline moment: when frenemy challenge-logging first kicked in.
  milestones = BASE_MILESTONES.slice();
  if (Number.isFinite(firstChallengeTs)) {
    milestones.push({
      ts: firstChallengeTs,
      label: "⚡ First frenemy challenge",
      sub: "agents start reviewing each other on the bus",
      hot: true,
    });
  }
  milestones.sort((a, b) => a.ts - b.ts);

  // Time domain = the real activity window. A single session with corrupt
  // (off-by-a-day) turn timestamps can otherwise stretch the domain across a
  // huge dead gap. Find the largest gap between consecutive turns; if it's big,
  // clip to whichever side holds the bulk of the activity.
  const allTs = [];
  for (const l of lanes.values()) for (const ts of l.turns) allTs.push(ts);
  allTs.sort((a, b) => a - b);
  if (allTs.length === 0) {
    tlMin = Date.now();
    tlMax = tlMin + 1;
  } else {
    tlMin = allTs[0];
    tlMax = allTs[allTs.length - 1];
    let gapAt = 0;
    let gapMax = 0;
    for (let i = 1; i < allTs.length; i++) {
      const g = allTs[i] - allTs[i - 1];
      if (g > gapMax) {
        gapMax = g;
        gapAt = i;
      }
    }
    if (gapMax > 30 * 60_000) {
      const after = allTs.length - gapAt;
      if (after >= gapAt) tlMin = allTs[gapAt];
      else tlMax = allTs[gapAt - 1];
    }
    if (tlMax <= tlMin) tlMax = tlMin + 1;
  }
}

function cumAt(lane, T) {
  const a = lane.cum;
  if (!a.length) return 0;
  let lo = 0;
  let hi = a.length - 1;
  let ans = -1;
  while (lo <= hi) {
    const mid = (lo + hi) >> 1;
    if (a[mid].ts <= T) {
      ans = mid;
      lo = mid + 1;
    } else hi = mid - 1;
  }
  return ans >= 0 ? a[ans].cum : 0;
}
/** turns count in (a, b] — for the trailing-window sparkline + liveness. */
function turnsInWindow(lane, a, b) {
  let n = 0;
  for (const ts of lane.turns) if (ts > a && ts <= b) n++;
  return n;
}

// ---- playback ---------------------------------------------------------------
const ACTIVE_WIN = 45_000; // a turn within this of T → "active"
const LINGER = 60_000; // keep a finished lane on screen this long before exit
const SPARK_WIN = 5 * 60_000; // trailing window shown in the sparkline
const SPARK_BINS = 18;
const RATE_WIN = 120_000; // burn/rate trailing window
const MAX_LANES = 14;

let asOfT = null;
let progress = 0;
let playing = false;
let lastFrame = 0;
let scrubbing = false;

// Product build story — real PR/commit landing times for each layer. When the
// playhead crosses one, a callout fires, a tick sits on the ribbon, and it's
// added to the accumulating build-log. The "first challenge" milestone is added
// dynamically from the data (see load()).
const BASE_MILESTONES = [
  [
    "2026-06-13T11:15:04-07:00",
    "Layer 0",
    "instance presence + active-pid reaper",
  ],
  ["2026-06-13T12:05:51-07:00", "Layer 1", "agent-to-agent message bus (#276)"],
  [
    "2026-06-13T14:03:36-07:00",
    "Layer 2",
    "bus delivery into agent context (#277)",
  ],
  [
    "2026-06-13T14:38:37-07:00",
    "Frenemy",
    "adversarial reviewer on the bus (#281)",
  ],
  [
    "2026-06-13T16:18:02-07:00",
    "Mission Control",
    "live dashboard + this replay",
  ],
].map(([iso, label, sub]) => ({ ts: Date.parse(iso), label, sub }));

// Combined, sorted milestone list (base + dynamic first-challenge); built in load().
let milestones = BASE_MILESTONES.slice();

const lanesEl = document.getElementById("lanes");
const loadingEl = document.getElementById("loading");
const ribbonFill = document.getElementById("ribbonFill");
const ticksEl = document.getElementById("ticks");
const milestoneEl = document.getElementById("milestone");
const mLabel = document.getElementById("mLabel");
const mSub = document.getElementById("mSub");
const buildlogEl = document.getElementById("buildlog");
const buildlogShown = new Map(); // milestone index -> chip element
let milestoneTimer = null;
const playBtn = document.getElementById("play");
const scrub = document.getElementById("scrub");
const speedSel = document.getElementById("speed");
const els = { clock: "clock", active: "active", burn: "burn", spend: "spend" };
for (const k of Object.keys(els)) els[k] = document.getElementById(els[k]);

/** session_id -> rendered <li> (with cached child nodes) */
const rendered = new Map();

function fmtCost(c) {
  return `$${(c || 0).toFixed(2)}`;
}
function fmtClock(ts) {
  return new Date(ts).toLocaleTimeString([], { hour12: false });
}

function laneEl(lane) {
  const li = document.createElement("li");
  li.className = "lane";
  li.innerHTML = `
    <div class="l-id">
      <div class="l-title"><span class="l-dot"></span><span class="nm"></span>
        <span class="l-badge" hidden>challenge</span></div>
      <div class="l-sub"></div>
    </div>
    <div class="spark">${'<i style="height:1px"></i>'.repeat(SPARK_BINS)}</div>
    <div class="l-cost">$0.00</div>
    <div class="l-chaltext" hidden></div>`;
  li.querySelector(".nm").textContent = lane.title;
  li.querySelector(".l-sub").textContent = [lane.model, shortId(lane.id)]
    .filter(Boolean)
    .join(" · ");
  return {
    li,
    nm: li.querySelector(".nm"),
    sub: li.querySelector(".l-sub"),
    badge: li.querySelector(".l-badge"),
    bars: [...li.querySelectorAll(".spark i")],
    cost: li.querySelector(".l-cost"),
    chaltext: li.querySelector(".l-chaltext"),
  };
}

function updateLane(r, lane, T) {
  // sparkline over the trailing window
  const start = T - SPARK_WIN;
  const step = SPARK_WIN / SPARK_BINS;
  let peak = 1;
  const vals = [];
  for (let i = 0; i < SPARK_BINS; i++) {
    const v = turnsInWindow(lane, start + i * step, start + (i + 1) * step);
    vals.push(v);
    if (v > peak) peak = v;
  }
  for (let i = 0; i < SPARK_BINS; i++) {
    r.bars[i].style.height = `${Math.max(1, (vals[i] / peak) * 100)}%`;
  }
  r.cost.textContent = fmtCost(cumAt(lane, T));
  const recent = turnsInWindow(lane, T - ACTIVE_WIN, T);
  r.li.classList.toggle("active", recent > 0);
  r.li.classList.toggle("idle", recent === 0);
}

function flashChallenge(r, body) {
  r.badge.hidden = false;
  r.li.classList.add("challenged");
  if (body && r.chaltext) {
    r.chaltext.textContent = `🔴 ${body}`;
    r.chaltext.hidden = false;
  }
  clearTimeout(r._cf);
  r._cf = setTimeout(() => {
    r.li.classList.remove("challenged");
    if (r.chaltext) r.chaltext.hidden = true;
  }, 4500);
}

function showMilestone(m) {
  mLabel.textContent = m.label;
  mSub.textContent = m.sub;
  milestoneEl.hidden = false;
  milestoneEl.classList.remove("show");
  milestoneEl.classList.toggle("hot", !!m.hot); // emphasize first-challenge
  void milestoneEl.offsetWidth; // restart the entry animation
  milestoneEl.classList.add("show");
  clearTimeout(milestoneTimer);
  milestoneTimer = setTimeout(() => {
    milestoneEl.classList.remove("show");
    milestoneEl.hidden = true;
  }, 4500);
}

function renderTicks() {
  if (!ticksEl) return;
  const span = tlMax - tlMin || 1;
  ticksEl.innerHTML = "";
  for (const m of milestones) {
    if (m.ts < tlMin || m.ts > tlMax) continue;
    const t = document.createElement("span");
    t.className = m.hot ? "tick hot" : "tick";
    t.style.left = `${((m.ts - tlMin) / span) * 100}%`;
    t.title = `${m.label} — ${m.sub}`;
    ticksEl.appendChild(t);
  }
}

/** Accumulating build-log: chips for milestones reached by T (add on play,
 *  remove when scrubbed before them — idempotent per frame). */
function reconcileBuildlog(T) {
  if (!buildlogEl) return;
  for (let i = 0; i < milestones.length; i++) {
    const m = milestones[i];
    const reached = m.ts <= T;
    const have = buildlogShown.get(i);
    if (reached && !have) {
      const li = document.createElement("li");
      li.className = m.hot ? "blog hot" : "blog";
      li.innerHTML = `<span class="b-label"></span><span class="b-sub"></span>`;
      li.querySelector(".b-label").textContent = m.label;
      li.querySelector(".b-sub").textContent = m.sub;
      buildlogEl.appendChild(li);
      buildlogShown.set(i, li);
    } else if (!reached && have) {
      have.remove();
      buildlogShown.delete(i);
    }
  }
}

let prevT = null;
// instant=true (scrubbing): rebuild without enter/leave animations or challenge
// flashes, so dragging is snappy and arbitrary-T-correct.
function renderFrame(instant) {
  const T = asOfT ?? tlMin;
  const alive = [...lanes.values()]
    .filter((l) => l.firstTs <= T && T <= l.lastTs + LINGER)
    .sort((a, b) => b.lastTs - a.lastTs) // most-recently-active first
    .slice(0, MAX_LANES);
  const aliveIds = new Set(alive.map((l) => l.id));

  // remove lanes that left
  for (const [id, r] of rendered) {
    if (!aliveIds.has(id)) {
      if (instant) {
        r.li.remove();
      } else {
        r.li.classList.add("leaving");
        const el = r.li;
        setTimeout(() => el.remove(), 520);
      }
      rendered.delete(id);
    }
  }
  // add/update alive lanes (newest on top via prepend on first sight)
  for (const lane of alive) {
    let r = rendered.get(lane.id);
    if (!r) {
      r = laneEl(lane);
      if (instant) r.li.classList.add("no-anim");
      rendered.set(lane.id, r);
      lanesEl.prepend(r.li);
    }
    updateLane(r, lane, T);
    // challenge burst (with real critique text) when crossed; not while scrubbing
    if (!instant && prevT != null) {
      for (const c of lane.challenges) {
        if (c.ts > prevT && c.ts <= T) flashChallenge(r, c.body);
      }
    }
  }

  // product milestones — fire a callout as the playhead crosses each layer
  if (!instant && prevT != null) {
    for (const m of milestones) {
      if (m.ts > prevT && m.ts <= T) showMilestone(m);
    }
  }
  reconcileBuildlog(T); // accumulating list (works for play + scrub)

  // header
  let spend = 0;
  let spendPrev = 0;
  let active = 0;
  for (const l of lanes.values()) {
    spend += cumAt(l, T);
    spendPrev += cumAt(l, T - RATE_WIN);
    if (
      l.firstTs <= T &&
      T <= l.lastTs + LINGER &&
      turnsInWindow(l, T - ACTIVE_WIN, T) > 0
    )
      active++;
  }
  els.clock.textContent = fmtClock(T);
  els.active.textContent = String(active);
  els.burn.textContent = `$${((spend - spendPrev) / (RATE_WIN / 3_600_000)).toFixed(0)}/hr`;
  els.spend.textContent = fmtCost(spend);
  ribbonFill.style.width = `${progress * 100}%`;
  if (!scrubbing) scrub.value = String(Math.round(progress * 1000));
  prevT = T;
}

function setT(p, instant) {
  progress = Math.min(1, Math.max(0, p));
  asOfT = tlMin + progress * (tlMax - tlMin);
  renderFrame(instant);
}

function tick(now) {
  if (!playing) return;
  const dt = lastFrame ? now - lastFrame : 16;
  lastFrame = now;
  const speed = Number(speedSel.value);
  const next = (asOfT ?? tlMin) + dt * speed;
  if (next >= tlMax) {
    setT(1);
    setPlaying(false);
    return;
  }
  setT((next - tlMin) / (tlMax - tlMin));
  requestAnimationFrame(tick);
}

function setPlaying(p) {
  playing = p;
  playBtn.textContent = p ? "⏸" : "▶";
  if (p) {
    if (progress >= 1) {
      // restart cleanly
      for (const r of rendered.values()) r.li.remove();
      rendered.clear();
      prevT = null;
      setT(0);
    }
    lastFrame = 0;
    requestAnimationFrame(tick);
  }
}

playBtn.addEventListener("click", () => setPlaying(!playing));
document.getElementById("restart").addEventListener("click", () => {
  for (const r of rendered.values()) r.li.remove();
  rendered.clear();
  prevT = null;
  setT(0);
  setPlaying(true);
});
// Grab the scrubber → pause and take control; drag → instant seek; release →
// stays where you left it (resume with play).
scrub.addEventListener("pointerdown", () => {
  scrubbing = true;
  setPlaying(false);
});
const endScrub = () => {
  scrubbing = false;
};
scrub.addEventListener("pointerup", endScrub);
scrub.addEventListener("pointercancel", endScrub);
scrub.addEventListener("input", () => {
  scrubbing = true; // covers keyboard/track-click without a pointerdown
  setPlaying(false);
  setT(Number(scrub.value) / 1000, true);
});
scrub.addEventListener("change", endScrub);

// ---- boot -------------------------------------------------------------------
(async () => {
  document.getElementById("day").textContent = boot.snapshotAt ?? "";
  await load();
  renderTicks();
  loadingEl.classList.add("hidden");
  setT(0);
  setPlaying(true);
})();
