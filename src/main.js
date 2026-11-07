/*
 * The web app.
 *
 * This file has no calendar math in it. Dates, lunar days, can-chi, tiết khí, holidays and the
 * grid's own layout all come from engine/amlich.js (Hồ Ngọc Đức's published algorithm). Everything
 * here is rendering, settings and offline plumbing, and it is deliberately plain: no framework, no
 * build step, no runtime dependency, because an app that must work offline should not need a network
 * to fetch a framework.
 */
import {
  LIMITS,
  today as engineToday,
  monthTitle,
  weekdays,
  monthGrid as engineMonthGrid,
  day as engineDay,
} from './engine/amlich.js';

const $ = (id) => document.getElementById(id);
const STORAGE_KEY = 'lichongtrang.web.settings.v1';

/* ------------------------------------------------------------------ state */

function defaultSettings() {
  return { language: 'vi', weekStart: 1, zone: '7', selectedIso: null };
}

function loadSettings() {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return defaultSettings();
    return { ...defaultSettings(), ...JSON.parse(raw) };
  } catch {
    return defaultSettings();       // private mode, or corrupt: never fail to render a calendar
  }
}

function saveSettings() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
  } catch { /* storage unavailable: the app still works, it just forgets */ }
}

let settings = loadSettings();
let view = { year: 0, month: 0 };
/**
 * Zoom levels, the same three the phone has (MonthScreen.kt): '' is the month grid, 'years' a
 * twelve-year block, and 'months' one year's twelve months. Tapping the title zooms out one level and
 * picking a cell zooms back in, so this decides what the arrows step by and what the title says.
 */
let zoom = '';
let selectorYear = 0;

/* ------------------------------------------------------------------ engine glue */

function deviceOffsetHours() {
  return -new Date().getTimezoneOffset() / 60;
}

function offsetHours() {
  return settings.zone === 'device' ? deviceOffsetHours() : Number(settings.zone);
}

/** The language to render frames in: Vietnamese, English, or whatever the browser asks for. */
function language() {
  if (settings.language === 'device') {
    const nav = (navigator.language || 'vi').toLowerCase();
    return nav.startsWith('en') ? 'en' : 'vi';
  }
  return settings.language;
}

function todayIso() {
  return engineToday(Date.now(), offsetHours()).iso;
}

function monthGrid(year, month) {
  return engineMonthGrid(year, month, settings.weekStart, Date.now(), offsetHours());
}

function dayInfo(iso) {
  return engineDay(iso, offsetHours(), language());
}

/** The build row: what engine bundle this page is running against. */
async function buildText() {
  try {
    const res = await fetch('build-info.json', { cache: 'no-cache' });
    const info = await res.json();
    const engineRev = (info.engineHash || 'unknown').slice(0, 8);
    return `engine ${engineRev} · web ${info.webHash || 'dev'} · ${info.built || ''}`.trim();
  } catch {
    return 'engine · build info unavailable';
  }
}

/* ------------------------------------------------------------------ rendering */

let renderedWeekdaysKey = '';

function renderWeekdays() {
  const key = `${language()}-${settings.weekStart}`;
  if (key === renderedWeekdaysKey) return;
  renderedWeekdaysKey = key;
  const names = weekdays(language(), settings.weekStart, false);
  const strip = $('weekdays');
  strip.textContent = '';
  for (const name of names) {
    const el = document.createElement('span');
    el.textContent = name;
    strip.append(el);
  }
}

