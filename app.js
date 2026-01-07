// Constants
const PERIODS = 8;
const ON_COURT = 4;
const LS_KEY = "rotation_planner_state_v8";
const THEME_KEY = "rotation_planner_theme";

// Helper: unique ID
const uid = () => Date.now().toString(36) + Math.random().toString(36).substr(2);

// Default State
function defaultState() {
  return {
    mode: "fair_optimized",
    currentPeriod: 1,
    topTwoCoverage: true,
    avoidStreaks: false,
    autoRebuild: false,
    players: [], // Start with empty roster
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

function getActivePool() { 
  return state.players.filter(p => p.available && !p.out); 
}

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

// --- Top Player Distribution ---
function calculateTopPlayerPenalty(lineup, pool) {
  if (!state.topTwoCoverage) return 0;
  
  const topPlayers = pool.filter(p => p.top).map(p => p.id);
  
  if (topPlayers.length === 0) return 0;
  if (topPlayers.length === 1) {
    return lineup.includes(topPlayers[0]) ? 0 : 100;
  }
  
  const topCount = lineup.filter(id => topPlayers.includes(id)).length;
  
  if (topCount === 1) return 0;
  if (topCount === 0) return 50;
  if (topCount === 2) return 5;
  return topCount * 10;
}

// --- IMPROVED: Core Fairness Function with STRICT Top Player Priority ---
function selectFairLineup(period, pool, played, streak) {
  const poolIds = pool.map(p => p.id);
  const topPlayerIds = pool.filter(p => p.top).map(p => p.id);
  
  // Sort all players by: 1) periods played (ascending), 2) top status (descending)
  const sorted = poolIds.slice().sort((a, b) => {
    const playedA = played[a] || 0;
    const playedB = played[b] || 0;
    
    // Primary: fewest periods played
    if (playedA !== playedB) return playedA - playedB;
    
    // Secondary: TOP players first
    const aTop = topPlayerIds.includes(a) ? 1 : 0;
    const bTop = topPlayerIds.includes(b) ? 1 : 0;
    if (aTop !== bTop) return bTop - aTop;
    
    // Tertiary: random
    return Math.random() - 0.5;
  });
  
  // Take the first ON_COURT players (they have min periods and TOP priority)
  let lineup = sorted.slice(0, ON_COURT);
  
  // Verify the lineup maintains fairness (everyone in lineup has same or +1 periods)
  const lineupPlayed = lineup.map(id => played[id] || 0);
  const minInLineup = Math.min(...lineupPlayed);
  const maxInLineup = Math.max(...lineupPlayed);
  
  // If lineup has a mix, we can optimize within those at the minimum
  if (maxInLineup === minInLineup) {
    // Everyone has same count - we can shuffle for streak optimization
    const candidates = sorted.filter(id => (played[id] || 0) === minInLineup);
    
    if (candidates.length > ON_COURT) {
      let bestLineup = lineup;
      let minScore = calculateStreakPenalty(lineup, streak) + calculateTopPlayerPenalty(lineup, pool);
      
      // Try a few random combinations to optimize streaks
      for (let i = 0; i < 30; i++) {
        const testLineup = shuffle(candidates).slice(0, ON_COURT);
        const score = calculateStreakPenalty(testLineup, streak) + calculateTopPlayerPenalty(testLineup, pool);
        
        if (score < minScore) {
          minScore = score;
          bestLineup = testLineup;
          if (score === 0) break;
        }
      }
      
      lineup = bestLineup;
    }
  }
  
  return lineup;
}

// --- Fair Optimized Mode ---
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

  for (let k = startPeriod; k <= PERIODS; k++) {
    if (state.locked[String(k)]) continue;
    
    const played = getPlayedCounts(k);
    const streak = getStreakCounts(k);
    
    state.schedule[String(k)] = selectFairLineup(k, pool, played, streak);
  }
  
  verifyFairness();
}

// --- Sliding Fixed Mode: Uses predetermined rotation patterns ---
function buildSlidingFixed(startPeriod) {
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

  // Get player IDs in roster order (this is why drag-to-reorder matters)
  const poolIds = pool.map(p => p.id);
  const numPlayers = poolIds.length;
  
  // Define rotation patterns based on number of players
  // These patterns match the charts: [positions on court for each period]
  const rotationPatterns = {
    8: [ // 8 players: each player plays 4 out of 8 periods
      [0, 1, 2, 3],  // Period 1: Players 1,2,3,4
      [4, 5, 6, 7],  // Period 2: Players 5,6,7,8
      [1, 2, 3, 4],  // Period 3: Players 2,3,4,5
      [5, 6, 7, 0],  // Period 4: Players 6,7,8,1
      [2, 3, 4, 5],  // Period 5: Players 3,4,5,6
      [6, 7, 0, 1],  // Period 6: Players 7,8,1,2
      [2, 3, 4, 5],  // Period 7: Players 3,4,5,6
      [6, 7, 0, 1]   // Period 8: Players 7,8,1,2
    ],
    7: [ // 7 players: each plays 4-5 periods
      [0, 1, 2, 3],  // Period 1: Players 1,2,3,4
      [4, 5, 6, 0],  // Period 2: Players 5,6,7,1
      [1, 2, 3, 4],  // Period 3: Players 2,3,4,5
      [5, 6, 0, 1],  // Period 4: Players 6,7,1,2
      [2, 3, 4, 5],  // Period 5: Players 3,4,5,6
      [6, 0, 1, 2],  // Period 6: Players 7,1,2,3
      [3, 4, 5, 6],  // Period 7: Players 4,5,6,7
      [0, 1, 2, 3]   // Period 8: Players 1,2,3,4
    ],
    6: [ // 6 players: each plays 5-6 periods
      [0, 1, 2, 3],  // Period 1: Players 1,2,3,4
      [4, 5, 0, 1],  // Period 2: Players 5,6,1,2
      [2, 3, 4, 5],  // Period 3: Players 3,4,5,6
      [0, 1, 2, 3],  // Period 4: Players 1,2,3,4
      [4, 5, 0, 1],  // Period 5: Players 5,6,1,2
      [2, 3, 4, 5],  // Period 6: Players 3,4,5,6
      [0, 1, 2, 3],  // Period 7: Players 1,2,3,4
      [4, 5, 0, 1]   // Period 8: Players 5,6,1,2
    ],
    5: [ // 5 players: each plays 6-7 periods
      [0, 1, 2, 3],  // Period 1: Players 1,2,3,4
      [4, 0, 1, 2],  // Period 2: Players 5,1,2,3
      [3, 4, 0, 1],  // Period 3: Players 4,5,1,2
      [2, 3, 4, 0],  // Period 4: Players 3,4,5,1
      [1, 2, 3, 4],  // Period 5: Players 2,3,4,5
      [0, 1, 2, 3],  // Period 6: Players 1,2,3,4
      [4, 0, 1, 2],  // Period 7: Players 5,1,2,3
      [3, 4, 0, 1]   // Period 8: Players 4,5,1,2
    ]
  };
  
  // Get the appropriate pattern or generate a fair one if not defined
  let pattern = rotationPatterns[numPlayers];
  
  if (!pattern) {
    // For non-standard player counts, fall back to fair algorithm
    buildFairOptimized(startPeriod);
    return;
  }
  
  // Apply the pattern
  for (let k = startPeriod; k <= PERIODS; k++) {
    if (state.locked[String(k)]) continue;
    
    const periodIndex = k - 1; // 0-based index
    const positions = pattern[periodIndex];
    
    // Map positions to actual player IDs
    const lineup = positions.map(pos => poolIds[pos]);
    state.schedule[String(k)] = lineup;
  }
  
  verifyFairness();
}

// --- Sliding Adaptive Mode: Sliding pattern with TOP player priority ---
function buildSlidingAdaptive(startPeriod) {
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

  const numPlayers = pool.length;
  
  // First, calculate how many periods each player SHOULD get for fairness
  const totalSlots = PERIODS * ON_COURT;
  const avgPeriods = totalSlots / numPlayers;
  const minPeriods = Math.floor(avgPeriods);
  const maxPeriods = Math.ceil(avgPeriods);
  
  // Calculate how many players get max vs min
  const playersWithMax = Math.round((avgPeriods - minPeriods) * numPlayers);
  const playersWithMin = numPlayers - playersWithMax;
  
  // Sort pool: TOP players first, then others
  const topPlayers = pool.filter(p => p.top);
  const nonTopPlayers = pool.filter(p => !p.top);
  
  // Assign target periods: TOP players get maxPeriods, fill remaining with non-top
  const targetPeriods = {};
  let maxSlotsLeft = playersWithMax;
  
  // Give TOP players the max periods first
  topPlayers.forEach(p => {
    if (maxSlotsLeft > 0) {
      targetPeriods[p.id] = maxPeriods;
      maxSlotsLeft--;
    } else {
      targetPeriods[p.id] = minPeriods;
    }
  });
  
  // Give remaining players the remaining slots
  nonTopPlayers.forEach(p => {
    if (maxSlotsLeft > 0) {
      targetPeriods[p.id] = maxPeriods;
      maxSlotsLeft--;
    } else {
      targetPeriods[p.id] = minPeriods;
    }
  });
  
  // Define rotation patterns (same as sliding fixed)
  const rotationPatterns = {
    8: [
      [0, 1, 2, 3],
      [4, 5, 6, 7],
      [1, 2, 3, 4],
      [5, 6, 7, 0],
      [2, 3, 4, 5],
      [6, 7, 0, 1],
      [2, 3, 4, 5],
      [6, 7, 0, 1]
    ],
    7: [
      [0, 1, 2, 3],
      [4, 5, 6, 0],
      [1, 2, 3, 4],
      [5, 6, 0, 1],
      [2, 3, 4, 5],
      [6, 0, 1, 2],
      [3, 4, 5, 6],
      [0, 1, 2, 3]
    ],
    6: [
      [0, 1, 2, 3],
      [4, 5, 0, 1],
      [2, 3, 4, 5],
      [0, 1, 2, 3],
      [4, 5, 0, 1],
      [2, 3, 4, 5],
      [0, 1, 2, 3],
      [4, 5, 0, 1]
    ],
    5: [
      [0, 1, 2, 3],
      [4, 0, 1, 2],
      [3, 4, 0, 1],
      [2, 3, 4, 0],
      [1, 2, 3, 4],
      [0, 1, 2, 3],
      [4, 0, 1, 2],
      [3, 4, 0, 1]
    ]
  };
  
  let pattern = rotationPatterns[numPlayers];
  
  if (!pattern) {
    // For non-standard player counts, fall back to fair algorithm with TOP priority
    buildFairOptimized(startPeriod);
    return;
  }
  
  // Reorder the pool to put TOP players in positions that get more playing time
  // We need to figure out which positions in the pattern play the most
  const positionCounts = Array(numPlayers).fill(0);
  pattern.forEach(periodPositions => {
    periodPositions.forEach(pos => {
      positionCounts[pos]++;
    });
  });
  
  // Create array of [position, count] and sort by count (descending)
  const positionsByPlayTime = positionCounts
    .map((count, pos) => ({ pos, count }))
    .sort((a, b) => b.count - a.count);
  
  // Create optimized roster order: assign TOP players to high-play positions
  const optimizedRoster = Array(numPlayers).fill(null);
  
  let topIndex = 0;
  let nonTopIndex = 0;
  
  positionsByPlayTime.forEach(({ pos, count }) => {
    if (topIndex < topPlayers.length) {
      optimizedRoster[pos] = topPlayers[topIndex++];
    } else {
      optimizedRoster[pos] = nonTopPlayers[nonTopIndex++];
    }
  });
  
  // Get optimized player IDs
  const optimizedIds = optimizedRoster.map(p => p.id);
  
  // Apply the pattern with optimized roster
  for (let k = startPeriod; k <= PERIODS; k++) {
    if (state.locked[String(k)]) continue;
    
    const periodIndex = k - 1;
    const positions = pattern[periodIndex];
    
    const lineup = positions.map(pos => optimizedIds[pos]);
    state.schedule[String(k)] = lineup;
  }
  
  verifyFairness();
}

// --- True Random Fair Mode ---
function buildTrueRandomFair(startPeriod) {
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
    
    // Find minimum periods played
    const minPlayed = Math.min(...poolIds.map(id => played[id] || 0));
    
    // Get all players with minimum periods
    const mustPlay = poolIds.filter(id => (played[id] || 0) === minPlayed);
    
    if (mustPlay.length >= ON_COURT) {
      // Randomly select from players with minimum time
      state.schedule[String(k)] = shuffle(mustPlay).slice(0, ON_COURT);
    } else {
      // Must include all mustPlay, fill rest from next tier
      const nextTier = poolIds.filter(id => (played[id] || 0) === minPlayed + 1);
      const needed = ON_COURT - mustPlay.length;
      state.schedule[String(k)] = [...mustPlay, ...shuffle(nextTier).slice(0, needed)];
    }
  }
  
  verifyFairness();
}

