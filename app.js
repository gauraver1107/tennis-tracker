import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import {
  getFirestore, doc, setDoc, onSnapshot
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';
import {
  getStorage, ref as storageRef, uploadBytes, getDownloadURL, deleteObject
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-storage.js';

import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const storage = getStorage(app);
const DOC_REF = doc(db, 'tennis', 'shared');

const DEFAULT_PLAYERS = ['Gaurav','Manuj','Manish','Vivek','Chirag','Gaurang','Manjeet'];
const ELO_START = 1200;
const ELO_K = 32;

// ── Season definitions (auto-detected from date) ─────────────────────────
// SS = Spring/Summer: Mar 1 – Aug 31
// FW = Fall/Winter:   Sep 1 – Feb 28/29
function getCurrentSeason(dateStr) {
  const d = dateStr ? new Date(dateStr + 'T00:00:00') : new Date();
  const month = d.getMonth() + 1; // 1-12
  const year  = d.getFullYear();
  if (month >= 3 && month <= 8) return { id: `SS${String(year).slice(2)}`, name: `Spring/Summer ${year}`, type: 'ss', start: `${year}-03-01`, end: `${year}-08-31` };
  // Fall/Winter spans two years
  const fwYear = month >= 9 ? year : year - 1;
  const endYear = fwYear + 1;
  const endDay  = new Date(endYear, 1, 29).getMonth() === 1 ? 29 : 28; // leap year check
  return { id: `FW${String(fwYear).slice(2)}`, name: `Fall/Winter ${fwYear}/${String(endYear).slice(2)}`, type: 'fw', start: `${fwYear}-09-01`, end: `${endYear}-02-${endDay}` };
}

function getSeasonForMatch(m) {
  return getCurrentSeason(m.date).id;
}

function matchesForSeason(seasonId) {
  return sortedMatches().filter(m => getCurrentSeason(m.date).id === seasonId);
}

let state = { players: [...DEFAULT_PLAYERS], matches: [], availability: {}, photos: [], apiKey: '', eloCarryover: {}, playerAvatars: {},
  location: { name: 'Edison, New Jersey', lat: 40.5187, lon: -74.4121 } };
let trendChart = null, eloChart = null, eloBarChart = null, winRateChart = null, weatherChart = null;
let currentFilter = 'all';
let currentSeasonId = getCurrentSeason().id;
let isSyncing = false;
let weatherCache = { data: null, fetchedAt: 0, location: null };
let tickerCache = { messages: [], date: '', filter: '' };
let tickerGenerated = false;
let lastKnownMatchCount = 0; // safety guard — tracks highest match count seen
let firebaseLoaded = false;  // safety guard — no saves allowed until first sync arrives

function setStatus(text, cls) {
  const el = document.getElementById('sync-status');
  el.textContent = text;
  el.className = 'status ' + (cls || '');
}

onSnapshot(DOC_REF, (snap) => {
  if (snap.exists()) {
    const data = snap.data();
    const incomingMatches = data.matches || [];
    // Safety — never accept empty matches if we already have data loaded
    if (incomingMatches.length === 0 && lastKnownMatchCount > 0) {
      console.warn('onSnapshot: ignoring empty matches — keeping', lastKnownMatchCount, 'existing matches');
      setStatus('Synced', 'online');
      return;
    }
    state = {
      players: data.players || [...DEFAULT_PLAYERS],
      matches: incomingMatches,
      location: data.location || { name: 'Edison, New Jersey', lat: 40.5187, lon: -74.4121 },
      availability: data.availability || {},
      photos: data.photos || [],
      apiKey: data.apiKey || '',
      eloCarryover: data.eloCarryover || {},
      playerAvatars: data.playerAvatars || {}
    };
    if (incomingMatches.length > lastKnownMatchCount) {
      lastKnownMatchCount = incomingMatches.length;
    }
  } else {
    // Document doesn't exist yet — don't overwrite state if we already have matches
    if (lastKnownMatchCount > 0) {
      console.warn('onSnapshot: document missing but we have local data — not resetting');
      setStatus('Synced', 'online');
      return;
    }
    state = { players: [...DEFAULT_PLAYERS], matches: [], location: null, availability: {}, photos: [], apiKey: '', playerAvatars: {} };
  }
  if (state.players.length < 5) state.players = [...DEFAULT_PLAYERS];
  state.matches.forEach(m => {
    if (!m.sets) m.sets = [];
    m.sets.forEach(s => { if (s.tbA === undefined) s.tbA = null; if (s.tbB === undefined) s.tbB = null; });
    if (m.notes === undefined) m.notes = '';
  });
  firebaseLoaded = true; // first sync complete — saves are now allowed
  setStatus('Synced', 'online');
  if (!tickerGenerated && state.matches.length > 0 && state.apiKey) {
    tickerGenerated = true;
    generateTicker();
  }
  renderAll();
}, (err) => {
  console.error('Sync error:', err);
  setStatus('Offline', 'offline');
});

async function saveState() {
  if (isSyncing) return;
  // Safety guard 1 — NEVER save before the first Firebase sync has arrived.
  // This closes the race condition where a user action (vote, location, API key)
  // triggers a save while state is still the empty default, wiping the database.
  if (!firebaseLoaded) {
    console.warn('saveState blocked — Firebase not loaded yet, refusing to write default empty state');
    setStatus('Still loading — try again in a moment', 'offline');
    return;
  }
  // Safety guard 2 — never write empty matches array if we know we had data
  if (state.matches.length === 0 && lastKnownMatchCount > 0) {
    console.warn('saveState blocked — would overwrite', lastKnownMatchCount, 'matches with empty array');
    setStatus('Save blocked — data safety', 'offline');
    return;
  }
  isSyncing = true;
  setStatus('Saving…', '');
  try {
    await setDoc(DOC_REF, state);
    lastKnownMatchCount = state.matches.length;
    setStatus('Synced', 'online');
  } catch (e) {
    console.error(e);
    setStatus('Save failed', 'offline');
  } finally {
    isSyncing = false;
  }
}

function setupTabs() {
  document.querySelectorAll('#tabs button').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('#tabs button').forEach(b => b.classList.remove('tab-active'));
      btn.classList.add('tab-active');
      document.querySelectorAll('.panel').forEach(p => p.classList.add('hidden'));
      document.getElementById('panel-' + btn.dataset.tab).classList.remove('hidden');
      if (btn.dataset.tab === 'dashboard') renderCharts();
      if (btn.dataset.tab === 'history') requestAnimationFrame(() => renderCharts());
      if (btn.dataset.tab === 'rotation') renderRotation();
      if (btn.dataset.tab === 'weather') loadWeather();
      if (btn.dataset.tab === 'photos') renderPhotos();
    });
  });
}

function sortedMatches() {
  return [...state.matches].sort((a, b) =>
    a.date.localeCompare(b.date) || a.createdAt - b.createdAt
  );
}

function filteredMatches() {
  const all = sortedMatches();
  if (currentFilter === 'all') return all;
  if (currentFilter.startsWith('season:')) {
    const sid = currentFilter.slice(7);
    return all.filter(m => getCurrentSeason(m.date).id === sid);
  }
  return all.filter(m => m.date === currentFilter);
}

function getAllSeasons() {
  const ids = new Set(state.matches.map(m => getCurrentSeason(m.date).id));
  ids.add(getCurrentSeason().id);
  return [...ids].sort().reverse().map(id => {
    const type = id.startsWith('SS') ? 'ss' : 'fw';
    const yr = '20' + id.slice(2);
    const name = type === 'ss'
      ? `☀️ Spring/Summer ${yr}`
      : `❄️ Fall/Winter ${yr}/${String(parseInt(yr)+1).slice(2)}`;
    return { id, name, type };
  });
}

function renderFilter() {
  const sel = document.getElementById('filter-weekend');
  const seasons = getAllSeasons();
  const dates   = [...new Set(state.matches.map(m => m.date))].sort().reverse();
  let html = `<option value="all">All time</option>`;
  seasons.forEach(s => {
    html += `<option value="season:${s.id}">${s.name}</option>`;
  });
  dates.forEach(d => {
    html += `<option value="${d}">${formatDate(d)}</option>`;
  });
  sel.innerHTML = html;
  sel.value = currentFilter;
  if (!sel.value) { sel.value = 'all'; currentFilter = 'all'; }
}

function renderSeasonBanner() {
  const box = document.getElementById('season-banner');
  if (!box) return;
  let season = getCurrentSeason();
  let type = season.type;
  if (currentFilter.startsWith('season:')) {
    const sid = currentFilter.slice(7);
    const found = getAllSeasons().find(s => s.id === sid);
    if (found) { type = found.type; season = getCurrentSeason(sid.startsWith('SS') ? `20${sid.slice(2)}-04-01` : `20${sid.slice(2)}-10-01`); }
  }
  const matches = filteredMatches();
  const today   = new Date();
  const endDate = new Date(season.end + 'T00:00:00');
  const daysLeft = Math.ceil((endDate - today) / 86400000);
  const daysStr  = daysLeft > 0 ? `${daysLeft} days left` : 'Season complete';
  box.className = `season-banner ${type}`;
  box.innerHTML = `
    <div class="sb-left">
      <div class="sb-icon">${type === 'ss' ? '☀️' : '❄️'}</div>
      <div>
        <div class="sb-title">${season.name || season.id}</div>
        <div class="sb-sub">${matches.length} matches · ${formatDate(season.start)} – ${formatDate(season.end)} · ${daysStr}</div>
      </div>
    </div>
    <div class="sb-badge">${season.id}</div>`;
}

function computeElo(seasonId) {
  const elo = {};
  state.players.forEach(p => { elo[p] = ELO_START; });
  const history = {};
  state.players.forEach(p => { history[p] = [{ n: 0, rating: ELO_START }]; });
  // Use matches for the current filter (season-aware) — hard reset to 1200 each season
  const matches = seasonId
    ? sortedMatches().filter(m => getCurrentSeason(m.date).id === seasonId)
    : filteredMatches();
  matches.forEach((m, idx) => {
    const teamAvg = (team) => team.reduce((acc, p) => acc + (elo[p] ?? ELO_START), 0) / team.length;
    const rA = teamAvg(m.teamA), rB = teamAvg(m.teamB);
    const expA = 1 / (1 + Math.pow(10, (rB - rA) / 400));
    const scoreA = m.winner === 'A' ? 1 : 0;
    const deltaA = ELO_K * (scoreA - expA);
    const deltaB = ELO_K * ((1 - scoreA) - (1 - expA));
    m.teamA.forEach(p => {
      elo[p] = (elo[p] ?? ELO_START) + deltaA;
      history[p].push({ n: idx + 1, rating: Math.round(elo[p]) });
    });
    m.teamB.forEach(p => {
      elo[p] = (elo[p] ?? ELO_START) + deltaB;
      history[p].push({ n: idx + 1, rating: Math.round(elo[p]) });
    });
  });
  const current = {};
  state.players.forEach(p => { current[p] = Math.round(elo[p] ?? ELO_START); });
  return { current, history };
}

function statsFor(matches) {
  const s = {};
  state.players.forEach(p => {
    s[p] = { matches: 0, wins: 0, losses: 0, setsWon: 0, setsLost: 0, gamesWon: 0, gamesLost: 0, lastPlayedIdx: -1 };
  });
  matches.forEach((m, idx) => {
    const aWin = m.winner === 'A';
    m.teamA.forEach(p => {
      if (!s[p]) return;
      s[p].matches++; aWin ? s[p].wins++ : s[p].losses++;
      s[p].lastPlayedIdx = idx;
      m.sets.forEach(set => {
        s[p].gamesWon += set.a; s[p].gamesLost += set.b;
        if (set.a > set.b) s[p].setsWon++; else s[p].setsLost++;
      });
    });
    m.teamB.forEach(p => {
      if (!s[p]) return;
      s[p].matches++; aWin ? s[p].losses++ : s[p].wins++;
      s[p].lastPlayedIdx = idx;
      m.sets.forEach(set => {
        s[p].gamesWon += set.b; s[p].gamesLost += set.a;
        if (set.b > set.a) s[p].setsWon++; else s[p].setsLost++;
      });
    });
  });
  return s;
}


function computePairStreaks() {
  const streaks = {};
  const sorted = sortedMatches();
  sorted.forEach(m => {
    const aWin = m.winner === 'A';
    [[m.teamA, aWin],[m.teamB, !aWin]].forEach(([team, won]) => {
      const key = [...team].sort().join('|');
      if (!streaks[key]) streaks[key] = { names: [...team].sort().join(' & '), current: 0, longest: 0 };
      if (won) {
        streaks[key].current++;
        if (streaks[key].current > streaks[key].longest) streaks[key].longest = streaks[key].current;
      } else {
        streaks[key].current = 0;
      }
    });
  });
  return streaks;
}

// ── Power rankings ────────────────────────────────────────────────────────
const PLAYER_COLORS = ['#378ADD','#1D9E75','#D85A30','#D4537E','#7F77DD','#EF9F27','#14B8A6'];

function playerColor(name) {
  const idx = state.players.indexOf(name);
  return PLAYER_COLORS[idx >= 0 ? idx % PLAYER_COLORS.length : 0];
}

// ELO over an arbitrary ordered list of matches (no filter dependency)
function eloOver(matches) {
  const elo = {};
  state.players.forEach(p => { elo[p] = ELO_START; });
  matches.forEach(m => {
    const teamAvg = t => t.reduce((a, p) => a + (elo[p] ?? ELO_START), 0) / t.length;
    const rA = teamAvg(m.teamA), rB = teamAvg(m.teamB);
    const expA = 1 / (1 + Math.pow(10, (rB - rA) / 400));
    const sA = m.winner === 'A' ? 1 : 0;
    const dA = ELO_K * (sA - expA), dB = ELO_K * ((1 - sA) - (1 - expA));
    m.teamA.forEach(p => { elo[p] = (elo[p] ?? ELO_START) + dA; });
    m.teamB.forEach(p => { elo[p] = (elo[p] ?? ELO_START) + dB; });
  });
  const out = {};
  state.players.forEach(p => { out[p] = Math.round(elo[p] ?? ELO_START); });
  return out;
}

function playedCounts(matches) {
  const c = {};
  state.players.forEach(p => { c[p] = 0; });
  matches.forEach(m => [...m.teamA, ...m.teamB].forEach(p => { if (c[p] !== undefined) c[p]++; }));
  return c;
}

// Last-N form dots + current win/loss streak for a player
function playerFormAndStreak(matches, player, n = 5) {
  const results = [];
  for (let i = matches.length - 1; i >= 0 && results.length < n; i--) {
    const m = matches[i];
    const inA = m.teamA.includes(player), inB = m.teamB.includes(player);
    if (!inA && !inB) continue;
    results.unshift((m.winner === 'A') === inA);
  }
  let streak = 0, streakType = null;
  for (let i = matches.length - 1; i >= 0; i--) {
    const m = matches[i];
    const inA = m.teamA.includes(player), inB = m.teamB.includes(player);
    if (!inA && !inB) continue;
    const won = (m.winner === 'A') === inA;
    if (streakType === null) { streakType = won ? 'W' : 'L'; streak = 1; }
    else if ((streakType === 'W') === won) streak++;
    else break;
  }
  return { form: results, streak, streakType };
}

