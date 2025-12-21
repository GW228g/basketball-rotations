// 4v4 Rotation Planner
// Modes:
// - sliding_fixed: moving window over active list
// - sliding_adaptive: slides over roster order and skips inactive
// - true_random_fair: only playing time fairness, random tie breaks
// - fair_optimized: greedily selects most owed, with optional streak limit and top-2 coverage

const PERIODS = 8;
const ON_COURT = 4;
const LS_KEY = "rotation_planner_state_v2";

function uid() { return Math.random().toString(16).slice(2); }

function defaultState() {
  return {
    mode: "sliding_adaptive",
    currentPeriod: 1,
    topTwoCoverage: true,
    avoidStreaks: true,
    autoRebuild: false,

    players: Array.from({ length: 8 }, (_, i) => ({
      id: uid(),
      name: `Player ${i + 1}`,
      top: i < 2,
      available: true,
      out: false
    })),

    schedule: {}, // { "1": [ids...], ... }
    locked: {}    // { "k": true } locks period k from rebuild changes
  };
}

let state = loadState();

function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    if (!parsed.players) return defaultState();
    // ensure new fields exist
    parsed.mode ??= "sliding_adaptive";
    parsed.currentPeriod ??= 1;
    parsed.topTwoCoverage ??= true;
    parsed.avoidStreaks ??= true;
    parsed.autoRebuild ??= false;
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

function activePlayers() {
  return state.players.filter(p => p.available && !p.out);
}

function playerById(id) {
  return state.players.find(p => p.id === id) || null;
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

function buildConsecutiveCounts(upToPeriod) {
  // returns { pid: current streak ending at upToPeriod }
  const streak = {};
  for (const p of state.players) streak[p.id] = 0;

  for (let k = 1; k <= upToPeriod; k++) {
    const lineup = new Set(state.schedule[String(k)] || []);
    for (const p of state.players) {
      if (lineup.has(p.id)) streak[p.id] = (streak[p.id] || 0) + 1;
      else streak[p.id] = 0;
    }
  }
  return streak;
}

function topActiveIds(pool) {
  return pool.filter(p => p.top).map(p => p.id);
}

function enforceTopTwo(lineup, pool) {
  if (!state.topTwoCoverage) return lineup;

  const topIds = topActiveIds(pool);
  if (topIds.length === 0) return lineup;

  const hasTop = lineup.some(pid => topIds.includes(pid));
  if (hasTop) return lineup;

  // swap a top player in
  const pickTop = topIds[Math.floor(Math.random() * topIds.length)];
  if (lineup.includes(pickTop)) return lineup;

  const replaceIdx = lineup.findIndex(pid => !topIds.includes(pid));
  if (replaceIdx >= 0) {
    const next = lineup.slice();
    next[replaceIdx] = pickTop;
    return next;
  }

  return lineup;
}

function violatesStreak(lineup, streakBefore) {
  if (!state.avoidStreaks) return false;
  // soft limit: 2 consecutive periods
  for (const pid of lineup) {
    const s = streakBefore[pid] || 0;
    if (s >= 2) return true;
  }
  return false;
}

function pickLineupMostOwed({ pool, need, played, streakBefore }) {
  // pool: player objects
  // need: remaining target allocations (higher means owed)
  // played: counts so far
  // Choose 4. Prefer higher need. Random tie breaks. Try to avoid streak violations.

  const ids = pool.map(p => p.id);

  // Sort by need desc, then played asc
  const sorted = ids.slice().sort((a, b) => {
    const dn = (need[b] ?? 0) - (need[a] ?? 0);
    if (dn !== 0) return dn;
    return (played[a] ?? 0) - (played[b] ?? 0);
  });

  // Build candidate bucket: within 1 of max need
  const maxNeed = need[sorted[0]] ?? 0;
  let bucket = sorted.filter(pid => (need[pid] ?? 0) >= maxNeed - 1);
  bucket = shuffle(bucket);

  // If bucket too small, expand
  let tier = maxNeed - 1;
  while (bucket.length < ON_COURT) {
    tier -= 1;
    const expanded = sorted.filter(pid => (need[pid] ?? 0) >= tier);
    bucket = shuffle(Array.from(new Set([...bucket, ...expanded])));
    if (tier < -50) break;
  }

  // Try a few random draws to avoid streaks if enabled
  let best = null;
  let bestScore = -Infinity;

  for (let attempt = 0; attempt < 30; attempt++) {
    const pick = shuffle(bucket).slice(0, ON_COURT);
    let score = 0;

    // Prefer higher need and lower played
    for (const pid of pick) {
      score += (need[pid] ?? 0) * 10;
      score += Math.max(0, 10 - (played[pid] ?? 0));
    }

    // Penalize streak violations
    if (violatesStreak(pick, streakBefore)) score -= 100;

    // Softly prefer including a top player (only as tie breaker)
    if (state.topTwoCoverage) {
      const topIds = topActiveIds(pool);
      if (topIds.length > 0 && pick.some(pid => topIds.includes(pid))) score += 2;
    }

    if (score > bestScore) {
      bestScore = score;
      best = pick;
    }
  }

  return best || shuffle(sorted).slice(0, ON_COURT);
}

function remainingNeedFromTargets({ poolIds, remainingSpots }) {
  // Distribute remaining spots evenly: base + remainder
  const base = Math.floor(remainingSpots / poolIds.length);
  const rem = remainingSpots % poolIds.length;
  const bonus = new Set(shuffle(poolIds).slice(0, rem));

  const need = {};
  for (const pid of poolIds) {
    need[pid] = base + (bonus.has(pid) ? 1 : 0);
  }
  return need;
}

// --- Build modes

function buildSlidingFixedFrom(startPeriod) {
  const pool = activePlayers();
  if (pool.length < ON_COURT) return;

  // ordered = active players in current roster order
  const ordered = state.players.filter(p => p.available && !p.out).map(p => p.id);

  for (let k = startPeriod; k <= PERIODS; k++) {
    if (state.locked[String(k)]) continue;

    const startIdx = (k - 1) % ordered.length;
    const lineup = [];
    for (let i = 0; i < ON_COURT; i++) {
      lineup.push(ordered[(startIdx + i) % ordered.length]);
    }
    state.schedule[String(k)] = enforceTopTwo(lineup, pool);
  }
}

function buildSlidingAdaptiveFrom(startPeriod) {
  const pool = activePlayers();
  if (pool.length < ON_COURT) return;

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

    // Fill if short (should be rare)
    if (lineup.length < ON_COURT) {
      for (const p of shuffle(pool)) {
        if (lineup.length >= ON_COURT) break;
        if (!used.has(p.id)) lineup.push(p.id);
      }
    }

    state.schedule[String(k)] = enforceTopTwo(lineup, pool);
  }
}

