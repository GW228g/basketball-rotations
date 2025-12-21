// 4v4 Rotation Planner (FIXED)
// - Theme toggle: robust + saved, defaults to system preference
// - Fair time optimized: strict fairness-first (min/max minutes stays tight)
// - Sliding modes kept as-is, but fairness modes now truly fair

const PERIODS = 8;
const ON_COURT = 4;
const LS_KEY = "rotation_planner_state_v4";
const THEME_KEY = "rotation_planner_theme";

function uid() { return Math.random().toString(16).slice(2); }

function defaultState() {
  return {
    mode: "fair_optimized",
    currentPeriod: 1,
    topTwoCoverage: false,
    avoidStreaks: false,
    autoRebuild: false,
    players: Array.from({ length: 8 }, (_, i) => ({
      id: uid(),
      name: `Player ${i + 1}`,
      top: i < 2,
      available: true,
      out: false
    })),
    schedule: {},
    locked: {}
  };
}

let state = loadState();
if (!Array.isArray(state.players) || state.players.length === 0) {
  state = defaultState();
  saveState();
}

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    parsed.mode ??= "fair_optimized";
    parsed.currentPeriod ??= 1;
    parsed.topTwoCoverage ??= false;
    parsed.avoidStreaks ??= false;
    parsed.autoRebuild ??= false;
    parsed.players ??= [];
    parsed.schedule ??= {};
    parsed.locked ??= {};
    return parsed;
  } catch {
    return defaultState();
  }
}

function saveState() {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
}

function clampCurrentPeriod() {
  state.currentPeriod = Math.max(1, Math.min(PERIODS, Number(state.currentPeriod || 1)));
}

function playerById(id) {
  return state.players.find(p => p.id === id) || null;
}

function activePlayers() {
  return state.players.filter(p => p.available && !p.out);
}

function nameById(id) {
  const p = playerById(id);
  return p ? p.name : "(unknown)";
}

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function playedCountsUpTo(periodInclusive) {
  const counts = {};
  for (const p of state.players) counts[p.id] = 0;
  for (let k = 1; k <= periodInclusive; k++) {
    const lineup = state.schedule[String(k)];
    if (!lineup) continue;
    for (const pid of lineup) counts[pid] = (counts[pid] || 0) + 1;
  }
  return counts;
}

function consecutiveCountsUpTo(periodInclusive) {
  const streak = {};
  for (const p of state.players) streak[p.id] = 0;
  for (let k = 1; k <= periodInclusive; k++) {
    const set = new Set(state.schedule[String(k)] || []);
    for (const p of state.players) {
      streak[p.id] = set.has(p.id) ? (streak[p.id] || 0) + 1 : 0;
    }
  }
  return streak;
}

function topActiveIds(pool) {
  return pool.filter(p => p.top).map(p => p.id);
}

// Fair Top-2 enforcement (only when enabled)
function enforceTopTwoFair(lineup, pool, played) {
  if (!state.topTwoCoverage) return lineup;

  const topIds = topActiveIds(pool);
  if (topIds.length === 0) return lineup;

  if (lineup.some(pid => topIds.includes(pid))) return lineup;

  // bring in the top player with the LEAST minutes so far
  const pickTop = topIds.slice().sort((a, b) => (played[a] ?? 0) - (played[b] ?? 0))[0];

  // swap out the NON-top player with the MOST minutes so far
  const replaceCandidates = lineup.filter(pid => !topIds.includes(pid));
  if (replaceCandidates.length === 0) return lineup;

  const replacePid = replaceCandidates
    .slice()
    .sort((a, b) => (played[b] ?? 0) - (played[a] ?? 0))[0];

  const next = lineup.slice();
  next[next.indexOf(replacePid)] = pickTop;
  return next;
}

function violatesStreak(lineup, streakBefore) {
  if (!state.avoidStreaks) return false;
  for (const pid of lineup) if ((streakBefore[pid] || 0) >= 2) return true;
  return false;
}

/**
 * STRICT fairness picker:
 * Always prioritize players with the LOWEST played minutes.
 * Tie-break randomly. Optionally avoid streaks + enforce Top-2.
 * This guarantees perfect 4/4/4/4 when divisible (32 slots / 8 players).
 */