// King of the court — crown transfers when the current king is on the losing
// team; new king = highest-ELO player (at that moment) on the winning team.
function computeKingOfCourt(matches) {
  if (!matches.length) return null;
  const elo = {};
  state.players.forEach(p => { elo[p] = ELO_START; });
  let king = null, since = null;
  matches.forEach(m => {
    const winners = m.winner === 'A' ? m.teamA : m.teamB;
    const losers  = m.winner === 'A' ? m.teamB : m.teamA;
    if (!king || losers.includes(king)) {
      king = [...winners].sort((a, b) => (elo[b] ?? ELO_START) - (elo[a] ?? ELO_START))[0];
      since = m.date;
    }
    const teamAvg = t => t.reduce((a, p) => a + (elo[p] ?? ELO_START), 0) / t.length;
    const rA = teamAvg(m.teamA), rB = teamAvg(m.teamB);
    const expA = 1 / (1 + Math.pow(10, (rB - rA) / 400));
    const sA = m.winner === 'A' ? 1 : 0;
    const dA = ELO_K * (sA - expA), dB = ELO_K * ((1 - sA) - (1 - expA));
    m.teamA.forEach(p => { elo[p] = (elo[p] ?? ELO_START) + dA; });
    m.teamB.forEach(p => { elo[p] = (elo[p] ?? ELO_START) + dB; });
  });
  const weekends = new Set(matches.filter(m => m.date >= since).map(m => m.date)).size;
  return { king, since, weekends };
}

// Head-to-head records between players when on OPPOSITE teams
function computeRivalries(matches, topN = 2) {
  const h2h = {};
  matches.forEach(m => {
    m.teamA.forEach(a => m.teamB.forEach(b => {
      const key = [a, b].sort().join('|');
      if (!h2h[key]) h2h[key] = { pair: [a, b].sort(), wins: {}, lastWinner: null, lastStreak: 0 };
      const rec = h2h[key];
      const winner = m.winner === 'A' ? a : b;
      rec.wins[winner] = (rec.wins[winner] || 0) + 1;
      if (rec.lastWinner === winner) rec.lastStreak++;
      else { rec.lastWinner = winner; rec.lastStreak = 1; }
    }));
  });
  return Object.values(h2h)
    .map(r => {
      const [p1, p2] = r.pair;
      const w1 = r.wins[p1] || 0, w2 = r.wins[p2] || 0;
      return { ...r, p1, p2, w1, w2, total: w1 + w2 };
    })
    .filter(r => r.total >= 3)
    .sort((a, b) => b.total - a.total || Math.abs(a.w1 - a.w2) - Math.abs(b.w1 - b.w2))
    .slice(0, topN);
}

// ELO-based win probability for the likely next matchup.
// Uses availability votes for the upcoming weekend when 4+ are in,
// otherwise falls back to the four players from the most recent match.
function computeMatchupForecast() {
  const eloMap = computeElo().current;
  const nextWeekend = getUpcomingWeekendDates()[0];
  const votes = (state.availability || {})[nextWeekend] || {};
  const inPlayers = state.players.filter(p => votes[p] === 'in');
  let pool, label;
  if (inPlayers.length >= 4) {
    pool = [...inPlayers].sort((a, b) => (eloMap[b] ?? ELO_START) - (eloMap[a] ?? ELO_START)).slice(0, 4);
    label = `Forecast · ${formatDate(nextWeekend)}`;
  } else {
    const last = sortedMatches().slice(-1)[0];
    if (!last) return null;
    pool = [...last.teamA, ...last.teamB];
    label = 'Next matchup forecast';
  }
  if (pool.length < 4) return null;
  const s = [...pool].sort((a, b) => (eloMap[b] ?? ELO_START) - (eloMap[a] ?? ELO_START));
  const teamA = [s[0], s[3]], teamB = [s[1], s[2]]; // balanced pairing 1&4 vs 2&3
  const avg = t => t.reduce((acc, p) => acc + (eloMap[p] ?? ELO_START), 0) / t.length;
  const pA = 1 / (1 + Math.pow(10, (avg(teamB) - avg(teamA)) / 400));
  const fav = pA >= 0.5 ? teamA : teamB;
  const dog = pA >= 0.5 ? teamB : teamA;
  const pct = Math.round(Math.max(pA, 1 - pA) * 100);
  return { label, text: `${fav.join(' & ')} ${pct}% over ${dog.join(' & ')}` };
}

// One-line hook per player, in priority order
function playerSubtitle(p, ctx) {
  const { rank, order, eloData, stats, careerStats, king, streak, streakType } = ctx;
  if (king && king.king === p) {
    return `King of the court · ${king.weekends} weekend${king.weekends === 1 ? '' : 's'}`;
  }
  if (streakType === 'W' && streak >= 3) return `🔥 ${streak}-match win streak`;
  if (streakType === 'L' && streak >= 3) return `❄️ ${streak} straight losses — bounce-back time`;
  const careerWins = careerStats[p]?.wins ?? 0;
  if (careerWins >= 10) {
    const next = Math.ceil((careerWins + 1) / 25) * 25;
    const need = next - careerWins;
    if (need <= 3) return `${need} win${need === 1 ? '' : 's'} from ${next} career wins`;
  }
  if (rank === order.length && order.length >= 3) {
    const above = order[rank - 2];
    const gap = (eloData.current[above] ?? ELO_START) - (eloData.current[p] ?? ELO_START);
    if (gap <= 35) return `1 win from escaping last place`;
  }
  if (rank > 1) {
    const above = order[rank - 2];
    const gap = (eloData.current[above] ?? ELO_START) - (eloData.current[p] ?? ELO_START);
    if (gap <= 15) return `${gap} pt${gap === 1 ? '' : 's'} behind ${above}`;
  }
  if (streakType === 'W' && streak === 2) return `Won last 2 — heating up`;
  const s = stats[p];
  const pct = s.matches ? Math.round((s.wins / s.matches) * 100) : 0;
  return `${s.wins}W–${s.losses}L · ${pct}% win rate`;
}

function renderPowerRankings() {
  const box = document.getElementById('power-rankings');
  if (!box) return;
  const matches = filteredMatches();
  if (matches.length === 0) { box.innerHTML = ''; return; }

  const eloData = computeElo();
  const played = playedCounts(matches);
  const order = [...state.players]
    .filter(p => played[p] > 0)
    .sort((a, b) => (eloData.current[b] ?? ELO_START) - (eloData.current[a] ?? ELO_START));

  // Movement = rank now vs rank before the most recent match date in scope
  const lastDate = matches[matches.length - 1].date;
  const prevMatches = matches.filter(m => m.date !== lastDate);
  const prevElo = eloOver(prevMatches);
  const prevPlayed = playedCounts(prevMatches);
  const prevOrder = [...state.players]
    .filter(p => prevPlayed[p] > 0)
    .sort((a, b) => prevElo[b] - prevElo[a]);

  const king = computeKingOfCourt(matches);
  const stats = statsFor(matches);
  const careerStats = statsFor(sortedMatches());

  const rows = order.map((p, i) => {
    const rank = i + 1;
    const prevIdx = prevOrder.indexOf(p);
    let moveHtml;
    if (prevIdx === -1) moveHtml = `<span class="pr-move new">NEW</span>`;
    else {
      const diff = prevIdx - i;
      moveHtml = diff > 0 ? `<span class="pr-move up">▲${diff}</span>`
        : diff < 0 ? `<span class="pr-move down">▼${-diff}</span>`
        : `<span class="pr-move flat">—</span>`;
    }
    const { form, streak, streakType } = playerFormAndStreak(matches, p);
    const dots = form.map(w => `<span class="pr-dot ${w ? 'w' : 'l'}"></span>`).join('');
    const sub = playerSubtitle(p, { rank, order, eloData, stats, careerStats, king, streak, streakType });
    const isKing = king && king.king === p;
    const avatarHtml = playerAvatarHtml(p, 'pr-avatar');
    return `
      <div class="pr-row ${isKing ? 'pr-king' : ''}">
        <span class="pr-rank">${rank}</span>
        ${moveHtml}
        ${avatarHtml}
        <div class="pr-info">
          <div class="pr-name">${escapeHtml(p)}${isKing ? ' <span class="pr-crown">👑</span>' : ''}</div>
          <div class="pr-sub">${sub}</div>
        </div>
        <div class="pr-form">${dots}</div>
        <span class="pr-elo">${eloData.current[p] ?? ELO_START}</span>
      </div>`;
  }).join('');

  const watchCards = [];
  computeRivalries(matches).forEach(r => {
    const leadTxt = r.w1 === r.w2
      ? `Tied ${r.w1}–${r.w2}`
      : (r.w1 > r.w2 ? `${r.p1} leads ${r.w1}–${r.w2}` : `${r.p2} leads ${r.w2}–${r.w1}`);
    const streakTxt = r.lastStreak >= 2 ? ` · ${r.lastWinner} won last ${r.lastStreak}` : '';
    watchCards.push(`
      <div class="rw-card">
        <div class="rw-title">${escapeHtml(r.p1)} vs ${escapeHtml(r.p2)}</div>
        <div class="rw-sub">${escapeHtml(leadTxt + streakTxt)}</div>
      </div>`);
  });
  const forecast = computeMatchupForecast();
  if (forecast) {
    watchCards.push(`
      <div class="rw-card rw-forecast">
        <div class="rw-title">🔮 ${escapeHtml(forecast.label)}</div>
        <div class="rw-sub">${escapeHtml(forecast.text)}</div>
      </div>`);
  }

  box.innerHTML = `
    <div class="pr-card">
      <div class="pr-header">
        <span class="pr-heading">🏅 Power rankings</span>
        <span class="pr-date">Through ${formatDate(lastDate)} · Match ${matches.length}</span>
      </div>
      ${rows}
      ${watchCards.length ? `<div class="rw-label">Rivalry watch</div><div class="rw-grid">${watchCards.join('')}</div>` : ''}
    </div>`;
}

function renderSummary() {
  const matches = filteredMatches();
  const totalMatches = matches.length;
  const weekends = currentFilter === 'all' ? new Set(state.matches.map(m => m.date)).size : (matches.length > 0 ? 1 : 0);
  const totalSets = matches.reduce((acc, m) => acc + m.sets.length, 0);
  const totalGames = matches.reduce((acc, m) => acc + m.sets.reduce((a, s) => a + s.a + s.b, 0), 0);

  const streaks = computePairStreaks();
  const topStreak = Object.values(streaks).sort((a, b) => b.longest - a.longest)[0];

  const cards = [
    { label: 'Matches', value: totalMatches },
    { label: 'Weekends', value: weekends },
    { label: 'Sets', value: totalSets },
    { label: 'Games', value: totalGames }
  ];
  let streakCard = '';
  if (topStreak && topStreak.longest > 0) {
    streakCard = `
      <div class="summary-card streak-card">
        <div class="label">🔥 Best pair streak</div>
        <div class="value">${topStreak.longest}</div>
        <div class="streak-pair">${escapeHtml(topStreak.names)}</div>
      </div>`;
  }
  document.getElementById('summary-cards').innerHTML =
    cards.map(c => `
      <div class="summary-card">
        <div class="label">${c.label}</div>
        <div class="value">${c.value}</div>
      </div>`).join('') + streakCard;
}

function renderChampion() {
  const box = document.getElementById('champion-badge');
  if (currentFilter === 'all' || filteredMatches().length === 0) {
    box.className = 'champion-hidden';
    return;
  }
  const s = statsFor(filteredMatches());
  const rows = state.players.map(p => ({ name: p, ...s[p], winRate: s[p].matches ? s[p].wins / s[p].matches : 0 }))
    .filter(r => r.matches > 0)
    .sort((a, b) => b.winRate - a.winRate || b.wins - a.wins || (b.setsWon - b.setsLost) - (a.setsWon - a.setsLost));
  if (rows.length === 0) { box.className = 'champion-hidden'; return; }
  const champ = rows[0];
  box.className = 'champion-badge';
  box.innerHTML = `
    <div class="champ-avatar-wrap">
      ${playerAvatarHtml(champ.name, 'champ-avatar')}
      <span class="champ-trophy">🏆</span>
    </div>
    <div>
      <div class="label">Champion of the weekend</div>
      <div class="name">${escapeHtml(champ.name)} — ${champ.wins}-${champ.losses}, ${Math.round(champ.winRate * 100)}%</div>
    </div>`;
}

// King of the Court badge — shown when viewing a specific weekend.
// The king is computed over ALL matches up to and including that weekend,
// so the crown carries continuity across weekends.
function renderKingBadge() {
  const box = document.getElementById('king-badge');
  if (!box) return;
  const isWeekend = currentFilter !== 'all' && !currentFilter.startsWith('season:');
  if (!isWeekend) { box.className = 'champion-hidden'; box.innerHTML = ''; return; }
  const upTo = sortedMatches().filter(m => m.date <= currentFilter);
  const king = computeKingOfCourt(upTo);
  if (!king) { box.className = 'champion-hidden'; box.innerHTML = ''; return; }
  box.className = 'champion-badge king-badge';
  box.innerHTML = `
    <div class="champ-avatar-wrap">
      ${playerAvatarHtml(king.king, 'champ-avatar')}
      <span class="champ-trophy">👑</span>
    </div>
    <div>
      <div class="label">King of the court</div>
      <div class="name">${escapeHtml(king.king)} — held ${king.weekends} weekend${king.weekends === 1 ? '' : 's'}</div>
    </div>`;
}

function renderLeaderboard() {
  const matches = filteredMatches();
  const s = statsFor(matches);
  const eloData = computeElo();
  const rows = state.players.map(p => ({
    name: p, ...s[p],
    winRate: s[p].matches ? s[p].wins / s[p].matches : 0,
    elo: Math.round(eloData.current[p] ?? ELO_START)
  })).sort((a, b) => b.elo - a.elo || b.winRate - a.winRate);
  document.getElementById('leaderboard').innerHTML = `
    <table>
      <thead>
        <tr>
          <th>#</th><th>Player</th>
          <th class="right">ELO</th>
          <th class="right">W-L</th>
          <th class="right">Win %</th>
          <th class="right">Sets</th>
          <th class="right">Games</th>
        </tr>
      </thead>
      <tbody>
        ${rows.map((r, i) => `
          <tr>
            <td>${i + 1}</td>
            <td><strong>${escapeHtml(r.name)}</strong></td>
            <td class="right"><strong>${r.elo}</strong></td>
            <td class="right">${r.wins}-${r.losses}</td>
            <td class="right">${r.matches ? Math.round(r.winRate * 100) : 0}%</td>
            <td class="right">${r.setsWon}-${r.setsLost}</td>
            <td class="right">${r.gamesWon}-${r.gamesLost}</td>
          </tr>`).join('')}
      </tbody>
    </table>`;
}

