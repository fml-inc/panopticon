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

  // Challenges → mark on the addressed lane.
  try {
    const msgs = await tool("query", {
      sql: "SELECT to_session sid, created_at_ms ts FROM agent_messages WHERE kind='challenge' AND to_session IS NOT NULL ORDER BY id",
    });
    for (const m of msgs) {
      const lane = lanes.get(m.sid);
      if (lane) lane.challenges.push(m.ts);
    }
  } catch {
    /* no bus */
  }

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

const lanesEl = document.getElementById("lanes");
const loadingEl = document.getElementById("loading");
const ribbonFill = document.getElementById("ribbonFill");
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
    <div class="l-cost">$0.00</div>`;
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

function flashChallenge(r) {
  r.badge.hidden = false;
  r.li.classList.add("challenged");
  setTimeout(() => {
    r.li.classList.remove("challenged");
  }, 1500);
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
    // challenge burst when its time crosses the playhead (not while scrubbing)
    if (!instant && prevT != null) {
      for (const cts of lane.challenges) {
        if (cts > prevT && cts <= T) flashChallenge(r);
      }
    }
  }

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
  loadingEl.classList.add("hidden");
  setT(0);
  setPlaying(true);
})();