function verifyFairness() {
  const pool = getActivePool();
  const counts = getPlayedCounts(PERIODS + 1);
  const played = pool.map(p => counts[p.id] || 0);
  
  if (played.length === 0) return;
  
  const min = Math.min(...played);
  const max = Math.max(...played);
  
  // Check basic fairness (max 1 period difference)
  if (max - min > 1) {
    console.error(`FAIRNESS VIOLATION: min=${min}, max=${max}`);
    console.error('Player counts:', pool.map(p => `${p.name}: ${counts[p.id] || 0}`));
    setStatus(`⚠️ Fairness issue detected. Please rebuild.`);
    return;
  }
  
  // STRICT CHECK: If there's unequal time, ALL TOP players must have MAX periods
  if (max > min) {
    const topPlayers = pool.filter(p => p.top);
    
    if (topPlayers.length > 0) {
      const topCounts = topPlayers.map(p => counts[p.id] || 0);
      const minTopCount = Math.min(...topCounts);
      
      // Every TOP player should have the maximum periods
      if (minTopCount < max) {
        console.error(`TOP PRIORITY VIOLATION: Some top players don't have max periods`);
        console.error('Top players:', topPlayers.map(p => `${p.name}: ${counts[p.id]}`));
        console.error('All players:', pool.map(p => `${p.name}: ${counts[p.id]}`));
        setStatus(`⚠️ Top players should have max time. Try rebuilding again.`);
        return;
      }
    }
  }
  
  console.log('✓ Fairness verified:', pool.map(p => `${p.name}: ${counts[p.id] || 0}`).join(', '));
}

