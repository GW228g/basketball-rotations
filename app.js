// Constants
const PERIODS = 8;
const ON_COURT = 4;
const LS_KEY = "rotation_planner_state_v7";
const THEME_KEY = "rotation_planner_theme";

// Helper: unique ID
const uid = () => Date.now().toString(36) + Math.random().toString(36).substr(2);

// Default State
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

// --- Persistence ---
function loadState() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaultState();
    return { ...defaultState(), ...JSON.parse(raw) };
  } catch {
    return defaultState();
  }
}

function saveState() {
  localStorage.setItem(LS_KEY, JSON.stringify(state));
}

// --- Logic Helpers ---
const getPlayer = (id) => state.players.find(p => p.id === id);
const getName = (id) => getPlayer(id)?.name || "Unknown";
function getActivePool() { return state.players.filter(p => p.available && !p.out); }

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

function getPlayedCounts(upToPeriod) {
  const counts = {};
  state.players.forEach(p => counts[p.id] = 0);
  for (let k = 1; k < upToPeriod; k++) {
    const lineup = state.schedule[String(k)];
    if (lineup) lineup.forEach(pid => counts[pid] = (counts[pid] || 0) + 1);
  }
  return counts;
}

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
function calculateStreakPenalty(lineup, streakBefore) {
  if (!state.avoidStreaks) return 0;
  let penalty = 0;
  for (const pid of lineup) {
    const s = streakBefore[pid] || 0;
    if (s >= 2) penalty += (s * 10);
    else if (s === 1) penalty += 1;
  }
  return penalty;
}

function enforceTopTwo(lineup, pool, playedCounts) {
  if (!state.topTwoCoverage) return lineup;
  const tops = pool.filter(p => p.top).map(p => p.id);
  const lineupSet = new Set(lineup);
  if (tops.some(id => lineupSet.has(id))) return lineup;
  if (tops.length === 0) return lineup;

  const bestTop = tops.sort((a, b) => (playedCounts[a] || 0) - (playedCounts[b] || 0))[0];
  const candidates = lineup.filter(id => !tops.includes(id));
  if (candidates.length === 0) return lineup;
  const worstNonTop = candidates.sort((a, b) => (playedCounts[b] || 0) - (playedCounts[a] || 0))[0];

  return lineup.map(id => id === worstNonTop ? bestTop : id);
}

function buildFairOptimized(startPeriod) {
  const pool = getActivePool();
  if (pool.length < ON_COURT) {
    setStatus(`Need ${ON_COURT} active players.`);
    return;
  }
  if (pool.length === ON_COURT) {
    for (let k = startPeriod; k <= PERIODS; k++) {
      if (!state.locked[String(k)]) state.schedule[String(k)] = pool.map(p => p.id);
    }
    return;
  }

  const poolIds = pool.map(p => p.id);
  for (let k = startPeriod; k <= PERIODS; k++) {
    if (state.locked[String(k)]) continue;
    const played = getPlayedCounts(k);
    const streak = getStreakCounts(k);

    const sorted = poolIds.slice().sort((a, b) => {
      const diff = (played[a] || 0) - (played[b] || 0);
      if (diff !== 0) return diff;
      return Math.random() - 0.5;
    });

    const candidateCount = Math.min(sorted.length, ON_COURT + 2); 
    const candidates = sorted.slice(0, candidateCount);
    let bestLineup = candidates.slice(0, ON_COURT);
    let minPenalty = Infinity;

    for (let i = 0; i < 50; i++) {
      const shuff = shuffle(candidates).slice(0, ON_COURT);
      const p = calculateStreakPenalty(shuff, streak);
      if (p < minPenalty) {
        minPenalty = p;
        bestLineup = shuff;
        if (p === 0) break;
      }
    }
    bestLineup = enforceTopTwo(bestLineup, pool, played);
    state.schedule[String(k)] = bestLineup;
  }
}

function rebuildFromCurrent() {
  const start = Math.max(1, state.currentPeriod);
  for (let k = start; k <= PERIODS; k++) {
    if (!state.locked[String(k)]) delete state.schedule[String(k)];
  }
  buildFairOptimized(start);
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
    renderLineups();
  };
}

function renderSettings() {
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
  // NOTE: We do NOT clear innerHTML if a drag is happening to avoid killing events
  // But for this simple app, we simply re-render fully on data change.
  // The drag logic below manipulates the DOM directly, then saves, then re-renders.
  
  div.innerHTML = "";
  
  state.players.forEach((p) => {
    const row = document.createElement("div");
    row.className = "player";
    row.dataset.id = p.id; // Store ID for drag logic

    // 1. Drag Handle
    const handle = document.createElement("div");
    handle.className = "drag-handle";
    handle.innerHTML = "☰";
    row.appendChild(handle);
    
    // 2. Name Input
    const nameInput = document.createElement("input");
    nameInput.type = "text";
    nameInput.value = p.name;
    nameInput.enterKeyHint = "done"; 
    nameInput.onchange = () => { p.name = nameInput.value; saveState(); renderAll(); };
    row.appendChild(nameInput);
    
    // 3. Status Pills
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
    row.appendChild(makePill("Top", "top"));
    row.appendChild(makePill("Avail", "available"));
    row.appendChild(makePill("Out", "out"));

    div.appendChild(row);
  });

  // Re-attach Drag Logic
  initDragAndDrop();
}