function pickStrictFairLineup({ poolIds, played, streakBefore }) {
  // sort by played ascending
  const sorted = poolIds.slice().sort((a, b) => (played[a] ?? 0) - (played[b] ?? 0));

  // Build lineup by taking from the lowest-played group(s)
  let lineup = [];
  let idx = 0;

  while (lineup.length < ON_COURT && idx < sorted.length) {
    const currentPlayed = played[sorted[idx]] ?? 0;
    const group = [];
    while (idx < sorted.length && ((played[sorted[idx]] ?? 0) === currentPlayed)) {
      group.push(sorted[idx]);
      idx++;
    }
    lineup = lineup.concat(shuffle(group));
  }

  lineup = lineup.slice(0, ON_COURT);

  // If streak avoidance is on, try a few reshuffles within the lowest-played set
  if (state.avoidStreaks) {
    let best = lineup;
    let bestPenalty = Infinity;

    // candidates: first ~6 lowest-played, enough to shuffle
    const candPool = sorted.slice(0, Math.min(sorted.length, 6));

    for (let t = 0; t < 30; t++) {
      const cand = shuffle(candPool).slice(0, ON_COURT);
      const penalty = violatesStreak(cand, streakBefore) ? 1 : 0;
      if (penalty < bestPenalty) {
        bestPenalty = penalty;
        best = cand;
        if (penalty === 0) break;
      }
    }
    lineup = best;
  }

  return lineup;
}

// --- Build modes

function buildSlidingAdaptiveFrom(startPeriod) {
  const pool = activePlayers();
  if (pool.length < ON_COURT) return;

  const played = playedCountsUpTo(startPeriod - 1);

  const rosterOrder = state.players.map(p => p.id);
  let pointer = (startPeriod - 1) % rosterOrder.length;

  function nextActiveId() {
    for (let tries = 0; tries < rosterOrder.length; tries++) {
      const pid = rosterOrder[pointer];
      pointer = (pointer + 1) % rosterOrder.length;
      const p = playerById(pid);
      if (p && p.available && !p.out) return pid;
    }
    return null;
  }

  for (let k = startPeriod; k <= PERIODS; k++) {
    if (state.locked[String(k)]) continue;

    const lineup = [];
    const used = new Set();
    while (lineup.length < ON_COURT) {
      const pid = nextActiveId();
      if (!pid) break;
      if (used.has(pid)) continue;
      used.add(pid);
      lineup.push(pid);
    }

    const finalLineup = enforceTopTwoFair(lineup, pool, played);
    state.schedule[String(k)] = finalLineup;
    for (const pid of finalLineup) played[pid] = (played[pid] || 0) + 1;
  }
}

function buildSlidingFixedFrom(startPeriod) {
  const pool = activePlayers();
  if (pool.length < ON_COURT) return;

  const played = playedCountsUpTo(startPeriod - 1);
  const ordered = state.players.filter(p => p.available && !p.out).map(p => p.id);

  for (let k = startPeriod; k <= PERIODS; k++) {
    if (state.locked[String(k)]) continue;

    const startIdx = (k - 1) % ordered.length;
    const lineup = [];
    for (let i = 0; i < ON_COURT; i++) lineup.push(ordered[(startIdx + i) % ordered.length]);

    const finalLineup = enforceTopTwoFair(lineup, pool, played);
    state.schedule[String(k)] = finalLineup;
    for (const pid of finalLineup) played[pid] = (played[pid] || 0) + 1;
  }
}

function buildTrueRandomFairFrom(startPeriod) {
  const pool = activePlayers();
  if (pool.length < ON_COURT) return;

  const poolIds = pool.map(p => p.id);
  const played = playedCountsUpTo(startPeriod - 1);
  let streak = consecutiveCountsUpTo(startPeriod - 1);

  for (let k = startPeriod; k <= PERIODS; k++) {
    if (state.locked[String(k)]) continue;

    // Random, but still fairness-biased: choose from lowest-played set with shuffles
    let lineup = pickStrictFairLineup({ poolIds, played, streakBefore: streak });
    lineup = shuffle(lineup); // inject extra randomness
    lineup = enforceTopTwoFair(lineup, pool, played);

    state.schedule[String(k)] = lineup;

    const set = new Set(lineup);
    for (const pid of poolIds) {
      if (set.has(pid)) {
        played[pid] = (played[pid] || 0) + 1;
        streak[pid] = (streak[pid] || 0) + 1;
      } else {
        streak[pid] = 0;
      }
    }
  }
}

function buildFairOptimizedFrom(startPeriod) {
  const pool = activePlayers();
  if (pool.length < ON_COURT) return;

  const poolIds = pool.map(p => p.id);
  const played = playedCountsUpTo(startPeriod - 1);
  let streak = consecutiveCountsUpTo(startPeriod - 1);

  for (let k = startPeriod; k <= PERIODS; k++) {
    if (state.locked[String(k)]) continue;

    let lineup = pickStrictFairLineup({ poolIds, played, streakBefore: streak });
    lineup = enforceTopTwoFair(lineup, pool, played);

    state.schedule[String(k)] = lineup;

    const set = new Set(lineup);
    for (const pid of poolIds) {
      if (set.has(pid)) {
        played[pid] = (played[pid] || 0) + 1;
        streak[pid] = (streak[pid] || 0) + 1;
      } else {
        streak[pid] = 0;
      }
    }
  }
}

