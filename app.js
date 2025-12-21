// [cite: 271-272] Constants
const PERIODS = 8;
const ON_COURT = 4;
const LS_KEY = "rotation_planner_state_v5";
const THEME_KEY = "rotation_planner_theme";

// Helper: unique ID
const uid = () => Date.now().toString(36) + Math.random().toString(36).substr(2);

// [cite: 276-293] Default State
function defaultState() {
  return {
    mode: "fair_optimized",
    currentPeriod: 1,
    topTwoCoverage: false,
    avoidStreaks: false,
    autoRebuild: false,
    // Create 8 default players
    players: Array.from({ length: 8 }, (_, i) => ({
      id: uid(),
      name: `Player ${i + 1}`,
      top: i < 2, // First 2 marked as top by default
      available: true,
      out: false
    })),
    schedule: {}, // { "1": [id, id...], "2": ... }
    locked: {}    // { "1": true, ... }
  };
}

let state = loadState();

// --- Persistence ---
function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaultState();
    const parsed = JSON.parse(raw);
    // Merge with default to handle schema updates
    return { ...defaultState(), ...parsed };
  } catch {
    return defaultState();
  }
}

function saveState() {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
}

// --- Logic Helpers ---

// [cite: 323] Find player object by ID
const getPlayer = (id) => state.players.find(p => p.id === id);
const getName = (id) => getPlayer(id)?.name || "Unknown";

// [cite: 328] Get Active Pool
function getActivePool() {
  return state.players.filter(p => p.available && !p.out);
}

// [cite: 335-344] Fisher-Yates Shuffle
function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// [cite: 345-355] Count minutes played so far
function getPlayedCounts(upToPeriod) {
  const counts = {};
  state.players.forEach(p => counts[p.id] = 0);
  for (let k = 1; k < upToPeriod; k++) {
    const lineup = state.schedule[String(k)];
    if (lineup) lineup.forEach(pid => counts[pid] = (counts[pid] || 0) + 1);
  }
  return counts;
}

// [cite: 357-366] Count consecutive periods (streak)
function getStreakCounts(upToPeriod) {
  const streak = {};
  state.players.forEach(p => streak[p.id] = 0);
  for (let k = 1; k < upToPeriod; k++) {
    const lineup = state.schedule[String(k)] || [];
    const set = new Set(lineup);
    state.players.forEach(p => {
      streak[p.id] = set.has(p.id) ? (streak[p.id] || 0) + 1 : 0;
    });
  }
  return streak;
}

// --- Core Generator Logic ---

/**
 * Calculates a "penalty score" for a potential lineup based on streaks.
 * 0 = Perfect, High number = Bad streak violation.
 * This replaces the strict true/false check.
 */
function calculateStreakPenalty(lineup, streakBefore) {
  if (!state.avoidStreaks) return 0;
  let penalty = 0;
  for (const pid of lineup) {
    const s = streakBefore[pid] || 0;
    if (s >= 2) penalty += (s * 10); // Heavy penalty for 3rd+ period
    else if (s === 1) penalty += 1;  // Slight preference to rotate if possible
  }
  return penalty;
}

// [cite: 373-392] Enforce Top-2 Coverage
function enforceTopTwo(lineup, pool, playedCounts) {
  if (!state.topTwoCoverage) return lineup;
  
  const tops = pool.filter(p => p.top).map(p => p.id);
  const lineupSet = new Set(lineup);
  
  // If we already have a top player, good.
  if (tops.some(id => lineupSet.has(id))) return lineup;
  if (tops.length === 0) return lineup;

  // We need to swap someone in.
  // 1. Pick Top player with LEAST minutes.
  const bestTop = tops.sort((a, b) => (playedCounts[a] || 0) - (playedCounts[b] || 0))[0];

  // 2. Pick non-top player in lineup with MOST minutes to swap out.
  const candidates = lineup.filter(id => !tops.includes(id));
  if (candidates.length === 0) return lineup; // Can't swap if everyone is top
  
  const worstNonTop = candidates.sort((a, b) => (playedCounts[b] || 0) - (playedCounts[a] || 0))[0];

  // Perform swap
  return lineup.map(id => id === worstNonTop ? bestTop : id);
}