function renderTitle(grid) {
  const el = $('title');
  // A zoomed-out level titles itself, and says what tapping it does next.
  if (zoom === 'years') {
    const start = blockStart(selectorYear);
    $('title-gregorian').textContent = `${start} – ${start + 11}`;
    $('title-canchi').textContent = '';
    el.setAttribute('aria-label', language() === 'en' ? 'Tap to pick a month' : 'Chạm để chọn tháng');
    return;
  }
  if (zoom === 'months') {
    // The lunar year comes from the year's midsummer, not 1 January, which can still be in the
    // previous lunar year - the same reference the phone's selector titles itself with.
    $('title-gregorian').textContent = String(selectorYear);
    $('title-canchi').textContent = monthTitle(selectorYear, 6, language()).canChi;
    el.setAttribute('aria-label', language() === 'en' ? 'Tap to go back to the month' : 'Chạm để về lịch tháng');
    return;
  }
  const title = monthTitle(grid.year, grid.month, language());
  $('title-gregorian').textContent = title.gregorian;
  $('title-canchi').textContent = title.canChi;
  el.setAttribute('aria-label', language() === 'en' ? 'Tap for the year view' : 'Chạm để xem theo năm');
}

/** The first year of the twelve-year block a year belongs to. */
function blockStart(year) {
  return Math.floor(year / 12) * 12;
}

/** Whether the engine can compute a year at all; outside its window there is nothing to show. */
function inRange(year) {
  return year >= LIMITS.minYear && year <= LIMITS.maxYear;
}

function clampYear(year) {
  return Math.min(Math.max(year, LIMITS.minYear), LIMITS.maxYear);
}

function cellClass(cell) {
  const classes = ['cell'];
  if (!cell.isCurrentMonth) classes.push('is-outside');
  if (cell.emphasis === 'holiday') classes.push('is-holiday');
  if (cell.emphasis === 'solarTerm') classes.push('is-term');
  if (cell.emphasis === 'monthStart') classes.push('is-month-start');
  if (cell.isToday) classes.push('is-today');
  if (cell.iso === settings.selectedIso) classes.push('is-selected');
  return classes.join(' ');
}

/**
 * The small print inside a cell: the lunar day, plus the lunar month on the days the engine says
 * carry a label. Which days those are is the engine's decision, not this file's.
 */
function cellLunarText(cell) {
  if (cell.showMonthLabel) return `${cell.lunarDay}/${cell.lunarMonth}${cell.lunarLeap ? 'n' : ''}`;
  return String(cell.lunarDay);
}

function renderGrid(grid) {
  const el = $('grid');
  el.textContent = '';
  for (const cell of grid.cells) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = cellClass(cell);
    button.dataset.iso = cell.iso;
    button.setAttribute('role', 'gridcell');

    const aria = [
      `${cell.day} tháng ${cell.month} ${cell.year}`,
      cell.lunarDayText ? `âm lịch ${cell.lunarDayText.toLowerCase()}` : '',
      cell.holiday || cell.solarTerm || '',
    ].filter(Boolean).join(', ');
    button.setAttribute('aria-label', aria);
    if (cell.isToday) button.setAttribute('aria-current', 'date');
    if (cell.iso === settings.selectedIso) button.setAttribute('aria-selected', 'true');

    const solar = document.createElement('span');
    solar.className = 'cell-solar';
    solar.textContent = String(cell.day);

    const lunar = document.createElement('span');
    lunar.className = 'cell-lunar';
    lunar.textContent = cellLunarText(cell);

    button.append(solar, lunar);

    if (cell.holidayShort) {
      const tag = document.createElement('span');
      tag.className = 'cell-label';
      tag.textContent = cell.holidayShort;
      button.append(tag);
    }

    el.append(button);
  }
  el.setAttribute('aria-rowcount', String(grid.rowCount));
}

function fact(text, kind) {
  const li = document.createElement('li');
  li.className = 'fact' + (kind ? ` is-${kind}` : '');
  li.textContent = text;
  return li;
}

/**
 * The day panel. With nothing to show it keeps its place and prompts, rather than disappearing: the
 * panel sits under the calendar, so removing it reflows everything below and swiping between months
 * jumps the page up and down. The prompt is the same in every month for the same reason.
 */
