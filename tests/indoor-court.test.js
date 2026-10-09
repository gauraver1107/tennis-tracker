import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { JSDOM } from 'jsdom';
import {
  EBRC, isRiskyWeather, indoorCourtPlan, renderIndoorCourtHtml, wireIndoorCourt
} from '../indoor-court.js';

// Saturday 2026-10-17, suggested 8-10 AM. Times are local (TZ pinned in npm test).
const SAT = '2026-10-17';
const at = (y, m, d, h = 12) => new Date(y, m - 1, d, h);

// ── Risk detection ──────────────────────────────────────────────────────────
test('risky: bad verdict, orange wind, or 30%+ rain', () => {
  assert.equal(isRiskyWeather({ verdictRank: 'bad', windTier: 'green', peakRain: 0 }), true);
  assert.equal(isRiskyWeather({ verdictRank: 'great', windTier: 'orange', peakRain: 0 }), true);
  assert.equal(isRiskyWeather({ verdictRank: 'ok', windTier: 'green', peakRain: 30 }), true);
});

test('not risky: great/ok verdict with calm wind and low rain', () => {
  assert.equal(isRiskyWeather({ verdictRank: 'great', windTier: 'green', peakRain: 10 }), false);
  assert.equal(isRiskyWeather({ verdictRank: 'ok', windTier: 'yellow', peakRain: 29 }), false);
  assert.equal(isRiskyWeather({ verdictRank: 'ok', windTier: undefined, peakRain: undefined }), false);
});

// ── Plan: price, deadlines, booking window ─────────────────────────────────
test('price: 2h weekend at $60/h plus 3.25% card fee', () => {
  const p = indoorCourtPlan(SAT, at(2026, 10, 12));
  assert.equal(p.base, 120);
  assert.equal(p.total, 123.9);
  assert.equal(p.perPlayer, 30.98);
  assert.equal(p.timeLabel, '8 AM – 10 AM');
});

test('cancel deadline is 24h before start', () => {
  const p = indoorCourtPlan(SAT, at(2026, 10, 12));
  assert.equal(p.start.getTime() - p.cancelBy.getTime(), 24 * 3600 * 1000);
  assert.equal(p.cancelByLabel, 'Fri, Oct 16, 8 AM');
});

test('cancel deadline is a true 24h across the DST change', () => {
  // Sun Nov 1 2026: clocks fall back at 2 AM in New York.
  const p = indoorCourtPlan('2026-11-01', at(2026, 10, 28));
  assert.equal(p.start.getTime() - p.cancelBy.getTime(), 24 * 3600 * 1000);
  assert.equal(p.cancelByLabel, 'Sat, Oct 31, 9 AM');
});

test('booking window states: not-yet, open, late, past', () => {
  assert.equal(indoorCourtPlan(SAT, at(2026, 10, 9)).bookingState, 'not-yet');
  assert.equal(indoorCourtPlan(SAT, at(2026, 10, 10, 0)).bookingState, 'open');
  assert.equal(indoorCourtPlan(SAT, at(2026, 10, 16, 9)).bookingState, 'late');
  assert.equal(indoorCourtPlan(SAT, at(2026, 10, 17, 8)).bookingState, 'past');
  assert.equal(indoorCourtPlan(SAT, at(2026, 10, 9)).opensOnLabel, 'Sat, Oct 10');
});

// ── Rendering: each state ───────────────────────────────────────────────────
test('render not-yet: shows when booking opens', () => {
  const html = renderIndoorCourtHtml(indoorCourtPlan(SAT, at(2026, 10, 9)));
  assert.match(html, /Booking opens 1 week ahead/);
  assert.match(html, /Sat, Oct 10/);
});

test('render open: shows price, cancel deadline and button', () => {
  const html = renderIndoorCourtHtml(indoorCourtPlan(SAT, at(2026, 10, 12)));
  assert.match(html, /Booking window is open/);
  assert.match(html, /\$123\.90 incl\. 3\.25% card fee/);
  assert.match(html, /Cancel by <strong>Fri, Oct 16, 8 AM<\/strong>/);
  assert.match(html, /class="ic-open-btn"/);
});

