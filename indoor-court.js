// ── Indoor court assist (East Brunswick Racquet Club) ─────────────────────
// Assist mode only: when weekend weather looks risky, suggest an indoor slot
// and link to the club's booking site. No automation — Club Automation's terms
// prohibit automated access, so the organizer books by hand.
// Self-contained (no imports) so app.js keeps working if this logic misbehaves.

export const EBRC = {
  name: 'East Brunswick Racquet Club',
  bookingUrl: 'https://ebrctennis.clubautomation.com/',
  weekendRate: 60,          // $/hour, Sat & Sun open to close
  cardFeeRate: 0.0325,      // 3.25% on card transactions
  bookingWindowDays: 7,     // open court bookable up to 1 week ahead
  cancelNoticeHours: 24     // < 24h notice or no-show = full charge
};

export const SUGGESTED_START_HOUR = 8;
export const SUGGESTED_HOURS = 2;
export const PLAYERS_PER_COURT = 4;
const RAIN_RISK_PCT = 30;

// Risky = the morning verdict isn't "great" for a real weather reason:
// bad verdict, orange wind, or a 30%+ rain chance.
export function isRiskyWeather({ verdictRank, windTier, peakRain }) {
  return verdictRank === 'bad' || windTier === 'orange' || (peakRain ?? 0) >= RAIN_RISK_PCT;
}

function hourLabel(h) {
  const suffix = h >= 12 ? 'PM' : 'AM';
  const h12 = h % 12 === 0 ? 12 : h % 12;
  return `${h12} ${suffix}`;
}

function fmtDay(d) {
  return d.toLocaleDateString('en-US', { weekday: 'short', month: 'short', day: 'numeric' });
}

function fmtDayTime(d) {
  return `${fmtDay(d)}, ${hourLabel(d.getHours())}`;
}

// dateStr is "YYYY-MM-DD" in club-local time. `now` is injectable for tests.
export function indoorCourtPlan(dateStr, now = new Date(), startHour = SUGGESTED_START_HOUR, hours = SUGGESTED_HOURS) {
  const [y, m, d] = dateStr.split('-').map(Number);
  const start = new Date(y, m - 1, d, startHour, 0, 0, 0);
  const end = new Date(y, m - 1, d, startHour + hours, 0, 0, 0);
  const cancelBy = new Date(start.getTime() - EBRC.cancelNoticeHours * 3600 * 1000);
  const opensOn = new Date(y, m - 1, d - EBRC.bookingWindowDays);

  const base = EBRC.weekendRate * hours;
  const total = Math.round(base * (1 + EBRC.cardFeeRate) * 100) / 100;
  const perPlayer = Math.round((total / PLAYERS_PER_COURT) * 100) / 100;

  let bookingState;
  if (now >= start) bookingState = 'past';
  else if (now < opensOn) bookingState = 'not-yet';
  else if (now >= cancelBy) bookingState = 'late';
  else bookingState = 'open';

  return {
    dateStr, start, end, hours, cancelBy, opensOn, bookingState,
    base, total, perPlayer,
    dayLabel: fmtDay(start),
    timeLabel: `${hourLabel(startHour)} – ${hourLabel(startHour + hours)}`,
    cancelByLabel: fmtDayTime(cancelBy),
    opensOnLabel: fmtDay(opensOn)
  };
}

const money = (n) => `$${n.toFixed(2)}`;

export function renderIndoorCourtHtml(plan) {
  if (!plan || plan.bookingState === 'past') return '';
  const windowLine = plan.bookingState === 'not-yet'
    ? `📅 Booking opens 1 week ahead — around <strong>${plan.opensOnLabel}</strong>.`
    : plan.bookingState === 'late'
      ? `⚠️ Less than 24h to go — a booking now <strong>can't be cancelled</strong> without the full charge.`
      : `📅 Booking window is open (up to 1 week ahead).`;
  return `
    <div class="ic-card" data-indoor-court="${plan.dateStr}">
      <div class="ic-title">🏟️ Indoor backup · EBRC</div>
      <div class="ic-slot">Suggested: <strong>${plan.dayLabel} · ${plan.timeLabel}</strong> (${plan.hours}h)</div>
      <div class="ic-line">💵 ${money(plan.total)} incl. 3.25% card fee · ≈ ${money(plan.perPlayer)} each for ${PLAYERS_PER_COURT}</div>
      <div class="ic-line">${windowLine}</div>
      <div class="ic-line">⏰ Cancel by <strong>${plan.cancelByLabel}</strong> or pay in full (no-shows too).</div>
      <button type="button" class="ic-open-btn">Find an indoor court ↗</button>
      <div class="ic-note">Opens Club Automation in a new tab — log in and book there.</div>
    </div>`;
}

// Null-safe: does nothing if the card isn't in `root`.
export function wireIndoorCourt(root, openFn = (url) => window.open(url, '_blank', 'noopener')) {
  const btn = root?.querySelector?.('.ic-open-btn');
  if (!btn) return;
  btn.addEventListener('click', () => openFn(EBRC.bookingUrl));
}