function renderPanel(iso) {
  const panel = $('panel');
  const body = $('panel-body');
  const hint = $('panel-hint');
  if (!iso) {
    panel.classList.add('is-empty');
    body.hidden = true;
    hint.hidden = false;
    return;
  }
  const info = dayInfo(iso);
  if (info.error) return;

  panel.classList.remove('is-empty');
  body.hidden = false;
  hint.hidden = true;

  const facts = $('panel-facts');
  facts.textContent = '';
  // The date first: the panel describes one day, and this is the engine's own complete rendering of it
  // - lunar day, lunar month, can-chi year and zodiac. It used to be the last chip, which buried the
  // one line that says what the panel is about. The surface gives it the selected day's violet.
  facts.append(fact(info.fullDate, 'selected-date'));
  if (info.holiday) facts.append(fact(info.holiday, 'holiday'));
  if (info.solarTerm) facts.append(fact(info.solarTerm, 'term'));
  facts.append(fact(`Ngày ${info.canChiDay}`));
  facts.append(fact(info.canChiYear));
  facts.append(fact(`Tuổi ${info.zodiac}`));
  if (info.nextHoliday) {
    const { name, daysUntil, iso: when } = info.nextHoliday;
    // Styled as a holiday, because that is what it is: the engine counts down to a festival, and the
    // legend paints festivals violet and solar terms green. This chip was green, so the same festival
    // appeared in two different colours on one screen.
    facts.append(fact(
      daysUntil === 0 ? `${name} hôm nay` : `Còn ${daysUntil} ngày: ${name} (${when})`,
      'holiday'
    ));
  }
}

function renderLegend(grid) {
  const section = $('legend');
  const list = $('legend-list');
  if (!grid.legend.length) {
    section.hidden = true;
    return;
  }
  section.hidden = false;
  $('legend-title').textContent =
    language() === 'en' ? 'Holidays & solar terms this month' : 'Lễ & tiết khí trong tháng';
  list.textContent = '';
  const cellsByIso = new Map(grid.cells.map((c) => [c.iso, c]));
  for (const entry of grid.legend) {
    const li = document.createElement('li');
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'legend-item';
    button.dataset.iso = entry.iso;

    const name = document.createElement('span');
    name.className = entry.kind === 'holiday' ? 'legend-kind-holiday' : 'legend-kind-term';
    name.textContent = entry.name;

    const when = document.createElement('span');
    when.className = 'legend-date';
    // The lunar date, with the solar date in brackets - the same shape the grid cells use, so the two
    // read as one system. The numbers come from the already-computed grid cells rather than calling
    // dayInfo() again for every legend item.
    const on = cellsByIso.get(entry.iso) ?? dayInfo(entry.iso);
    const solar = `${entry.iso.slice(8, 10)}/${entry.iso.slice(5, 7)}`;
    when.textContent = on.error
      ? solar
      : `${on.lunarDay}/${on.lunarMonth}${on.lunarLeap ? 'n' : ''} (${solar})`;

    button.append(name, when);
    li.append(button);
    list.append(li);
  }
}

/** The tallest the panel has been: it keeps this height, so it cannot resize under a finger sweeping
 * through months. It only ever grows, so the layout settles after the first full panel. */
let panelFactsHeight = 0;

function syncPanelHeight() {
  // An empty panel is the same size as a full one. Measuring the panel itself rather than the facts
  // list plus guessed padding is deliberate: the facts carry their own margin and the panel its border,
  // and a few pixels out is a visible twitch every time the selection leaves the month.
  const height = $('panel').offsetHeight;
  if (height > panelFactsHeight) {
    panelFactsHeight = height;
    $('panel').style.minHeight = `${height}px`;
  }
}

let renderedMonthKey = '';