function rebuildFromCurrent() {
  const start = Math.max(1, state.currentPeriod);
  
  for (let k = start; k <= PERIODS; k++) {
    if (!state.locked[String(k)]) delete state.schedule[String(k)];
  }
  
  // Call the appropriate builder based on mode
  switch(state.mode) {
    case 'sliding_fixed':
      buildSlidingFixed(start);
      break;
    case 'sliding_adaptive':
      buildSlidingAdaptive(start);
      break;
    case 'true_random_fair':
      buildTrueRandomFair(start);
      break;
    case 'fair_optimized':
    default:
      buildFairOptimized(start);
      break;
  }
  
  saveState();
  renderAll();
  
  const dist = analyzeTopDistribution();
  setStatus(`Rebuilt from Period ${start}. ${dist}`);
}

// --- Analysis Helper ---
function analyzeTopDistribution() {
  const topPlayers = state.players.filter(p => p.top && p.available && !p.out);
  if (topPlayers.length < 2 || !state.topTwoCoverage) return "";
  
  let periodsWithOne = 0;
  let periodsWithNone = 0;
  let periodsWithBoth = 0;
  
  for (let k = 1; k <= PERIODS; k++) {
    const lineup = state.schedule[String(k)];
    if (!lineup) continue;
    
    const topCount = lineup.filter(id => topPlayers.map(p => p.id).includes(id)).length;
    if (topCount === 1) periodsWithOne++;
    else if (topCount === 0) periodsWithNone++;
    else if (topCount >= 2) periodsWithBoth++;
  }
  
  return `Top coverage: ${periodsWithOne}/${PERIODS} optimal`;
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
      el.onclick = () => { 
        state[key] = el.checked; 
        saveState(); 
        if (state.autoRebuild) rebuildFromCurrent();
        else renderAll();
      };
    } else {
      el.value = state[key];
      el.onchange = () => { 
        state[key] = el.value; 
        saveState(); 
        renderAll(); 
      };
    }
  };
  
  bind("mode", "mode");
  bind("topTwoCoverage", "topTwoCoverage");
  bind("avoidStreaks", "avoidStreaks");
  bind("autoRebuild", "autoRebuild");
}