test('render late: warns that cancellation will be charged', () => {
  const html = renderIndoorCourtHtml(indoorCourtPlan(SAT, at(2026, 10, 16, 9)));
  assert.match(html, /Less than 24h to go/);
});

test('render past or missing plan: nothing', () => {
  assert.equal(renderIndoorCourtHtml(indoorCourtPlan(SAT, at(2026, 10, 17, 9))), '');
  assert.equal(renderIndoorCourtHtml(null), '');
});

test('render uses no inline handlers', () => {
  const html = renderIndoorCourtHtml(indoorCourtPlan(SAT, at(2026, 10, 12)));
  assert.doesNotMatch(html, /onclick/i);
});

// ── DOM wiring (jsdom) ──────────────────────────────────────────────────────
function makeBox(html) {
  const dom = new JSDOM('<!doctype html><div id="weekend-coordinator"></div>');
  const box = dom.window.document.getElementById('weekend-coordinator');
  box.innerHTML = html;
  return box;
}

test('button opens the club booking site in a new tab', () => {
  const box = makeBox(renderIndoorCourtHtml(indoorCourtPlan(SAT, at(2026, 10, 12))));
  const opened = [];
  wireIndoorCourt(box, (url) => opened.push(url));
  box.querySelector('.ic-open-btn').click();
  assert.deepEqual(opened, [EBRC.bookingUrl]);
});

test('default opener uses _blank + noopener', () => {
  const box = makeBox(renderIndoorCourtHtml(indoorCourtPlan(SAT, at(2026, 10, 12))));
  const calls = [];
  const realWindow = globalThis.window;
  globalThis.window = { open: (...args) => calls.push(args) };
  try {
    wireIndoorCourt(box);
    box.querySelector('.ic-open-btn').click();
  } finally {
    globalThis.window = realWindow;
  }
  assert.deepEqual(calls, [[EBRC.bookingUrl, '_blank', 'noopener']]);
});

test('wiring is null-safe: no card, no root', () => {
  assert.doesNotThrow(() => wireIndoorCourt(makeBox('<div>calm weekend</div>')));
  assert.doesNotThrow(() => wireIndoorCourt(null));
  assert.doesNotThrow(() => wireIndoorCourt(undefined));
});

test('re-render does not stack cards or click handlers', () => {
  const html = renderIndoorCourtHtml(indoorCourtPlan(SAT, at(2026, 10, 12)));
  const box = makeBox('');
  const opened = [];
  // renderWeekendCoordinator replaces box.innerHTML then wires, every time.
  for (let i = 0; i < 3; i++) {
    box.innerHTML = `<div class="wc-right">${html}</div>`;
    wireIndoorCourt(box, (url) => opened.push(url));
  }
  assert.equal(box.querySelectorAll('.ic-card').length, 1);
  box.querySelector('.ic-open-btn').click();
  assert.equal(opened.length, 1);
});

// ── Project guards ──────────────────────────────────────────────────────────
const root = new URL('../', import.meta.url);

test('app.js loads indoor-court.js only via guarded dynamic import', () => {
  const app = readFileSync(new URL('app.js', root), 'utf8');
  const staticImport = /^import\s[^;(]*from\s*['"]\.\/indoor-court\.js['"]/m.test(app);
  const guardedDynamic = /import\('\.\/indoor-court\.js'\)[\s\S]{0,200}\.catch\(/.test(app);
  assert.equal(staticImport, false, 'app.js must not statically import indoor-court.js');
  assert.equal(guardedDynamic, true, 'app.js must import indoor-court.js dynamically with .catch');
});

test('styles.css is pure ASCII', () => {
  const css = readFileSync(new URL('styles.css', root));
  const bad = [...css].findIndex(b => b > 0x7e || (b < 0x20 && b !== 0x0a && b !== 0x0d && b !== 0x09));
  assert.equal(bad, -1, `non-ASCII byte at offset ${bad}`);
});

test('.gitignore keeps env files out of git', () => {
  const gi = readFileSync(new URL('.gitignore', root), 'utf8');
  assert.match(gi, /^\.env$/m);
  assert.match(gi, /^\.env\.\*$/m);
});