function render() {
  const grid = monthGrid(view.year, view.month);
  renderedMonthKey = `${view.year}-${view.month}`;
  renderTitle(grid);
  renderWeekdays();
  renderGrid(grid);
  renderLegend(grid);

  // The selected day is remembered across months; if it is not in view, the panel shows nothing
  // rather than pretending a day is selected.
  const inView = grid.cells.some((c) => c.iso === settings.selectedIso);
  // Whether the month on screen is the one today is in: the way back to today is offered only when
  // the view is somewhere else. The panel does not depend on this - it keeps its place and prompts in
  // every month, so nothing below it shifts as you swipe.
  const today = todayIso();
  const away = view.year !== Number(today.slice(0, 4)) || view.month !== Number(today.slice(5, 7));
  renderPanel(inView ? settings.selectedIso : null);
  syncPanelHeight();
  renderTodayButton(away);
  updateSettingsUi();
  // Last, because it covers the month view: hiding the weekday strip, the grid and the day panel is
  // the selector's own business, and the panel above has just been measured.
  renderSelector();
}

/** The "back to today" pill, shown only when the view is away from the current month. */
function renderTodayButton(away) {
  const button = $('today-button');
  const english = language() === 'en';
  button.hidden = !away;
  button.textContent = english ? 'Today' : 'Hôm nay';
  button.setAttribute('aria-label', english ? 'Go to today' : 'Về hôm nay');
  document.body.classList.toggle('is-away', away);
}

/* ------------------------------------------------------ zoomed-out levels */

/**
 * The two zoomed-out levels, drawn into one grid of twelve, four to a row - the same shape the phone
 * uses for both (YearBlockSelector / YearSelector in MonthScreen.kt).
 *
 * This replaces a "year view" that never had any styles of its own: it appended twelve month blocks,
 * each holding its own twenty-eight to thirty-one day buttons, to the element the month grid uses, so
 * a tap on the title rendered three hundred and sixty-five numbers into seven columns, run together
 * inside fifty-pixel boxes. Nothing like a month or a year could be picked from it, and no check
 * looked, so it shipped. The level's cells are drawn here from scratch, and the levels are the phone's
 * three rather than one improvised one.
 */
function renderSelector() {
  const el = $('selector');
  const open = zoom !== '';
  el.hidden = !open;
  // Set on the body rather than as `hidden` on each part: the weekday strip, the grid and the panel
  // already carry a `display` from a rule of their own, and `hidden` loses to those.
  document.body.classList.toggle('is-zoomed', open);
  if (!open) {
    // Emptied rather than left hidden: a stale level in the tree is a reading waiting to be misread,
    // and the count of its cells is the first thing a check reaches for.
    el.textContent = '';
    return;
  }

  const english = language() === 'en';
  el.setAttribute('aria-label', english
    ? (zoom === 'years' ? 'Pick a year' : 'Pick a month')
    : (zoom === 'years' ? 'Chọn năm' : 'Chọn tháng'));
  el.textContent = '';

  // Twelve years of the block the selector year is in, or the twelve months of the selector year.
  const values = [];
  if (zoom === 'years') {
    const start = blockStart(selectorYear);
    for (let i = 0; i < 12; i += 1) values.push(start + i);
  } else {
    for (let i = 1; i <= 12; i += 1) values.push(i);
  }

  for (const value of values) {
    const button = document.createElement('button');
    button.type = 'button';
    button.className = 'selector-cell';
    button.setAttribute('role', 'gridcell');
    if (zoom === 'years') {
      button.dataset.pickYear = String(value);
      // The engine's window ends; the years past it are shown, because a block with holes in it would
      // read as a fault, but they cannot be picked.
      button.disabled = !inRange(value);
      button.textContent = String(value);
      if (value === view.year) button.classList.add('is-current');
    } else {
      const title = monthTitle(selectorYear, value, language());
      button.dataset.pickMonth = String(value);
      // The engine's own title for the month, less the year: the year is the header above, and the
      // name has to fit a cell on one line. The full title stays as the accessible name.
      button.textContent = title.gregorian.replace(/\s+\d{4}$/, '');
      button.setAttribute('aria-label', title.gregorian);
      if (selectorYear === view.year && value === view.month) button.classList.add('is-current');
    }
    el.append(button);
  }
}