// --- IMPROVED: Player rendering with DELETE button and TOP limit ---
function renderPlayers() {
  const div = document.getElementById("players");
  if (!div) return;
  
  div.innerHTML = "";
  
  if (state.players.length === 0) {
    div.innerHTML = '<div class="hint">No players yet. Use "Import List" to add players.</div>';
    return;
  }
  
  state.players.forEach((p) => {
    const row = document.createElement("div");
    row.className = "player";
    row.dataset.id = p.id;
    
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
    nameInput.onchange = () => { 
      p.name = nameInput.value; 
      saveState(); 
      renderAll(); 
    };
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
        // Special handling for TOP checkbox - limit to 2
        if (key === "top" && cb.checked) {
          const currentTopCount = state.players.filter(pl => pl.top).length;
          if (currentTopCount >= 2) {
            cb.checked = false;
            setStatus("⚠️ Maximum 2 top players allowed");
            return;
          }
        }
        
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
    
    // 4. DELETE BUTTON
    const deleteBtn = document.createElement("button");
    deleteBtn.className = "delete-btn";
    deleteBtn.innerHTML = "✕";
    deleteBtn.title = "Delete player";
    deleteBtn.onclick = (e) => {
      e.stopPropagation();
      if (confirm(`Delete ${p.name}?`)) {
        state.players = state.players.filter(player => player.id !== p.id);
        
        // Remove from all schedules
        Object.keys(state.schedule).forEach(period => {
          state.schedule[period] = state.schedule[period].filter(id => id !== p.id);
        });
        
        saveState();
        if (state.autoRebuild) rebuildFromCurrent();
        else renderAll();
      }
    };
    row.appendChild(deleteBtn);
    
    div.appendChild(row);
  });
  
  initDragAndDrop();
}

