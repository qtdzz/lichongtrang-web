import { readFile } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { test, expect } from '@playwright/test';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = join(ROOT, 'dist');

test('renders calendar, handles interactions, matches all 11 visual baselines, and works offline', async ({ page, context }, testInfo) => {
  const isChromium = testInfo.project.name === 'chromium';

  // Freeze time to 2026-09-28 12:00 UTC+7 (Mid-Autumn Festival week) so screenshots and calendar
  // states are 100% deterministic across runs, and stub navigator.storage.persist() to record its call.
  await context.addInitScript(() => {
    const FROZEN_MS = 1790571600000; // 2026-09-28T05:00:00.000Z
    const OriginalDate = Date;
    class FrozenDate extends OriginalDate {
      constructor(...args) {
        super(...(args.length === 0 ? [FROZEN_MS] : args));
      }
      static now() {
        return FROZEN_MS;
      }
    }
    globalThis.Date = FrozenDate;

    window.__persistAsked = false;
    const storage = navigator.storage ?? {};
    storage.persisted = () => Promise.resolve(false);
    storage.persist = () => {
      window.__persistAsked = true;
      return Promise.resolve(true);
    };
    if (navigator.storage !== storage) Object.defineProperty(navigator, 'storage', { value: storage });
  });

  async function snap(name, { stabilizeBuildRow = false } = {}) {
    if (!isChromium) return;
    await page.evaluate(() => window.scrollTo(0, 0));
    let previousBuildText = null;
    if (stabilizeBuildRow) {
      previousBuildText = await page.evaluate(() => {
        const el = document.getElementById('build-row');
        const prev = el?.textContent ?? null;
        if (el) el.textContent = 'engine baseline · web baseline · 2026-09-28T05:00:00Z';
        return prev;
      });
    }
    await expect(page).toHaveScreenshot(name);
    if (stabilizeBuildRow && previousBuildText !== null) {
      await page.evaluate((prev) => {
        const el = document.getElementById('build-row');
        if (el) el.textContent = prev;
      }, previousBuildText);
    }
  }

  const noise = [];
  let wentOffline = false;
  page.on('console', (m) => {
    if (m.type() === 'error') noise.push(`console error: ${m.text()}`);
  });
  page.on('pageerror', (e) => noise.push(`page error: ${e.message}`));
  page.on('requestfailed', (r) => {
    if (!wentOffline) noise.push(`request failed: ${r.url()} (${r.failure()?.errorText})`);
  });

  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.cell-lunar', { timeout: 15000 });

  const todayCell = page.locator('.cell.is-today').first();
  await ((await todayCell.count()) ? todayCell : page.locator('.cell').first()).click();
  await page.waitForSelector('#panel-body:not([hidden])', { timeout: 5000 });
  await page.waitForFunction(() => (document.getElementById('panel-facts')?.children.length ?? 0) > 0, {
    timeout: 5000,
  });

  const measure = () =>
    page.evaluate(() => {
      const cells = [...document.querySelectorAll('.cell-lunar')];
      const first = cells[0];
      const style = first ? getComputedStyle(first) : null;
      const cell = first?.closest('.cell') ?? first?.parentElement ?? null;
      const box = cell?.getBoundingClientRect() ?? null;
      const opaqueBackground = (el) => {
        for (let node = el; node; node = node.parentElement) {
          const value = getComputedStyle(node).backgroundColor;
          const parts = value.match(/[\d.]+/g);
          if (!parts) continue;
          const alpha = parts.length > 3 ? Number(parts[3]) : 1;
          if (alpha > 0.9) return value;
        }
        return getComputedStyle(document.body).backgroundColor;
      };
      const background = cell ? opaqueBackground(cell) : null;
      const text = document.body.innerText.replace(/\s+/g, ' ').trim();
      const rgb = (value) => (value || '').match(/\d+/g)?.slice(0, 3).map(Number) ?? null;
      const luminance = (c) => {
        if (!c) return null;
        const [r, g, b] = c.map((v) => {
          const s = v / 255;
          return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
        });
        return 0.2126 * r + 0.7152 * g + 0.0722 * b;
      };
      const fg = luminance(rgb(style?.color));
      const bg = luminance(rgb(background));
      const contrast = fg != null && bg != null && fg !== bg
        ? (Math.max(fg, bg) + 0.05) / (Math.min(fg, bg) + 0.05)
        : null;
      return {
        cells: cells.length,
        firstLunar: first?.textContent?.trim() ?? null,
        solarCells: document.querySelectorAll('.cell-solar').length,
        legendItems: document.querySelectorAll('.legend-item').length,
        facts: document.querySelectorAll('.fact').length,
        dayPanelText: document.querySelector('.panel, .day-panel, aside')?.innerText?.replace(/\s+/g, ' ').slice(0, 160) ?? null,
        buildRow: document.getElementById('build-row')?.textContent?.trim() ?? null,
        undefineds: (document.body.innerText.match(/undefined/gi) ?? []).length,
        selectorCells: document.querySelectorAll('.selector-cell').length,
        legendContrast: (() => {
          const ratios = {};
          for (const cls of ['legend-kind-holiday', 'legend-kind-term']) {
            const el = document.querySelector(`.${cls}`);
            if (!el) continue;
            const fgL = luminance(rgb(getComputedStyle(el).color));
            const bgL = luminance(rgb(opaqueBackground(el)));
            ratios[cls] = fgL != null && bgL != null && fgL !== bgL
              ? (Math.max(fgL, bgL) + 0.05) / (Math.min(fgL, bgL) + 0.05)
              : null;
          }
          return ratios;
        })(),
        outsideContrast: (() => {
          const ratios = {};
          for (const cls of ['cell-solar', 'cell-lunar']) {
            const el = document.querySelector(`.cell.is-outside .${cls}`);
            if (!el) continue;
            const cell = el.closest('.cell');
            const opacity = Number(getComputedStyle(cell).opacity ?? 1);
            const fgRgb = rgb(getComputedStyle(el).color);
            const bgRgb = rgb(opaqueBackground(el));
            const blended = fgRgb.map((c, i) => Math.round(c * opacity + bgRgb[i] * (1 - opacity)));
            const fgL = luminance(blended);
            const bgL = luminance(bgRgb);
            ratios[cls] = (Math.max(fgL, bgL) + 0.05) / (Math.min(fgL, bgL) + 0.05);
          }
          return ratios;
        })(),
        a11yStructure: (() => {
          const weekdays = document.getElementById('weekdays');
          const grid = document.getElementById('grid');
          const menu = document.getElementById('menu');
          return {
            hasH1: document.querySelectorAll('h1').length >= 1,
            weekdaysHasColumnHeaders: [...weekdays.children].every((c) => c.getAttribute('role') === 'columnheader'),
            weekdaysParentIsGrid: weekdays.parentElement?.getAttribute('role') === 'grid' || weekdays.getAttribute('role') !== 'row',
            gridCellsHaveRowParent: [...grid.querySelectorAll('[role="gridcell"]')].every((c) => c.parentElement?.getAttribute('role') === 'row'),
            menuTagAllowsDialog: menu.getAttribute('role') !== 'dialog' || menu.tagName.toLowerCase() !== 'aside',
          };
        })(),
        panelOpensWithDate: document.querySelector('.fact')?.classList.contains('is-selected-date') ?? false,
        legendDates: [...document.querySelectorAll('.legend-date')].map((el) => el.textContent),
        offlineBadgeHidden: document.getElementById('offline-badge')?.hidden ?? null,
        scrollWidth: document.documentElement.scrollWidth,
        innerWidth: window.innerWidth,
        cellBox: box?.toJSON() ?? null,
        colors: { text: style?.color ?? null, background, contrast },
        bodyText: text.slice(0, 200),
      };
    });

  const view = await measure();
  expect(view.cells).toBeGreaterThanOrEqual(28);
  expect(view.cells % 7).toBe(0);
  expect(view.solarCells).toBeGreaterThan(0);
  expect(view.scrollWidth).toBeLessThanOrEqual(view.innerWidth + 1);
  expect(view.cellBox.height).toBeGreaterThanOrEqual(40);
  expect(view.colors.contrast).toBeGreaterThanOrEqual(4.5);
  expect(view.undefineds).toBe(0);
  expect(view.selectorCells).toBe(0);
  expect(await page.title()).toBe('Lịch Ông Trăng');

  const header = await page.evaluate(() => {
    const box = document.querySelector('.title-gregorian').getBoundingClientRect();
    return {
      offBy: Math.round((box.left + box.width / 2) - window.innerWidth / 2),
      leading: document.querySelector('.top').firstElementChild.id,
      last: document.querySelector('.top').lastElementChild.className,
      canChi: document.getElementById('title-canchi').textContent.trim(),
    };
  });
  expect(Math.abs(header.offBy)).toBeLessThanOrEqual(2);
  expect(header.leading).toBe('menu-button');
  expect(header.last).toMatch(/nav-balance/);
  expect(header.canChi).toBe('Năm Bính Ngọ');

  // Verify 2-digit month titles ("Tháng 12 2026") do not truncate on narrow 360px phone screens
  await page.setViewportSize({ width: 360, height: 844 });
  await page.locator('#datepicker-button').click();
  await page.locator('#picker-month').selectOption('12');
  await page.locator('#datepicker-submit').click();
  const narrowHeader = await page.evaluate(() => {
    const el = document.getElementById('title-gregorian');
    const canChiEl = document.getElementById('title-canchi');
    return {
      text: el.textContent.trim(),
      truncated: el.scrollWidth > el.clientWidth,
      canChiTruncated: canChiEl.scrollWidth > canChiEl.clientWidth,
    };
  });
  expect(narrowHeader).toEqual({
    text: 'Tháng 12 2026',
    truncated: false,
    canChiTruncated: false,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  await page.locator('#today-button').click();
  await page.waitForTimeout(100);

  for (const ratio of Object.values(view.legendContrast ?? {})) {
    if (ratio != null) expect(ratio).toBeGreaterThanOrEqual(4.5);
  }
  for (const ratio of Object.values(view.outsideContrast ?? {})) {
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  }
  expect(view.a11yStructure).toEqual({
    hasH1: true,
    weekdaysHasColumnHeaders: true,
    weekdaysParentIsGrid: true,
    gridCellsHaveRowParent: true,
    menuTagAllowsDialog: true,
  });
  expect(view.panelOpensWithDate).toBe(true);
  for (const text of view.legendDates ?? []) {
    expect(text).toMatch(/^\d+\/\d+n? \(\d\d\/\d\d\)$/);
  }

  const m3Light = await page.evaluate(() => {
    const root = getComputedStyle(document.documentElement);
    const holidayCell = document.querySelector('.cell.is-holiday:not(.is-selected)');
    const termCell = document.querySelector('.cell.is-term:not(.is-selected)');
    const panel = getComputedStyle(document.getElementById('panel'));
    const drawer = getComputedStyle(document.getElementById('menu'));
    const sheet = getComputedStyle(document.getElementById('sheet'));
    const sheetBefore = getComputedStyle(document.getElementById('sheet'), '::before');
    return {
      surfaceToken: root.getPropertyValue('--md-sys-color-surface').trim(),
      primaryToken: root.getPropertyValue('--md-sys-color-primary').trim(),
      holidayBg: holidayCell ? getComputedStyle(holidayCell).backgroundColor : null,
      termBg: termCell ? getComputedStyle(termCell).backgroundColor : null,
      panelBorderTop: panel.borderTopWidth,
      panelRadius: panel.borderTopLeftRadius,
      drawerRadiusRight: drawer.borderTopRightRadius,
      drawerBorderRight: drawer.borderRightWidth,
      sheetRadiusTop: sheet.borderTopLeftRadius,
      sheetHandleDisplay: sheetBefore.display,
      sheetHandleWidth: sheetBefore.width,
    };
  });
  expect(m3Light.surfaceToken).toBe('#faf8ff');
  expect(m3Light.primaryToken).toBe('#583d9e');
  expect(m3Light.holidayBg).toBe('rgba(0, 0, 0, 0)');
  expect(m3Light.termBg).toBe('rgba(0, 0, 0, 0)');
  expect(m3Light.panelBorderTop).toBe('0px');
  expect(m3Light.panelRadius).toBe('20px');
  expect(m3Light.drawerRadiusRight).toBe('28px');
  expect(m3Light.drawerBorderRight).toBe('0px');
  expect(m3Light.sheetRadiusTop).toBe('28px');
  expect(m3Light.sheetHandleDisplay).toBe('block');
  expect(m3Light.sheetHandleWidth).toBe('32px');

  const holidayIso = await page.evaluate(() => document.querySelector('.cell.is-holiday')?.dataset.iso ?? null);
  expect(holidayIso).not.toBeNull();
  await page.locator(`.cell[data-iso="${holidayIso}"]`).click();
  const selectedHolidayContrastLight = await page.evaluate((iso) => {
    const el = document.querySelector(`.cell[data-iso="${iso}"] .cell-solar`);
    const cell = el.closest('.cell');
    const rgb = (v) => v.match(/\d+/g).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => {
      const [rs, gs, bs] = [r, g, b].map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
    };
    const l1 = lum(rgb(getComputedStyle(el).color));
    const l2 = lum(rgb(getComputedStyle(cell).backgroundColor));
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }, holidayIso);
  expect(selectedHolidayContrastLight).toBeGreaterThanOrEqual(4.5);
  await todayCell.click();

  // ---- Swipe & in-place selection
  const swipeState = () => page.evaluate(() => ({
    title: document.getElementById('title-gregorian').textContent,
    selected: document.querySelector('.cell.is-selected')?.dataset.iso ?? null,
  }));
  const swipeBox = await page.locator('#grid').boundingBox();
  expect(swipeBox).not.toBeNull();

  const swipeY = swipeBox.y + swipeBox.height / 2;
  const swipeMid = swipeBox.x + swipeBox.width / 2;
  const before = await swipeState();
  const drag = async (fromX, toX) => {
    await page.mouse.move(fromX, swipeY);
    await page.mouse.down();
    await page.mouse.move(toX, swipeY, { steps: 8 });
    await page.mouse.up();
    await page.waitForTimeout(260);
  };

  const notToday = await page.evaluate(() => {
    const today = document.querySelector('.cell.is-today')?.dataset.iso ?? '';
    const cells = [...document.querySelectorAll('.cell[data-iso]')];
    return (cells.find((c) => c.dataset.iso.startsWith(today.slice(0, 7)) && c.dataset.iso !== today)
      ?? cells.find((c) => c.dataset.iso !== today))?.dataset.iso ?? null;
  });
  expect(notToday).not.toBeNull();

  await page.evaluate(() => {
    document.querySelector('.cell').__sameNode = true;
  });
  await page.locator(`.cell[data-iso="${notToday}"]`).click();
  await page.waitForTimeout(120);
  const moved = await swipeState();
  expect(moved.selected).toBe(notToday);

  const selectionDom = await page.evaluate(() => ({
    sameNode: document.querySelector('.cell')?.__sameNode === true,
    selectedClassCount: document.querySelectorAll('.cell.is-selected').length,
    ariaSelectedCount: document.querySelectorAll('.cell[aria-selected="true"]').length,
  }));
  expect(selectionDom).toEqual({
    sameNode: true,
    selectedClassCount: 1,
    ariaSelectedCount: 1,
  });

  const panelBefore = await page.evaluate(() => {
    const rect = document.getElementById('panel').getBoundingClientRect();
    return { top: Math.round(rect.top), height: Math.round(rect.height) };
  });

  // 1:1 direct manipulation during drag (no 28px hard stop) and snap-back when released under threshold
  await page.mouse.move(swipeMid, swipeY);
  await page.mouse.down();
  await page.mouse.move(swipeMid - 110, swipeY, { steps: 6 });
  const farDrag = await page.evaluate(() => {
    const grid = document.getElementById('grid');
    return {
      transform: grid.style.transform,
      opacity: Number(grid.style.opacity || 1),
      overflowX: getComputedStyle(document.querySelector('.month-grid')).overflowX,
      scrollWidth: document.documentElement.scrollWidth,
      innerWidth: window.innerWidth,
    };
  });
  expect(farDrag.transform).toBe('translateX(-110px)');
  expect(farDrag.opacity).toBeLessThan(1);
  expect(farDrag.overflowX).toBe('clip');
  expect(farDrag.scrollWidth).toBeLessThanOrEqual(farDrag.innerWidth + 1);

  // Pull back below 60px threshold, pause so release velocity is 0, and release to verify snap-back
  await page.mouse.move(swipeMid - 36, swipeY, { steps: 4 });
  await page.waitForTimeout(60);
  await page.mouse.up();
  await page.waitForTimeout(220);
  const afterSnapBack = await page.evaluate(() => ({
    transform: document.getElementById('grid').style.transform,
    opacity: document.getElementById('grid').style.opacity,
    title: document.getElementById('title-gregorian').textContent,
    selected: document.querySelector('.cell.is-selected')?.dataset.iso ?? null,
  }));
  expect(afterSnapBack).toEqual({
    transform: '',
    opacity: '',
    title: before.title,
    selected: notToday,
  });

  await page.evaluate(() => {
    window.__gridAnimations = [];
    document.getElementById('grid').addEventListener('animationstart', (e) => {
      window.__gridAnimations.push({
        name: e.animationName,
        classes: [...e.currentTarget.classList],
      });
    });
  });

  await drag(swipeMid + 60, swipeMid - 60);
  const afterLeft = await swipeState();
  expect(afterLeft.title).not.toBe(before.title);
  if (afterLeft.selected) expect(afterLeft.selected).toBe(before.selected);
  const swipeLeftAnim = await page.evaluate(() => ({
    recorded: window.__gridAnimations,
    settledClasses: [...document.getElementById('grid').classList],
  }));
  expect(swipeLeftAnim.recorded.some((a) => a.name === 'grid-slide-next' && a.classes.includes('is-entering-next'))).toBe(true);
  expect(swipeLeftAnim.recorded.some((a) => a.name === 'grid-fade-in')).toBe(true);
  expect(swipeLeftAnim.settledClasses).toEqual(['grid']);

  const away = await page.evaluate(() => {
    const panel = document.getElementById('panel').getBoundingClientRect();
    return {
      prompt: document.body.innerText.includes('Chọn một ngày để xem chi tiết âm lịch'),
      panelHeight: Math.round(panel.height),
      factsHeight: Math.round(document.getElementById('panel-body').getBoundingClientRect().height),
      todayShown: !document.getElementById('today-button').hidden,
      todayLabel: document.getElementById('today-button').textContent,
    };
  });
  expect(away.prompt).toBe(true);
  expect(Math.abs(away.panelHeight - panelBefore.height)).toBeLessThanOrEqual(2);
  expect(away.factsHeight).toBe(0);
  expect(away.todayShown).toBe(true);
  expect(away.todayLabel).toMatch(/Hôm nay|Today/);

  const overlap = await page.evaluate(() => {
    window.scrollTo(0, document.body.scrollHeight);
    const pill = document.getElementById('today-button').getBoundingClientRect();
    const panel = document.getElementById('panel').getBoundingClientRect();
    return Math.round(panel.bottom - pill.top);
  });
  expect(overlap).toBeLessThanOrEqual(0);

  const centred = await page.evaluate(() => {
    const mid = (el) => { const r = el.getBoundingClientRect(); return Math.round(r.left + r.width / 2); };
    const panel = document.getElementById('panel');
    const hint = document.getElementById('panel-hint');
    return {
      hintOffset: Math.abs(mid(hint) - mid(panel)),
      hintAlign: getComputedStyle(hint).textAlign,
      factsJustify: getComputedStyle(document.querySelector('.panel-facts')).justifyContent,
      dateAlign: getComputedStyle(document.querySelector('.fact.is-selected-date')).textAlign,
    };
  });
  expect(centred.hintOffset).toBeLessThanOrEqual(2);
  expect(centred.hintAlign).toBe('center');
  expect(centred.factsJustify).toBe('center');
  expect(centred.dateAlign).toBe('center');

  const apple = await page.evaluate(() => ({
    capable: document.querySelector('meta[name="apple-mobile-web-app-capable"]')?.content ?? null,
    statusBar: document.querySelector('meta[name="apple-mobile-web-app-status-bar-style"]')?.content ?? null,
    title: document.querySelector('meta[name="apple-mobile-web-app-title"]')?.content ?? null,
    asked: Boolean(window.__persistAsked),
  }));
  expect(apple).toEqual({
    capable: 'yes',
    statusBar: 'default',
    title: 'Lịch Ông Trăng',
    asked: false,
  });

  await snap('phone-away.png');

  await page.locator('#today-button').click();
  await page.waitForTimeout(120);
  const afterToday = await swipeState();
  expect(afterToday.title).toBe(before.title);

  await drag(swipeMid - 60, swipeMid + 60);
  const afterRight = await swipeState();
  expect(afterRight.title).not.toBe(before.title);
  await page.locator('#today-button').click();
  await page.waitForTimeout(120);
  expect((await swipeState()).title).toBe(before.title);

  // Header prev/next buttons also trigger Shared X-Axis entrance animations, including rapid mid-animation clicks
  await page.evaluate(() => { window.__gridAnimations = []; });
  await page.locator('#prev').click();
  await page.waitForTimeout(20);
  await page.locator('#prev').click();
  await page.waitForTimeout(260);
  await page.locator('#next').click();
  await page.waitForTimeout(20);
  await page.locator('#next').click();
  await page.waitForTimeout(260);
  const buttonAnims = await page.evaluate(() => window.__gridAnimations.map((a) => a.name));
  expect(buttonAnims.filter((n) => n === 'grid-slide-prev').length).toBe(2);
  expect(buttonAnims.filter((n) => n === 'grid-slide-next').length).toBe(2);
  expect((await swipeState()).title).toBe(before.title);

  // Mostly-vertical scroll locks out horizontal drag hijacking even if pointer later drifts sideways
  await page.mouse.move(swipeMid, swipeY);
  await page.mouse.down();
  await page.mouse.move(swipeMid - 2, swipeY - 30, { steps: 3 });
  await page.mouse.move(swipeMid - 80, swipeY - 35, { steps: 4 });
  expect(await page.evaluate(() => document.getElementById('grid').style.transform)).toBe('');
  await page.mouse.up();
  expect((await swipeState()).title).toBe(before.title);

  // Velocity-based flick (>= 25px, < 60px) commits even if final pointermove has zero dx
  await page.mouse.move(swipeMid, swipeY);
  await page.mouse.down();
  await page.mouse.move(swipeMid - 40, swipeY, { steps: 3 });
  await page.mouse.move(swipeMid - 40, swipeY + 1, { steps: 1 });
  await page.mouse.up();
  await page.waitForTimeout(260);
  expect((await swipeState()).title).not.toBe(before.title);
  await page.locator('#today-button').click();
  await page.waitForTimeout(120);
  expect((await swipeState()).title).toBe(before.title);

  // Boundary overscroll at 1900-01 applies hyperbolic rubber-band without opacity fade or month shift
  await page.locator('#datepicker-button').click();
  await page.locator('#picker-year').selectOption('1900');
  await page.locator('#picker-month').selectOption('1');
  await page.locator('#picker-day').selectOption('1');
  await page.locator('#datepicker-submit').click();
  await page.evaluate(() => { window.__gridAnimations = []; });
  await page.locator('#prev').click();
  await page.mouse.move(swipeMid - 40, swipeY);
  await page.mouse.down();
  await page.mouse.move(swipeMid + 56, swipeY, { steps: 4 });
  const boundaryDrag = await page.evaluate(() => ({
    transform: document.getElementById('grid').style.transform,
    opacity: document.getElementById('grid').style.opacity,
  }));
  expect(boundaryDrag.transform).toBe('translateX(32px)');
  expect(boundaryDrag.opacity).toBe('');
  await page.mouse.up();
  await page.waitForTimeout(220);
  expect((await swipeState()).title).toBe('Tháng 1 1900');
  expect(await page.evaluate(() => window.__gridAnimations.length)).toBe(0);
  await page.locator('#today-button').click();
  await page.waitForTimeout(120);

  // prefers-reduced-motion: reduce suppresses both inline drag transforms and entrance animations
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.evaluate(() => { window.__gridAnimations = []; });
  await page.mouse.move(swipeMid, swipeY);
  await page.mouse.down();
  await page.mouse.move(swipeMid - 70, swipeY, { steps: 4 });
  expect(await page.evaluate(() => document.getElementById('grid').style.transform)).toBe('');
  await page.mouse.up();
  expect((await swipeState()).title).not.toBe(before.title);
  expect(await page.evaluate(() => window.__gridAnimations.length)).toBe(0);
  await page.emulateMedia({ reducedMotion: 'no-preference' });
  await page.locator('#today-button').click();
  await page.waitForTimeout(120);

  // ---- Zoom levels
  const zoomState = () => page.evaluate(() => {
    const cells = [...document.querySelectorAll('.selector-cell')];
    const boxes = cells.map((c) => c.getBoundingClientRect());
    const rows = [...new Set(boxes.map((b) => Math.round(b.top)))];
    const shown = (id) => getComputedStyle(document.getElementById(id)).display !== 'none';
    const visibleDays = [...document.querySelectorAll('.cell')]
      .filter((c) => c.getBoundingClientRect().height > 0).length;
    const selectorEl = document.getElementById('selector');
    const selectorCellsHaveRowParent = [...selectorEl.querySelectorAll('[role="gridcell"]')].every(
      (c) => c.parentElement?.getAttribute('role') === 'row',
    );
    return {
      title: document.getElementById('title-gregorian').textContent.trim(),
      canChi: document.getElementById('title-canchi').textContent.trim(),
      labels: cells.map((c) => c.textContent.trim()),
      ariaLabels: cells.map((c) => c.getAttribute('aria-label') ?? ''),
      current: cells.filter((c) => c.classList.contains('is-current')).map((c) => c.textContent.trim()),
      disabled: cells.filter((c) => c.disabled).map((c) => c.textContent.trim()),
      rows: rows.length,
      perRow: rows.length ? boxes.filter((b) => Math.round(b.top) === rows[0]).length : 0,
      minWidth: boxes.length ? Math.round(Math.min(...boxes.map((b) => b.width))) : 0,
      minHeight: boxes.length ? Math.round(Math.min(...boxes.map((b) => b.height))) : 0,
      cells: cells.length,
      selectorShown: !selectorEl.hidden,
      selectorCellsHaveRowParent,
      monthPartsHidden: ['grid', 'weekdays', 'panel'].filter((id) => !shown(id)),
      visibleDayCells: visibleDays,
    };
  });

  await page.locator('#title').click();
  await page.waitForTimeout(150);
  await snap('phone-years.png');
  const years = await zoomState();
  expect(years.cells).toBe(12);
  expect(years.rows).toBe(3);
  expect(years.perRow).toBe(4);
  expect(years.selectorShown).toBe(true);
  expect(years.selectorCellsHaveRowParent).toBe(true);
  expect(years.monthPartsHidden).toEqual(['grid', 'weekdays', 'panel']);
  expect(years.visibleDayCells).toBe(0);
  expect(years.title).toMatch(/^\d{4} – \d{4}$/);

  const targetYear = await page.evaluate(() => {
    const cells = [...document.querySelectorAll('.selector-cell')];
    const yList = cells.map((c) => Number(c.textContent.trim()));
    const highlighted = cells.find((c) => c.classList.contains('is-current')) ?? cells[0];
    const current = Number(highlighted.textContent.trim());
    return yList.find((y) => y > current) ?? current;
  });
  await page.locator('.selector-cell', { hasText: new RegExp(`^${targetYear}$`) }).click();
  await page.waitForTimeout(150);
  await snap('phone-months.png');
  const months = await zoomState();
  expect(months.cells).toBe(12);
  expect(months.rows).toBe(3);
  expect(months.perRow).toBe(4);
  expect(months.title).toBe(String(targetYear));
  expect(months.canChi.length).toBeGreaterThan(0);
  expect(months.canChi).not.toMatch(/\(/);

  const monthCell = page.locator('.selector-cell').nth(6);
  const monthName = await monthCell.getAttribute('aria-label');
  await monthCell.click();
  await page.waitForTimeout(150);
  expect((await page.locator('#title-gregorian').innerText()).trim()).toBe(monthName);

  await page.locator('#title').click();
  await page.waitForTimeout(100);
  await page.locator('.selector-cell.is-current').click();
  await page.waitForTimeout(100);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  const afterEscape = await zoomState();
  expect(afterEscape.selectorShown).toBe(true);
  expect(afterEscape.title).toBe(years.title);
  await page.keyboard.press('Escape');
  await page.waitForTimeout(100);
  expect((await zoomState()).selectorShown).toBe(false);

  const pill = page.locator('#today-button');
  if (await pill.isVisible()) {
    await pill.click();
    await page.waitForTimeout(120);
  }

  // ---- Date picker popup
  const dpButton = page.locator('#datepicker-button');
  await expect(dpButton).toBeVisible();
  const dpBox = await dpButton.boundingBox();
  expect(dpBox.width).toBeGreaterThanOrEqual(48);
  expect(dpBox.height).toBeGreaterThanOrEqual(48);

  // Open while zoomed out to verify zoom reset on submit, and test pre-fill + cancel first
  await dpButton.click();
  await page.waitForSelector('#datepicker:not([hidden])', { timeout: 4000 });
  expect(await dpButton.getAttribute('aria-expanded')).toBe('true');
  expect(await page.locator('#picker-year').inputValue()).toBe('2026');
  expect(await page.locator('#picker-month').inputValue()).toBe('9');
  expect(await page.locator('#picker-day').inputValue()).toBe('28');

  // Keyboard isolation inside #datepicker
  await page.locator('#picker-day').focus();
  await page.keyboard.press('PageDown');
  expect((await swipeState()).title).toBe(before.title);

  // Cancel leaves calendar state unchanged
  await page.locator('#datepicker-cancel').click();
  expect(await page.locator('#datepicker').evaluate((el) => el.hidden)).toBe(true);
  expect(await dpButton.getAttribute('aria-expanded')).toBe('false');

  // Same-month submit via Enter while zoomed out exits zoom view
  await page.locator('#title').click();
  expect((await zoomState()).selectorShown).toBe(true);
  await dpButton.click();
  await page.locator('#picker-day').selectOption('15');
  await page.locator('#picker-day').press('Enter');
  expect(await page.locator('#datepicker').evaluate((el) => el.hidden)).toBe(true);
  expect((await zoomState()).selectorShown).toBe(false);
  expect((await swipeState()).selected).toBe('2026-09-15');

  // Day clamping across leap and non-leap February, and submit while zoomed out
  await page.locator('#title').click();
  expect((await zoomState()).selectorShown).toBe(true);
  await dpButton.click();
  await page.locator('#picker-year').selectOption('2026');
  await page.locator('#picker-month').selectOption('1');
  await page.locator('#picker-day').selectOption('31');
  await page.locator('#picker-month').selectOption('2');
  expect(await page.locator('#picker-day').inputValue()).toBe('28');
  await page.locator('#picker-year').selectOption('2024');
  expect(await page.locator('#picker-day').evaluate((el) => el.options.length)).toBe(29);
  await page.locator('#picker-day').selectOption('29');
  await page.locator('#datepicker-submit').click();

  expect(await page.locator('#datepicker').evaluate((el) => el.hidden)).toBe(true);
  expect((await zoomState()).selectorShown).toBe(false);
  expect(await swipeState()).toEqual({
    title: 'Tháng 2 2024',
    selected: '2024-02-29',
  });
  await page.locator('#today-button').click();
  await page.waitForTimeout(120);

  // ---- Menu, Settings, and About dialogs
  await page.locator('#menu-button').click({ timeout: 4000 });
  await page.waitForFunction(() => document.getElementById('menu').classList.contains('is-open'), { timeout: 4000 });
  await page.waitForTimeout(250);
  await snap('phone-drawer.png');

  await page.locator('#menu-settings').click();
  await page.waitForSelector('#sheet:not([hidden])', { timeout: 4000 });
  await snap('phone-settings.png');

  await page.locator('#sheet-close').click();
  await page.waitForTimeout(150);

  // Install guide dialog (#menu-install -> #install) + beforeinstallprompt & standalone handling
  await page.locator('#menu-button').click({ timeout: 4000 });
  const installMenuRow = page.locator('#menu-install');
  await expect(installMenuRow).toBeVisible();
  expect((await installMenuRow.boundingBox()).height).toBeGreaterThanOrEqual(48);
  await installMenuRow.click();
  await page.waitForSelector('#install:not([hidden])', { timeout: 4000 });
  expect(await installMenuRow.getAttribute('aria-expanded')).toBe('true');
  expect(await page.locator('#install-prompt').evaluate((el) => el.hidden)).toBe(true);
  const installText = await page.locator('#install').innerText();
  expect(installText).toContain('iPhone / iPad (Safari)');
  expect(installText).toContain('Thêm vào Màn hình chính');
  expect(installText).toContain('Android (Chrome)');
  expect(installText).toContain('Máy tính (Chrome / Edge / Safari)');

  // Synthetic beforeinstallprompt reveals #install-prompt and calls prompt() on click
  await page.evaluate(() => {
    window.__promptCalled = 0;
    const ev = new Event('beforeinstallprompt', { cancelable: true });
    ev.prompt = async () => { window.__promptCalled += 1; };
    ev.userChoice = Promise.resolve({ outcome: 'accepted' });
    window.dispatchEvent(ev);
  });
  await expect(page.locator('#install-prompt')).toBeVisible();
  expect((await page.locator('#install-prompt').boundingBox()).height).toBeGreaterThanOrEqual(48);
  await page.locator('#install-prompt').click();
  expect(await page.evaluate(() => window.__promptCalled)).toBe(1);
  expect(await page.locator('#install-prompt').evaluate((el) => el.hidden)).toBe(true);

  await page.evaluate(() => window.dispatchEvent(new Event('appinstalled')));
  await page.waitForFunction(() => window.__persistAsked === true, { timeout: 4000 });

  await page.locator('#install-close').click();
  expect(await page.locator('#install').evaluate((el) => el.hidden)).toBe(true);
  expect(await installMenuRow.getAttribute('aria-expanded')).toBe('false');
  await page.waitForTimeout(150);

  await page.locator('#menu-button').click({ timeout: 4000 });
  await page.locator('#menu-about').click();
  await page.waitForFunction(
    () => {
      const row = document.getElementById('build-row');
      return !!row && !!row.textContent && !row.textContent.includes('…');
    },
    { timeout: 5000 },
  );

  const aboutText = await page.locator('#about').innerText();
  const buildRowText = await page.locator('#build-row').innerText();
  const info = JSON.parse(await readFile(join(DIST, 'build-info.json'), 'utf8'));
  expect(buildRowText).toContain(info.engineHash.slice(0, 8));
  expect(aboutText).toMatch(/Thuật toán & tài liệu tham khảo/i);
  expect(aboutText).toContain('Hồ Ngọc Đức — Thuật toán tính âm lịch');
  expect(aboutText).toContain('Astronomical Algorithms');
  for (const removedDetail of [
    'quy tắc chuyển đổi',
    'chuỗi sóc',
    'đông chí',
    'Kotlin',
    'Kiểm chứng',
    'Giấy phép',
    'Bản dựng',
    'Reingold',
    'Seidelmann',
  ]) {
    expect(aboutText).not.toContain(removedDetail);
  }
  expect(aboutText).toContain('Mã nguồn: github.com/qtdzz/lichongtrang-web');
  expect(aboutText).toMatch(
    /License:\s*AGPL-3\.0 \(ứng dụng, © 2026 Tien Nguyen\) · Phi thương mại \(thuật toán amlich, © 2006 Hồ Ngọc Đức\)/,
  );
  expect(aboutText).toMatch(/Build/i);
  await expect(page.locator('#about a[href="https://www.informatik.uni-leipzig.de/~duc/amlich/calrules.html"]')).toBeVisible();
  await expect(page.locator('#about a[href="https://web.archive.org/web/20250123093939/http://www.informatik.uni-leipzig.de/~duc/amlich/calrules.html"]')).toBeVisible();
  await expect(page.locator('#about a[href="https://web.archive.org/web/20241204143834/http://www.informatik.uni-leipzig.de/~duc/amlich/calrules_en.html"]')).toBeVisible();
  await expect(page.locator('#about a[href="https://web.archive.org/web/20240905135905/https://www.informatik.uni-leipzig.de/~duc/amlich/amlich-hnd.js"]')).toBeVisible();
  await expect(page.locator('#about a[href="https://github.com/qtdzz/lichongtrang-web"]')).toBeVisible();
  await expect(page.locator('#about a[href="LICENSE.txt"]')).toBeVisible();
  await expect(page.locator('#about a[href="NOTICE.txt"]')).toBeVisible();

  const titleBeforeModalKeys = await page.locator('#title-gregorian').innerText();
  const selectedBeforeModalKeys = await page.locator('.cell.is-selected').getAttribute('data-iso');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('PageDown');
  expect(await page.locator('#title-gregorian').innerText()).toBe(titleBeforeModalKeys);
  expect(await page.locator('.cell.is-selected').getAttribute('data-iso')).toBe(selectedBeforeModalKeys);

  await snap('phone-about.png', { stabilizeBuildRow: true });

  await page.evaluate(() => {
    window.__copied = null;
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: {
        writeText: async (t) => {
          window.__copied = t;
        },
      },
    });
  });
  await page.locator('#build-row').dispatchEvent('dblclick');
  await page.waitForTimeout(80);
  await page.locator('#build-row').dispatchEvent('dblclick');
  const copiedDuringRace = await page.evaluate(() => window.__copied);
  expect(copiedDuringRace).toMatch(/^engine /);
  expect(copiedDuringRace).not.toContain('Đã sao chép');
  await page.waitForTimeout(1300);
  expect(await page.locator('#build-row').innerText()).toBe(buildRowText);

  await page.locator('#about-close').click();
  await page.waitForTimeout(200);

  const titleBeforeModKeys = await page.locator('#title-gregorian').innerText();
  const selectedBeforeModKeys = await page.locator('.cell.is-selected').getAttribute('data-iso');
  await page.keyboard.press('Alt+ArrowLeft');
  await page.keyboard.press('Control+PageDown');
  expect(await page.locator('#title-gregorian').innerText()).toBe(titleBeforeModKeys);
  expect(await page.locator('.cell.is-selected').getAttribute('data-iso')).toBe(selectedBeforeModKeys);

  await snap('phone.png');
  await page.emulateMedia({ colorScheme: 'dark' });
  await page.waitForTimeout(100);
  const darkView = await measure();
  expect(darkView.colors.contrast).toBeGreaterThanOrEqual(4.5);
  for (const ratio of Object.values(darkView.legendContrast ?? {})) {
    if (ratio != null) expect(ratio).toBeGreaterThanOrEqual(4.5);
  }
  for (const ratio of Object.values(darkView.outsideContrast ?? {})) {
    expect(ratio).toBeGreaterThanOrEqual(4.5);
  }
  await page.locator(`.cell[data-iso="${holidayIso}"]`).click();
  await expect(page.locator(`.cell[data-iso="${holidayIso}"]`)).toHaveClass(/is-selected/);
  await page.waitForTimeout(160);
  const selectedHolidayContrastDark = await page.evaluate((iso) => {
    const el = document.querySelector(`.cell[data-iso="${iso}"] .cell-solar`);
    const cell = el.closest('.cell');
    const rgb = (v) => v.match(/\d+/g).slice(0, 3).map(Number);
    const lum = ([r, g, b]) => {
      const [rs, gs, bs] = [r, g, b].map((c) => {
        const s = c / 255;
        return s <= 0.03928 ? s / 12.92 : ((s + 0.055) / 1.055) ** 2.4;
      });
      return 0.2126 * rs + 0.7152 * gs + 0.0722 * bs;
    };
    const l1 = lum(rgb(getComputedStyle(el).color));
    const l2 = lum(rgb(getComputedStyle(cell).backgroundColor));
    return (Math.max(l1, l2) + 0.05) / (Math.min(l1, l2) + 0.05);
  }, holidayIso);
  expect(selectedHolidayContrastDark).toBeGreaterThanOrEqual(4.5);
  await todayCell.click();
  await page.waitForTimeout(100);
  await snap('phone-dark.png');
  await page.emulateMedia({ colorScheme: 'light' });
  await page.waitForTimeout(100);

  // ---- Desktop viewport (1280x900)
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.waitForTimeout(150);
  await page.locator('#menu-button').click({ timeout: 4000 });
  await page.locator('#menu-about').click({ timeout: 4000 });
  await page.waitForTimeout(250);
  const desktopDialog = await page.evaluate(() => {
    const rect = document.getElementById('about').getBoundingClientRect();
    return {
      dx: Math.abs((rect.left + rect.width / 2) - window.innerWidth / 2),
      dy: Math.abs((rect.top + rect.height / 2) - window.innerHeight / 2),
      width: Math.round(rect.width),
    };
  });
  expect(desktopDialog.dx).toBeLessThanOrEqual(2);
  expect(desktopDialog.dy).toBeLessThanOrEqual(2);
  expect(desktopDialog.width).toBeLessThanOrEqual(700);
  const desktopHandleDisplay = await page.evaluate(
    () => getComputedStyle(document.getElementById('about'), '::before').display,
  );
  expect(desktopHandleDisplay).toBe('none');

  await snap('desktop-about.png', { stabilizeBuildRow: true });
  await page.locator('#about-close').click();
  await page.waitForTimeout(150);
  await snap('desktop.png');
  await page.setViewportSize({ width: 390, height: 844 });

  // ---- Offline reload
  await page.evaluate(() => navigator.serviceWorker.ready);
  await page.reload({ waitUntil: 'networkidle' });
  expect(await page.evaluate(() => !!navigator.serviceWorker.controller)).toBe(true);

  await context.setOffline(true);
  wentOffline = true;
  await page.reload({ waitUntil: 'domcontentloaded' });
  await page.waitForSelector('.cell-lunar', { timeout: 10000 });
  const offlineView = await measure();
  expect(offlineView.cells).toBe(view.cells);
  expect(offlineView.firstLunar).toBe(view.firstLunar);
  expect(offlineView.offlineBadgeHidden).toBe(false);
  await snap('phone-offline.png');
  await page.locator('#next').click();
  await page.waitForTimeout(100);
  const badgeFabGap = await page.evaluate(() => {
    const badge = document.getElementById('offline-badge').getBoundingClientRect();
    const fab = document.getElementById('today-button').getBoundingClientRect();
    return Math.round(fab.top - badge.bottom);
  });
  expect(badgeFabGap).toBeGreaterThanOrEqual(4);

  expect(noise).toEqual([]);
});

test('sanitizes corrupt or out-of-range localStorage settings on startup', async ({ page, context }) => {
  await context.addInitScript(() => {
    if (!sessionStorage.getItem('__seededCorruptSettings')) {
      sessionStorage.setItem('__seededCorruptSettings', '1');
      localStorage.setItem(
        'lichongtrang.web.settings.v1',
        JSON.stringify({ weekStart: 99, zone: 'mars', selectedIso: '1800-99-99' }),
      );
    }
  });

  const noise = [];
  page.on('console', (m) => {
    if (m.type() === 'error') noise.push(`console error: ${m.text()}`);
  });
  page.on('pageerror', (e) => noise.push(`page error: ${e.message}`));

  await page.goto('/', { waitUntil: 'networkidle' });
  await page.waitForSelector('.cell-lunar', { timeout: 10000 });

  const bodyText = await page.evaluate(() => document.body.innerText);
  expect(bodyText).not.toContain('NaN');
  expect(bodyText).not.toContain('undefined');

  await expect(page.locator('[data-weekstart="1"]')).toHaveAttribute('aria-checked', 'true');
  await expect(page.locator('[data-zone="7"]')).toHaveAttribute('aria-checked', 'true');

  await page.locator('#datepicker-button').click();
  const pickerYear = Number(await page.locator('#picker-year').inputValue());
  expect(pickerYear).toBeGreaterThanOrEqual(1900);
  expect(pickerYear).toBeLessThanOrEqual(2100);
  expect(noise).toEqual([]);
});

test('requests persistent storage on standalone PWA launch only when not yet persisted', async ({ browser }) => {
  for (const alreadyPersisted of [false, true]) {
    const context = await browser.newContext();
    await context.addInitScript((persistedValue) => {
      Object.defineProperty(navigator, 'standalone', { configurable: true, value: true });
      window.__persistAsked = false;
      const storage = navigator.storage ?? {};
      storage.persisted = () => Promise.resolve(persistedValue);
      storage.persist = () => {
        window.__persistAsked = true;
        return Promise.resolve(true);
      };
      if (navigator.storage !== storage) Object.defineProperty(navigator, 'storage', { value: storage });
    }, alreadyPersisted);

    const page = await context.newPage();
    await page.goto('/', { waitUntil: 'networkidle' });
    await page.waitForSelector('.cell-lunar', { timeout: 10000 });
    await page.waitForTimeout(50);

    expect(await page.evaluate(() => Boolean(window.__persistAsked))).toBe(!alreadyPersisted);
    await context.close();
  }
});
