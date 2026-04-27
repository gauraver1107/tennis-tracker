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

const DEFAULT_PLAYERS = ['Gaurav','Manuj','Manish','Vivek','Chirag','Gaurang'];
const ELO_START = 1200;
const ELO_K = 32;

let state = { players: [...DEFAULT_PLAYERS], matches: [], availability: {}, photos: [] };
let trendChart = null, eloChart = null, weatherChart = null;
let currentFilter = 'all';
let isSyncing = false;
let weatherCache = { data: null, fetchedAt: 0, location: null };

function setStatus(text, cls) {
  const el = document.getElementById('sync-status');
  el.textContent = text;
  el.className = 'status ' + (cls || '');
}

onSnapshot(DOC_REF, (snap) => {
  if (snap.exists()) {
    const data = snap.data();
    state = {
      players: data.players || [...DEFAULT_PLAYERS],
      matches: data.matches || [],
      location: data.location || null,
      availability: data.availability || {},
      photos: data.photos || []
    };
  } else {
    state = { players: [...DEFAULT_PLAYERS], matches: [], location: null, availability: {}, photos: [] };
  }
  if (state.players.length < 5) state.players = [...DEFAULT_PLAYERS];
  state.matches.forEach(m => {
    if (!m.sets) m.sets = [];
    m.sets.forEach(s => { if (s.tbA === undefined) s.tbA = null; if (s.tbB === undefined) s.tbB = null; });
    if (m.notes === undefined) m.notes = '';
  });
  setStatus('Synced', 'online');
  renderAll();
}, (err) => {
  console.error('Sync error:', err);
  setStatus('Offline', 'offline');
});