// --- Custom Touch/Mouse Drag Logic ---
function initDragAndDrop() {
  const list = document.getElementById("players");
  let draggingEle = null;
  let placeholder = null;
  let isDragging = false;
  let startY = 0;
  let ghost = null;

  const handles = list.querySelectorAll('.drag-handle');
  
  const onStart = (e) => {
    // Determine Touch or Mouse
    const touch = e.touches ? e.touches[0] : e;
    const target = e.target.closest('.player');
    if(!target) return;

    e.preventDefault(); // Stop scrolling on mobile
    isDragging = true;
    draggingEle = target;
    startY = touch.clientY;

    // Create Ghost for Visuals
    ghost = draggingEle.cloneNode(true);
    ghost.classList.add('dragging-ghost');
    // Strip inputs from ghost to clean up
    const inputs = ghost.querySelectorAll('input');
    inputs.forEach(i => i.value = i.value); // freeze value
    document.body.appendChild(ghost);

    // Initial Ghost Position
    const rect = draggingEle.getBoundingClientRect();
    ghost.style.top = `${rect.top}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.width = `${rect.width}px`;

    draggingEle.classList.add('dragging');
  };

  const onMove = (e) => {
    if (!isDragging || !ghost) return;
    const touch = e.touches ? e.touches[0] : e;
    
    // Move Ghost
    ghost.style.top = `${touch.clientY - 20}px`;
    ghost.style.left = `${touch.clientX}px`;

    // Swap Detection
    const swapTarget = document.elementFromPoint(touch.clientX, touch.clientY);
    if (!swapTarget) return;
    const row = swapTarget.closest('.player');
    
    if (row && row !== draggingEle && list.contains(row)) {
      // Logic: If moving down, insert after. If moving up, insert before.
      const rect = row.getBoundingClientRect();
      const next = (touch.clientY - rect.top) / rect.height > 0.5;
      
      // Simple DOM swap (insert puts it in new spot and removes from old)
      if (next) {
        list.insertBefore(draggingEle, row.nextSibling);
      } else {
        list.insertBefore(draggingEle, row);
      }
    }
  };

  const onEnd = () => {
    if (!isDragging) return;
    isDragging = false;
    
    if (ghost) {
      ghost.remove();
      ghost = null;
    }
    if (draggingEle) {
      draggingEle.classList.remove('dragging');
      draggingEle = null;
    }

    // Save New Order based on DOM
    const newOrder = [];
    const domRows = list.querySelectorAll('.player');
    domRows.forEach(row => {
      const id = row.dataset.id;
      const pData = state.players.find(p => p.id === id);
      if (pData) newOrder.push(pData);
    });
    
    state.players = newOrder;
    saveState();
  };

  // Attach to Handles (Touch & Mouse)
  handles.forEach(h => {
    h.addEventListener('mousedown', onStart);
    h.addEventListener('touchstart', onStart, { passive: false });
  });

  // Global Move/Up listeners
  window.addEventListener('mousemove', onMove);
  window.addEventListener('touchmove', onMove, { passive: false });
  window.addEventListener('mouseup', onEnd);
  window.addEventListener('touchend', onEnd);
}

// --- Rest of UI ---

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
    
    const head = document.createElement("div");
    head.className = "lineup-header";
    head.innerHTML = `<span><strong>Period ${k}</strong></span> ${locked ? '<span class="lockedTag">Locked</span>' : ''}`;
    wrap.appendChild(head);

    if (!lineup) {
      wrap.innerHTML += `<div class="muted">Not scheduled</div>`;
      div.appendChild(wrap);
      continue;
    }

    const onCourtNames = lineup.map(getName).join(", ");
    wrap.innerHTML += `<div class="on-court">${onCourtNames}</div>`;
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

// --- Event Wiring ---
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
document.getElementById("printBtn").onclick = () => {
  window.print();
};

const importDialog = document.getElementById("importDialog");
document.getElementById("importBtn").onclick = () => importDialog.showModal();
document.getElementById("confirmImportBtn").onclick = () => {
  const txt = document.getElementById("importText").value;
  if (!txt.trim()) return;
  const names = txt.split(/\n/).map(s => s.trim()).filter(s => s.length > 0);
  const newPlayers = names.map(n => ({
    id: uid(),
    name: n,
    top: false, available: true, out: false
  }));
  state.players = [...state.players, ...newPlayers];
  saveState();
  renderAll();
  document.getElementById("importText").value = ""; 
  setStatus(`Added ${newPlayers.length} players.`);
};

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

initTheme();
renderAll();