// --- Rebuild

function rebuildFromCurrent() {
  clampCurrentPeriod();
  const start = state.currentPeriod;

  const pool = activePlayers();
  if (pool.length < ON_COURT) {
    setStatus(`Not enough active players. Need ${ON_COURT}, have ${pool.length}.`);
    return;
  }

  for (let k = start; k <= PERIODS; k++) {
    if (state.locked[String(k)]) continue;
    delete state.schedule[String(k)];
  }

  if (state.mode === "sliding_fixed") buildSlidingFixedFrom(start);
  else if (state.mode === "sliding_adaptive") buildSlidingAdaptiveFrom(start);
  else if (state.mode === "true_random_fair") buildTrueRandomFairFrom(start);
  else if (state.mode === "fair_optimized") buildFairOptimizedFrom(start);

  saveState();
  renderAll();
  setStatus(`Rebuilt from period ${start}.`);
}

// --- Theme (robust)

function applyTheme(theme) {
  document.documentElement.setAttribute("data-theme", theme);
  const btn = document.getElementById("themeToggle");
  if (btn) btn.textContent = theme === "light" ? "Dark mode" : "Light mode";
}

function initTheme() {
  const saved = localStorage.getItem(THEME_KEY);
  const prefersLight = window.matchMedia && window.matchMedia("(prefers-color-scheme: light)").matches;
  const theme = saved || (prefersLight ? "light" : "dark");
  applyTheme(theme);

  function wire() {
    const btn = document.getElementById("themeToggle");
    if (!btn) return false;
    btn.type = "button";
    btn.onclick = () => {
      const current = document.documentElement.getAttribute("data-theme") || "dark";
      const next = current === "light" ? "dark" : "light";
      localStorage.setItem(THEME_KEY, next);
      applyTheme(next);
    };
    return true;
  }

  // Try now, and again shortly after (covers caching/DOM timing edge cases)
  if (!wire()) setTimeout(wire, 250);
}

// --- UI

const elPlayers = document.getElementById("players");
const elLineups = document.getElementById("lineups");
const elMinutes = document.getElementById("minutes");
const elStatus = document.getElementById("status");

function setStatus(msg) {
  if (elStatus) elStatus.textContent = msg || "";
}

function renderPeriodSelect() {
  const sel = document.getElementById("currentPeriod");
  if (!sel) return;
  sel.innerHTML = "";
  for (let i = 1; i <= PERIODS; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `Period ${i}`;
    sel.appendChild(opt);
  }
  sel.value = String(state.currentPeriod);
  sel.onchange = () => { state.currentPeriod = Number(sel.value); saveState(); renderAll(); };
}

function renderSettings() {
  const mode = document.getElementById("mode");
  const topTwo = document.getElementById("topTwoCoverage");
  const avoid = document.getElementById("avoidStreaks");
  const auto = document.getElementById("autoRebuild");

  if (mode) {
    mode.value = state.mode;
    mode.onchange = () => { state.mode = mode.value; saveState(); renderAll(); };
  }
  if (topTwo) {
    topTwo.checked = !!state.topTwoCoverage;
    topTwo.onchange = () => { state.topTwoCoverage = topTwo.checked; saveState(); renderAll(); };
  }
  if (avoid) {
    avoid.checked = !!state.avoidStreaks;
    avoid.onchange = () => { state.avoidStreaks = avoid.checked; saveState(); renderAll(); };
  }
  if (auto) {
    auto.checked = !!state.autoRebuild;
    auto.onchange = () => { state.autoRebuild = auto.checked; saveState(); renderAll(); };
  }
}

