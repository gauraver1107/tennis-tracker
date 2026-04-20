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

const DEFAULT_PLAYERS = ['Gaurav','Manuj','Manish','Vivek','Chirag'];
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
  if (state.players.length !== 5) state.players = [...DEFAULT_PLAYERS];
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

function renderSummary() {
  const matches = filteredMatches();
  const totalMatches = matches.length;
  const weekends = currentFilter === 'all' ? new Set(state.matches.map(m => m.date)).size : (matches.length > 0 ? 1 : 0);
  const totalSets = matches.reduce((acc, m) => acc + m.sets.length, 0);
  const totalGames = matches.reduce((acc, m) => acc + m.sets.reduce((a, s) => a + s.a + s.b, 0), 0);
  const cards = [
    { label: 'Matches', value: totalMatches },
    { label: 'Weekends', value: weekends },
    { label: 'Sets', value: totalSets },
    { label: 'Games', value: totalGames }
  ];
  document.getElementById('summary-cards').innerHTML = cards.map(c => `
    <div class="summary-card">
      <div class="label">${c.label}</div>
      <div class="value">${c.value}</div>
    </div>`).join('');
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
  const colors = ['#378ADD','#1D9E75','#D85A30','#D4537E','#7F77DD'];
  const dashes = [[], [6,4], [2,3], [8,4,2,4], [4,2]];
  const matches = sortedMatches();

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
  const winDatasets = state.players.map((p, i) => ({
    label: p, data: running[p].series,
    borderColor: colors[i], backgroundColor: colors[i],
    borderDash: dashes[i], tension: 0.2, pointRadius: 3, spanGaps: true
  }));

  if (trendChart) trendChart.destroy();
  const winCanvas = document.getElementById('trendChart');
  if (labels.length === 0) {
    blankChart(winCanvas, 'Log a match to see trends');
  } else {
    trendChart = new Chart(winCanvas, {
      type: 'line',
      data: { labels, datasets: winDatasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { y: { min: 0, max: 100, ticks: { callback: v => v + '%' } }, x: { title: { display: true, text: 'Match #' } } },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 12 } } } }
      }
    });
  }

  const eloData = computeElo();
  const eloDatasets = state.players.map((p, i) => ({
    label: p,
    data: eloData.history[p].map(pt => ({ x: pt.n, y: Math.round(pt.rating) })),
    borderColor: colors[i], backgroundColor: colors[i],
    borderDash: dashes[i], tension: 0.2, pointRadius: 3
  }));

  if (eloChart) eloChart.destroy();
  const eloCanvas = document.getElementById('eloChart');
  if (matches.length === 0) {
    blankChart(eloCanvas, 'ELO appears after the first match');
  } else {
    eloChart = new Chart(eloCanvas, {
      type: 'line',
      data: { datasets: eloDatasets },
      options: {
        responsive: true, maintainAspectRatio: false,
        scales: { x: { type: 'linear', title: { display: true, text: 'Match #' }, ticks: { stepSize: 1 } }, y: { title: { display: true, text: 'Rating' } } },
        plugins: { legend: { position: 'bottom', labels: { boxWidth: 12, font: { size: 12 } } } }
      }
    });
  }
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
  const arr = Object.values(pairStats)
    .sort((a, b) => (b.wins / b.matches) - (a.wins / a.matches) || b.wins - a.wins);
  const list = document.getElementById('chemistry-list');
  if (arr.length === 0) {
    list.innerHTML = `<div class="hint" style="text-align:center; padding:2rem;">No pairings yet.</div>`;
    return;
  }
  list.innerHTML = `
    <div class="table-wrap">
      <table>
        <thead><tr><th>Pairing</th><th class="right">W-L</th><th class="right">Win %</th></tr></thead>
        <tbody>
          ${arr.map(p => `
            <tr>
              <td>${escapeHtml(p.names)}</td>
              <td class="right">${p.wins}-${p.matches - p.wins}</td>
              <td class="right">${Math.round((p.wins / p.matches) * 100)}%</td>
            </tr>`).join('')}
        </tbody>
      </table>
    </div>`;
}

function addPair(store, team, won) {
  const key = [...team].sort().join('|');
  if (!store[key]) store[key] = { names: [...team].sort().join(' & '), matches: 0, wins: 0 };
  store[key].matches++; if (won) store[key].wins++;
}