function renderCharts() {
  const COLORS = PLAYER_COLORS;
  const matches = filteredMatches();
  const eloData = computeElo();
  const stats   = statsFor(matches);

  // ── Option B: ELO horizontal bar leaderboard ──────────────────────────
  const sorted = [...state.players]
    .sort((a, b) => eloData.current[b] - eloData.current[a]);
  const eloVals  = sorted.map(p => eloData.current[p]);
  const wrVals   = sorted.map(p => stats[p].matches ? stats[p].wins / stats[p].matches : 0);
  const barColors = sorted.map((p, i) => {
    const col = COLORS[state.players.indexOf(p) % COLORS.length];
    return col + (wrVals[i] > 0.5 ? 'ee' : wrVals[i] > 0 ? 'bb' : '66');
  });

  if (eloBarChart) eloBarChart.destroy();
  const eloBarCanvas = document.getElementById('eloBarChart');
  if (!eloBarCanvas) return;
  if (matches.length === 0) {
    blankChart(eloBarCanvas, 'Log a match to see rankings');
  } else {
    eloBarChart = new Chart(eloBarCanvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: sorted.map(p => escapeHtml(p)),
        datasets: [{
          data: eloVals,
          backgroundColor: barColors,
          borderRadius: 6,
          borderSkipped: false
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true, maintainAspectRatio: false,
        scales: {
          x: {
            min: Math.min(ELO_START - 20, Math.min(...eloVals) - 20),
            grid: { color: 'rgba(127,127,127,0.08)' },
            ticks: { font: { size: 11 } }
          },
          y: { grid: { display: false }, ticks: { font: { size: 12 } } }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ` ELO ${ctx.raw} · Win rate ${Math.round(wrVals[ctx.dataIndex] * 100)}% · ${stats[sorted[ctx.dataIndex]].matches} matches`
            }
          }
        }
      }
    });
  }

  // ── Option C: Win rate vertical bars ──────────────────────────────────
  const wrSorted = [...state.players]
    .filter(p => stats[p].matches > 0)
    .sort((a, b) => (stats[b].wins / stats[b].matches) - (stats[a].wins / stats[a].matches));

  if (winRateChart) winRateChart.destroy();
  const wrCanvas = document.getElementById('winRateBarChart');
  if (!wrCanvas) return;
  if (wrSorted.length === 0) {
    blankChart(wrCanvas, 'Log a match to see win rates');
  } else {
    winRateChart = new Chart(wrCanvas.getContext('2d'), {
      type: 'bar',
      data: {
        labels: wrSorted.map(p => escapeHtml(p)),
        datasets: [{
          data: wrSorted.map(p => Math.round(stats[p].wins / stats[p].matches * 100)),
          backgroundColor: wrSorted.map(p => COLORS[state.players.indexOf(p) % COLORS.length] + 'cc'),
          borderRadius: 6,
          borderSkipped: false
        }]
      },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: {
          y: {
            min: 0, max: 100,
            ticks: { callback: v => v + '%', font: { size: 11 } },
            grid: { color: 'rgba(127,127,127,0.08)' }
          },
          x: { grid: { display: false }, ticks: { font: { size: 12 } } }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.raw}% win rate (${stats[wrSorted[ctx.dataIndex]].wins}W–${stats[wrSorted[ctx.dataIndex]].losses}L)`
            }
          }
        }
      }
    });
  }

  // ── ELO history line chart (clean, no fill) ───────────────────────────
  if (eloChart) eloChart.destroy();
  const eloLineCanvas = document.getElementById('eloChart');
  if (!eloLineCanvas) return;
  if (matches.length === 0) {
    blankChart(eloLineCanvas, 'ELO history appears after first match');
    document.getElementById('eloLegend').innerHTML = '';
  } else {
    const activePlayers = state.players.filter(p => eloData.history[p].length > 1);
    const lineDatasets = activePlayers.map(p => {
      const i = state.players.indexOf(p);
      const col = COLORS[i % COLORS.length];
      return {
        label: p,
        data: eloData.history[p].map(pt => ({ x: pt.n, y: pt.rating })),
        borderColor: col,
        backgroundColor: 'transparent',
        tension: 0.3,
        pointRadius: (ctx) => (ctx.dataIndex === 0 || ctx.dataIndex === eloData.history[p].length - 1) ? 4 : 2,
        pointHoverRadius: 6,
        borderWidth: 2.5,
        borderDash: i > 2 ? [5, 3] : []
      };
    });
    eloChart = new Chart(eloLineCanvas.getContext('2d'), {
      type: 'line',
      data: { datasets: lineDatasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: { type: 'linear', title: { display: true, text: 'Match #', font: { size: 11 } }, ticks: { stepSize: 5, font: { size: 11 } }, grid: { color: 'rgba(127,127,127,0.08)' } },
          y: { title: { display: true, text: 'ELO', font: { size: 11 } }, grid: { color: 'rgba(127,127,127,0.08)' }, ticks: { font: { size: 11 } } }
        },
        plugins: {
          legend: { display: false },
          tooltip: { callbacks: { label: ctx => ` ${ctx.dataset.label}: ${ctx.raw.y}` } }
        }
      }
    });
    renderChartLegend('eloLegend', activePlayers, COLORS.slice(0, activePlayers.length), activePlayers.map((_, i) => i > 2 ? [5, 3] : []));
  }
}

function renderChartLegend(id, players, colors, dashes) {
  const el = document.getElementById(id);
  if (!el) return;
  el.innerHTML = players.map((p, i) => {
    const dashStyle = dashes[i].length
      ? `repeating-linear-gradient(to right, ${colors[i]} 0, ${colors[i]} ${dashes[i][0]}px, transparent ${dashes[i][0]}px, transparent ${dashes[i][0] + (dashes[i][1] || 4)}px)`
      : 'none';
    const solidBg = dashes[i].length ? 'transparent' : colors[i];
    return `
      <span class="chart-legend-item">
        <span class="chart-legend-line" style="background:${solidBg};${dashes[i].length ? `background-image:${dashStyle}` : ''}; border-color:${colors[i]}"></span>
        ${escapeHtml(p)}
      </span>`;
  }).join('');
}



function blankChart(canvas, msg) {
  const ctx = canvas.getContext('2d');
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = 'rgba(127,127,127,0.8)';
  ctx.font = '13px sans-serif';
  ctx.textAlign = 'center';
  ctx.fillText(msg, canvas.width / 2, canvas.height / 2);
}

function renderHistory() {
  const list = document.getElementById('history-list');
  if (state.matches.length === 0) {
    list.innerHTML = `<div class="hint" style="text-align:center; padding:2rem;">No matches yet.</div>`;
    return;
  }
  const grouped = {};
  state.matches.forEach(m => { (grouped[m.date] = grouped[m.date] || []).push(m); });
  const dates = Object.keys(grouped).sort().reverse();
  list.innerHTML = dates.map(d => {
    const matches = grouped[d].sort((a, b) => b.createdAt - a.createdAt);
    return `
      <div class="weekend-header">${formatDate(d)} · ${matches.length} match${matches.length === 1 ? '' : 'es'}</div>
      ${matches.map(m => renderMatchCard(m)).join('')}`;
  }).join('');
  list.querySelectorAll('[data-delete]').forEach(btn => {
    btn.addEventListener('click', () => {
      if (!confirm('Delete this match?')) return;
      state.matches = state.matches.filter(m => m.id !== btn.dataset.delete);
      saveState();
    });
  });
  list.querySelectorAll('[data-share]').forEach(btn => {
    btn.addEventListener('click', () => {
      const m = state.matches.find(m => m.id === btn.dataset.share);
      if (m) openShareModal(m);
    });
  });
}

function renderMatchCard(m) {
  const aWin = m.winner === 'A';
  const score = m.sets.map(s => {
    const tb = (s.tbA != null && s.tbB != null) ? ` (${s.tbA}-${s.tbB})` : '';
    return `${s.a}-${s.b}${tb}`;
  }).join(', ');
  const notes = m.notes ? `<div class="notes">"${escapeHtml(m.notes)}"</div>` : '';
  const teamLine = (team, won) => `
    <div class="team-line ${won ? 'winner' : ''}">
      <span class="mc-avatars">${team.map(p => playerAvatarHtml(p, 'mc-avatar')).join('')}</span>
      <span>${escapeHtml(team.join(' & '))}${won ? ' ✓' : ''}</span>
    </div>`;
  return `
    <div class="match-card">
      <div class="teams">
        ${teamLine(m.teamA, aWin)}
        ${teamLine(m.teamB, !aWin)}
        <div class="score">${score}</div>
        ${notes}
      </div>
      <div class="actions">
        <button class="btn-small" data-share="${m.id}">Share</button>
        <button class="btn-small" data-delete="${m.id}">Delete</button>
      </div>
    </div>`;
}

function renderChemistry() {
  const pairStats = {};
  state.matches.forEach(m => {
    const aWin = m.winner === 'A';
    addPair(pairStats, m.teamA, aWin);
    addPair(pairStats, m.teamB, !aWin);
  });
  const streaks = computePairStreaks();
  const arr = Object.values(pairStats).map(p => ({
    ...p,
    longest: streaks[p.names.split(' & ').sort().join('|')]?.longest ?? 0,
    current: streaks[p.names.split(' & ').sort().join('|')]?.current ?? 0
  })).sort((a, b) => (b.wins / b.matches) - (a.wins / a.matches) || b.wins - a.wins);

  const list = document.getElementById('chemistry-list');
  if (arr.length === 0) {
    list.innerHTML = `<div class="hint" style="text-align:center; padding:2rem;">No pairings yet.</div>`;
    return;
  }
  list.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead>
          <tr>
            <th>Pairing</th>
            <th class="right">W-L</th>
            <th class="right">Win %</th>
            <th class="right">Best streak</th>
            <th class="right">On fire</th>
          </tr>
        </thead>
        <tbody>
          ${arr.map(p => `
            <tr>
              <td>${escapeHtml(p.names)}</td>
              <td class="right">${p.wins}-${p.matches - p.wins}</td>
              <td class="right">${Math.round((p.wins / p.matches) * 100)}%</td>
              <td class="right">${p.longest > 0 ? `🏆 ${p.longest}` : '—'}</td>
              <td class="right">${p.current >= 3 ? `🔥 ${p.current}` : p.current > 0 ? `${p.current}` : '—'}</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>
    <p class="hint" style="margin-top:8px">Best streak = longest consecutive wins ever. On fire = current active win streak.</p>`;
}

function addPair(store, team, won) {
  const key = [...team].sort().join('|');
  if (!store[key]) store[key] = { names: [...team].sort().join(' & '), matches: 0, wins: 0 };
  store[key].matches++; if (won) store[key].wins++;
}

function renderRotation() {
  const box = document.getElementById('rotation-suggestion');
  const n = state.players.length;
  if (n < 5) {
    box.innerHTML = `<div class="hint">Need at least 5 players set up.</div>`;
    return;
  }  const matches = sortedMatches();
  const s = statsFor(matches);
  const eloData = computeElo();
  const lastMatchIdx = matches.length - 1;
  const restScore = {};
  state.players.forEach(p => {
    const last = s[p].lastPlayedIdx;
    restScore[p] = last < 0 ? 999 : (lastMatchIdx - last);
  });
  const pairCounts = {};
  matches.forEach(m => {
    const pA = [...m.teamA].sort().join('|');
    const pB = [...m.teamB].sort().join('|');
    pairCounts[pA] = (pairCounts[pA] || 0) + 1;
    pairCounts[pB] = (pairCounts[pB] || 0) + 1;
  });

  const sittingCount = n - 4;
  const sorted = [...state.players].sort((a, b) => restScore[b] - restScore[a]);
  const sittingOut = sorted.slice(0, sittingCount);
  const playing = state.players.filter(p => !sittingOut.includes(p));

  const combos = [];
  for (let i = 0; i < playing.length; i++) {
    for (let j = i + 1; j < playing.length; j++) {
      const teamA = [playing[i], playing[j]];
      const teamB = playing.filter(p => !teamA.includes(p));
      if (teamB.length !== 2) continue;
      const eloA = (eloData.current[teamA[0]] + eloData.current[teamA[1]]) / 2;
      const eloB = (eloData.current[teamB[0]] + eloData.current[teamB[1]]) / 2;
      const balance = Math.abs(eloA - eloB);
      const pairA = [...teamA].sort().join('|');
      const pairB = [...teamB].sort().join('|');
      const freshness = (pairCounts[pairA] || 0) + (pairCounts[pairB] || 0);
      combos.push({ teamA, teamB, balance, freshness, score: balance + freshness * 30 });
    }
  }
  const top = combos.sort((a, b) => a.score - b.score).slice(0, 3);
  const pick = top[Math.floor(Math.random() * Math.min(top.length, 3))] || top[0];
  if (!pick) {
    box.innerHTML = `<div class="hint">Need more data.</div>`;
    return;
  }
  const teamAElo = Math.round((eloData.current[pick.teamA[0]] + eloData.current[pick.teamA[1]]) / 2);
  const teamBElo = Math.round((eloData.current[pick.teamB[0]] + eloData.current[pick.teamB[1]]) / 2);
  box.innerHTML = `
    <div class="rotation-card">
      <div class="rotation-teams">
        <div class="rotation-team">
          <div class="t-label">Team A</div>
          <div class="t-name">${escapeHtml(pick.teamA[0])}</div>
          <div class="t-name">${escapeHtml(pick.teamA[1])}</div>
          <div class="t-elo">Avg ELO ${teamAElo}</div>
        </div>
        <div class="rotation-vs">vs</div>
        <div class="rotation-team">
          <div class="t-label">Team B</div>
          <div class="t-name">${escapeHtml(pick.teamB[0])}</div>
          <div class="t-name">${escapeHtml(pick.teamB[1])}</div>
          <div class="t-elo">Avg ELO ${teamBElo}</div>
        </div>
      </div>
      <div class="rotation-sit">
        <span class="hint" style="margin:0">Sitting out</span>
        <span class="name">${escapeHtml(sittingOut.join(' & '))}</span>
      </div>
    </div>`;
}

function playerAvatarUrl(name) {
  const entry = (state.playerAvatars || {})[name];
  if (!entry) return null;
  return typeof entry === 'string' ? entry : entry.url;
}

// Reusable avatar — photo if set, colored initials circle otherwise
function playerAvatarHtml(p, cls) {
  const url = playerAvatarUrl(p);
  return url
    ? `<img class="${cls}" src="${escapeHtml(url)}" alt="${escapeHtml(p)}" loading="lazy">`
    : `<span class="${cls} avatar-initials" style="background:${playerColor(p)}">${escapeHtml(p.slice(0, 2).toUpperCase())}</span>`;
}

function renderPlayersPanel() {
  const container = document.getElementById('player-inputs');
  const MAX = 7;
  const slots = [...state.players];
  while (slots.length < MAX) slots.push('');
  container.innerHTML = slots.map((p, i) => {
    const av = p ? playerAvatarUrl(p) : null;
    const avatarHtml = av
      ? `<img class="pp-avatar" src="${escapeHtml(av)}" alt="${escapeHtml(p)}">`
      : `<span class="pp-avatar pp-initials" style="background:${p ? playerColor(p) : 'var(--border-strong)'}">${p ? escapeHtml(p.slice(0, 2).toUpperCase()) : '?'}</span>`;
    return `
    <div class="pp-row">
      <span style="font-size:12px;color:var(--text-muted);min-width:20px">${i + 1}.</span>
      ${avatarHtml}
      <input type="text" data-player-idx="${i}" value="${escapeHtml(p)}" placeholder="Player ${i + 1} name" style="flex:1">
      ${p ? `<button class="btn-small pp-photo-btn" data-avatar-player="${escapeHtml(p)}" title="Set photo">📷</button>` : ''}
    </div>`;
  }).join('');
  container.querySelectorAll('[data-avatar-player]').forEach(btn => {
    btn.addEventListener('click', () => pickAvatar(btn.dataset.avatarPlayer));
  });
}

function pickAvatar(player) {
  const input = document.createElement('input');
  input.type = 'file';
  input.accept = 'image/*';
  input.addEventListener('change', () => {
    const file = input.files && input.files[0];
    if (!file) return;
    const reader = new FileReader();
    reader.onerror = () => alert('Could not read the selected file.');
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => alert('Could not load that image — try a different one.');
      img.onload = () => openCropModal(img, (dataUrl) => saveAvatar(player, dataUrl));
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
  input.click();
}

async function saveAvatar(player, dataUrl) {
  if (!firebaseLoaded) { alert('Still connecting — try again in a moment.'); return; }
  try {
    // clean up any old Storage-based avatar from the previous implementation
    const prev = (state.playerAvatars || {})[player];
    if (prev && prev.path) {
      try { await deleteObject(storageRef(storage, prev.path)); } catch (e) { /* ignore */ }
    }
    if (!state.playerAvatars) state.playerAvatars = {};
    state.playerAvatars[player] = dataUrl; // base64, lives in Firestore state
    await saveState();
    renderPlayersPanel();
    renderPowerRankings();
    renderChampion();
    renderKingBadge();
    renderHistory();
  } catch (err) {
    console.error('Avatar save failed:', err);
    alert('Could not save photo: ' + err.message);
  }
}

// Square crop modal: drag to position, slider to zoom
function openCropModal(img, onSave) {
  const overlay = document.createElement('div');
  overlay.className = 'crop-overlay';
  overlay.innerHTML = `
    <div class="crop-box">
      <div class="crop-title">Position &amp; zoom</div>
      <canvas class="crop-canvas" width="280" height="280"></canvas>
      <input type="range" class="crop-zoom" min="100" max="300" value="100" aria-label="Zoom">
      <div class="crop-actions">
        <button type="button" class="btn-small crop-cancel">Cancel</button>
        <button type="button" class="btn-small crop-save">✓ Save photo</button>
      </div>
    </div>`;
  document.body.appendChild(overlay);
  const canvas = overlay.querySelector('.crop-canvas');
  const ctx = canvas.getContext('2d');
  const V = 280;
  const base = Math.max(V / img.width, V / img.height); // cover the square
  let zoom = 1, offX = 0, offY = 0;

  function clampOffsets() {
    const w = img.width * base * zoom, h = img.height * base * zoom;
    const maxX = Math.max(0, (w - V) / 2), maxY = Math.max(0, (h - V) / 2);
    offX = Math.min(maxX, Math.max(-maxX, offX));
    offY = Math.min(maxY, Math.max(-maxY, offY));
  }
  function draw(c = ctx, size = V) {
    const s = size / V;
    const w = img.width * base * zoom * s, h = img.height * base * zoom * s;
    c.fillStyle = '#000';
    c.fillRect(0, 0, size, size);
    c.drawImage(img, (size - w) / 2 + offX * s, (size - h) / 2 + offY * s, w, h);
  }
  draw();

  let dragging = false, lastX = 0, lastY = 0;
  canvas.addEventListener('pointerdown', (e) => {
    dragging = true; lastX = e.clientX; lastY = e.clientY;
    canvas.setPointerCapture(e.pointerId);
  });
  canvas.addEventListener('pointermove', (e) => {
    if (!dragging) return;
    offX += e.clientX - lastX; offY += e.clientY - lastY;
    lastX = e.clientX; lastY = e.clientY;
    clampOffsets(); draw();
  });
  canvas.addEventListener('pointerup', () => { dragging = false; });
  canvas.addEventListener('pointercancel', () => { dragging = false; });

  overlay.querySelector('.crop-zoom').addEventListener('input', (e) => {
    zoom = parseInt(e.target.value, 10) / 100;
    clampOffsets(); draw();
  });
  overlay.querySelector('.crop-cancel').addEventListener('click', () => overlay.remove());
  overlay.querySelector('.crop-save').addEventListener('click', () => {
    const out = document.createElement('canvas');
    out.width = 256; out.height = 256;
    draw(out.getContext('2d'), 256);
    overlay.remove();
    onSave(out.toDataURL('image/jpeg', 0.85));
  });
}

function savePlayers() {
  const inputs = document.querySelectorAll('[data-player-idx]');
  const next = [];
  inputs.forEach(inp => { const v = inp.value.trim(); if (v) next.push(v); });
  if (next.length < 5) { alert('You need at least 5 player names.'); return; }
  if (next.length > 7) { alert('Maximum 7 players supported.'); return; }
  if (new Set(next).size !== next.length) { alert('Player names must be unique.'); return; }
  const rename = {};
  state.players.forEach((old, i) => { if (next[i]) rename[old] = next[i]; });
  if (state.playerAvatars) {
    const remapped = {};
    Object.entries(state.playerAvatars).forEach(([name, v]) => { remapped[rename[name] || name] = v; });
    state.playerAvatars = remapped;
  }
  state.matches = state.matches.map(m => ({
    ...m,
    teamA: m.teamA.map(p => rename[p] || p),
    teamB: m.teamB.map(p => rename[p] || p)
  }));
  state.players = next;
  saveState();
  alert(`Saved ${next.length} players: ${next.join(', ')}`);
}
function renderLogForm() {
  ['a1','a2','b1','b2'].forEach(id => {
    const sel = document.getElementById(id);
    const prev = sel.value;
    sel.innerHTML = '<option value="">— Select —</option>' +
      state.players.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
    if (prev) sel.value = prev;
    sel.onchange = updateSittingOut;
  });
  const dateInput = document.getElementById('match-date');
  if (!dateInput.value) dateInput.value = new Date().toISOString().slice(0, 10);
  document.getElementById('sets-format').onchange = renderSetsInputs;
  renderSetsInputs();
  updateSittingOut();
}

function renderSetsInputs() {
  const format = parseInt(document.getElementById('sets-format').value, 10);
  const container = document.getElementById('sets-container');
  let html = '<label>Set scores (tiebreak optional)</label>';
  for (let i = 0; i < format; i++) {
    html += `
      <div class="set-row">
        <div class="games">
          <span class="set-label">Set ${i + 1}</span>
          <input type="number" min="0" max="20" placeholder="A games" data-set="${i}" data-field="a">
          <input type="number" min="0" max="20" placeholder="B games" data-set="${i}" data-field="b">
        </div>
        <div class="tb">
          <span class="tb-label">Tiebreak</span>
          <input type="number" min="0" max="30" placeholder="A pts" data-set="${i}" data-field="tbA">
          <input type="number" min="0" max="30" placeholder="B pts" data-set="${i}" data-field="tbB">
        </div>
      </div>`;
  }
  container.innerHTML = html;
}

function updateSittingOut() {
  const picked = ['a1','a2','b1','b2'].map(id => document.getElementById(id).value).filter(Boolean);
  const sitting = state.players.filter(p => !picked.includes(p));
  const label = document.getElementById('sitting-out');
  if (picked.length < 4) label.textContent = `Pick 4 players.`;
  else if (new Set(picked).size !== 4) label.textContent = `Each player can only be on one team.`;
  else label.textContent = `Sitting out: ${sitting.join(', ') || 'nobody'}`;
}

function saveMatch() {
  const err = document.getElementById('form-error');
  err.classList.add('hidden');
  const date = document.getElementById('match-date').value;
  const a1 = document.getElementById('a1').value;
  const a2 = document.getElementById('a2').value;
  const b1 = document.getElementById('b1').value;
  const b2 = document.getElementById('b2').value;
  const notes = document.getElementById('match-notes').value.trim();
  const picked = [a1, a2, b1, b2];
  if (!date) return showErr(err, 'Pick a date.');
  if (picked.some(p => !p)) return showErr(err, 'Pick all 4 players.');
  if (new Set(picked).size !== 4) return showErr(err, 'Each player can only play once per match.');
  const setsRaw = {};
  document.querySelectorAll('#sets-container input[type="number"]').forEach(inp => {
    const s = inp.dataset.set, f = inp.dataset.field;
    if (!setsRaw[s]) setsRaw[s] = {};
    const v = inp.value;
    setsRaw[s][f] = v === '' ? null : parseInt(v, 10);
  });
  const sets = [];
  let tieFound = false;
  Object.keys(setsRaw).sort((a, b) => a - b).forEach(k => {
    const r = setsRaw[k];
    if (r.a == null || r.b == null || Number.isNaN(r.a) || Number.isNaN(r.b)) return;
    if (r.a === r.b) { tieFound = true; showErr(err, `Set ${parseInt(k) + 1} can't be a tie.`); return; }
    sets.push({
      a: r.a, b: r.b,
      tbA: (r.tbA == null || Number.isNaN(r.tbA)) ? null : r.tbA,
      tbB: (r.tbB == null || Number.isNaN(r.tbB)) ? null : r.tbB
    });
  });
  if (tieFound) return;
  if (sets.length === 0) return showErr(err, 'Enter at least one completed set.');
  let aSets = 0, bSets = 0;
  sets.forEach(s => { if (s.a > s.b) aSets++; else bSets++; });
  if (aSets === bSets) return showErr(err, 'Match is tied overall. Add another set.');
  const match = {
    id: 'm_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7),
    date, createdAt: Date.now(),
    teamA: [a1, a2], teamB: [b1, b2],
    sets, notes, winner: aSets > bSets ? 'A' : 'B'
  };
  state.matches.push(match);
  saveState();
  ['a1','a2','b1','b2'].forEach(id => document.getElementById(id).value = '');
  document.getElementById('match-notes').value = '';
  renderSetsInputs();
  updateSittingOut();
  openShareModal(match);
  // Regenerate ticker with new match data after a short delay
  tickerCache = { messages: [], date: '', filter: '' };
  tickerGenerated = false;
  setTimeout(() => generateTicker(true), 500);
}