/* ------------------------------------------------------------------ interaction */

function shiftMonth(delta) {
  let { year, month } = view;
  month += delta;
  while (month > 12) { month -= 12; year += 1; }
  while (month < 1) { month += 12; year -= 1; }
  if (!inRange(year)) return;
  view = { year, month };
  render();
}

/** The arrows step by whatever unit is on screen: a month, a year, or a whole twelve-year block. */
function shiftZoom(delta) {
  if (zoom === '') {
    shiftMonth(delta);
    return;
  }
  selectorYear = clampYear(selectorYear + delta * (zoom === 'years' ? 12 : 1));
  render();
}

/** Tapping the title zooms out one level at a time, and comes back round to the month grid. */
function cycleZoom() {
  if (zoom === '') {
    selectorYear = view.year;
    zoom = 'years';
  } else if (zoom === 'years') {
    zoom = 'months';
  } else {
    zoom = '';
  }
  render();
}

/** One level closer to the grid: a year's months, then the block, then the grid. */
function stepOut() {
  if (zoom === '') return false;
  zoom = zoom === 'months' ? 'years' : '';
  render();
  return true;
}

function selectDay(iso) {
  const prevIso = settings.selectedIso;
  settings.selectedIso = iso;
  saveSettings();
  const gridEl = $('grid');
  const sameMonthRendered = zoom === '' && renderedMonthKey === `${view.year}-${view.month}`;
  const nextCell = sameMonthRendered ? gridEl.querySelector(`.cell[data-iso="${iso}"]`) : null;
  if (nextCell) {
    if (prevIso && prevIso !== iso) {
      const prevCell = gridEl.querySelector(`.cell[data-iso="${prevIso}"]`);
      if (prevCell) {
        prevCell.classList.remove('is-selected');
        prevCell.removeAttribute('aria-selected');
      }
    }
    nextCell.classList.add('is-selected');
    nextCell.setAttribute('aria-selected', 'true');
    renderPanel(iso);
    syncPanelHeight();
    return;
  }
  render();
}

function updateSettingsUi() {
  for (const button of document.querySelectorAll('[data-language]')) {
    button.setAttribute('aria-checked', String(button.dataset.language === settings.language));
  }
  for (const button of document.querySelectorAll('[data-weekstart]')) {
    button.setAttribute('aria-checked', String(Number(button.dataset.weekstart) === settings.weekStart));
  }
  for (const button of document.querySelectorAll('[data-zone]')) {
    button.setAttribute('aria-checked', String(button.dataset.zone === settings.zone));
  }
}

/**
 * The drawer and the two dialogs, the button that opens each one, and the fact that only one is open at
 * a time. They share one backdrop, and a `null` id closes whatever is open.
 *
 * Two mechanisms, deliberately: the drawer is slid off-screen rather than hidden, so it can come in from
 * the edge, and `visibility` is what keeps its buttons out of the tab order while it is away. A dialog
 * is simply hidden.
 */
const PANELS = [
  { id: 'menu', opener: 'menu-button', slides: true },
  { id: 'sheet', opener: 'menu-settings' },
  { id: 'about', opener: 'menu-about' },
];

function openPanel(id) {
  for (const panel of PANELS) {
    const open = panel.id === id;
    if (panel.slides) $(panel.id).classList.toggle('is-open', open);
    else $(panel.id).hidden = !open;
    $(panel.opener).setAttribute('aria-expanded', String(open));
  }
  $('sheet-backdrop').hidden = id === null;
  // Filled when the About dialog opens rather than at load: it is a fetch, and a row reading "…" for a
  // moment is worse than one that appears already answered.
  if (id === 'about') {
    buildText().then((text) => { $('build-row').textContent = text; });
  }
}