function renderRotation() {
  const box = document.getElementById('rotation-suggestion');
  if (state.players.length !== 5) {
    box.innerHTML = `<div class="hint">Set up 5 players first.</div>`;
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
  const sorted = [...state.players].sort((a, b) => restScore[b] - restScore[a]);
  const sitOut = sorted[0];
  const playing = state.players.filter(p => p !== sitOut);
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
        <span class="name">${escapeHtml(sitOut)}</span>
      </div>
    </div>`;
}

function renderPlayersPanel() {
  const container = document.getElementById('player-inputs');
  container.innerHTML = state.players.map((p, i) =>
    `<input type="text" data-player-idx="${i}" value="${escapeHtml(p)}">`
  ).join('');
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

function savePlayers() {
  const inputs = document.querySelectorAll('[data-player-idx]');
  const next = [];
  inputs.forEach(inp => { const v = inp.value.trim(); if (v) next.push(v); });
  if (next.length !== 5) { alert('All 5 player names are required.'); return; }
  if (new Set(next).size !== 5) { alert('Player names must be unique.'); return; }
  const rename = {};
  state.players.forEach((old, i) => { rename[old] = next[i]; });
  state.matches = state.matches.map(m => ({
    ...m,
    teamA: m.teamA.map(p => rename[p] || p),
    teamB: m.teamB.map(p => rename[p] || p)
  }));
  state.players = next;
  saveState();
}

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
    temperature_unit: 'fahrenheit',
    wind_speed_unit: 'mph',
    precipitation_unit: 'inch',
    timezone: 'auto',
    forecast_days: 7
  });
  const res = await fetch(`https://api.open-meteo.com/v1/forecast?${params}`);
  if (!res.ok) throw new Error('Weather fetch failed');
  return res.json();
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
  const tempMax = day.temperature_2m_max ?? 70;
  const tempMin = day.temperature_2m_min ?? 60;
  const code = day.weather_code ?? 0;

  if (rain >= 60 || code >= 95 || code >= 71 && code <= 77) return { rank: 'bad', reason: rain >= 60 ? 'High chance of rain' : code >= 95 ? 'Thunderstorms expected' : 'Snow expected' };
  if (wind >= 20) return { rank: 'bad', reason: `Very windy (${Math.round(wind)} mph gusts)` };
  if (tempMax >= 95) return { rank: 'bad', reason: `Too hot (${Math.round(tempMax)}°F)` };
  if (tempMax <= 40) return { rank: 'bad', reason: `Too cold (${Math.round(tempMax)}°F high)` };

  if (rain >= 30) return { rank: 'ok', reason: `${rain}% rain chance — check radar before heading out` };
  if (wind >= 15) return { rank: 'ok', reason: `Breezy (${Math.round(wind)} mph) — lighter balls may drift` };
  if (tempMax >= 88) return { rank: 'ok', reason: `Warm (${Math.round(tempMax)}°F) — bring extra water` };
  if (tempMin <= 50 && tempMax <= 60) return { rank: 'ok', reason: `Cool (${Math.round(tempMin)}–${Math.round(tempMax)}°F) — layer up` };

  return { rank: 'great', reason: `${weatherLabel(code)}, ${Math.round(tempMax)}°F, light wind — perfect for tennis` };
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
    const day = {
      weather_code: daily.weather_code[nextWeekend],
      temperature_2m_max: daily.temperature_2m_max[nextWeekend],
      temperature_2m_min: daily.temperature_2m_min[nextWeekend],
      precipitation_probability_max: daily.precipitation_probability_max[nextWeekend],
      wind_speed_10m_max: daily.wind_speed_10m_max[nextWeekend]
    };
    const verdict = playabilityScore(day);
    const dayName = new Date(daily.time[nextWeekend] + 'T00:00:00').toLocaleDateString(undefined, { weekday: 'long' });
    adviceEl.innerHTML = `
      <div class="play-advice ${verdict.rank}">
        <div class="verdict-icon">${verdict.rank === 'great' ? '🎾' : verdict.rank === 'ok' ? '⚠️' : '🚫'}</div>
        <div>
          <div class="verdict-label">${dayName}'s outlook</div>
          <div class="verdict-text">${verdict.reason}</div>
        </div>
      </div>`;
  } else {
    adviceEl.innerHTML = '';
  }

  let html = '<div class="forecast-grid">';
  for (let i = 0; i < daily.time.length; i++) {
    const day = {
      weather_code: daily.weather_code[i],
      temperature_2m_max: daily.temperature_2m_max[i],
      temperature_2m_min: daily.temperature_2m_min[i],
      precipitation_probability_max: daily.precipitation_probability_max[i],
      wind_speed_10m_max: daily.wind_speed_10m_max[i]
    };
    const verdict = playabilityScore(day);
    const d = new Date(daily.time[i] + 'T00:00:00');
    const dayName = i === 0 ? 'Today' : d.toLocaleDateString(undefined, { weekday: 'short' });
    html += `
      <div class="forecast-day play-${verdict.rank}">
        <div class="day-name">${dayName}</div>
        <div class="day-icon">${weatherIcon(day.weather_code)}</div>
        <div class="day-temp">${Math.round(day.temperature_2m_max)}°</div>
        <div class="day-low">${Math.round(day.temperature_2m_min)}°</div>
        <div class="day-rain">💧 ${day.precipitation_probability_max}%</div>
        <div class="day-wind">💨 ${Math.round(day.wind_speed_10m_max)}mph</div>
      </div>`;
  }
  html += '</div>';
  forecastEl.innerHTML = html;

  renderHourlyChart(data);
}