function showErr(el, msg) { el.textContent = msg; el.classList.remove('hidden'); }


function resetAll() {
  if (!confirm('Delete ALL match data? This cannot be undone.')) return;
  state.matches = [];
  saveState();
}

function exportCsv() {
  const rows = [['date','team_a_p1','team_a_p2','team_b_p1','team_b_p2','winner','sets','notes']];
  sortedMatches().forEach(m => {
    const setsStr = m.sets.map(s => {
      const tb = (s.tbA != null && s.tbB != null) ? `(${s.tbA}-${s.tbB})` : '';
      return `${s.a}-${s.b}${tb}`;
    }).join('; ');
    rows.push([m.date, m.teamA[0], m.teamA[1], m.teamB[0], m.teamB[1], m.winner, setsStr, (m.notes || '').replace(/"/g, '""')]);
  });
  const csv = rows.map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
  const blob = new Blob([csv], { type: 'text/csv' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = `tennis_matches_${new Date().toISOString().slice(0, 10)}.csv`;
  document.body.appendChild(a); a.click(); document.body.removeChild(a);
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

function buildShareMessage(m) {
  const aWin = m.winner === 'A';
  const winners = aWin ? m.teamA : m.teamB;
  const losers = aWin ? m.teamB : m.teamA;
  const score = m.sets.map(s => {
    const aFirst = aWin;
    const tb = (s.tbA != null && s.tbB != null)
      ? ` (${aFirst ? s.tbA + '-' + s.tbB : s.tbB + '-' + s.tbA})`
      : '';
    return `${aFirst ? s.a + '-' + s.b : s.b + '-' + s.a}${tb}`;
  }).join(', ');
  let msg = `🎾 Match result — ${formatDate(m.date)}\n\n`;
  msg += `🏆 ${winners.join(' & ')}\n`;
  msg += `    def.\n`;
  msg += `    ${losers.join(' & ')}\n\n`;
  msg += `Score: ${score}`;
  if (m.notes) msg += `\n\n"${m.notes}"`;
  const url = window.location.href.split('?')[0];
  msg += `\n\nLeaderboard: ${url}`;
  return msg;
}

function openShareModal(m) {
  const modal = document.getElementById('share-modal');
  const textarea = document.getElementById('share-text');
  textarea.value = buildShareMessage(m);
  modal.classList.remove('hidden');
}

// ── Voice entry + LLM parsing ──────────────────────────────────────────────

const ANTHROPIC_KEY_STORE = 'tennis_anthropic_key';
let recognition = null;
let pendingTranscript = '';
let pendingApiCallback = null;
let lastParsedResult = null;
let lastVoteMsg = '';

function getApiKey() {
  // Firebase first (shared across all devices), localStorage as offline fallback
  return state.apiKey || localStorage.getItem(ANTHROPIC_KEY_STORE) || '';
}

async function saveApiKey(key) {
  const trimmed = key.trim();
  localStorage.setItem(ANTHROPIC_KEY_STORE, trimmed); // offline fallback
  state.apiKey = trimmed;
  await saveState(); // saves to Firebase → syncs to all devices instantly
}

function setupVoiceEntry() {
  const btn = document.getElementById('voice-btn');
  if (!btn) return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    btn.title = 'Voice not supported — use Chrome or Safari';
    btn.style.opacity = '0.4';
    btn.style.cursor = 'not-allowed';
    document.querySelector('.voice-sub').textContent = 'Voice not supported — use Chrome or Safari on mobile';
    return;
  }

  // ── State ──────────────────────────────────────────────
  let isListening   = false;   // user intent — true between tap-start and tap-stop
  let accumulatedTranscript = ''; // all confirmed text across restarts
  let timerInterval = null;
  let startTime     = null;
  let restartTimer  = null;

  function createRecognition() {
    const r = new SpeechRecognition();
    r.continuous      = true;   // don't stop after one sentence
    r.interimResults  = true;
    r.lang            = 'en-US';
    r.maxAlternatives = 1;
    return r;
  }

  function startTimer() {
    startTime = Date.now();
    timerInterval = setInterval(() => {
      if (!isListening) return;
      const elapsed = Math.floor((Date.now() - startTime) / 1000);
      const mins = Math.floor(elapsed / 60).toString().padStart(2,'0');
      const secs = (elapsed % 60).toString().padStart(2,'0');
      const current = accumulatedTranscript.trim();
      showVoiceTranscript(
        `🔴 Recording ${mins}:${secs}  (tap ⏹️ to stop)\n` +
        (current ? `"${current}"` : 'Listening… speak now')
      );
    }, 500);
  }

  function stopTimer() {
    clearInterval(timerInterval);
    timerInterval = null;
  }

  function startListening() {
    isListening = true;
    accumulatedTranscript = '';
    btn.classList.add('listening');
    btn.textContent = '⏹️';
    btn.title = 'Tap to stop recording';
    hideEl('voice-parsed');
    hideEl('voice-error');
    startTimer();
    launchRecognition();
  }

  function stopListening() {
    isListening = false;          // set BEFORE stop() so onend doesn't restart
    clearTimeout(restartTimer);
    stopTimer();
    try { recognition.stop(); } catch(e) {}
    btn.classList.remove('listening');
    btn.textContent = '🎤';
    btn.title = 'Tap to speak';

    // Small delay to let final onresult fire before we read accumulatedTranscript
    setTimeout(() => {
      const final = accumulatedTranscript.trim();
      if (final) {
        pendingTranscript = final;
        showVoiceTranscript(`✅ Recorded: "${final}"\nParsing with Claude…`);
        parseWithLLM(final);
      } else {
        showVoiceTranscript('Nothing captured — tap the mic and speak clearly');
      }
    }, 300);
  }

  function launchRecognition() {
    recognition = createRecognition();

    recognition.onresult = (e) => {
      let interim = '';
      for (let i = e.resultIndex; i < e.results.length; i++) {
        if (e.results[i].isFinal) {
          accumulatedTranscript += e.results[i][0].transcript + ' ';
        } else {
          interim += e.results[i][0].transcript;
        }
      }
      // Update display live with accumulated + interim
      const display = (accumulatedTranscript + interim).trim();
      const elapsed = startTime ? Math.floor((Date.now() - startTime) / 1000) : 0;
      const mins = Math.floor(elapsed / 60).toString().padStart(2,'0');
      const secs = (elapsed % 60).toString().padStart(2,'0');
      showVoiceTranscript(`🔴 Recording ${mins}:${secs}  (tap ⏹️ to stop)\n"${display}"`);
    };

    recognition.onend = () => {
      // Auto-restart if user hasn't tapped stop
      if (isListening) {
        restartTimer = setTimeout(() => {
          if (isListening) {
            try { recognition.start(); }
            catch(e) {
              // If start fails, recreate and try again
              launchRecognition();
            }
          }
        }, 200);
      }
    };

    recognition.onerror = (e) => {
      if (e.error === 'not-allowed') {
        isListening = false;
        stopTimer();
        btn.classList.remove('listening');
        btn.textContent = '🎤';
        showVoiceError('Microphone permission denied — check your browser settings');
        return;
      }
      // For no-speech or aborted — just restart silently if still listening
      if (isListening && (e.error === 'no-speech' || e.error === 'aborted')) {
        restartTimer = setTimeout(() => {
          if (isListening) launchRecognition();
        }, 300);
        return;
      }
      // Any other error — stop and show message
      if (isListening) {
        isListening = false;
        stopTimer();
        btn.classList.remove('listening');
        btn.textContent = '🎤';
        const msgs = { 'network': 'Network error — check your connection', 'audio-capture': 'Could not access microphone' };
        showVoiceError(msgs[e.error] || `Mic error: ${e.error}`);
      }
    };

    try {
      recognition.start();
    } catch(e) {
      showVoiceError('Could not start microphone: ' + e.message);
      isListening = false;
      stopTimer();
      btn.classList.remove('listening');
      btn.textContent = '🎤';
    }
  }

  // ── Button handler ──────────────────────────────────────
  btn.addEventListener('click', () => {
    if (btn.classList.contains('parsing')) return; // ignore while AI is working
    if (isListening) {
      stopListening();
    } else {
      startListening();
    }
  });
}


async function parseWithLLM(transcript) {
  const btn = document.getElementById('voice-btn');
  const key = getApiKey();
  if (!key) {
    pendingApiCallback = () => parseWithLLM(transcript);
    openApiKeyModal();
    return;
  }

  btn.classList.add('parsing');
  btn.textContent = '⏳';
  showVoiceTranscript('Parsing: "' + transcript + '"');

  const playerList = state.players.join(', ');
  const prompt = `You are a tennis match parser. Given a spoken description of a doubles tennis match, extract the structured data.

Players in this group: ${playerList}

Match description: "${transcript}"

Rules:
- Match player names from the description to the closest name in the player list (handle speech-to-text errors, abbreviations, nicknames)
- Extract set scores as arrays of {a, b} where a = Team A games, b = Team B games
- Team A is the team mentioned first or the winners if "beat/def/won" language is used
- If scores are spoken as words convert them: "six three" → 6-3, "seven six" → 7-6
- If only one score is mentioned assume it's one set
- If no scores detected set sets to []
- If player names are ambiguous make your best guess

Respond ONLY with valid JSON, no explanation:
{
  "teamA": ["PlayerName1", "PlayerName2"],
  "teamB": ["PlayerName3", "PlayerName4"],
  "sets": [{"a": 6, "b": 3}],
  "notes": "any extra context mentioned",
  "confidence": "high|medium|low",
  "interpretation": "one sentence describing what you understood"
}`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'x-api-key': key, 'anthropic-version': '2023-06-01', 'anthropic-dangerous-direct-browser-access': 'true' },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) {
      const err = await res.json();
      if (res.status === 401) {
        localStorage.removeItem(ANTHROPIC_KEY_STORE);
        state.apiKey = '';
        saveState();
        showVoiceError('Invalid API key — please re-enter.');
      }
      else showVoiceError('API error: ' + (err.error?.message || res.status));
      return;
    }

    const data = await res.json();
    const raw = data.content[0]?.text || '';
    const cleaned = raw.replace(/```json|```/g, '').trim();
    const parsed = JSON.parse(cleaned);
    showParsedResult(parsed, transcript);

  } catch(e) {
    showVoiceError('Parse failed: ' + e.message + ' — try rephrasing or fill manually.');
  } finally {
    btn.classList.remove('parsing');
    btn.textContent = '🎤';
  }
}

function showParsedResult(parsed, original) {
  const el = document.getElementById('voice-parsed');
  if (!el) return;

  lastParsedResult = parsed; // store safely — no encoding needed

  const confColor = parsed.confidence === 'high' ? 'var(--accent)' : parsed.confidence === 'medium' ? '#EF9F27' : '#D85A30';
  const setsStr = (parsed.sets || []).map(s => `${s.a}-${s.b}`).join(', ') || '—';
  const teamAStr = (parsed.teamA || []).join(' & ') || '—';
  const teamBStr = (parsed.teamB || []).join(' & ') || '—';

  el.innerHTML = `
    <div class="vp-title">Parsed result
      <span style="margin-left:8px;padding:1px 7px;border-radius:4px;font-size:10px;background:${confColor}22;color:${confColor}">${parsed.confidence || '?'} confidence</span>
    </div>
    <div class="vp-row"><span class="vp-label">Team A</span><span class="vp-val">${escapeHtml(teamAStr)}</span></div>
    <div class="vp-row"><span class="vp-label">Team B</span><span class="vp-val">${escapeHtml(teamBStr)}</span></div>
    <div class="vp-row"><span class="vp-label">Sets</span><span class="vp-val">${escapeHtml(setsStr)}</span></div>
    ${parsed.notes ? `<div class="vp-row"><span class="vp-label">Notes</span><span class="vp-val">${escapeHtml(parsed.notes)}</span></div>` : ''}
    <div class="vp-row" style="border-bottom:none"><span class="vp-label" style="font-style:italic;font-size:12px">"${escapeHtml(parsed.interpretation || '')}"</span></div>
    <div class="vp-actions">
      <button class="btn-small" id="apply-parsed-btn">✅ Apply to form</button>
      <button class="btn-small" id="retry-voice-btn">🔄 Try again</button>
    </div>`;

  el.classList.remove('hidden');
  hideEl('voice-error');

  // Scroll the card into view so user sees it
  setTimeout(() => el.scrollIntoView({ behavior: 'smooth', block: 'nearest' }), 50);

  // Wire buttons safely — no inline onclick encoding
  document.getElementById('apply-parsed-btn')?.addEventListener('click', () => applyParsedResult());
  document.getElementById('retry-voice-btn')?.addEventListener('click', () => retryVoice());
}

function applyParsedResult() {
  const parsed = lastParsedResult;
  if (!parsed) { showVoiceError('No parsed result — record a match first.'); return; }
  try {
    const players = state.players;

    // Apply teams — fuzzy match parsed names to actual player names
    const findPlayer = (name) => {
      if (!name) return '';
      const lower = name.toLowerCase();
      return players.find(p => p.toLowerCase() === lower) ||
             players.find(p => p.toLowerCase().startsWith(lower.slice(0,3))) ||
             players.find(p => lower.includes(p.toLowerCase().slice(0,3))) || '';
    };

    const a1 = findPlayer(parsed.teamA?.[0]);
    const a2 = findPlayer(parsed.teamA?.[1]);
    const b1 = findPlayer(parsed.teamB?.[0]);
    const b2 = findPlayer(parsed.teamB?.[1]);

    if (a1) document.getElementById('a1').value = a1;
    if (a2) document.getElementById('a2').value = a2;
    if (b1) document.getElementById('b1').value = b1;
    if (b2) document.getElementById('b2').value = b2;
    updateSittingOut();

    // Apply sets
    if (parsed.sets?.length) {
      const format = Math.max(parsed.sets.length, 1);
      document.getElementById('sets-format').value = format <= 1 ? '1' : format <= 3 ? '3' : '5';
      renderSetsInputs();
      setTimeout(() => {
        parsed.sets.forEach((set, i) => {
          const aInput = document.querySelector(`input[data-set="${i}"][data-field="a"]`);
          const bInput = document.querySelector(`input[data-set="${i}"][data-field="b"]`);
          if (aInput) aInput.value = set.a;
          if (bInput) bInput.value = set.b;
        });
      }, 50);
    }

    // Apply notes
    if (parsed.notes) {
      const notesEl = document.getElementById('match-notes');
      if (notesEl && !notesEl.value) notesEl.value = parsed.notes;
    }

    // Hide parsed result, show success and scroll to form
    hideEl('voice-parsed');
    showVoiceTranscript('✅ Applied! Review the form below and tap Save match.');
    setTimeout(() => {
      document.getElementById('a1')?.closest('.card')?.scrollIntoView({ behavior: 'smooth', block: 'start' });
    }, 100);

  } catch(e) {
    showVoiceError('Could not apply — please fill the form manually.');
  }
}

function retryVoice() {
  hideEl('voice-parsed');
  hideEl('voice-error');
  showVoiceTranscript('Tap the 🎤 mic button to record again');
}

function showVoiceTranscript(text) {
  const el = document.getElementById('voice-transcript');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
}
function showVoiceError(text) {
  const el = document.getElementById('voice-error');
  if (!el) return;
  el.textContent = text;
  el.classList.remove('hidden');
  hideEl('voice-parsed');
}
function hideEl(id) {
  const el = document.getElementById(id);
  if (el) el.classList.add('hidden');
}

function openApiKeyModal() {
  document.getElementById('apikey-input').value = getApiKey();
  document.getElementById('apikey-modal').classList.remove('hidden');
}

function setupApiKeyModal() {
  document.getElementById('apikey-save').addEventListener('click', async () => {
    const key = document.getElementById('apikey-input').value.trim();
    if (!key.startsWith('sk-ant-')) { alert('Key should start with sk-ant-'); return; }
    const btn = document.getElementById('apikey-save');
    btn.textContent = 'Saving…';
    btn.disabled = true;
    await saveApiKey(key);
    btn.textContent = 'Save & parse';
    btn.disabled = false;
    document.getElementById('apikey-modal').classList.add('hidden');
    if (pendingApiCallback) { pendingApiCallback(); pendingApiCallback = null; }
  });
  document.getElementById('apikey-cancel').addEventListener('click', () => {
    document.getElementById('apikey-modal').classList.add('hidden');
    pendingApiCallback = null;
  });
}

// ── Vote WhatsApp share ────────────────────────────────────────────────────

function buildVoteShareMessage(player, vote, dateStr) {
  const votesForDate = state.availability[dateStr] || {};
  const counts = { in: 0, maybe: 0, out: 0 };
  state.players.forEach(p => { const v = votesForDate[p]; if (v) counts[v]++; });
  const dayName = new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long', month: 'short', day: 'numeric' });
  const voteEmoji = vote === 'in' ? '✅' : vote === 'maybe' ? '❓' : '❌';
  const voteLabel = vote === 'in' ? 'IN' : vote === 'maybe' ? 'MAYBE' : 'OUT';
  let msg = `🎾 Weekend Tennis Update\n\n`;
  msg += `${voteEmoji} ${player} voted ${voteLabel} for ${dayName}\n\n`;
  msg += `Current votes:\n`;
  msg += `✅ In: ${counts.in} · ❓ Maybe: ${counts.maybe} · ❌ Out: ${counts.out}\n\n`;
  if (counts.in >= 4) msg += `🏆 Enough for doubles! Come vote 👇\n`;
  else if (counts.in + counts.maybe >= 4) msg += `⏳ Almost there — maybes please confirm!\n`;
  else msg += `Waiting for more votes 👇\n`;
  const weatherVerdict = getWeatherVerdictText(dateStr);
  if (weatherVerdict) msg += `\n🌤️ Weather: ${weatherVerdict}\n`;
  msg += `\n${window.location.href.split('?')[0]}`;
  return msg;
}

function getWeatherVerdictText(dateStr) {
  if (!weatherCache.data) return null;
  try {
    const daily = weatherCache.data.daily;
    const idx = daily.time.indexOf(dateStr);
    if (idx === -1) return null;
    const rain = daily.precipitation_probability_max[idx];
    const wind = Math.round(daily.wind_speed_10m_max[idx]);
    const temp = Math.round(daily.temperature_2m_max[idx]);
    if (rain >= 60) return `${rain}% rain likely — fingers crossed 🤞`;
    if (wind >= 30) return `${wind}km/h wind — tricky conditions`;
    if (rain >= 30) return `${temp}°C, ${rain}% rain chance — should be OK`;
    return `${temp}°C, light wind ${wind}km/h — looks great! ☀️`;
  } catch { return null; }
}

function showVoteShareToast(player, vote, dateStr) {
  // Remove existing toast if any
  const existing = document.getElementById('vote-toast');
  if (existing) existing.remove();

  const msg = buildVoteShareMessage(player, vote, dateStr);
  const toast = document.createElement('div');
  toast.id = 'vote-toast';
  toast.className = 'vote-share-toast';
  const voteLabel = vote === 'in' ? '✅ In' : vote === 'maybe' ? '❓ Maybe' : '❌ Out';
  toast.innerHTML = `
    <div class="toast-text">
      <strong>${escapeHtml(player)} voted ${voteLabel}</strong>
      Share to WhatsApp group?
    </div>
    <button class="toast-btn" id="vote-toast-share-btn">Share</button>
    <button class="toast-close" id="vote-toast-close-btn">✕</button>`;
  document.body.appendChild(toast);

  lastVoteMsg = msg;
  document.getElementById('vote-toast-share-btn')?.addEventListener('click', () => {
    window.open(`https://wa.me/?text=${encodeURIComponent(lastVoteMsg)}`, '_blank');
    document.getElementById('vote-toast')?.remove();
  });
  document.getElementById('vote-toast-close-btn')?.addEventListener('click', () => {
    document.getElementById('vote-toast')?.remove();
  });

  // Auto-dismiss after 8 seconds
  setTimeout(() => { document.getElementById('vote-toast')?.remove(); }, 8000);
}

function shareVoteToWhatsApp(encodedMsg) {
  const msg = decodeURIComponent(encodedMsg);
  window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
  document.getElementById('vote-toast')?.remove();
}

function setupShareModal() {
  const modal = document.getElementById('share-modal');
  document.getElementById('share-whatsapp').addEventListener('click', () => {
    const text = document.getElementById('share-text').value;
    window.open(`https://wa.me/?text=${encodeURIComponent(text)}`, '_blank');
    modal.classList.add('hidden');
  });
  document.getElementById('share-copy').addEventListener('click', async () => {
    const text = document.getElementById('share-text').value;
    try {
      await navigator.clipboard.writeText(text);
      alert('Copied to clipboard!');
    } catch {
      alert('Could not copy — please select and copy manually.');
    }
  });
  document.getElementById('share-dismiss').addEventListener('click', () => {
    modal.classList.add('hidden');
  });
}

function formatDate(d) {
  const dt = new Date(d + 'T00:00:00');
  return dt.toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric', year: 'numeric' });
}

// Known locations — avoids geocoding failures for common inputs
const KNOWN_LOCATIONS = {
  'edison': { lat: 40.5187, lon: -74.4121, label: 'Edison, New Jersey' },
  'edison nj': { lat: 40.5187, lon: -74.4121, label: 'Edison, New Jersey' },
  'edison, nj': { lat: 40.5187, lon: -74.4121, label: 'Edison, New Jersey' },
  'edison, new jersey': { lat: 40.5187, lon: -74.4121, label: 'Edison, New Jersey' },
  'new york': { lat: 40.7128, lon: -74.0060, label: 'New York, NY' },
};

async function geocodeLocation(name) {
  // Check known locations first (case-insensitive)
  const key = name.toLowerCase().trim();
  if (KNOWN_LOCATIONS[key]) return KNOWN_LOCATIONS[key];

  // Try Open-Meteo geocoding — use just the city name for better results
  const cityName = name.split(',')[0].trim(); // "Edison, NJ" → "Edison"
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(cityName)}&count=5&language=en&format=json`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (!data.results || data.results.length === 0) throw new Error('Location not found');
    // Pick result in US if multiple
    const us = data.results.find(r => r.country_code === 'US') || data.results[0];
    return { lat: us.latitude, lon: us.longitude, label: `${us.name}${us.admin1 ? ', ' + us.admin1 : ''}` };
  } catch(e) {
    throw new Error(`Could not find "${name}". Try just the city name like "Edison" or "Newark".`);
  }
}

async function fetchWeather(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,uv_index_max,sunrise,sunset',
    hourly: 'temperature_2m,precipitation_probability,wind_speed_10m,weather_code,uv_index',
    temperature_unit: 'celsius',
    wind_speed_unit: 'kmh',
    precipitation_unit: 'mm',
    timezone: 'auto',
    forecast_days: 7
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error('Weather fetch failed');
  return res.json();
}

const MORNING_START = 6;
const MORNING_END = 12;

function getMorningHours(data, dateStr) {
  const times = data.hourly.time;
  const hours = [];
  for (let i = 0; i < times.length; i++) {
    const tDate = times[i].slice(0, 10);
    // Parse hour directly from string "2026-05-14T06:00" — avoids timezone issues
    const hour = parseInt(times[i].slice(11, 13), 10);
    if (tDate === dateStr && hour >= MORNING_START && hour <= MORNING_END) {
      hours.push({
        hour,
        label: hour === 12 ? '12 PM' : `${hour} AM`,
        temp: Math.round(data.hourly.temperature_2m[i]),
        rain: data.hourly.precipitation_probability[i] ?? 0,
        wind: Math.round(data.hourly.wind_speed_10m[i] ?? 0),
        code: data.hourly.weather_code[i] ?? 0,
        uv:   Math.round((data.hourly.uv_index?.[i] ?? 0) * 10) / 10
      });
    }
  }
  return hours;
}


// ── UV Index helpers ───────────────────────────────────────────────────────
function uvLevel(uv) {
  if (uv >= 11) return { level: 'Extreme',   color: '#7B2FBE', bg: 'rgba(123,47,190,0.12)', text: 'Extreme UV — avoid outdoor play',       emoji: '🟣', rank: 'extreme' };
  if (uv >= 8)  return { level: 'Very High', color: '#D85A30', bg: 'rgba(216,90,48,0.12)',  text: 'Very high UV — SPF 50+, seek shade',     emoji: '🔴', rank: 'veryhigh' };
  if (uv >= 6)  return { level: 'High',      color: '#EF9F27', bg: 'rgba(239,159,39,0.12)', text: 'High UV — wear sunscreen and hat',         emoji: '🟠', rank: 'high' };
  if (uv >= 3)  return { level: 'Moderate',  color: '#F5C842', bg: 'rgba(245,200,66,0.12)', text: 'Moderate UV — sunscreen recommended',      emoji: '🟡', rank: 'moderate' };
  return         { level: 'Low',             color: '#1D9E75', bg: 'rgba(29,158,117,0.12)', text: 'Low UV — safe to play without sunscreen',  emoji: '🟢', rank: 'low' };
}
function uvDotColor(uv) {
  if (uv >= 11) return '#7B2FBE';
  if (uv >= 8)  return '#D85A30';
  if (uv >= 6)  return '#EF9F27';
  if (uv >= 3)  return '#F5C842';
  return '#1D9E75';
}
function renderUVCard(hours, dailyUvMax) {
  const peakUV = hours.length ? Math.max(...hours.map(h => h.uv || 0)) : (dailyUvMax || 0);
  const peakHour = hours.length ? hours.reduce((b,h)=>(h.uv||0)>(b.uv||0)?h:b, hours[0]) : null;
  const info = uvLevel(peakUV);
  const pct = Math.min(100, peakUV / 12 * 100).toFixed(0);
  return '<div class="uv-card uv-' + info.rank + '"><div class="uv-left"><div class="uv-emoji">' + info.emoji + '</div><div><div class="uv-label">UV Index 6 AM-12 PM</div><div class="uv-title">' + info.level + ' <span class="uv-num">' + peakUV.toFixed(1) + '</span>' + (peakHour ? ' <span class="uv-peak-time">peaks ' + peakHour.label + '</span>' : '') + '</div><div class="uv-advice">' + info.text + '</div></div></div><div class="uv-bar-wrap"><div class="uv-track"><div class="uv-fill" style="width:' + pct + '%;background:' + info.color + '"></div></div><div class="uv-zones"><span style="color:#1D9E75">Low 0</span><span style="color:#F5C842">Mod 3</span><span style="color:#EF9F27">High 6</span><span style="color:#D85A30">8+</span><span style="color:#7B2FBE">11+</span></div></div></div>';
}
function morningPlayability(hours) {
  if (!hours || hours.length === 0) return null;
  const peakRain = Math.max(...hours.map(h => h.rain));
  const peakWind = Math.max(...hours.map(h => h.wind));
  const tempMin = Math.min(...hours.map(h => h.temp));
  const tempMax = Math.max(...hours.map(h => h.temp));
  const hasBadCode = hours.some(h => h.code >= 95 || (h.code >= 71 && h.code <= 77));
  const dominantCode = hours[Math.floor(hours.length / 2)]?.code ?? 0;

  if (peakRain >= 60 || hasBadCode) return { rank: 'bad', reason: hasBadCode ? 'Thunderstorms or snow expected' : 'High rain chance morning' };
  if (peakWind >= 30) return { rank: 'bad', reason: `Very windy (${peakWind} km/h)` };
  if (tempMax >= 35) return { rank: 'bad', reason: `Too hot (${tempMax}°C)` };
  if (tempMax <= 5) return { rank: 'bad', reason: `Too cold (${tempMax}°C)` };
  if (peakRain >= 30) return { rank: 'ok', reason: `${peakRain}% rain chance — check radar first` };
  if (peakWind >= 20) return { rank: 'ok', reason: `Breezy (${peakWind} km/h) — balls may drift` };
  if (tempMax >= 32) return { rank: 'ok', reason: `Warm (${tempMax}°C) — bring extra water` };
  if (tempMax <= 12) return { rank: 'ok', reason: `Cool (${tempMin}–${tempMax}°C) — layer up` };
  return { rank: 'great', reason: `${weatherLabel(dominantCode)}, ${tempMin}–${tempMax}°C, light wind` };
}

function findBestWindow(hours) {
  if (!hours || hours.length < 3) return null;
  let bestScore = Infinity, bestIdx = 0;
  // Scan every 3-consecutive-hour window, pick lowest combined rain + wind
  for (let i = 0; i <= hours.length - 3; i++) {
    const score = hours[i].rain   + hours[i+1].rain   + hours[i+2].rain
                + hours[i].wind   + hours[i+1].wind   + hours[i+2].wind;
    if (score < bestScore) { bestScore = score; bestIdx = i; }
  }
  const a = hours[bestIdx], b = hours[bestIdx + 1], c = hours[bestIdx + 2];
  return {
    startLabel: a.label,
    endLabel:   c.label,
    midLabel:   b.label,
    temp: Math.round((a.temp + b.temp + c.temp) / 3),
    rain: Math.max(a.rain, b.rain, c.rain),
    wind: Math.max(a.wind, b.wind, c.wind),
    code: b.code  // middle hour is most representative
  };
}

function weatherIcon(code) {
  if (code === 0) return '☀️';
  if (code <= 2) return '🌤️';
  if (code === 3) return '☁️';
  if (code >= 45 && code <= 48) return '🌫️';
  if (code >= 51 && code <= 67) return '🌧️';
  if (code >= 71 && code <= 77) return '❄️';
  if (code >= 80 && code <= 82) return '🌦️';
  if (code >= 95) return '⛈️';
  return '🌤️';
}

function weatherLabel(code) {
  if (code === 0) return 'Clear';
  if (code <= 2) return 'Partly cloudy';
  if (code === 3) return 'Overcast';
  if (code >= 45 && code <= 48) return 'Fog';
  if (code >= 51 && code <= 57) return 'Drizzle';
  if (code >= 61 && code <= 67) return 'Rain';
  if (code >= 71 && code <= 77) return 'Snow';
  if (code >= 80 && code <= 82) return 'Showers';
  if (code >= 95) return 'Thunderstorm';
  return 'Mixed';
}

function playabilityScore(day) {
  const rain = day.precipitation_probability_max ?? 0;
  const wind = day.wind_speed_10m_max ?? 0;
  const tempMax = day.temperature_2m_max ?? 20;
  const tempMin = day.temperature_2m_min ?? 15;
  const code = day.weather_code ?? 0;

  if (rain >= 60 || code >= 95 || (code >= 71 && code <= 77)) return { rank: 'bad', reason: rain >= 60 ? 'High chance of rain' : code >= 95 ? 'Thunderstorms expected' : 'Snow expected' };
  if (wind >= 30) return { rank: 'bad', reason: `Very windy (${Math.round(wind)} km/h)` };
  if (tempMax >= 35) return { rank: 'bad', reason: `Too hot (${Math.round(tempMax)}°C)` };
  if (tempMax <= 5) return { rank: 'bad', reason: `Too cold (${Math.round(tempMax)}°C)` };
  if (rain >= 30) return { rank: 'ok', reason: `${rain}% rain chance — check radar` };
  if (wind >= 20) return { rank: 'ok', reason: `Breezy (${Math.round(wind)} km/h) — balls may drift` };
  if (tempMax >= 32) return { rank: 'ok', reason: `Warm (${Math.round(tempMax)}°C) — bring extra water` };
  if (tempMax <= 12) return { rank: 'ok', reason: `Cool (${Math.round(tempMin)}–${Math.round(tempMax)}°C) — layer up` };
  return { rank: 'great', reason: `${weatherLabel(code)}, ${Math.round(tempMax)}°C, light wind — perfect for tennis` };
}

async function loadWeather() {
  const forecastEl = document.getElementById('weather-forecast');
  const adviceEl   = document.getElementById('weather-play-advice');
  const inputEl    = document.getElementById('location-name');

  // Always show current location name
  const locName = state.location?.name || 'Edison, New Jersey';
  if (!inputEl.dataset.userEdited) inputEl.value = locName;

  const cacheValid = weatherCache.data
    && weatherCache.location === locName
    && (Date.now() - weatherCache.fetchedAt) < 30 * 60 * 1000;

  if (!cacheValid) {
    forecastEl.innerHTML = '<div class="weather-loading">Loading forecast…</div>';
    adviceEl.innerHTML = '';
    try {
      // Use stored coords if available, otherwise geocode
      let geo = state.location?.lat
        ? { lat: state.location.lat, lon: state.location.lon }
        : await geocodeLocation(locName);
      const weather = await fetchWeather(geo.lat, geo.lon);
      weatherCache = { data: weather, fetchedAt: Date.now(), location: locName, geo };
    } catch(e) {
      forecastEl.innerHTML = `<div class="error">${escapeHtml(e.message)}</div>`;
      return;
    }
  }

  renderWeather();
}

function renderWeather() {
  const data = weatherCache.data;
  if (!data) return;
  const daily = data.daily;
  const forecastEl = document.getElementById('weather-forecast');
  const adviceEl = document.getElementById('weather-play-advice');

  const nextWeekend = findNextWeekendIdx(daily.time);
  if (nextWeekend !== -1) {
    const dateStr = daily.time[nextWeekend];
    const morningHours = getMorningHours(data, dateStr);
    const verdict = morningHours.length ? morningPlayability(morningHours) : playabilityScore({
      weather_code: daily.weather_code[nextWeekend],
      temperature_2m_max: daily.temperature_2m_max[nextWeekend],
      temperature_2m_min: daily.temperature_2m_min[nextWeekend],
      precipitation_probability_max: daily.precipitation_probability_max[nextWeekend],
      wind_speed_10m_max: daily.wind_speed_10m_max[nextWeekend]
    });
    const dayName = new Date(dateStr + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long' });
    adviceEl.innerHTML = `
      <div class="play-advice ${verdict.rank}">
        <div class="verdict-icon">${verdict.rank === 'great' ? '🎾' : verdict.rank === 'ok' ? '⚠️' : '🚫'}</div>
        <div>
          <div class="verdict-label">${dayName} morning · 6 AM – 12 PM</div>
          <div class="verdict-text">${verdict.reason}</div>
        </div>
      </div>
      ${renderUVCard(morningHours, daily.uv_index_max?.[nextWeekend] ?? 0)}`;
  } else {
    adviceEl.innerHTML = '';
  }

  let html = '<div class="forecast-grid">';
  for (let i = 0; i < daily.time.length; i++) {
    const dateStr = daily.time[i];
    const morningHours = getMorningHours(data, dateStr);
    let verdict;
    if (morningHours.length) {
      verdict = morningPlayability(morningHours);
    } else {
      verdict = playabilityScore({
        weather_code: daily.weather_code[i],
        temperature_2m_max: daily.temperature_2m_max[i],
        temperature_2m_min: daily.temperature_2m_min[i],
        precipitation_probability_max: daily.precipitation_probability_max[i],
        wind_speed_10m_max: daily.wind_speed_10m_max[i]
      });
    }
    const tempMax = morningHours.length ? Math.max(...morningHours.map(h => h.temp)) : Math.round(daily.temperature_2m_max[i]);
    const tempMin = morningHours.length ? Math.min(...morningHours.map(h => h.temp)) : Math.round(daily.temperature_2m_min[i]);
    const peakRain = morningHours.length ? Math.max(...morningHours.map(h => h.rain)) : daily.precipitation_probability_max[i];
    const peakWind = morningHours.length ? Math.max(...morningHours.map(h => h.wind)) : Math.round(daily.wind_speed_10m_max[i]);
    const code = morningHours.length ? (morningHours[Math.floor(morningHours.length / 2)]?.code ?? daily.weather_code[i]) : daily.weather_code[i];
    const d = new Date(dateStr + 'T00:00:00');
    const dayName = i === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' });
    html += `
      <div class="forecast-day play-${verdict.rank}">
        <div class="day-name">${dayName}</div>
        <div class="day-icon">${weatherIcon(code)}</div>
        <div class="day-temp">${tempMax}°C</div>
        <div class="day-low">${tempMin}°C</div>
        <div class="day-rain">💧 ${peakRain}%</div>
        <div class="day-wind">💨 ${peakWind}km/h</div>
      </div>`;
  }
  html += '</div>';
  forecastEl.innerHTML = html;

  renderMorningChart(data);
}

function findNextWeekendIdx(dates) {
  for (let i = 0; i < dates.length; i++) {
    const d = new Date(dates[i] + 'T00:00:00');
    if (d.getDay() === 0 || d.getDay() === 6) return i;
  }
  return -1;
}

function renderMorningChart(data) {
  const canvas = document.getElementById('weatherChart');

  const today = new Date();
  const todayStr = today.toISOString().slice(0, 10);
  const tomorrowStr = new Date(today.getTime() + 86400000).toISOString().slice(0, 10);
  const targetDate = getMorningHours(data, todayStr).length >= 3 ? todayStr : tomorrowStr;
  const hours = getMorningHours(data, targetDate);

  if (weatherChart) weatherChart.destroy();
  if (hours.length === 0) {
    blankChart(canvas, 'Morning hourly data unavailable');
    return;
  }

  const labels = hours.map(h => h.label);
  const temps = hours.map(h => h.temp);
  const rain = hours.map(h => h.rain);
  const wind = hours.map(h => h.wind);

  weatherChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Temp (°C)', data: temps, borderColor: '#D85A30', backgroundColor: '#D85A30', yAxisID: 'y', tension: 0.3, pointRadius: 3 },
        { label: 'Rain %', data: rain, borderColor: '#378ADD', backgroundColor: '#378ADD', yAxisID: 'y1', tension: 0.3, pointRadius: 3, borderDash: [4, 2] },
        { label: 'Wind (km/h)', data: wind, borderColor: '#7F77DD', backgroundColor: '#7F77DD', yAxisID: 'y1', tension: 0.3, pointRadius: 3, borderDash: [2, 3] }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { position: 'left', title: { display: true, text: '°C' } },
        y1: { position: 'right', title: { display: true, text: '% / km/h' }, grid: { drawOnChartArea: false }, min: 0 }
      },
      plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 12 } } } }
    }
  });
}


async function saveLocation() {
  const name = document.getElementById('location-name').value.trim();
  if (!name) return;
  try {
    const geo = await geocodeLocation(name);
    state.location = { name: geo.label, lat: geo.lat, lon: geo.lon };
    weatherCache = { data: null, fetchedAt: 0, location: null };
    document.getElementById('location-name').dataset.userEdited = '';
    await saveState();
    loadWeather();
  } catch(e) {
    alert(e.message);
  }
}



function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

let coordinatorDate = null;

function getUpcomingWeekendDates() {
  const today = new Date();
  today.setHours(0, 0, 0, 0);
  const dates = [];
  for (let i = 0; i < 14; i++) {
    const d = new Date(today);
    d.setDate(today.getDate() + i);
    const dow = d.getDay();
    if (dow === 0 || dow === 6) {
      dates.push(d.toISOString().slice(0, 10));
      if (dates.length === 2) break;
    }
  }
  return dates;
}

async function renderWeekendCoordinator() {
  const box = document.getElementById('weekend-coordinator');
  if (!box) return;
  const dates = getUpcomingWeekendDates();
  if (dates.length === 0) { box.innerHTML = ''; return; }
  if (!coordinatorDate || !dates.includes(coordinatorDate)) coordinatorDate = dates[0];

  try {
    if (!weatherCache.data || (Date.now() - weatherCache.fetchedAt) > 30 * 60 * 1000) {
      const locationName = (state.location?.name || 'Edison, NJ').trim();
      const geo = state.location?.lat ? state.location : await geocodeLocation(locationName);
      const weather = await fetchWeather(geo.lat, geo.lon);
      weatherCache = { data: weather, fetchedAt: Date.now(), location: locationName, geo };
    }
  } catch (e) { console.warn('Weather unavailable:', e); }

  let weatherColHtml = '';
  let verdict = null;
  if (weatherCache.data) {
    const daily = weatherCache.data.daily;
    const idx = daily.time.indexOf(coordinatorDate);
    if (idx !== -1) {
      const morningHours = getMorningHours(weatherCache.data, coordinatorDate);
      verdict = morningHours.length ? morningPlayability(morningHours) : playabilityScore({
        weather_code: daily.weather_code[idx],
        temperature_2m_max: daily.temperature_2m_max[idx],
        temperature_2m_min: daily.temperature_2m_min[idx],
        precipitation_probability_max: daily.precipitation_probability_max[idx],
        wind_speed_10m_max: daily.wind_speed_10m_max[idx]
      });

      const tempMin = morningHours.length ? Math.min(...morningHours.map(h => h.temp)) : Math.round(daily.temperature_2m_min[idx]);
      const tempMax = morningHours.length ? Math.max(...morningHours.map(h => h.temp)) : Math.round(daily.temperature_2m_max[idx]);
      const peakRain = morningHours.length ? Math.max(...morningHours.map(h => h.rain)) : daily.precipitation_probability_max[idx];
      const peakWind = morningHours.length ? Math.max(...morningHours.map(h => h.wind)) : Math.round(daily.wind_speed_10m_max[idx]);
      const code = morningHours.length ? (morningHours[Math.floor(morningHours.length / 2)]?.code ?? daily.weather_code[idx]) : daily.weather_code[idx];
      const bestWin = findBestWindow(morningHours);
      const sunrise = daily.sunrise ? daily.sunrise[idx]?.slice(11, 16) : null;

      const bestWindowHtml = bestWin ? `
        <div class="wc-best-window">
          <span style="font-size:14px">🌟</span>
          <div>
            <div style="font-size:12px;font-weight:600">Best: ${bestWin.startLabel} – ${bestWin.endLabel}</div>
            <div style="font-size:11px;color:var(--text-muted)">${bestWin.temp}°C · 💧${bestWin.rain}% · 💨${bestWin.wind}km/h</div>
          </div>
        </div>` : '';

      const hourlyGridHtml = morningHours.length ? `
        <div class="wc-hour-grid">
          ${morningHours.map(h => {
            const isBest = bestWin && (h.label === bestWin.startLabel || h.label === bestWin.midLabel || h.label === bestWin.endLabel);
            const isWarn = !isBest && (h.rain >= 30 || h.wind >= 20);
            const cls = isBest ? 'wc-hour-cell best' : isWarn ? 'wc-hour-cell warn' : 'wc-hour-cell';
            return `
              <div class="${cls}">
                <div class="wc-h-time">${h.label}</div>
                <div class="wc-h-icon">${weatherIcon(h.code)}</div>
                <div class="wc-h-temp">${h.temp}°C</div>
                <div class="wc-h-rain">💧${h.rain}%</div>
                <div class="wc-h-wind">💨${h.wind}</div>
                ${h.uv != null ? `<div class="wc-h-uv" style="color:${uvDotColor(h.uv)}">UV ${h.uv.toFixed(0)}</div>` : ''}
                ${isBest ? '<div class="wc-best-badge">Best</div>' : ''}
              </div>`;
          }).join('')}
        </div>` : '';

      weatherColHtml = `
        <div class="wc-right">
          <div class="wc-weather-card">
            <div class="wc-weather-top">
              <div class="wc-weather-icon">${weatherIcon(code)}</div>
              <div class="wc-weather-main">
                <div class="wc-weather-temp">${tempMin}° – ${tempMax}°C</div>
                <div class="wc-weather-desc">6 AM – 12 PM · ${weatherLabel(code)}</div>
              </div>
            </div>
            <div class="wc-weather-stats">
              <div class="wc-stat">
                <div class="wc-stat-label">Peak rain</div>
                <div class="wc-stat-value">💧 ${peakRain}%</div>
              </div>
              <div class="wc-stat">
                <div class="wc-stat-label">Peak wind</div>
                <div class="wc-stat-value">💨 ${peakWind} km/h</div>
              </div>
              ${sunrise ? `
              <div class="wc-stat">
                <div class="wc-stat-label">Sunrise</div>
                <div class="wc-stat-value">🌅 ${sunrise}</div>
              </div>` : ''}
            </div>
          </div>
          ${bestWindowHtml}
          ${hourlyGridHtml}
          <div class="wc-verdict ${verdict.rank}">
            ${verdict.rank === 'great' ? '🎾 Great morning to play' : verdict.rank === 'ok' ? '⚠️ ' + verdict.reason : '🚫 ' + verdict.reason}
          </div>
        </div>`;
    }
  }
  if (!weatherColHtml) {
    weatherColHtml = `<div class="wc-right"><div class="wc-no-weather">Open Weather tab once to load morning forecast</div></div>`;
  }

  const toggleHtml = dates.length > 1 ? `
    <div class="wc-toggle-date">
      ${dates.map(d => `
        <button data-date="${d}" class="${d === coordinatorDate ? 'active' : ''}">
          ${new Date(d + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'short', month: 'short', day: 'numeric' })}
        </button>`).join('')}
    </div>` : '';

  const votesForDate = state.availability[coordinatorDate] || {};
  const voteCounts = { in: 0, maybe: 0, out: 0 };
  state.players.forEach(p => { const v = votesForDate[p]; if (v) voteCounts[v]++; });

  const playerVotesHtml = state.players.map(p => {
    const vote = votesForDate[p] || null;
    const rowClass = vote ? `voted-${vote}` : '';
    const statusLabel = vote === 'in' ? '<span class="wc-vote-status status-in">✅ In</span>'
      : vote === 'maybe' ? '<span class="wc-vote-status status-maybe">❓ Maybe</span>'
      : vote === 'out' ? '<span class="wc-vote-status status-out">❌ Out</span>'
      : '<span class="wc-vote-status">Not voted</span>';
    const btnIn    = `<button class="vote-btn ${vote === 'in' ? 'selected-in' : vote ? 'not-selected' : ''}" data-player="${escapeHtml(p)}" data-vote="in">✅</button>`;
    const btnMaybe = `<button class="vote-btn ${vote === 'maybe' ? 'selected-maybe' : vote ? 'not-selected' : ''}" data-player="${escapeHtml(p)}" data-vote="maybe">❓</button>`;
    const btnOut   = `<button class="vote-btn ${vote === 'out' ? 'selected-out' : vote ? 'not-selected' : ''}" data-player="${escapeHtml(p)}" data-vote="out">❌</button>`;
    return `
      <div class="wc-player-vote ${rowClass}">
        <div class="wc-player-info">
          <div class="wc-player-name">${escapeHtml(p)}</div>
          ${statusLabel}
        </div>
        <div class="wc-vote-buttons">${btnIn}${btnMaybe}${btnOut}</div>
      </div>`;
  }).join('');

  const totalVoted = voteCounts.in + voteCounts.maybe + voteCounts.out;
  const goBadgeClass = voteCounts.in >= 4 ? 'go' : voteCounts.in + voteCounts.maybe >= 4 ? 'close' : 'wait';
  const goBadgeText = voteCounts.in >= 4 ? '🎾 Doubles confirmed!'
    : voteCounts.in === 3 ? '👀 1 more needed'
    : voteCounts.in + voteCounts.maybe >= 4 ? '⏳ Waiting on maybes'
    : totalVoted === 0 ? 'No votes yet' : `${5 - totalVoted} yet to vote`;

  box.className = 'weekend-coordinator';
  box.innerHTML = `
    ${toggleHtml}
    <div class="wc-body">
      <div class="wc-left">
        <div class="wc-votes">${playerVotesHtml}</div>
        <div class="wc-summary">
          <span>✅ <strong>${voteCounts.in}</strong></span>
          <span>❓ <strong>${voteCounts.maybe}</strong></span>
          <span>❌ <strong>${voteCounts.out}</strong></span>
          <span class="wc-go-badge ${goBadgeClass}">${goBadgeText}</span>
        </div>
      </div>
      ${weatherColHtml}
    </div>`;

  box.querySelectorAll('.wc-toggle-date button').forEach(btn => {
    btn.addEventListener('click', () => { coordinatorDate = btn.dataset.date; renderWeekendCoordinator(); });
  });
  box.querySelectorAll('.vote-btn:not(.not-selected)').forEach(btn => {
    btn.addEventListener('click', () => recordVote(btn.dataset.player, btn.dataset.vote));
  });
}

function recordVote(player, vote) {
  if (!state.availability) state.availability = {};
  if (!state.availability[coordinatorDate]) state.availability[coordinatorDate] = {};
  const current = state.availability[coordinatorDate][player];
  if (current === vote) {
    delete state.availability[coordinatorDate][player];
  } else {
    state.availability[coordinatorDate][player] = vote;
    showVoteShareToast(player, vote, coordinatorDate);
  }
  saveState();
}

async function compressImage(file, maxDimension = 1600, quality = 0.82) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onerror = () => reject(new Error('Could not read file'));
    reader.onload = (e) => {
      const img = new Image();
      img.onerror = () => reject(new Error('Could not load image'));
      img.onload = () => {
        let { width, height } = img;
        if (width > maxDimension || height > maxDimension) {
          if (width > height) {
            height = Math.round(height * (maxDimension / width));
            width = maxDimension;
          } else {
            width = Math.round(width * (maxDimension / height));
            height = maxDimension;
          }
        }
        const canvas = document.createElement('canvas');
        canvas.width = width;
        canvas.height = height;
        const ctx = canvas.getContext('2d');
        ctx.drawImage(img, 0, 0, width, height);
        canvas.toBlob(blob => {
          if (!blob) return reject(new Error('Compression failed'));
          resolve(blob);
        }, 'image/jpeg', quality);
      };
      img.src = e.target.result;
    };
    reader.readAsDataURL(file);
  });
}

let pendingPhotoFile = null;

function setupPhotoTab() {
  const fileInput = document.getElementById('photo-file');
  const preview = document.getElementById('photo-preview');
  const errorEl = document.getElementById('photo-error');

  fileInput.addEventListener('change', async (e) => {
    errorEl.classList.add('hidden');
    const file = e.target.files[0];
    if (!file) return;
    if (!file.type.startsWith('image/')) {
      errorEl.textContent = 'Please pick an image file.';
      errorEl.classList.remove('hidden');
      return;
    }
    try {
      const compressed = await compressImage(file);
      pendingPhotoFile = compressed;
      const url = URL.createObjectURL(compressed);
      const origKB = Math.round(file.size / 1024);
      const newKB = Math.round(compressed.size / 1024);
      preview.innerHTML = `
        <img src="${url}">
        <div class="preview-info">Compressed ${origKB}KB → ${newKB}KB</div>`;
      preview.classList.remove('hidden');
    } catch (err) {
      errorEl.textContent = 'Could not process image: ' + err.message;
      errorEl.classList.remove('hidden');
    }
  });

  document.getElementById('photo-upload-btn').addEventListener('click', uploadPhoto);
}

async function uploadPhoto() {
  const errorEl = document.getElementById('photo-error');
  errorEl.classList.add('hidden');
  if (!pendingPhotoFile) {
    errorEl.textContent = 'Pick a photo first.';
    errorEl.classList.remove('hidden');
    return;
  }
  const uploader = document.getElementById('photo-uploader').value;
  if (!uploader) {
    errorEl.textContent = 'Who uploaded this?';
    errorEl.classList.remove('hidden');
    return;
  }

  const btn = document.getElementById('photo-upload-btn');
  const originalText = btn.textContent;
  btn.textContent = 'Uploading...';
  btn.disabled = true;
  setStatus('Uploading photo…', '');

  try {
    const photoId = 'photo_' + Date.now() + '_' + Math.random().toString(36).slice(2, 7);
    const path = `photos/${photoId}.jpg`;
    const sref = storageRef(storage, path);
    await uploadBytes(sref, pendingPhotoFile, { contentType: 'image/jpeg' });
    const url = await getDownloadURL(sref);

    if (!state.photos) state.photos = [];
    state.photos.push({
      id: photoId,
      path: path,
      url: url,
      uploader: uploader,
      date: new Date().toISOString().slice(0, 10),
      createdAt: Date.now()
    });
    await saveState();

    pendingPhotoFile = null;
    document.getElementById('photo-file').value = '';
    document.getElementById('photo-preview').classList.add('hidden');
    document.getElementById('photo-preview').innerHTML = '';
    setStatus('Synced', 'online');
    renderPhotos();
  } catch (err) {
    console.error('Upload failed:', err);
    errorEl.textContent = 'Upload failed: ' + (err.message || 'check Storage rules');
    errorEl.classList.remove('hidden');
    setStatus('Upload failed', 'offline');
  } finally {
    btn.textContent = originalText;
    btn.disabled = false;
  }
}

function renderPhotosPanel() {
  const sel = document.getElementById('photo-uploader');
  if (!sel) return;
  const prev = sel.value;
  sel.innerHTML = '<option value="">— Who uploaded? —</option>' +
    state.players.map(p => `<option value="${escapeHtml(p)}">${escapeHtml(p)}</option>`).join('');
  if (prev) sel.value = prev;
  renderPhotos();
}

function renderPhotos() {
  const list = document.getElementById('photo-timeline');
  if (!list) return;
  const photos = [...(state.photos || [])].sort((a, b) => b.createdAt - a.createdAt);
  if (photos.length === 0) {
    list.innerHTML = `<div class="hint" style="text-align:center; padding:2rem;">No photos yet. First one sets the tradition!</div>`;
    return;
  }
  list.innerHTML = photos.map(p => `
    <div class="photo-item">
      <img src="${p.url}" data-fullsize="${p.url}" loading="lazy">
      <div class="photo-meta">
        <div class="photo-info">
          <div>📸 ${escapeHtml(p.uploader)}</div>
          <div class="photo-date">${formatDate(p.date)}</div>
        </div>
        <button class="btn-small" data-delete-photo="${p.id}">Delete</button>
      </div>
    </div>`).join('');
  list.querySelectorAll('img[data-fullsize]').forEach(img => {
    img.addEventListener('click', () => openLightbox(img.dataset.fullsize));
  });
  list.querySelectorAll('[data-delete-photo]').forEach(btn => {
    btn.addEventListener('click', () => deletePhoto(btn.dataset.deletePhoto));
  });
}

function openLightbox(url) {
  const box = document.createElement('div');
  box.className = 'photo-lightbox';
  box.innerHTML = `<img src="${url}">`;
  box.addEventListener('click', () => box.remove());
  document.body.appendChild(box);
}

async function deletePhoto(id) {
  if (!confirm('Delete this photo?')) return;
  const photo = state.photos.find(p => p.id === id);
  if (!photo) return;
  try {
    if (photo.path) {
      await deleteObject(storageRef(storage, photo.path));
    }
  } catch (e) {
    console.warn('Storage delete failed (maybe already gone):', e);
  }
  state.photos = state.photos.filter(p => p.id !== id);
  await saveState();
}

// ── AI Ticker ──────────────────────────────────────────────────────────────

function buildTickerContext() {
  const today = new Date().toISOString().slice(0, 10);
  const allMatches = sortedMatches(); // all matches regardless of filter
  const todayMatches = allMatches.filter(m => m.date === today);

  // Compute ELO and stats directly from all matches
  const eloData = computeElo();
  const playerStats = {};
  state.players.forEach(p => {
    playerStats[p] = { wins: 0, losses: 0, matches: 0 };
  });
  allMatches.forEach(m => {
    const aWin = m.winner === 'A';
    m.teamA.forEach(p => {
      if (!playerStats[p]) return;
      playerStats[p].matches++;
      aWin ? playerStats[p].wins++ : playerStats[p].losses++;
    });
    m.teamB.forEach(p => {
      if (!playerStats[p]) return;
      playerStats[p].matches++;
      aWin ? playerStats[p].losses++ : playerStats[p].wins++;
    });
  });

  // Today's star
  const todayStats = {};
  state.players.forEach(p => { todayStats[p] = { w: 0, l: 0 }; });
  todayMatches.forEach(m => {
    const aWin = m.winner === 'A';
    m.teamA.forEach(p => { if (todayStats[p]) aWin ? todayStats[p].w++ : todayStats[p].l++; });
    m.teamB.forEach(p => { if (todayStats[p]) aWin ? todayStats[p].l++ : todayStats[p].w++; });
  });
  const todayStar = state.players
    .filter(p => todayStats[p].w > 0)
    .sort((a, b) => todayStats[b].w - todayStats[a].w)[0] || null;

  const eloLeader = [...state.players]
    .sort((a, b) => (eloData.current[b] || 1200) - (eloData.current[a] || 1200))[0];

  const mostLosses = [...state.players]
    .filter(p => playerStats[p].matches > 0)
    .sort((a, b) => playerStats[b].losses - playerStats[a].losses)[0];

  const biggestUpset = allMatches.reduce((best, m) => {
    const teamAvg = (team) => team.reduce((s, p) => s + (eloData.current[p] || 1200), 0) / team.length;
    const eloA = teamAvg(m.teamA), eloB = teamAvg(m.teamB);
    const gap = m.winner === 'A' ? eloB - eloA : eloA - eloB;
    return gap > (best?.gap || 0) ? { match: m, gap } : best;
  }, null);

  // Power-ranking extras for richer commentary
  const king = computeKingOfCourt(allMatches);
  const milestones = [];
  state.players.forEach(p => {
    if (playerStats[p].matches === 0) return;
    const w = playerStats[p].wins;
    if (w >= 10) {
      const next = Math.ceil((w + 1) / 25) * 25;
      if (next - w <= 2) milestones.push(`${p} is ${next - w} win${next - w === 1 ? '' : 's'} from ${next} career wins`);
    }
  });
  const lastDate = allMatches.length ? allMatches[allMatches.length - 1].date : null;
  const rankMovers = [];
  if (lastDate) {
    const prev = allMatches.filter(m => m.date !== lastDate);
    const prevElo = eloOver(prev);
    const prevPlayed = playedCounts(prev);
    const played = playedCounts(allMatches);
    const nowOrder = state.players.filter(p => played[p] > 0)
      .sort((a, b) => (eloData.current[b] ?? 1200) - (eloData.current[a] ?? 1200));
    const prevOrder = state.players.filter(p => prevPlayed[p] > 0)
      .sort((a, b) => prevElo[b] - prevElo[a]);
    nowOrder.forEach((p, i) => {
      const pi = prevOrder.indexOf(p);
      if (pi >= 0 && pi - i !== 0) rankMovers.push(`${p} ${pi - i > 0 ? 'climbed' : 'dropped'} ${Math.abs(pi - i)} spot${Math.abs(pi - i) === 1 ? '' : 's'} to #${i + 1}`);
    });
  }

  return {
    king: king ? king.king : null,
    kingWeekends: king ? king.weekends : 0,
    milestones,
    rankMovers,
    todayStar,
    todayMatches: todayMatches.length,
    todayScores: todayMatches.map(m => {
      const aWin = m.winner === 'A';
      return `${m.teamA.join('&')} ${aWin ? 'beat' : 'lost to'} ${m.teamB.join('&')} ${m.sets.map(s => `${s.a}-${s.b}`).join(',')}`;
    }),
    eloLeader,
    eloLeaderRating: eloData.current[eloLeader] || 1200,
    mostLosses,
    mostLossesCount: mostLosses ? playerStats[mostLosses].losses : 0,
    biggestUpsetWinners: biggestUpset ? (biggestUpset.match.winner === 'A' ? biggestUpset.match.teamA : biggestUpset.match.teamB) : null,
    biggestUpsetScore: biggestUpset ? biggestUpset.match.sets.map(s => `${s.a}-${s.b}`).join(',') : null,
    totalMatches: allMatches.length,
    players: state.players,
    winRates: state.players.map(p => ({
      name: p,
      wins: playerStats[p].wins,
      losses: playerStats[p].losses,
      elo: eloData.current[p] || 1200
    }))
  };
}

