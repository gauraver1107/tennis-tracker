<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0, maximum-scale=1.0, user-scalable=no">
<meta name="theme-color" content="#1D9E75">
<title>Weekend Tennis Tracker</title>
<link rel="stylesheet" href="styles.css">
<link rel="icon" href="data:image/svg+xml,<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 100 100'><text y='.9em' font-size='90'>🎾</text></svg>">
</head>
<body>

<header>
  <h1>🎾 Weekend tennis</h1>
  <div class="status" id="sync-status">Connecting…</div>
</header>

<nav class="tabs" id="tabs">
  <button data-tab="dashboard" class="tab-active">Dashboard</button>
  <button data-tab="log">Log match</button>
  <button data-tab="weather">Weather</button>
  <button data-tab="history">History</button>
  <button data-tab="chemistry">Partners</button>
  <button data-tab="players">Players</button>
</nav>

<main>

  <section id="panel-dashboard" class="panel">
    <div id="ai-ticker-wrap" class="ticker-wrap hidden">
      <div class="ticker-track">
        <div class="ticker-content" id="ai-ticker"></div>
      </div>
      <button id="ticker-refresh" class="ticker-refresh" title="Generate new messages">↺</button>
    </div>
    <div class="controls-row">
      <label>View</label>
      <select id="filter-weekend"></select>
      <button id="export-csv" class="btn-small">Export CSV</button>
    </div>
    <div class="badge-row">
      <div id="champion-badge" class="champion-hidden"></div>
      <div id="king-badge" class="champion-hidden"></div>
    </div>
    <div id="power-rankings"></div>
    <div id="season-banner" class="season-banner"></div>
    <div id="weekend-coordinator"></div>
    <div class="summary-grid" id="summary-cards"></div>
    <h3>ELO Leaderboard</h3>
    <div class="chart-wrap tall"><canvas id="eloBarChart" aria-label="ELO leaderboard"></canvas></div>
    <h3>Win Rate</h3>
    <div class="chart-wrap"><canvas id="winRateBarChart" aria-label="Win rate per player"></canvas></div>
  </section>

  <section id="panel-log" class="panel hidden">

    <!-- Voice entry card -->
    <div class="card voice-card">
      <div class="voice-header">
        <div>
          <div class="voice-title">🎙️ Voice entry</div>
          <div class="voice-sub">Speak the match naturally — Claude will parse it</div>
        </div>
        <button id="voice-btn" class="voice-btn" title="Tap to speak">🎤</button>
      </div>
      <div id="voice-transcript" class="voice-transcript hidden"></div>
      <div id="voice-parsed" class="voice-parsed hidden"></div>
      <div id="voice-error" class="error hidden"></div>
      <div class="voice-examples">
        Try: <em>"Chirag Manuj vs Manish Gaurav 6-3, 6-4"</em> or <em>"We beat them six three"</em>
      </div>
    </div>

    <!-- Manual entry card -->
    <div class="card">
      <div class="form-grid-2">
        <div>
          <label>Date</label>
          <input type="date" id="match-date">
        </div>
        <div>
          <label>Sets format</label>
          <select id="sets-format">
            <option value="1">Best of 1</option>
            <option value="3" selected>Best of 3</option>
            <option value="5">Best of 5</option>
          </select>
        </div>
      </div>
      <label>Team A</label>
      <div class="form-grid-2">
        <select id="a1"></select>
        <select id="a2"></select>
      </div>
      <label>Team B</label>
      <div class="form-grid-2">
        <select id="b1"></select>
        <select id="b2"></select>
      </div>
      <div id="sets-container"></div>
      <label>Notes (optional)</label>
      <textarea id="match-notes" rows="2" placeholder="Memorable rally, weather, injuries..."></textarea>
      <div id="sitting-out" class="hint"></div>
      <div id="form-error" class="error hidden"></div>
      <button id="save-match" class="btn-primary">Save match</button>
    </div>
  </section>

  <section id="panel-rotation" class="panel hidden">
    <p class="hint">Suggested lineup balancing rest, partner variety, and ELO-based team strength.</p>
    <div id="rotation-suggestion"></div>
    <button id="reshuffle" class="btn-primary">Shuffle again</button>
  </section>

  <section id="panel-weather" class="panel hidden">
    <div class="card">
      <label>Where do you play?</label>
      <div class="location-row">
        <input type="text" id="location-name" placeholder="e.g., Edison, NJ" value="Edison, NJ">
        <button id="save-location" class="btn-small">Update</button>
      </div>
      <p class="hint" style="margin-top:10px">Forecast powered by Open-Meteo. No account needed.</p>
    </div>
    <div id="weather-play-advice"></div>
    <h3>7-day forecast</h3>
    <div id="weather-forecast"></div>
    <h3>Hourly morning forecast (6 AM – 12 PM)</h3>
    <div class="chart-wrap"><canvas id="weatherChart"></canvas></div>
  </section>

  <section id="panel-photos" class="panel hidden">
    <div class="card">
      <label>Upload this weekend's photo</label>
      <p class="hint" style="margin-top:0">One photo per weekend — the team moment, trophy shot, or just everyone's smiles. Auto-compressed to keep it fast.</p>
      <div class="photo-upload-row">
        <select id="photo-uploader"></select>
        <input type="file" id="photo-file" accept="image/*" capture="environment">
      </div>
      <div id="photo-preview" class="photo-preview hidden"></div>
      <div id="photo-error" class="error hidden"></div>
      <button id="photo-upload-btn" class="btn-primary">Upload photo</button>
    </div>
    <h3>Photo timeline</h3>
    <div id="photo-timeline"></div>
  </section>

  <section id="panel-history" class="panel hidden">
    <h3>ELO Rating History</h3>
    <div class="chart-wrap"><canvas id="eloChart"></canvas></div>
    <div id="eloLegend" class="chart-legend-row"></div>
    <h3>Matches</h3>
    <div id="history-list"></div>
  </section>

  <section id="panel-chemistry" class="panel hidden">
    <p class="hint">Win rate for every pairing that has played together.</p>
    <div id="chemistry-list"></div>
  </section>

  <section id="panel-players" class="panel hidden">
    <div class="card">
      <p class="hint">Edit player names and tap 📷 to set a profile photo. Changes sync to all devices.</p>
      <div id="player-inputs"></div>
      <button id="save-players" class="btn-primary">Save names</button>
    </div>
  </section>