function findNextWeekendIdx(dates) {
  for (let i = 0; i < dates.length; i++) {
    const d = new Date(dates[i] + 'T00:00:00');
    const dow = d.getDay();
    if (dow === 0 || dow === 6) return i;
  }
  return -1;
}

function renderHourlyChart(data) {
  const canvas = document.getElementById('weatherChart');
  if (!canvas) return;
  const now = new Date();
  const tomorrowStart = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 6);
  const tomorrowEnd = new Date(now.getFullYear(), now.getMonth(), now.getDate() + 1, 22);

  const times = data.hourly.time;
  const labels = [], temps = [], rain = [], wind = [];
  for (let i = 0; i < times.length; i++) {
    const t = new Date(times[i]);
    if (t >= tomorrowStart && t <= tomorrowEnd) {
      labels.push(t.toLocaleTimeString(undefined, { hour: 'numeric' }));
      temps.push(Math.round(data.hourly.temperature_2m[i]));
      rain.push(data.hourly.precipitation_probability[i]);
      wind.push(Math.round(data.hourly.wind_speed_10m[i]));
    }
  }

  if (weatherChart) weatherChart.destroy();
  if (labels.length === 0) {
    blankChart(canvas, 'Hourly data unavailable');
    return;
  }

  weatherChart = new Chart(canvas, {
    type: 'line',
    data: {
      labels,
      datasets: [
        { label: 'Temp (°F)', data: temps, borderColor: '#D85A30', backgroundColor: '#D85A30', yAxisID: 'y', tension: 0.3, pointRadius: 2 },
        { label: 'Rain %', data: rain, borderColor: '#378ADD', backgroundColor: '#378ADD', yAxisID: 'y1', tension: 0.3, pointRadius: 2, borderDash: [4,2] },
        { label: 'Wind (mph)', data: wind, borderColor: '#7F77DD', backgroundColor: '#7F77DD', yAxisID: 'y1', tension: 0.3, pointRadius: 2, borderDash: [2,3] }
      ]
    },
    options: {
      responsive: true, maintainAspectRatio: false,
      interaction: { mode: 'index', intersect: false },
      scales: {
        y: { position: 'left', title: { display: true, text: '°F' } },
        y1: { position: 'right', title: { display: true, text: '% / mph' }, grid: { drawOnChartArea: false }, min: 0 }
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
      const day = {
        weather_code: daily.weather_code[idx],
        temperature_2m_max: daily.temperature_2m_max[idx],
        temperature_2m_min: daily.temperature_2m_min[idx],
        precipitation_probability_max: daily.precipitation_probability_max[idx],
        wind_speed_10m_max: daily.wind_speed_10m_max[idx]
      };
      verdict = playabilityScore(day);
      weatherColHtml = `
        <div class="wc-right">
          <div class="wc-weather-card">
            <div class="wc-weather-top">
              <div class="wc-weather-icon">${weatherIcon(day.weather_code)}</div>
              <div class="wc-weather-main">
                <div class="wc-weather-temp">${Math.round(day.temperature_2m_max)}° / ${Math.round(day.temperature_2m_min)}°F</div>
                <div class="wc-weather-desc">${weatherLabel(day.weather_code)}</div>
              </div>
            </div>
            <div class="wc-weather-stats">
              <div class="wc-stat">
                <div class="wc-stat-label">Rain chance</div>
                <div class="wc-stat-value">💧 ${day.precipitation_probability_max}%</div>
              </div>
              <div class="wc-stat">
                <div class="wc-stat-label">Wind speed</div>
                <div class="wc-stat-value">💨 ${Math.round(day.wind_speed_10m_max)} mph</div>
              </div>
            </div>
          </div>
          <div class="wc-verdict ${verdict.rank}">
            ${verdict.rank === 'great' ? '🎾 Great day to play' : verdict.rank === 'ok' ? '⚠️ Playable — ' + verdict.reason : '🚫 ' + verdict.reason}
          </div>
        </div>`;
    }
  }
  if (!weatherColHtml) {
    weatherColHtml = `<div class="wc-right"><div class="wc-no-weather">Open Weather tab once to load forecast</div></div>`;
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