async function copyBuildRow() {
  const text = $('build-row').textContent;
  try {
    await navigator.clipboard.writeText(text);
    $('build-row').textContent = 'Đã sao chép ✓';
    setTimeout(() => { $('build-row').textContent = text; }, 1200);
  } catch {
    const range = document.createRange();
    range.selectNodeContents($('build-row'));
    const selection = window.getSelection();
    selection.removeAllRanges();
    selection.addRange(range);
  }
}

/* ------------------------------------------------------------------ wiring */

document.addEventListener('click', (event) => {
  // The zoomed-out levels, handled before the day cells: a year opens its own twelve months, a month
  // opens its grid. Picking is what zooms back in, exactly as it does on the phone.
  const yearCell = event.target.closest('[data-pick-year]');
  if (yearCell) {
    selectorYear = Number(yearCell.dataset.pickYear);
    zoom = 'months';
    render();
    return;
  }
  const monthCell = event.target.closest('[data-pick-month]');
  if (monthCell) {
    view = { year: selectorYear, month: Number(monthCell.dataset.pickMonth) };
    zoom = '';
    render();
    return;
  }
  const cell = event.target.closest('.cell, [data-iso]');
  if (cell && cell.dataset.iso) {
    // A click this soon after a swipe is the tail of that drag, not a choice of day.
    if (Date.now() - swipedAt < 500) return;
    zoom = '';
    selectDay(cell.dataset.iso);
    return;
  }
  const language = event.target.closest('[data-language]');
  if (language) {
    settings.language = language.dataset.language;
    saveSettings();
    render();
    return;
  }
  const weekstart = event.target.closest('[data-weekstart]');
  if (weekstart) {
    settings.weekStart = Number(weekstart.dataset.weekstart);
    saveSettings();
    render();
    return;
  }
  const zone = event.target.closest('[data-zone]');
  if (zone) {
    settings.zone = zone.dataset.zone;
    saveSettings();
    render();
    return;
  }
  if (event.target.closest('#prev')) shiftZoom(-1);
  else if (event.target.closest('#next')) shiftZoom(1);
  // Back to today: the view moves to today's month and today becomes the selected day, so the panel
  // describes it. Any zoom level is closed, because a keyboard user can reach this button with a
  // selector open behind it, and landing on a month under a twelve-year block would be disorienting.
  else if (event.target.closest('#today-button')) {
    const today = todayIso();
    view = { year: Number(today.slice(0, 4)), month: Number(today.slice(5, 7)) };
    zoom = '';
    selectDay(today);
  }
  else if (event.target.closest('#menu-button')) openPanel('menu');
  else if (event.target.closest('#menu-settings')) openPanel('sheet');
  else if (event.target.closest('#menu-about')) openPanel('about');
  else if (event.target.closest('#menu-close') || event.target.closest('#about-close')) openPanel(null);
  else if (event.target.closest('#sheet-close') || event.target.closest('#sheet-backdrop')) openPanel(null);
  else if (event.target.closest('#title')) cycleZoom();
});

$('build-row').addEventListener('dblclick', copyBuildRow);
// Long-press, the way the phone's build row copies.
let pressTimer = null;
$('build-row').addEventListener('pointerdown', () => {
  pressTimer = setTimeout(copyBuildRow, 550);
});
for (const done of ['pointerup', 'pointercancel', 'pointerleave']) {
  $('build-row').addEventListener(done, () => clearTimeout(pressTimer));
}