// --- Custom Touch/Mouse Drag Logic ---
function initDragAndDrop() {
  const list = document.getElementById("players");
  let draggingEle = null;
  let isDragging = false;
  let ghost = null;
  
  const handles = list.querySelectorAll('.drag-handle');
  
  const onStart = (e) => {
    const touch = e.touches ? e.touches[0] : e;
    const target = e.target.closest('.player');
    if(!target) return;
    
    e.preventDefault();
    isDragging = true;
    draggingEle = target;
    
    ghost = draggingEle.cloneNode(true);
    ghost.classList.add('dragging-ghost');
    const inputs = ghost.querySelectorAll('input');
    inputs.forEach(i => i.value = i.value);
    document.body.appendChild(ghost);
    
    const rect = draggingEle.getBoundingClientRect();
    ghost.style.top = `${rect.top}px`;
    ghost.style.left = `${rect.left}px`;
    ghost.style.width = `${rect.width}px`;
    
    draggingEle.classList.add('dragging');
  };
  
  const onMove = (e) => {
    if (!isDragging || !ghost) return;
    const touch = e.touches ? e.touches[0] : e;
    
    ghost.style.top = `${touch.clientY - 20}px`;
    ghost.style.left = `${touch.clientX}px`;
    
    const swapTarget = document.elementFromPoint(touch.clientX, touch.clientY);
    if (!swapTarget) return;
    
    const row = swapTarget.closest('.player');
    if (row && row !== draggingEle && list.contains(row)) {
      const rect = row.getBoundingClientRect();
      const next = (touch.clientY - rect.top) / rect.height > 0.5;
      
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
  
  handles.forEach(h => {
    h.addEventListener('mousedown', onStart);
    h.addEventListener('touchstart', onStart, { passive: false });
  });
  
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
  const topPlayerIds = state.players.filter(p => p.top).map(p => p.id);
  
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
    
    if (!lineup || lineup.length === 0) {
      wrap.innerHTML += `<div class="muted">Not scheduled</div>`;
      div.appendChild(wrap);
      continue;
    }
    
    const onCourtNames = lineup.map(id => {
      const name = getName(id);
      const isTop = topPlayerIds.includes(id);
      return isTop ? `<strong>${name}</strong>` : name;
    }).join(", ");
    
    wrap.innerHTML += `<div class="on-court">${onCourtNames}</div>`;
    
    const benchIds = activePool.filter(id => !lineup.includes(id));
    if (benchIds.length > 0) {
      const benchNames = benchIds.map(id => {
        const name = getName(id);
        const isTop = topPlayerIds.includes(id);
        return isTop ? `<strong>${name}</strong>` : name;
      }).join(", ");
      wrap.innerHTML += `<div class="bench"><strong>Sitting:</strong> ${benchNames}</div>`;
    }
    
    div.appendChild(wrap);
  }
}

function renderMinutes() {
  const div = document.getElementById("minutes");
  if (!div) return;
  
  if (state.players.length === 0) {
    div.innerHTML = '<div class="hint">No players to display.</div>';
    return;
  }
  
  const counts = getPlayedCounts(PERIODS + 1);
  const rows = state.players.slice().sort((a,b) => a.name.localeCompare(b.name));
  
  let html = `<table class="table"><thead><tr><th>Player</th><th>Periods</th></tr></thead><tbody>`;
  
  rows.forEach(p => {
    const periodsPlayed = counts[p.id] || 0;
    const statusBadges = [
      p.top ? '<span class="badge">TOP</span>' : '',
      !p.available ? '<span class="badge">(N/A)</span>' : ''
    ].filter(Boolean).join(' ');
    
    html += `<tr>
      <td>${p.name} ${statusBadges}</td>
      <td>${periodsPlayed}</td>
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
    top: false, 
    available: true, 
    out: false
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