async function generateTicker(force = false) {
  const key = getApiKey();
  if (!key) { hideTickerWrap(); return; }

  const today = new Date().toISOString().slice(0, 10);
  const allMatches = sortedMatches();

  if (allMatches.length === 0) { hideTickerWrap(); return; }

  // Use cache if same day, same filter, not forced
  if (!force && tickerCache.messages.length > 0 &&
      tickerCache.date === today && tickerCache.filter === currentFilter) {
    renderTickerMessages(tickerCache.messages);
    return;
  }

  showTickerLoading();

  const ctx = buildTickerContext();

  const prompt = `You are an uplifting, motivational sports commentator for a weekend doubles tennis group. Generate EXACTLY 3 ticker messages based on actual player performance. Messages 1 and 2 in English, Message 3 in Devanagari Hindi Haryanvi.

Player stats:
${ctx.winRates.filter(p => p.wins + p.losses > 0).map(p => `${p.name}: ${p.wins}W-${p.losses}L, ELO ${p.elo}`).join(', ')}

Today (${ctx.todayMatches} matches): ${ctx.todayScores.join(' | ') || 'none today yet'}
Today star: ${ctx.todayStar || 'none yet'} | ELO leader: ${ctx.eloLeader} (${ctx.eloLeaderRating}) | Total: ${ctx.totalMatches} matches
${ctx.biggestUpsetWinners ? `Biggest upset: ${ctx.biggestUpsetWinners.join(' & ')} won ${ctx.biggestUpsetScore}` : ''}
${ctx.king ? `King of the Court 👑: ${ctx.king} (held ${ctx.kingWeekends} weekend${ctx.kingWeekends === 1 ? '' : 's'})` : ''}
${ctx.milestones.length ? `Approaching milestones: ${ctx.milestones.join('; ')}` : ''}
${ctx.rankMovers.length ? `Latest rank moves: ${ctx.rankMovers.join('; ')}` : ''}

ENGLISH RULES (messages 1-2):
- Max 12 words each
- Motivational and personal — mention specific player names based on their performance
- Message 1: celebrate today's best performer or a notable achievement with their name
- Message 2: motivate someone who is still climbing — encourage them by name, never negative
- Always uplifting — "X is finding their rhythm!", "Watch out for Y!", "Z's time is coming!"
- Use emojis 🎾 😄 🔥 💪 👑 🚀 ⭐
- Include 🏆 next to today's star's name
- When exciting, reference the King of the Court crown, an approaching milestone, or a big rank climb

HARYANVI HINDI RULES (message 3 — must be in Devanagari script):
- Warm, celebratory, motivational — NEVER negative or demotivating
- Can include a player's name if they played well today — celebrate them warmly
- Use Haryanvi words: कति, धमाल, घैंत, जोड़ी, दबदबा, कसुट्टा, हिम्मत, धाकड़, माहौल, स्वैग, असली, पावर
- Vary endings each time: "कति घैंत!", "वाह भाई वाह!", "धाकड़ खेल!", "कमाल कर दिया!", "असली Haryana power!"
- Choose and adapt based on context:
  If someone played great: "आज [NAME] ने court पे कति धमाल मचा दिया — कति घैंत! 🏆"
  If great partnership: "जोड़ी ने match में पूरी Haryanvi छाप छोड़ दी — कसुट्टा खेल!"
  If good session: "आज court पे असली Haryana power देखने को मिली — वाह भाई वाह!"
  If comeback: "Match tight था, पर अपनी जोड़ी ने हिम्मत ना छोड़ी — धाकड़ खेल!"
  If dominant win: "शुरू से end तक team का दबदबा बना रहा — कमाल कर दिया!"
  If everyone played: "Court पे आये, खेले, और जीत ले गये — असली Haryana power!"
  If motivating: "आज का game full कसुट्टा था — अगली बार और धमाल होगा!"
  General energy: "Team ने patience रखा और result अपने नाम करा — घैंत खेल!"
- Max 15 words. Always ends with a positive exclamation.

Respond ONLY with JSON array of exactly 3 strings, no explanation, no markdown:
["english msg 1", "english msg 2", "देवनागरी हरियाणवी msg 3"]`;

  try {
    const res = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'x-api-key': key,
        'anthropic-version': '2023-06-01',
        'anthropic-dangerous-direct-browser-access': 'true'
      },
      body: JSON.stringify({
        model: 'claude-sonnet-4-5',
        max_tokens: 200,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) {
      const errData = await res.json().catch(() => ({}));
      console.warn('Ticker API error:', res.status, errData);
      const errMsg = errData?.error?.message || `API error ${res.status}`;
      // Show error in ticker so user can see what's wrong
      renderTickerMessages([`⚠️ ${errMsg}`]);
      return;
    }

    const data = await res.json();
    const raw = data.content?.[0]?.text || '';
    console.log('Ticker raw response:', raw); // debug
    if (!raw) { hideTickerWrap(); return; }

    // Strip any markdown fences and parse
    const cleaned = raw.replace(/```json|```/g, '').trim();
    let messages;
    try {
      messages = JSON.parse(cleaned);
    } catch(parseErr) {
      // If JSON parse fails, try extracting quoted strings
      const extracted = cleaned.match(/"([^"]+)"/g);
      messages = extracted ? extracted.map(s => s.replace(/"/g, '')) : null;
    }

    if (!Array.isArray(messages) || messages.length === 0) {
      hideTickerWrap();
      return;
    }

    tickerCache = { messages, date: today, filter: currentFilter };
    renderTickerMessages(messages);

  } catch(e) {
    console.warn('Ticker generation failed:', e.message);
    renderTickerMessages([`⚠️ Ticker error: ${e.message} — check console`]);
  }
}

function renderTickerMessages(messages) {
  const wrap = document.getElementById('ai-ticker-wrap');
  const ticker = document.getElementById('ai-ticker');
  if (!wrap || !ticker) return;

  // Build scrolling content — messages separated by 🎾
  ticker.innerHTML = messages.map((msg, i) =>
    `<span>${escapeHtml(msg)}</span>${i < messages.length - 1 ? '<span class="ticker-sep">🎾</span>' : ''}`
  ).join('');

  // Restart animation by re-adding the element
  ticker.style.animation = 'none';
  ticker.offsetHeight; // force reflow
  ticker.style.animation = '';

  wrap.classList.remove('hidden');
}

function showTickerLoading() {
  const wrap = document.getElementById('ai-ticker-wrap');
  const ticker = document.getElementById('ai-ticker');
  if (!wrap || !ticker) return;
  ticker.innerHTML = '<span style="color:rgba(255,255,255,0.75);font-style:italic">🎾 Generating match commentary…</span>';
  wrap.classList.remove('hidden');
}

function hideTickerWrap() {
  const wrap = document.getElementById('ai-ticker-wrap');
  if (wrap) wrap.classList.add('hidden');
}

function renderAll() {
  renderFilter();
  renderPowerRankings();
  renderSeasonBanner();
  renderWeekendCoordinator();
  renderSummary();
  renderChampion();
  renderKingBadge();
  renderHistory();
  renderChemistry();
  renderPlayersPanel();
  renderLogForm();
  renderCharts();
  renderPhotosPanel();
}

setupTabs();
setupShareModal();
setupVoiceEntry();
setupApiKeyModal();
window.applyParsedResult = applyParsedResult;
window.retryVoice = retryVoice;
window.shareVoteToWhatsApp = shareVoteToWhatsApp;
setupPhotoTab();
document.getElementById('save-match')?.addEventListener('click', saveMatch);
document.getElementById('ticker-refresh')?.addEventListener('click', () => {
  tickerGenerated = false;
  generateTicker(true);
});
document.getElementById('save-players')?.addEventListener('click', savePlayers);
document.getElementById('reset-all')?.addEventListener('click', resetAll);
document.getElementById('export-csv')?.addEventListener('click', exportCsv);
document.getElementById('reshuffle')?.addEventListener('click', renderRotation);
document.getElementById('save-location')?.addEventListener('click', saveLocation);
document.getElementById('filter-weekend')?.addEventListener('change', (e) => {
  currentFilter = e.target.value;
  tickerCache = { messages: [], date: '', filter: '' };
  tickerGenerated = false;
  renderPowerRankings();
  renderSeasonBanner();
  renderSummary();
  renderChampion();
  renderKingBadge();
  renderCharts();
  setTimeout(() => generateTicker(), 100);
});