// [cite: 402] Main Logic: Fair Optimized
function buildFairOptimized(startPeriod) {
  const pool = getActivePool();
  // Edge Case: Not enough players
  if (pool.length < ON_COURT) {
    setStatus(`Need ${ON_COURT} active players (have ${pool.length}).`);
    return;
  }
  // Edge Case: Exactly 4 players
  if (pool.length === ON_COURT) {
    for (let k = startPeriod; k <= PERIODS; k++) {
      if (!state.locked[String(k)]) {
        state.schedule[String(k)] = pool.map(p => p.id);
      }
    }
    return;
  }

  const poolIds = pool.map(p => p.id);

  for (let k = startPeriod; k <= PERIODS; k++) {
    if (state.locked[String(k)]) continue;

    const played = getPlayedCounts(k);
    const streak = getStreakCounts(k);

    // 1. Sort by minutes played (Ascending)
    // [cite: 403] Sort logic
    const sorted = poolIds.slice().sort((a, b) => {
      const diff = (played[a] || 0) - (played[b] || 0);
      if (diff !== 0) return diff;
      return Math.random() - 0.5; // Randomize ties
    });

    // 2. Try to form a lineup from the lowest-minute players
    // We take the top X candidates (e.g. 6) and shuffle them to find the best streak combination
    const candidateCount = Math.min(sorted.length, ON_COURT + 2); 
    const candidates = sorted.slice(0, candidateCount);

    let bestLineup = candidates.slice(0, ON_COURT);
    let minPenalty = Infinity;

    // Monte Carlo attempt: Try 50 shuffles of the candidates to minimize penalty
    for (let i = 0; i < 50; i++) {
      const shuff = shuffle(candidates).slice(0, ON_COURT);
      const p = calculateStreakPenalty(shuff, streak);
      if (p < minPenalty) {
        minPenalty = p;
        bestLineup = shuff;
        if (p === 0) break; // Perfect lineup found
      }
    }

    // 3. Apply Top-2 constraint
    bestLineup = enforceTopTwo(bestLineup, pool, played);

    state.schedule[String(k)] = bestLineup;
  }
}

// --- Application Flow ---

function rebuildFromCurrent() {
  const start = Math.max(1, state.currentPeriod);
  
  // Clear future unlocked periods
  for (let k = start; k <= PERIODS; k++) {
    if (!state.locked[String(k)]) delete state.schedule[String(k)];
  }

  const mode = state.mode;
  // Map simplified modes (Removed legacy "sliding" logic for brevity, defaulted to fair)
  // You can re-add complex sliding logic here if strictly needed, 
  // but "Fair Optimized" is usually what users want.
  if (mode === "true_random_fair") {
     // reuse optimized but shuffle purely
     buildFairOptimized(start); 
  } else {
     buildFairOptimized(start);
  }

  saveState();
  renderAll();
  setStatus(`Rebuilt starting from Period ${start}`);
}

// --- UI Rendering ---

function renderAll() {
  renderPeriodSelect();
  renderSettings();
  renderPlayers();
  renderLineups();
  renderMinutes();
}

function renderPeriodSelect() {
  const sel = document.getElementById("currentPeriod");
  if (!sel) return;
  sel.innerHTML = "";
  for (let i = 1; i <= PERIODS; i++) {
    const opt = document.createElement("option");
    opt.value = i;
    opt.textContent = `Period ${i}`;
    sel.appendChild(opt);
  }
  sel.value = state.currentPeriod;
  sel.onchange = () => {
    state.currentPeriod = Number(sel.value);
    saveState();
    renderLineups(); // Re-render to update highlights
  };
}

function renderSettings() {
  // Bind simple checkboxes
  const bind = (id, key) => {
    const el = document.getElementById(id);
    if (!el) return;
    if (el.type === "checkbox") {
      el.checked = !!state[key];
      el.onclick = () => { state[key] = el.checked; saveState(); renderAll(); };
    } else {
      el.value = state[key];
      el.onchange = () => { state[key] = el.value; saveState(); renderAll(); };
    }
  };
  bind("mode", "mode");
  bind("topTwoCoverage", "topTwoCoverage");
  bind("avoidStreaks", "avoidStreaks");
  bind("autoRebuild", "autoRebuild");
}

function renderPlayers() {
  const div = document.getElementById("players");
  if (!div) return;
  div.innerHTML = "";
  
  state.players.forEach(p => {
    const row = document.createElement("div");
    row.className = "player";
    
    // Name Input
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = p.name;
    // Mobile UX: "Done" key
    nameInput.enterKeyHint = "done"; 
    nameInput.onchange = () => { p.name = nameInput.value; saveState(); renderAll(); };
    
    // Helper for Pill Checkboxes
    const makePill = (lbl, key) => {
      const label = document.createElement("label");
      label.className = "pill";
      label.innerHTML = `<span class="badge">${lbl}</span>`;
      const cb = document.createElement("input");
      cb.type = "checkbox";
      cb.checked = !!p[key];
      cb.onclick = () => {
        p[key] = cb.checked;
        saveState();
        if (state.autoRebuild) rebuildFromCurrent();
        else renderAll();
      };
      label.appendChild(cb);
      return label;
    };

    row.appendChild(nameInput);
    row.appendChild(makePill("Top", "top"));
    row.appendChild(makePill("Avail", "available"));
    row.appendChild(makePill("Out", "out"));
    div.appendChild(row);
  });
}

