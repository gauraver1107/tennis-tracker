import { initializeApp } from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-app.js';
import {
  getFirestore, doc, setDoc, onSnapshot
} from 'https://www.gstatic.com/firebasejs/10.7.1/firebase-firestore.js';

import { firebaseConfig } from './firebase-config.js';

const app = initializeApp(firebaseConfig);
const db = getFirestore(app);
const DOC_REF = doc(db, 'tennis', 'shared');

const DEFAULT_PLAYERS = ['Gaurav','Manuj','Manish','Vivek','Chirag'];
const ELO_START = 1200;
const ELO_K = 32;

let state = { players: [...DEFAULT_PLAYERS], matches: [] };
let trendChart = null, eloChart = null;
let currentFilter = 'all';
let isSyncing = false;

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
      matches: data.matches || []
    };
  } else {
    state = { players: [...DEFAULT_PLAYERS], matches: [] };
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

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, c =>
    ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[c]
  );
}

function renderAll() {
  renderFilter();
  renderSummary();
  renderChampion();
  renderLeaderboard();
  renderHistory();
  renderChemistry();
  renderPlayersPanel();
  renderLogForm();
  renderCharts();
}

setupTabs();
setupShareModal();
document.getElementById('save-match').addEventListener('click', saveMatch);
document.getElementById('save-players').addEventListener('click', savePlayers);
document.getElementById('reset-all').addEventListener('click', resetAll);
document.getElementById('export-csv').addEventListener('click', exportCsv);
document.getElementById('reshuffle').addEventListener('click', renderRotation);
document.getElementById('filter-weekend').addEventListener('change', (e) => {
  currentFilter = e.target.value;
  renderSummary();
  renderChampion();
  renderLeaderboard();
});
