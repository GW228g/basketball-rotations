// 4v4 Rotation Planner (UPDATED)
// Fix: Top-2 enforcement no longer benches the same kid repeatedly in Sliding modes.
// It now swaps out the player in the lineup with the MOST minutes so far (fair).

const PERIODS = 8;
const ON_COURT = 4;
const LS_KEY = "rotation_planner_state_v3";

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
    parsed.mode ??= "sliding_adaptive";
    parsed.currentPeriod ??= 1;
    parsed.topTwoCoverage ??= true;
    parsed.avoidStreaks ??= true;
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

function buildConsecutiveCounts(upToPeriod) {
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

// FAIR Top-2 enforcement:
// - If lineup has no top player, bring in a top player who has played the LEAST so far
// - Swap out a non-top player in the lineup who has played the MOST so far
function enforceTopTwoFair(lineup, pool, played) {
  if (!state.topTwoCoverage) return lineup;

  const topIds = topActiveIds(pool);
  if (topIds.length === 0) return lineup;

  if (lineup.some(pid => topIds.includes(pid))) return lineup;

  const pickTop = topIds.slice().sort((a, b) => (played[a] ?? 0) - (played[b] ?? 0))[0];

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
  for (const pid of lineup) {
    if ((streakBefore[pid] || 0) >= 2) return true;
  }
  return false;
}

function remainingNeedFromTargets(poolIds, remainingSpots) {
  const base = Math.floor(remainingSpots / poolIds.length);
  const rem = remainingSpots % poolIds.length;
  const bonus = new Set(shuffle(poolIds).slice(0, rem));
  const need = {};
  for (const pid of poolIds) need[pid] = base + (bonus.has(pid) ? 1 : 0);
  return need;
}

function pickLineupMostOwed({ pool, need, played, streakBefore }) {
  const ids = pool.map(p => p.id);
  const sorted = ids.slice().sort((a, b) => {
    const dn = (need[b] ?? 0) - (need[a] ?? 0);
    if (dn !== 0) return dn;
    return (played[a] ?? 0) - (played[b] ?? 0);
  });

  const maxNeed = need[sorted[0]] ?? 0;
  let bucket = sorted.filter(pid => (need[pid] ?? 0) >= maxNeed - 1);
  bucket = shuffle(bucket);

  let tier = maxNeed - 1;
  while (bucket.length < ON_COURT) {
    tier -= 1;
    const expanded = sorted.filter(pid => (need[pid] ?? 0) >= tier);
    bucket = shuffle(Array.from(new Set([...bucket, ...expanded])));
    if (tier < -50) break;
  }

  let best = null;
  let bestScore = -Infinity;

  for (let attempt = 0; attempt < 30; attempt++) {
    const pick = shuffle(bucket).slice(0, ON_COURT);
    let score = 0;

    for (const pid of pick) {
      score += (need[pid] ?? 0) * 10;
      score += Math.max(0, 10 - (played[pid] ?? 0));
    }

    if (violatesStreak(pick, streakBefore)) score -= 100;

    if (score > bestScore) {
      bestScore = score;
      best = pick;
    }
  }

  return best || shuffle(sorted).slice(0, ON_COURT);
}

// --- Build modes

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

    if (lineup.length < ON_COURT) {
      for (const p of shuffle(pool)) {
        if (lineup.length >= ON_COURT) break;
        if (!used.has(p.id)) lineup.push(p.id);
      }
    }

    const finalLineup = enforceTopTwoFair(lineup, pool, played);
    state.schedule[String(k)] = finalLineup;

    for (const pid of finalLineup) played[pid] = (played[pid] || 0) + 1;
  }
}

function buildTrueRandomFairFrom(startPeriod) {
  const pool = activePlayers();
  if (pool.length < ON_COURT) return;

  const played = playedCountsUpTo(startPeriod - 1);
  let streak = buildConsecutiveCounts(startPeriod - 1);

  const ids = pool.map(p => p.id);
  const periodsLeft = PERIODS - startPeriod + 1;
  const remainingSpots = periodsLeft * ON_COURT;
  const need = remainingNeedFromTargets(ids, remainingSpots);

  for (let k = startPeriod; k <= PERIODS; k++) {
    if (state.locked[String(k)]) continue;

    const pick = pickLineupMostOwed({ pool, need, played, streakBefore: streak });
    // In true random mode, Top-2 and streak rules still apply only if you keep them checked.
    const lineup = enforceTopTwoFair(pick, pool, played);

    state.schedule[String(k)] = lineup;

    const set = new Set(lineup);
    for (const pid of ids) {
      if (set.has(pid)) {
        played[pid] = (played[pid] || 0) + 1;
        need[pid] = (need[pid] || 0) - 1;
        streak[pid] = (streak[pid] || 0) + 1;
      } else streak[pid] = 0;
    }
  }
}

function buildFairOptimizedFrom(startPeriod) {
  // This mode already balances time well; still uses the fair Top-2 swap.
  buildTrueRandomFairFrom(startPeriod);
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

// --- UI wiring

const elPlayers = document.getElementById("players");
const elLineups = document.getElementById("lineups");
const elMinutes = document.getElementById("minutes");
const elStatus = document.getElementById("status");

function setStatus(msg) { elStatus.textContent = msg || ""; }

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
  sel.onchange = () => { state.currentPeriod = Number(sel.value); saveState(); renderAll(); };
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
    name.onchange = () => { p.name = (name.value || "").trim() || p.name; saveState(); renderAll(); };

    const top = document.createElement("label");
    top.className = "pill";
    top.innerHTML = `<span class="badge">Top</span>`;
    const topCb = document.createElement("input");
    topCb.type = "checkbox";
    topCb.checked = !!p.top;
    topCb.onchange = () => { p.top = topCb.checked; saveState(); state.autoRebuild ? rebuildFromCurrent() : renderAll(); };
    top.appendChild(topCb);

    const avail = document.createElement("label");
    avail.className = "pill";
    avail.innerHTML = `<span class="badge">Avail</span>`;
    const availCb = document.createElement("input");
    availCb.type = "checkbox";
    availCb.checked = !!p.available;
    availCb.onchange = () => { p.available = availCb.checked; saveState(); state.autoRebuild ? rebuildFromCurrent() : renderAll(); };
    avail.appendChild(availCb);

    const out = document.createElement("label");
    out.className = "pill";
    out.innerHTML = `<span class="badge">Out</span>`;
    const outCb = document.createElement("input");
    outCb.type = "checkbox";
    outCb.checked = !!p.out;
    outCb.onchange = () => { p.out = outCb.checked; saveState(); state.autoRebuild ? rebuildFromCurrent() : renderAll(); };
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

    if (!lineup) { body.className = "small"; body.textContent = "No lineup yet. Rebuild to generate."; }
    else body.textContent = lineup.map(nameById).join(", ");

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
  setStatus("");
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