function buildTrueRandomFairFrom(startPeriod) {
  const pool = activePlayers();
  if (pool.length < ON_COURT) return;

  const played = playedCountsUpTo(startPeriod - 1);
  const streakBeforeStart = buildConsecutiveCounts(startPeriod - 1);

  const ids = pool.map(p => p.id);
  const periodsLeft = PERIODS - startPeriod + 1;
  const remainingSpots = periodsLeft * ON_COURT;
  const need = remainingNeedFromTargets({ poolIds: ids, remainingSpots });

  let streak = { ...streakBeforeStart };

  for (let k = startPeriod; k <= PERIODS; k++) {
    if (state.locked[String(k)]) continue;

    // Only rule is fairness by need. TopTwo and streak toggles can still apply if turned on.
    // If you want purely minutes-only, just turn off Top-2 and Avoid streaks in UI.
    const pick = pickLineupMostOwed({ pool, need, played, streakBefore: streak });
    const lineup = enforceTopTwo(pick, pool);

    state.schedule[String(k)] = lineup;

    // update counters
    const lineupSet = new Set(lineup);
    for (const pid of ids) {
      if (lineupSet.has(pid)) {
        played[pid] = (played[pid] || 0) + 1;
        need[pid] = (need[pid] || 0) - 1;
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

  const played = playedCountsUpTo(startPeriod - 1);
  const streakBeforeStart = buildConsecutiveCounts(startPeriod - 1);

  const ids = pool.map(p => p.id);
  const periodsLeft = PERIODS - startPeriod + 1;
  const remainingSpots = periodsLeft * ON_COURT;
  const need = remainingNeedFromTargets({ poolIds: ids, remainingSpots });

  let streak = { ...streakBeforeStart };

  for (let k = startPeriod; k <= PERIODS; k++) {
    if (state.locked[String(k)]) continue;

    const pick = pickLineupMostOwed({ pool, need, played, streakBefore: streak });
    const lineup = enforceTopTwo(pick, pool);

    state.schedule[String(k)] = lineup;

    const lineupSet = new Set(lineup);
    for (const pid of ids) {
      if (lineupSet.has(pid)) {
        played[pid] = (played[pid] || 0) + 1;
        need[pid] = (need[pid] || 0) - 1;
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

  // Clear future periods except locked ones
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

// --- UI wiring

const elPlayers = document.getElementById("players");
const elLineups = document.getElementById("lineups");
const elMinutes = document.getElementById("minutes");
const elStatus = document.getElementById("status");

function setStatus(msg) {
  elStatus.textContent = msg || "";
}

function renderPeriodSelect() {
  const sel = document.getElementById("currentPeriod");
  sel.innerHTML = "";
  for (let i = 1; i <= PERIODS; i++) {
    const opt = document.createElement("option");
    opt.value = String(i);
    opt.textContent = `Period ${i}`;
    sel.appendChild(opt);
  }
  sel.value = String(state.currentPeriod);
  sel.onchange = () => {
    state.currentPeriod = Number(sel.value);
    saveState();
    renderAll();
  };
}

function renderSettings() {
  const mode = document.getElementById("mode");
  const topTwo = document.getElementById("topTwoCoverage");
  const avoid = document.getElementById("avoidStreaks");
  const auto = document.getElementById("autoRebuild");

  mode.value = state.mode;
  mode.onchange = () => { state.mode = mode.value; saveState(); renderAll(); };

  topTwo.checked = !!state.topTwoCoverage;
  topTwo.onchange = () => { state.topTwoCoverage = topTwo.checked; saveState(); renderAll(); };

  avoid.checked = !!state.avoidStreaks;
  avoid.onchange = () => { state.avoidStreaks = avoid.checked; saveState(); renderAll(); };

  auto.checked = !!state.autoRebuild;
  auto.onchange = () => { state.autoRebuild = auto.checked; saveState(); renderAll(); };
}

function renderPlayers() {
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
      if (state.autoRebuild) rebuildFromCurrent(); else renderAll();
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
      if (state.autoRebuild) rebuildFromCurrent(); else renderAll();
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
      if (state.autoRebuild) rebuildFromCurrent(); else renderAll();
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

  // helpful warning if Top-2 coverage is enabled but none are active
  const pool = activePlayers();
  const topIds = topActiveIds(pool);
  if (state.topTwoCoverage && topIds.length === 0) {
    setStatus("Top-2 coverage is on, but none of your Top players are currently active.");
  } else {
    setStatus("");
  }
}

// Buttons
document.getElementById("rebuildBtn").onclick = rebuildFromCurrent;

document.getElementById("lockCurrentBtn").onclick = () => {
  clampCurrentPeriod();
  state.locked[String(state.currentPeriod)] = true;
  saveState();
  renderAll();
  setStatus(`Locked period ${state.currentPeriod}.`);
};

document.getElementById("unlockAllBtn").onclick = () => {
  clampCurrentPeriod();
  for (let k = state.currentPeriod; k <= PERIODS; k++) delete state.locked[String(k)];
  saveState();
  renderAll();
  setStatus("Unlocked all future periods.");
};

document.getElementById("saveRosterBtn").onclick = () => {
  saveState();
  setStatus("Roster saved.");
};

document.getElementById("resetGameBtn").onclick = () => {
  if (!confirm("Reset schedule and locks? Roster stays.")) return;
  state.currentPeriod = 1;
  state.schedule = {};
  state.locked = {};
  saveState();
  renderAll();
  setStatus("Game reset.");
};

document.getElementById("resetAllBtn").onclick = () => {
  if (!confirm("Reset everything including roster names?")) return;
  state = defaultState();
  saveState();
  renderAll();
  setStatus("Everything reset.");
};

renderAll();