document.addEventListener('keydown', (event) => {
  if (event.key === 'Escape') {
    // Escape steps one zoom level closer before it closes the menu, the settings or the credits.
    if (!stepOut()) openPanel(null);
    return;
  }
  if (event.target.closest('#sheet')) return;
  // The page keys step by whatever unit is on screen, the same as the arrows do.
  if (event.key === 'PageUp') { shiftZoom(-1); event.preventDefault(); return; }
  if (event.key === 'PageDown') { shiftZoom(1); event.preventDefault(); return; }
  const iso = settings.selectedIso;
  if (!iso) return;
  const step = { ArrowLeft: -1, ArrowRight: 1, ArrowUp: -7, ArrowDown: 7 }[event.key];
  if (step === undefined) return;
  event.preventDefault();
  const date = new Date(`${iso}T12:00:00Z`);
  date.setUTCDate(date.getUTCDate() + step);
  const next = date.toISOString().slice(0, 10);
  const [y, m] = [Number(next.slice(0, 4)), Number(next.slice(5, 7))];
  if (y !== view.year || m !== view.month) {
    if (!inRange(y)) return;
    view = { year: y, month: m };
  }
  // Moving the day selection is picking a day, so it zooms back in the way a cell does.
  zoom = '';
  selectDay(next);
});

// Swipe to change month, which is how a phone user expects a calendar to move. Pointer events rather
// than touch events, so a mouse drag does the same thing and the gesture can be measured in a browser
// instead of only on a phone.
//
// Two bars have to be cleared before a drag counts as a swipe: 60px across, and more horizontal than
// vertical, so an ordinary sideways-ish scroll never changes the month. The click the browser then
// fires is ignored below, otherwise the same gesture would also select whichever day it started on.
const SWIPE_MIN_PX = 60;
let dragFrom = null;
let swipedAt = 0;

$('grid').addEventListener('pointerdown', (event) => {
  dragFrom = event.isPrimary ? { x: event.clientX, y: event.clientY } : null;
});
$('grid').addEventListener('pointercancel', () => { dragFrom = null; });
$('grid').addEventListener('pointerup', (event) => {
  const from = dragFrom;
  dragFrom = null;
  if (!from) return;
  const dx = event.clientX - from.x;
  const dy = event.clientY - from.y;
  if (Math.abs(dx) < SWIPE_MIN_PX || Math.abs(dx) <= Math.abs(dy)) return;
  swipedAt = Date.now();
  shiftMonth(dx < 0 ? 1 : -1);
});

/* ------------------------------------------------------------------ offline */

// Ask for persistent storage, where the browser offers it. No browser promises to grant it, and Safari
// does not implement the request at all - but where it is granted, the offline cache stops being the
// first thing evicted, which decides whether an installed app still opens offline next week.
navigator.storage?.persist?.().catch(() => {});

function setOfflineBadge() {
  const badge = $('offline-badge');
  // The label is set whenever the badge is considered at all. Shown without it, all that is left is the
  // pill's own background and radius: an unlabelled dark bar floating over the calendar.
  badge.textContent = language() === 'en'
    ? 'Offline — the calendar still works'
    : 'Đang ngoại tuyến — lịch vẫn chạy';
  if (navigator.onLine) {
    badge.hidden = true;
  } else {
    badge.hidden = false;
  }
}

window.addEventListener('online', setOfflineBadge);
window.addEventListener('offline', setOfflineBadge);

if ('serviceWorker' in navigator) {
  navigator.serviceWorker.register('sw.js').then((registration) => {
    // "Ready" is the honest moment to claim offline works: it means the shell is cached.
    navigator.serviceWorker.ready.then(() => {
      // The same path the online/offline events use, so the badge can never appear without its label.
      setOfflineBadge();
    });
    registration.addEventListener('updatefound', () => {
      // A new version is being cached; it will apply on the next load. Nothing to interrupt.
    });
  }).catch(() => {
    // No service worker: the app still works, it just needs the network each time.
  });
}

/* ------------------------------------------------------------------ start */

const today = todayIso();
view = { year: clampYear(Number(today.slice(0, 4))), month: Number(today.slice(5, 7)) };
if (!settings.selectedIso) settings.selectedIso = today;

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', () => { setOfflineBadge(); render(); });
} else {
  setOfflineBadge();
  render();
}