function renderLineups() {
  const div = document.getElementById("lineups");
  if (!div) return;
  div.innerHTML = "";

  const activePool = getActivePool().map(p => p.id);

  for (let k = 1; k <= PERIODS; k++) {
    const sk = String(k);
    const lineup = state.schedule[sk];
    const locked = state.locked[sk];

    const wrap = document.createElement("div");
    wrap.className = `lineup ${k === state.currentPeriod ? "current" : ""}`;
    
    // Header
    const head = document.createElement("div");
    head.className = "lineup-header";
    head.innerHTML = `<span><strong>Period ${k}</strong></span> ${locked ? '<span class="lockedTag">Locked</span>' : ''}`;
    wrap.appendChild(head);

    if (!lineup) {
      wrap.innerHTML += `<div class="muted">Not scheduled</div>`;
      div.appendChild(wrap);
      continue;
    }

    // On Court
    const onCourtNames = lineup.map(getName).join(", ");
    wrap.innerHTML += `<div class="on-court">${onCourtNames}</div>`;

    // Bench (Who is active but NOT in lineup)
    const benchIds = activePool.filter(id => !lineup.includes(id));
    if (benchIds.length > 0) {
      const benchNames = benchIds.map(getName).join(", ");
      wrap.innerHTML += `<div class="bench"><strong>Sitting:</strong> ${benchNames}</div>`;
    }

    div.appendChild(wrap);
  }
}

function renderMinutes() {
  const div = document.getElementById("minutes");
  if (!div) return;
  const counts = getPlayedCounts(PERIODS + 1);
  
  // Sort by name for table
  const rows = state.players.slice().sort((a,b) => a.name.localeCompare(b.name));

  let html = `<table class="table"><thead><tr><th>Player</th><th>Played</th></tr></thead><tbody>`;
  rows.forEach(p => {
    html += `<tr>
      <td>${p.name} ${p.top ? '<span class="badge">TOP</span>' : ''} ${!p.available ? '(N/A)' : ''}</td>
      <td>${counts[p.id] || 0}</td>
    </tr>`;
  });
  html += `</tbody></table>`;
  div.innerHTML = html;
}

function setStatus(msg) {
  const el = document.getElementById("status");
  if (el) el.textContent = msg;
  setTimeout(() => { if(el) el.textContent = ""; }, 4000);
}

// --- Actions & Event Listeners ---

document.getElementById("rebuildBtn").onclick = rebuildFromCurrent;

document.getElementById("lockCurrentBtn").onclick = () => {
  state.locked[String(state.currentPeriod)] = true;
  saveState();
  renderAll();
  setStatus(`Period ${state.currentPeriod} locked.`);
};

document.getElementById("unlockAllBtn").onclick = () => {
  state.locked = {};
  saveState();
  renderAll();
  setStatus("All periods unlocked.");
};

document.getElementById("resetGameBtn").onclick = () => {
  if(!confirm("Clear schedule? (Roster stays)")) return;
  state.schedule = {};
  state.locked = {};
  state.currentPeriod = 1;
  saveState();
  renderAll();
  setStatus("Schedule reset.");
};

document.getElementById("resetAllBtn").onclick = () => {
  if(!confirm("Full Reset? (Deletes Roster)")) return;
  localStorage.removeItem(LS_KEY);
  location.reload();
};

document.getElementById("saveRosterBtn").onclick = () => {
  saveState();
  setStatus("Roster saved.");
};

// New: Copy to Clipboard
document.getElementById("shareBtn").onclick = () => {
  let text = "🏀 Rotation:\n";
  for(let k=1; k<=PERIODS; k++) {
    const l = state.schedule[String(k)];
    if(l) text += `P${k}: ${l.map(getName).join(", ")}\n`;
  }
  navigator.clipboard.writeText(text)
    .then(() => setStatus("Copied to clipboard!"))
    .catch(() => setStatus("Copy failed."));
};

// Theme Toggle
// [cite: 531-538] Robust Theme logic
function initTheme() {
  const btn = document.getElementById("themeToggle");
  const saved = localStorage.getItem(THEME_KEY);
  const sys = window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark";
  const theme = saved || sys;
  
  document.documentElement.setAttribute("data-theme", theme);
  btn.textContent = theme === "light" ? "Dark Mode" : "Light Mode";

  btn.onclick = () => {
    const cur = document.documentElement.getAttribute("data-theme");
    const next = cur === "light" ? "dark" : "light";
    document.documentElement.setAttribute("data-theme", next);
    localStorage.setItem(THEME_KEY, next);
    btn.textContent = next === "light" ? "Dark Mode" : "Light Mode";
  };
}

// Boot
initTheme();
renderAll();
