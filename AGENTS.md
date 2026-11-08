# Lịch Ông Trăng (lichongtrang-web)

Offline-first Vietnamese lunisolar calendar PWA (vanilla ES modules + CSS, bundled with Vite).

## Hard Constraints & Non-Negotiables
- **100% Offline-First & Zero Backend**: Must run completely offline in the browser with no backend server, API calls, analytics, or external runtime origins (no Google Fonts, CDNs, or remote scripts/images). `tests/unit/pwa-build.test.js` fails the build if any asset references an external URL or is missing from the Service Worker `PRECACHE` list.
- **Zero Runtime Dependencies**: Plain ES modules and vanilla CSS only (`package.json` has zero `dependencies`, only `vite`, `vitest`, and `@playwright/test` in `devDependencies`).
- **Engine Parity (`src/engine/amlich.js`)**: Implements Hồ Ngọc Đức's lunisolar algorithm (supported range 1900–2100). Its exported functions and return shapes (`LIMITS`, `limits`, `today`, `monthTitle`, `weekdays`, `monthGrid`, `day`, `WebApi`) are locked against the 132-answer Android/JVM reference corpus (`tests/unit/fixtures/engine-dump.json`). Do not change engine outputs unless intentional; handle UI-only formatting in `src/main.js`.
- **Clean Repository Structure**: `tests/unit/pwa-build.test.js` enforces exact `x.y.z` pinned `devDependencies` versions in `package.json` and forbids stray directories like `tools/`.
- **Accessibility & Visual Parity**:
  - Every interactive element is a native `<button>` with >= 48px tap targets (`--tap: 48px`) where applicable.
  - All text (including `.cell.is-outside`, `.cell-lunar`, selected holidays, and legend items) must meet WCAG AA contrast (>= 4.5:1) in both light and dark themes.
  - Maintain valid ARIA grid hierarchy (`.month-grid[role="grid"]` -> `#weekdays[role="row"] > span[role="columnheader"]` and `#grid[role="rowgroup"] > .grid-row[role="row"] > button[role="gridcell"]`, where `.grid-row` uses `display: contents`).
  - Playwright E2E enforces `maxDiffPixels: 0` against 11 golden screenshots in `tests/e2e/__screenshots__/`. Any intentional visual change requires updating snapshots.

## Environment & Commands
- **CLI Note**: `npm` and `bun` are not in the default `PATH` on this machine; `/usr/bin/node` (v26+) is available. Use `node --run <script>`, `./node_modules/.bin/<tool>`, or `make`.
- **Build & Unit/Offline Audit**: `make check` (or `node --run check` -> runs `vite build && vitest run`)
- **E2E & Visual Regression**: `make verify-browser` (or `node --run test:e2e` -> runs `playwright test --project=chromium`)
- **Update Visual Snapshots**: `node --run test:e2e:update` (or `./node_modules/.bin/playwright test --project=chromium --update-snapshots`)
- **Local Prod Preview**: `node --run build && node --run preview` (serves `dist/` on `http://127.0.0.1:4173`)

## Codebase Map
- `index.html`: Single-page shell: header (`.top`), month grid (`.month-grid` wrapping `#weekdays` + `#grid`), zoomed year/month selector (`#selector`), day details panel (`#panel`), monthly holiday/solar-term legend (`#legend`), navigation drawer (`#menu`), settings dialog (`#sheet`), about dialog (`#about`), today FAB (`#today-button`), and offline badge (`#offline-badge`).
- `src/main.js`: UI state (`localStorage` key `lichongtrang.web.settings.v1`), DOM rendering, 3 zoom levels (`''` month view, `'years'` 12-year block, `'months'` 12 months), pointer-swipe month navigation, keyboard navigation, and Service Worker registration.
- `src/styles.css`: Material Design 3 Expressive color tokens (`--md-sys-color-*` for light and `@media (prefers-color-scheme: dark)`), responsive layout, and reduced-motion rules.
- `src/engine/amlich.js`: Pure calendar calculation engine and UI view-model builders.
- `src/sw.template.js` & `vite.config.js`: `offlineBuildPlugin` generates `dist/build-info.json` and `dist/sw.js` with content-hashed precache list at the end of `vite build`.
- `tests/unit/amlich.test.js`: Unit tests + 132-answer JVM corpus verification.
- `tests/unit/pwa-build.test.js`: Build hygiene, zero-external-origin check, precache completeness, and offline Service Worker execution in `node:vm`.
- `tests/e2e/app.spec.js`: Full E2E interaction, contrast, ARIA structure, offline reload, and 11-screenshot visual regression suite (time frozen at `2026-09-28T05:00:00.000Z`).