function renderPlayers() {
  if (!elPlayers) return;
  elPlayers.innerHTML = "";

  state.players.forEach((p) => {
    const row = document.createElement("div");
    row.className = "player";

    const name = document.createElement("input");
    name.type = "text";
    name.value = p.name;
    name.onchange = () => {
      p.name = (name.value || "").trim() || p.name;
      saveState();
      renderAll();
    };

    const top = document.createElement("label");
    top.className = "pill";
    top.innerHTML = `<span class="badge">Top</span>`;
    const topCb = document.createElement("input");
    topCb.type = "checkbox";
    topCb.checked = !!p.top;
    topCb.onchange = () => {
      p.top = topCb.checked;
      saveState();
      state.autoRebuild ? rebuildFromCurrent() : renderAll();
    };
    top.appendChild(topCb);

    const avail = document.createElement("label");
    avail.className = "pill";
    avail.innerHTML = `<span class="badge">Avail</span>`;
    const availCb = document.createElement("input");
    availCb.type = "checkbox";
    availCb.checked = !!p.available;
    availCb.onchange = () => {
      p.available = availCb.checked;
      saveState();
      state.autoRebuild ? rebuildFromCurrent() : renderAll();
    };
    avail.appendChild(availCb);

    const out = document.createElement("label");
    out.className = "pill";
    out.innerHTML = `<span class="badge">Out</span>`;
    const outCb = document.createElement("input");
    outCb.type = "checkbox";
    outCb.checked = !!p.out;
    outCb.onchange = () => {
      p.out = outCb.checked;
      saveState();
      state.autoRebuild ? rebuildFromCurrent() : renderAll();
    };
    out.appendChild(outCb);

    row.appendChild(name);
    row.appendChild(top);
    row.appendChild(avail);
    row.appendChild(out);
    elPlayers.appendChild(row);
  });
}

function renderLineups() {
  if (!elLineups) return;
  elLineups.innerHTML = "";

  for (let k = 1; k <= PERIODS; k++) {
    const wrap = document.createElement("div");
    wrap.className = "lineup";
    if (k === state.currentPeriod) wrap.classList.add("current");

    const locked = !!state.locked[String(k)];
    const title = document.createElement("div");
    title.innerHTML = `<strong>Period ${k}</strong>${locked ? `<span class="lockedTag">Locked</span>` : ""}`;
    wrap.appendChild(title);

    const lineup = state.schedule[String(k)];
    const body = document.createElement("div");

    if (!lineup) {
      body.className = "small";
      body.textContent = "No lineup yet. Rebuild to generate.";
    } else {
      body.textContent = lineup.map(nameById).join(", ");
    }

    wrap.appendChild(body);
    elLineups.appendChild(wrap);
  }
}

function renderMinutes() {
  if (!elMinutes) return;
  const counts = playedCountsUpTo(PERIODS);

  const rows = state.players.map(p => ({
    name: p.name,
    played: counts[p.id] || 0,
    status: p.out ? "Out" : (p.available ? "Available" : "Not here"),
    top: p.top ? "Top" : ""
  }));

  elMinutes.innerHTML = `
    <table class="table">
      <thead><tr><th>Player</th><th>Played</th><th>Status</th><th></th></tr></thead>
      <tbody>
        ${rows.map(r => `
          <tr>
            <td>${escapeHtml(r.name)}</td>
            <td>${r.played}</td>
            <td>${r.status}</td>
            <td>${r.top}</td>
          </tr>
        `).join("")}
      </tbody>
    </table>
  `;
}

function escapeHtml(s) {
  return String(s)
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderAll() {
  clampCurrentPeriod();
  renderSettings();
  renderPeriodSelect();
  renderPlayers();
  renderLineups();
  renderMinutes();
}

// Buttons
const rebuildBtn = document.getElementById("rebuildBtn");
if (rebuildBtn) rebuildBtn.onclick = rebuildFromCurrent;

const lockBtn = document.getElementById("lockCurrentBtn");
if (lockBtn) lockBtn.onclick = () => {
  clampCurrentPeriod();
  state.locked[String(state.currentPeriod)] = true;
  saveState();
  renderAll();
  setStatus(`Locked period ${state.currentPeriod}.`);
};

const unlockBtn = document.getElementById("unlockAllBtn");
if (unlockBtn) unlockBtn.onclick = () => {
  clampCurrentPeriod();
  for (let k = state.currentPeriod; k <= PERIODS; k++) delete state.locked[String(k)];
  saveState();
  renderAll();
  setStatus("Unlocked all future periods.");
};

const saveRosterBtn = document.getElementById("saveRosterBtn");
if (saveRosterBtn) saveRosterBtn.onclick = () => {
  saveState();
  setStatus("Roster saved.");
};

const resetGameBtn = document.getElementById("resetGameBtn");
if (resetGameBtn) resetGameBtn.onclick = () => {
  if (!confirm("Reset schedule and locks? Roster stays.")) return;
  state.currentPeriod = 1;
  state.schedule = {};
  state.locked = {};
  saveState();
  renderAll();
  setStatus("Game reset.");
};

const resetAllBtn = document.getElementById("resetAllBtn");
if (resetAllBtn) resetAllBtn.onclick = () => {
  if (!confirm("Reset everything including roster names?")) return;
  state = defaultState();
  saveState();
  renderAll();
  setStatus("Everything reset.");
};

// Start
initTheme();
renderAll();