</main>

<div id="share-modal" class="modal hidden">
  <div class="modal-content">
    <h3>Match saved! 🎾</h3>
    <p>Share to WhatsApp group?</p>
    <textarea id="share-text" rows="6"></textarea>
    <div class="modal-actions">
      <button id="share-whatsapp" class="btn-primary">Open WhatsApp</button>
      <button id="share-copy" class="btn-small">Copy text</button>
      <button id="share-dismiss" class="btn-small">Skip</button>
    </div>
  </div>
</div>

<div id="vote-share-modal" class="modal hidden">
  <div class="modal-content">
    <h3>Share your vote 📣</h3>
    <p>Let the group know you've voted!</p>
    <textarea id="vote-share-text" rows="7"></textarea>
    <div class="modal-actions">
      <button id="vote-share-whatsapp" class="btn-primary">Open WhatsApp</button>
      <button id="vote-share-copy" class="btn-small">Copy</button>
      <button id="vote-share-dismiss" class="btn-small">Skip</button>
    </div>
  </div>
</div>

<div id="apikey-modal" class="modal hidden">
  <div class="modal-content">
    <h3>🎙️ Anthropic API key needed</h3>
    <p>Voice parsing uses Claude AI. Enter your Anthropic API key once — it will be shared across all group members' devices automatically via Firebase.</p>
    <label>API key</label>
    <input type="password" id="apikey-input" placeholder="sk-ant-...">
    <div style="font-size:12px;color:var(--text-muted);margin-top:6px">Get a free key at <strong>console.anthropic.com</strong> · Set a $1/month spend limit · Saved once for everyone 🎾</div>
    <div class="modal-actions" style="margin-top:12px">
      <button id="apikey-save" class="btn-primary" style="width:auto;flex:1;margin-top:0">Save & parse</button>
      <button id="apikey-cancel" class="btn-small">Cancel</button>
    </div>
  </div>
</div>

<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
<script type="module" src="app.js"></script>

</body>
</html>