async function saveState() {
  if (isSyncing) return;
  isSyncing = true;
  setStatus('Saving…', '');
  try {
    await setDoc(DOC_REF, state);
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
  return all.filter(m => m.date === currentFilter);
}

function computeElo() {
  const elo = {};
  state.players.forEach(p => { elo[p] = ELO_START; });
  const history = {};
  state.players.forEach(p => { history[p] = [{ n: 0, rating: ELO_START }]; });
  sortedMatches().forEach((m, idx) => {
    const teamAvg = (team) => team.reduce((acc, p) => acc + (elo[p] ?? ELO_START), 0) / team.length;
    const rA = teamAvg(m.teamA), rB = teamAvg(m.teamB);
    const expA = 1 / (1 + Math.pow(10, (rB - rA) / 400));
    const expB = 1 - expA;
    const scoreA = m.winner === 'A' ? 1 : 0;
    const scoreB = 1 - scoreA;
    const deltaA = ELO_K * (scoreA - expA);
    const deltaB = ELO_K * (scoreB - expB);
    m.teamA.forEach(p => {
      elo[p] = (elo[p] ?? ELO_START) + deltaA;
      history[p].push({ n: idx + 1, rating: elo[p] });
    });
    m.teamB.forEach(p => {
      elo[p] = (elo[p] ?? ELO_START) + deltaB;
      history[p].push({ n: idx + 1, rating: elo[p] });
    });
  });
  return { current: elo, history };
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

function renderFilter() {
  const sel = document.getElementById('filter-weekend');
  const weekends = [...new Set(state.matches.map(m => m.date))].sort().reverse();
  sel.innerHTML = `<option value="all">All time</option>` +
    weekends.map(d => `<option value="${d}">${formatDate(d)}</option>`).join('');
  sel.value = currentFilter;
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
    <div class="trophy">🏆</div>
    <div>
      <div class="label">Champion of the weekend</div>
      <div class="name">${escapeHtml(champ.name)} — ${champ.wins}-${champ.losses}, ${Math.round(champ.winRate * 100)}%</div>
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
  const COLORS = ['#378ADD','#1D9E75','#D85A30','#D4537E','#7F77DD','#EF9F27'];
  const DASHES = [[], [6,4], [2,3], [8,4,2,4], [4,2], [3,1]];
  const matches = sortedMatches();

  // ── Option 1: Smooth filled area — win rate trend ──
  const running = {};
  state.players.forEach(p => { running[p] = { w: 0, total: 0, series: [] }; });
  matches.forEach(m => {
    const aWin = m.winner === 'A';
    state.players.forEach(p => {
      const r = running[p];
      if (m.teamA.includes(p)) { r.total++; if (aWin) r.w++; }
      else if (m.teamB.includes(p)) { r.total++; if (!aWin) r.w++; }
      r.series.push(r.total ? Math.round((r.w / r.total) * 100) : null);
    });
  });
  const labels = matches.map((m, i) => `#${i + 1}`);

  if (trendChart) trendChart.destroy();
  const winCanvas = document.getElementById('trendChart');
  if (labels.length === 0) {
    blankChart(winCanvas, 'Log a match to see trends');
  } else {
    const winCtx = winCanvas.getContext('2d');
    const winDatasets = state.players.map((p, i) => {
      const grad = winCtx.createLinearGradient(0, 0, 0, 240);
      grad.addColorStop(0, COLORS[i] + '55');
      grad.addColorStop(1, COLORS[i] + '00');
      return {
        label: p,
        data: running[p].series,
        borderColor: COLORS[i],
        backgroundColor: grad,
        fill: true,
        tension: 0.45,
        pointRadius: 4,
        pointHoverRadius: 6,
        borderWidth: 2.5,
        borderDash: DASHES[i],
        spanGaps: true
      };
    });
    trendChart = new Chart(winCtx, {
      type: 'line',
      data: { labels, datasets: winDatasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          y: {
            min: 0, max: 100,
            ticks: { callback: v => v + '%', font: { size: 11 } },
            grid: { color: 'rgba(127,127,127,0.08)' }
          },
          x: {
            title: { display: true, text: 'Match #', font: { size: 11 } },
            grid: { color: 'rgba(127,127,127,0.08)' }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.dataset.label}: ${ctx.raw !== null ? ctx.raw + '%' : 'no matches yet'}`
            }
          }
        }
      }
    });
    renderChartLegend('trendLegend', state.players, COLORS, DASHES);
  }

  // ── Option 6: ELO history with gradient fill ──
  const eloData = computeElo();

  if (eloChart) eloChart.destroy();
  const eloCanvas = document.getElementById('eloChart');
  if (matches.length === 0) {
    blankChart(eloCanvas, 'ELO appears after the first match');
  } else {
    const eloCtx = eloCanvas.getContext('2d');
    const eloDatasets = state.players.map((p, i) => {
      const grad = eloCtx.createLinearGradient(0, 0, 0, 240);
      grad.addColorStop(0, COLORS[i] + '50');
      grad.addColorStop(1, COLORS[i] + '00');
      return {
        label: p,
        data: eloData.history[p].map(pt => ({ x: pt.n, y: Math.round(pt.rating) })),
        borderColor: COLORS[i],
        backgroundColor: grad,
        fill: true,
        tension: 0.35,
        pointRadius: 3,
        pointHoverRadius: 5,
        borderWidth: 2,
        borderDash: DASHES[i]
      };
    });
    eloChart = new Chart(eloCtx, {
      type: 'line',
      data: { datasets: eloDatasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        interaction: { mode: 'index', intersect: false },
        scales: {
          x: {
            type: 'linear',
            title: { display: true, text: 'Match #', font: { size: 11 } },
            ticks: { stepSize: 1 },
            grid: { color: 'rgba(127,127,127,0.08)' }
          },
          y: {
            title: { display: true, text: 'ELO rating', font: { size: 11 } },
            grid: { color: 'rgba(127,127,127,0.08)' }
          }
        },
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              label: ctx => ` ${ctx.dataset.label}: ${ctx.raw.y}`
            }
          }
        }
      }
    });
    renderChartLegend('eloLegend', state.players, COLORS, DASHES);
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
  return `
    <div class="match-card">
      <div class="teams">
        <div class="team-line ${aWin ? 'winner' : ''}">${escapeHtml(m.teamA.join(' & '))}${aWin ? ' ✓' : ''}</div>
        <div class="team-line ${!aWin ? 'winner' : ''}">${escapeHtml(m.teamB.join(' & '))}${!aWin ? ' ✓' : ''}</div>
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
  }
  const matches = sortedMatches();
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

function renderPlayersPanel() {
  const container = document.getElementById('player-inputs');
  const MAX = 6;
  const slots = [...state.players];
  while (slots.length < MAX) slots.push('');
  container.innerHTML = slots.map((p, i) => `
    <div style="display:flex;align-items:center;gap:8px;">
      <span style="font-size:12px;color:var(--text-muted);min-width:18px;">${i + 1}.</span>
      <input type="text" data-player-idx="${i}" value="${escapeHtml(p)}" placeholder="Player ${i + 1} name" style="flex:1;">
    </div>`).join('');
}

function savePlayers() {
  const inputs = document.querySelectorAll('[data-player-idx]');
  const next = [];
  inputs.forEach(inp => { const v = inp.value.trim(); if (v) next.push(v); });
  if (next.length < 5) { alert('You need at least 5 player names.'); return; }
  if (next.length > 6) { alert('Maximum 6 players supported.'); return; }
  if (new Set(next).size !== next.length) { alert('Player names must be unique.'); return; }
  const rename = {};
  state.players.forEach((old, i) => { if (next[i]) rename[old] = next[i]; });
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

function getApiKey() {
  return localStorage.getItem(ANTHROPIC_KEY_STORE) || '';
}
function saveApiKey(key) {
  localStorage.setItem(ANTHROPIC_KEY_STORE, key.trim());
}

function setupVoiceEntry() {
  const btn = document.getElementById('voice-btn');
  if (!btn) return;

  const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SpeechRecognition) {
    btn.title = 'Voice not supported in this browser — use Chrome or Safari';
    btn.style.opacity = '0.4';
    btn.style.cursor = 'not-allowed';
    document.querySelector('.voice-sub').textContent = 'Voice not supported — use Chrome or Safari on mobile';
    return;
  }

  recognition = new SpeechRecognition();
  recognition.continuous = false;
  recognition.interimResults = true;
  recognition.lang = 'en-US';

  let finalTranscript = '';

  recognition.onstart = () => {
    btn.classList.add('listening');
    btn.textContent = '⏹️';
    btn.title = 'Tap to stop';
    showVoiceTranscript('Listening… speak your match result');
    hideEl('voice-parsed');
    hideEl('voice-error');
    finalTranscript = '';
  };

  recognition.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      if (e.results[i].isFinal) finalTranscript += e.results[i][0].transcript + ' ';
      else interim += e.results[i][0].transcript;
    }
    showVoiceTranscript('"' + (finalTranscript + interim).trim() + '"');
  };

  recognition.onend = () => {
    btn.classList.remove('listening');
    btn.textContent = '🎤';
    btn.title = 'Tap to speak';
    if (finalTranscript.trim()) {
      pendingTranscript = finalTranscript.trim();
      parseWithLLM(pendingTranscript);
    } else {
      showVoiceTranscript('Nothing detected — tap the mic and try again');
    }
  };

  recognition.onerror = (e) => {
    btn.classList.remove('listening');
    btn.textContent = '🎤';
    const msgs = { 'not-allowed': 'Microphone permission denied — check browser settings', 'network': 'Network error', 'no-speech': 'No speech detected — try again' };
    showVoiceError(msgs[e.error] || 'Mic error: ' + e.error);
  };

  btn.addEventListener('click', () => {
    if (btn.classList.contains('listening')) {
      recognition.stop();
    } else if (btn.classList.contains('parsing')) {
      // do nothing while parsing
    } else {
      try { recognition.start(); }
      catch(e) { showVoiceError('Could not start mic: ' + e.message); }
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
        model: 'claude-sonnet-4-20250514',
        max_tokens: 400,
        messages: [{ role: 'user', content: prompt }]
      })
    });

    if (!res.ok) {
      const err = await res.json();
      if (res.status === 401) { localStorage.removeItem(ANTHROPIC_KEY_STORE); showVoiceError('Invalid API key — please re-enter.'); }
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
      <button class="btn-small" onclick="applyParsedResult(${encodeURIComponent(JSON.stringify(parsed))})">✅ Apply to form</button>
      <button class="btn-small" onclick="retryVoice()">🔄 Try again</button>
    </div>`;
  el.classList.remove('hidden');
  hideEl('voice-error');
}

function applyParsedResult(encoded) {
  try {
    const parsed = JSON.parse(decodeURIComponent(encoded));
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

    // Hide parsed result, show success
    hideEl('voice-parsed');
    showVoiceTranscript('✅ Applied! Review the form below and tap Save match.');

  } catch(e) {
    showVoiceError('Could not apply — please fill the form manually.');
  }
}

function retryVoice() {
  hideEl('voice-parsed');
  hideEl('voice-error');
  const btn = document.getElementById('voice-btn');
  if (btn && recognition) {
    try { recognition.start(); }
    catch(e) { showVoiceError('Tap the mic button to try again.'); }
  }
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
  document.getElementById('apikey-save').addEventListener('click', () => {
    const key = document.getElementById('apikey-input').value.trim();
    if (!key.startsWith('sk-ant-')) { alert('Key should start with sk-ant-'); return; }
    saveApiKey(key);
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
    <button class="toast-btn" onclick="shareVoteToWhatsApp(${encodeURIComponent(msg)})">Share</button>
    <button class="toast-close" onclick="document.getElementById('vote-toast')?.remove()">✕</button>`;
  document.body.appendChild(toast);

  // Auto-dismiss after 8 seconds
  setTimeout(() => { document.getElementById('vote-toast')?.remove(); }, 8000);
}

function shareVoteToWhatsApp(encodedMsg) {
  const msg = decodeURIComponent(encodedMsg);
  window.open(`https://wa.me/?text=${encodeURIComponent(msg)}`, '_blank');
  document.getElementById('vote-toast')?.remove();
}


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

async function geocodeLocation(name) {
  const url = `https://geocoding-api.open-meteo.com/v1/search?name=${encodeURIComponent(name)}&count=1&language=en&format=json`;
  const res = await fetch(url);
  const data = await res.json();
  if (!data.results || data.results.length === 0) throw new Error('Location not found');
  const r = data.results[0];
  return { lat: r.latitude, lon: r.longitude, label: `${r.name}${r.admin1 ? ', ' + r.admin1 : ''}` };
}

async function fetchWeather(lat, lon) {
  const params = new URLSearchParams({
    latitude: lat,
    longitude: lon,
    daily: 'weather_code,temperature_2m_max,temperature_2m_min,precipitation_probability_max,wind_speed_10m_max,sunrise,sunset',
    hourly: 'temperature_2m,precipitation_probability,wind_speed_10m,weather_code',
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
    const t = new Date(times[i]);
    const tDate = times[i].slice(0, 10);
    const hour = t.getHours();
    if (tDate === dateStr && hour >= MORNING_START && hour <= MORNING_END) {
      hours.push({
        hour,
        label: hour === 12 ? '12 PM' : `${hour} AM`,
        temp: Math.round(data.hourly.temperature_2m[i]),
        rain: data.hourly.precipitation_probability[i],
        wind: Math.round(data.hourly.wind_speed_10m[i]),
        code: data.hourly.weather_code[i]
      });
    }
  }
  return hours;
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
  if (!hours || hours.length < 2) return null;
  let bestScore = Infinity, bestIdx = 0;
  for (let i = 0; i < hours.length - 1; i++) {
    const score = hours[i].rain + hours[i + 1].rain + hours[i].wind + hours[i + 1].wind;
    if (score < bestScore) { bestScore = score; bestIdx = i; }
  }
  const a = hours[bestIdx], b = hours[bestIdx + 1];
  return { startLabel: a.label, endLabel: b.label, temp: Math.round((a.temp + b.temp) / 2), rain: Math.max(a.rain, b.rain), wind: Math.max(a.wind, b.wind), code: a.code };
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
  const adviceEl = document.getElementById('weather-play-advice');
  const inputEl = document.getElementById('location-name');

  if (state.location?.name && !inputEl.dataset.userEdited) {
    inputEl.value = state.location.name;
  }
  const locationName = (inputEl.value || 'Edison, NJ').trim();

  const cacheValid = weatherCache.data && weatherCache.location === locationName && (Date.now() - weatherCache.fetchedAt) < 30 * 60 * 1000;
  if (!cacheValid) {
    forecastEl.innerHTML = '<div class="weather-loading">Loading forecast…</div>';
    adviceEl.innerHTML = '';
    try {
      const geo = state.location?.lat ? state.location : await geocodeLocation(locationName);
      const weather = await fetchWeather(geo.lat, geo.lon);
      weatherCache = { data: weather, fetchedAt: Date.now(), location: locationName, geo };
    } catch (e) {
      forecastEl.innerHTML = `<div class="error">Couldn't load weather for "${escapeHtml(locationName)}". Try a different location name.</div>`;
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
      </div>`;
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
    await saveState();
    loadWeather();
  } catch (e) {
    alert('Could not find "' + name + '". Try "City, State" or "City, Country".');
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
            const isBest = bestWin && (h.label === bestWin.startLabel || h.label === bestWin.endLabel);
            const isWarn = !isBest && (h.rain >= 30 || h.wind >= 20);
            const cls = isBest ? 'wc-hour-cell best' : isWarn ? 'wc-hour-cell warn' : 'wc-hour-cell';
            return `
              <div class="${cls}">
                <div class="wc-h-time">${h.label}</div>
                <div class="wc-h-icon">${weatherIcon(h.code)}</div>
                <div class="wc-h-temp">${h.temp}°C</div>
                <div class="wc-h-rain">💧${h.rain}%</div>
                <div class="wc-h-wind">💨${h.wind}</div>
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

function renderAll() {
  renderFilter();
  renderWeekendCoordinator();
  renderSummary();
  renderChampion();
  renderLeaderboard();
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
document.getElementById('save-match').addEventListener('click', saveMatch);
document.getElementById('save-players').addEventListener('click', savePlayers);
document.getElementById('reset-all').addEventListener('click', resetAll);
document.getElementById('export-csv').addEventListener('click', exportCsv);
document.getElementById('reshuffle').addEventListener('click', renderRotation);
document.getElementById('save-location').addEventListener('click', saveLocation);
document.getElementById('filter-weekend').addEventListener('change', (e) => {
  currentFilter = e.target.value;
  renderSummary();
  renderChampion();
  renderLeaderboard();
});
