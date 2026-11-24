import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'vite';
import { beforeAll, describe, it, expect } from 'vitest';
import { hashTree, NON_PRECACHED_FILES, resolveBuildCommit, staticMetaMimeMiddleware } from '../../vite.config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = join(ROOT, 'dist');
const ORIGIN = 'https://lich.example';
const ALLOWED_HTML_METADATA_URL_RE = /^https:\/\/(?:lichongtrang\.com(?:\/[^\s"')]*)?|github\.com\/qtdzz\/lichongtrang-web|schema\.org(?:\/[^\s"')]*)?)$/;
const ALLOWED_SPEC_ORIGIN_RE = /^https?:\/\/(?:www\.)?w3\.org(?:\/|$)|^https:\/\/schema\.org(?:\/|$)/;

function collectHtmlAssetRefs(html) {
  const referenced = new Set();
  for (const tagMatch of html.matchAll(/<([a-z0-9-]+)\b([^>]*)>/gi)) {
    const tag = tagMatch[1].toLowerCase();
    const attrs = tagMatch[2];
    for (const attrMatch of attrs.matchAll(/\b(?:href|src)\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>"']+))/gi)) {
      const value = (attrMatch[1] ?? attrMatch[2] ?? attrMatch[3]).trim();
      if (/^(?:#|data:)/i.test(value)) continue;
      if (tag === 'a' && /^https?:\/\//i.test(value)) continue;
      if (tag === 'link' && /(?:^|\s)rel\s*=\s*(?:"canonical"|'canonical'|canonical(?=\s|$))/i.test(attrs)) {
        if (value !== 'https://lichongtrang.com/') {
          throw new Error(`Unexpected canonical URL: ${value}`);
        }
        continue;
      }
      if (/^https?:|^\/\//i.test(value)) {
        throw new Error(`Disallowed external runtime attribute on <${tag}>: ${value}`);
      }
      referenced.add(value.replace(/^\.?\//, ''));
    }
    for (const srcsetMatch of attrs.matchAll(/\bsrcset\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s>"']+))/gi)) {
      const rawSrcset = srcsetMatch[1] ?? srcsetMatch[2] ?? srcsetMatch[3];
      for (const candidate of rawSrcset.split(',')) {
        const url = candidate.trim().split(/\s+/)[0];
        if (!url || /^(?:#|data:)/i.test(url)) continue;
        if (/^https?:|^\/\//i.test(url)) {
          throw new Error(`Disallowed external srcset URL on <${tag}>: ${url}`);
        }
        referenced.add(url.replace(/^\.?\//, ''));
      }
    }
  }
  for (const scriptMatch of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script>/gi)) {
    const attrs = scriptMatch[1];
    const body = scriptMatch[2];
    if (/\bsrc\s*=/i.test(attrs) || /\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json(?=\s|$))/i.test(attrs)) {
      continue;
    }
    if (/https?:\/\/|['"`]\/\/[a-z0-9.-]/i.test(body)) {
      throw new Error(`Disallowed URL inside inline <script>: ${body}`);
    }
  }
  return referenced;
}

function assertNoDisallowedExternalUrls(file, rawText) {
  const text =
    file === 'index.html'
      ? rawText.replace(/(<a\b[^>]*?)\s+\bhref\s*=\s*(?:"https?:\/\/[^"]*"|'https?:\/\/[^']*'|https?:\/\/[^\s>"']+)/gi, '$1')
      : rawText;
  for (const m of text.matchAll(/https?:\/\/[^\s"')]+/g)) {
    const url = m[0];
    if (ALLOWED_SPEC_ORIGIN_RE.test(url)) continue;
    if (file === 'index.html' && ALLOWED_HTML_METADATA_URL_RE.test(url)) continue;
    throw new Error(`${file} mentions an external URL: ${url}`);
  }
}

function parseJsonLdScripts(html) {
  const matches = [
    ...html.matchAll(
      /<script\b([^>]*\btype\s*=\s*(?:"application\/ld\+json"|'application\/ld\+json'|application\/ld\+json(?=\s|$))[^>]*)>([\s\S]*?)<\/script>/gi,
    ),
  ];
  if (matches.length === 0) throw new Error('Missing JSON-LD script');
  return matches.map((m) => JSON.parse(m[2]));
}

async function walk(root, prefix = '') {
  const out = [];
  for (const entry of await readdir(join(root, prefix), { withFileTypes: true })) {
    const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) out.push(...await walk(root, rel));
    else out.push(rel);
  }
  return out;
}

beforeAll(async () => {
  await build({ root: ROOT, logLevel: 'silent' });
});

describe('offline precache audit', () => {
  it('only skips exact filename or path-segment matches in hashTree', async () => {
    expect(NON_PRECACHED_FILES).toEqual(['_headers', 'robots.txt', 'sitemap.xml', 'llms.txt', 'og-image.png']);
    const dir = await mkdtemp(join(tmpdir(), 'lot-hash-'));
    try {
      await mkdir(join(dir, 'assets'), { recursive: true });
      await writeFile(join(dir, 'sw.js'), 'worker');
      for (const name of [...NON_PRECACHED_FILES, 'index.html', 'build-info.json', 'assets/index-a1b2_sw.js']) {
        await writeFile(join(dir, name), 'data');
      }
      const { files } = await hashTree(dir, { skip: ['sw.js', ...NON_PRECACHED_FILES] });
      expect(files).toEqual(['assets/index-a1b2_sw.js', 'build-info.json', 'index.html']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('sets UTF-8 MIME, cache, and noindex headers in staticMetaMimeMiddleware', () => {
    const cases = [
      ['/robots.txt', '/robots.txt', { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }],
      ['//llms.txt?v=1', '/llms.txt', { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' }],
      ['/sitemap.xml', '/sitemap.xml', { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-cache' }],
      ['/LICENSE.txt', '/LICENSE.txt', { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex' }],
      ['/NOTICE.txt?raw=1', '/NOTICE.txt', { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex' }],
    ];
    for (const [inputUrl, normalizedUrl, expectedHeaders] of cases) {
      const headers = {};
      let nextCalled = false;
      const req = { url: inputUrl };
      const res = { setHeader: (k, v) => { headers[k] = v; } };
      staticMetaMimeMiddleware(req, res, () => { nextCalled = true; });
      expect(nextCalled).toBe(true);
      expect(req.url).toBe(normalizedUrl);
      expect(headers).toEqual(expectedHeaders);
    }
  });

  it('keeps project structure and config clean and deterministic', async () => {
    expect(existsSync(join(ROOT, 'tools'))).toBe(false);
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    expect(pkg.license).toBe('AGPL-3.0-only AND LicenseRef-HoNgocDuc-NonCommercial');
    expect(pkg.repository?.url).toBe('git+https://github.com/qtdzz/lichongtrang-web.git');
    expect(pkg.homepage).toBe('https://github.com/qtdzz/lichongtrang-web');
    expect(pkg.scripts['test:e2e']).toBe('playwright test --project=chromium');
    expect(pkg.scripts['test:e2e:all']).toBe('playwright test');
    for (const version of Object.values(pkg.devDependencies)) {
      expect(version).toMatch(/^\d+\.\d+\.\d+$/);
    }
    const dockerignore = await readFile(join(ROOT, '.dockerignore'), 'utf8');
    expect(dockerignore).not.toContain('verify-shots');
    expect(dockerignore).toContain('test-results');
    expect(dockerignore).toContain('playwright-report');
  });

  it('resolves git commit and embeds version and commit in build-info.json and Dockerfile', async () => {
    expect(resolveBuildCommit(ROOT, {
      GIT_SHA: 'ABCDEF1234567890',
      GITHUB_SHA: '1111111',
      CF_PAGES_COMMIT_SHA: '2222222',
    })).toBe('abcdef1');
    expect(resolveBuildCommit(ROOT, {
      GIT_SHA: 'not-a-sha',
      GITHUB_SHA: '  1234567890abcdef  ',
      CF_PAGES_COMMIT_SHA: '3333333',
    })).toBe('1234567');
    expect(resolveBuildCommit(ROOT, {
      CF_PAGES_COMMIT_SHA: '89ABCDEF0',
    })).toBe('89abcde');

    const headSha = resolveBuildCommit(ROOT, {});
    expect(headSha).toMatch(/^[0-9a-f]{7}$/);

    const tempDir = await mkdtemp(join(tmpdir(), 'lot-nogit-'));
    try {
      expect(resolveBuildCommit(tempDir, {})).toBeNull();
    } finally {
      await rm(tempDir, { recursive: true, force: true });
    }

    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
    const buildInfo = JSON.parse(await readFile(join(DIST, 'build-info.json'), 'utf8'));
    expect(buildInfo.version).toBe(pkg.version);
    expect(buildInfo.commit).toBe(headSha);
    expect(buildInfo.engineHash).toMatch(/^[0-9a-f]{64}$/);
    expect(buildInfo.webHash).toMatch(/^[0-9a-f]{12}$/);
    expect(buildInfo.built).toMatch(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}Z$/);

    const dockerfile = await readFile(join(ROOT, 'Dockerfile'), 'utf8');
    const argIdx = dockerfile.indexOf('ARG GIT_SHA');
    const envIdx = dockerfile.indexOf('ENV GIT_SHA');
    const checkIdx = dockerfile.indexOf('RUN npm run check');
    expect(argIdx).toBeGreaterThan(-1);
    expect(envIdx).toBeGreaterThan(argIdx);
    expect(checkIdx).toBeGreaterThan(envIdx);
  });

  it('ships verbatim LICENSE and NOTICE files and retains @license headers in bundled JS', async () => {
    const [rootLicense, pubLicense, distLicense] = await Promise.all([
      readFile(join(ROOT, 'LICENSE'), 'utf8'),
      readFile(join(ROOT, 'public/LICENSE.txt'), 'utf8'),
      readFile(join(DIST, 'LICENSE.txt'), 'utf8'),
    ]);
    expect(pubLicense).toBe(rootLicense);
    expect(distLicense).toBe(rootLicense);
    expect(rootLicense).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');

    const [rootNotice, pubNotice, distNotice] = await Promise.all([
      readFile(join(ROOT, 'NOTICE'), 'utf8'),
      readFile(join(ROOT, 'public/NOTICE.txt'), 'utf8'),
      readFile(join(DIST, 'NOTICE.txt'), 'utf8'),
    ]);
    expect(pubNotice).toBe(rootNotice);
    expect(distNotice).toBe(rootNotice);
    expect(rootNotice).toContain('Copyright (C) 2026 Tien Nguyen');
    expect(rootNotice).toContain('Section 7');
    expect(rootNotice).toContain('Copyright (c) 2006 Ho Ngoc Duc. All Rights Reserved.');
    expect(rootNotice).toContain('https://github.com/qtdzz/lichongtrang-web');

    const allFiles = await walk(DIST);
    const jsBundles = await Promise.all(
      allFiles
        .filter((f) => f.startsWith('assets/') && f.endsWith('.js'))
        .map((f) => readFile(join(DIST, f), 'utf8')),
    );
    const bundledJs = jsBundles.join('\n');
    expect(bundledJs).toContain('Copyright (c) 2006 Ho Ngoc Duc. All Rights Reserved.');
    expect(bundledJs).toContain('Copyright (C) 2026 Tien Nguyen');
    expect(bundledJs).not.toContain('modulepreload');
  });

  it('precaches every emitted asset and references no external origins', async () => {
    const allFiles = (await walk(DIST)).sort();
    const swText = await readFile(join(DIST, 'sw.js'), 'utf8');
    const match = swText.match(/const PRECACHE = (\[[\s\S]*?\]);/);
    expect(match).not.toBeNull();

    const precached = JSON.parse(match[1]);
    const precachedSet = new Set(precached);

    for (const file of precached) {
      expect(allFiles).toContain(file);
    }

    expect(allFiles).toContain('_headers');
    expect(precachedSet.has('_headers')).toBe(false);
    const headersText = await readFile(join(DIST, '_headers'), 'utf8');
    expect(headersText).toContain('/sw.js');
    expect(headersText).toContain('/assets/*');
    for (const path of ['/build-info.json', '/LICENSE.txt', '/NOTICE.txt']) {
      const block = headersText.match(new RegExp(`^${path.replace('.', '\\.')}\\n(?:  .+\\n?)+`, 'm'));
      expect(block, `missing _headers block for ${path}`).not.toBeNull();
      expect(block[0]).toContain('X-Robots-Tag: noindex');
    }
    const nginxText = await readFile(join(ROOT, 'docker/nginx.conf'), 'utf8');
    expect(nginxText).toMatch(/location = \/build-info\.json \{((?:[^{}]|\{[^{}]*\})*)\}/);
    const buildInfoBlock = nginxText.match(/location = \/build-info\.json \{((?:[^{}]|\{[^{}]*\})*)\}/)?.[1] ?? '';
    expect(buildInfoBlock).toContain('add_header X-Robots-Tag "noindex";');
    const licenseBlock = nginxText.match(/location ~ \^\/\(LICENSE\|NOTICE\)\\\.txt\$ \{((?:[^{}]|\{[^{}]*\})*)\}/)?.[1] ?? '';
    expect(licenseBlock).toContain('add_header X-Robots-Tag "noindex";');
    for (const [path, contentType] of [
      ['/robots.txt', 'text/plain; charset=utf-8'],
      ['/llms.txt', 'text/plain; charset=utf-8'],
      ['/sitemap.xml', 'application/xml; charset=utf-8'],
    ]) {
      const block = headersText.match(new RegExp(`^${path.replace('.', '\\.')}\\n(?:  .+\\n?)+`, 'm'));
      expect(block, `missing _headers block for ${path}`).not.toBeNull();
      expect(block[0]).toContain(`Content-Type: ${contentType}`);
      expect(block[0]).toContain('Cache-Control: no-cache');
    }
    const charsetLine = nginxText.match(/^\s*charset_types\s+([^;]+);/m)?.[1] ?? '';
    expect(charsetLine).not.toContain('text/html');
    expect(charsetLine).toContain('application/xml');
    expect(charsetLine).toContain('text/plain');
    expect(charsetLine).toContain('text/javascript');
    const gzipLine = nginxText.match(/^\s*gzip_types\s+([^;]+);/m)?.[1] ?? '';
    expect(gzipLine).toContain('application/xml');
    expect(gzipLine).toContain('text/plain');
    expect(gzipLine).toContain('text/javascript');
    for (const path of ['/robots.txt', '/llms.txt', '/sitemap.xml']) {
      const block = nginxText.match(new RegExp(`location = ${path.replace('.', '\\.')} \\{((?:[^{}]|\\{[^{}]*\\})*)\\}`));
      expect(block, `missing nginx location for ${path}`).not.toBeNull();
      expect(block[1]).toContain('add_header Cache-Control "no-cache";');
      if (path === '/sitemap.xml') {
        expect(block[1]).toContain('types { application/xml xml; }');
      }
    }

    const html = await readFile(join(DIST, 'index.html'), 'utf8');
    const referenced = collectHtmlAssetRefs(html);

    const assetFiles = allFiles.filter((f) => f.startsWith('assets/'));
    expect(assetFiles.length).toBeGreaterThanOrEqual(2);
    for (const asset of assetFiles) {
      expect(precachedSet.has(asset)).toBe(true);
      if (asset.endsWith('.js')) {
        const jsText = await readFile(join(DIST, asset), 'utf8');
        for (const m of jsText.matchAll(/fetch\(["']([^"']+)["']/g)) {
          referenced.add(m[1].replace(/^\.?\//, ''));
        }
      }
    }

    for (const ref of referenced) {
      expect(precachedSet.has(ref)).toBe(true);
    }

    const textFiles = ['index.html', 'manifest.webmanifest', 'sw.js', ...assetFiles];
    for (const file of textFiles) {
      const rawText = await readFile(join(DIST, file), 'utf8');
      assertNoDisallowedExternalUrls(file, rawText);
    }
  });

  it('emits valid SVG and exact-dimension PNG icons precached by the service worker', async () => {
    const swText = await readFile(join(DIST, 'sw.js'), 'utf8');
    const precached = new Set(JSON.parse(swText.match(/const PRECACHE = (\[[\s\S]*?\]);/)[1]));
    const manifest = JSON.parse(await readFile(join(DIST, 'manifest.webmanifest'), 'utf8'));

    expect(manifest.icons).toEqual([
      { src: 'icons/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
      { src: 'icons/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
      { src: 'icons/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
    ]);

    for (const icon of manifest.icons) {
      expect(precached.has(icon.src)).toBe(true);
    }

    const svgText = await readFile(join(DIST, 'icons/icon.svg'), 'utf8');
    expect(svgText).toContain('width="512" height="512" viewBox="0 0 512 512"');
    expect(svgText).toContain('rsvg-convert');
    expect(svgText).toContain('#9678e3');
    expect(svgText).toContain('#fff3a8');
    expect(svgText).toContain('#432787');

    const expectedPngs = [
      ['icons/apple-touch-icon.png', 180, 180],
      ['icons/icon-192.png', 192, 192],
      ['icons/icon-512.png', 512, 512],
      ['icons/icon-maskable-512.png', 512, 512],
    ];
    for (const [relPath, width, height] of expectedPngs) {
      expect(precached.has(relPath)).toBe(true);
      const buf = await readFile(join(DIST, relPath));
      expect(buf.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
      expect(buf.readUInt32BE(16)).toBe(width);
      expect(buf.readUInt32BE(20)).toBe(height);
    }
  });

  it('emits robots.txt, sitemap.xml, llms.txt, and 1200x630 og-image.png outside the SW precache', async () => {
    const swText = await readFile(join(DIST, 'sw.js'), 'utf8');
    const precached = new Set(JSON.parse(swText.match(/const PRECACHE = (\[[\s\S]*?\]);/)[1]));

    for (const file of ['robots.txt', 'sitemap.xml', 'llms.txt', 'og-image.png']) {
      expect(existsSync(join(DIST, file)), `${file} missing from dist/`).toBe(true);
      expect(precached.has(file), `${file} must not be precached`).toBe(false);
    }

    const robots = await readFile(join(DIST, 'robots.txt'), 'utf8');
    expect(robots).toContain('User-agent: *');
    expect(robots).toContain('Allow: /');
    expect(robots).toContain('Sitemap: https://lichongtrang.com/sitemap.xml');

    const sitemap = await readFile(join(DIST, 'sitemap.xml'), 'utf8');
    expect(sitemap).toContain('<loc>https://lichongtrang.com/</loc>');
    expect(sitemap).toContain('http://www.sitemaps.org/schemas/sitemap/0.9');

    const llms = await readFile(join(DIST, 'llms.txt'), 'utf8');
    expect(llms).toContain('# Lịch Ông Trăng');
    expect(llms).toContain('Vietnamese Lunar Calendar');
    expect(llms).toContain('12 traditional Vietnamese lunar holidays');
    expect(llms).not.toContain('solar and lunar holidays');
    expect(llms).toContain('https://lichongtrang.com/');
    expect(llms).toContain('https://github.com/qtdzz/lichongtrang-web');
    expect(llms).toContain('https://lichongtrang.com/NOTICE.txt');
    expect(llms).toContain('https://lichongtrang.com/LICENSE.txt');

    const ogPng = await readFile(join(DIST, 'og-image.png'));
    expect(ogPng.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(ogPng.readUInt32BE(16)).toBe(1200);
    expect(ogPng.readUInt32BE(20)).toBe(630);
  });

  it('includes bilingual SEO metadata, Open Graph, JSON-LD, and semantic noscript in built HTML', async () => {
    expect(ALLOWED_HTML_METADATA_URL_RE.test('https://cdn.example.net/tracker.js')).toBe(false);
    expect(ALLOWED_HTML_METADATA_URL_RE.test('https://fonts.googleapis.com/css2')).toBe(false);

    const html = await readFile(join(DIST, 'index.html'), 'utf8');
    expect(html).toContain('<title>Lịch Ông Trăng — Âm Lịch Việt Nam (Vietnamese Lunar Calendar)</title>');
    expect(html).toContain('<meta name="description" content="Xem âm lịch Việt Nam (Vietnamese lunar calendar) miễn phí, không quảng cáo, chạy offline: lịch âm dương 1900–2100, Can Chi, 24 tiết khí và ngày lễ Việt Nam.">');
    expect(html).toContain('<link rel="canonical" href="https://lichongtrang.com/">');
    expect(html).toContain('<meta name="robots" content="index, follow, max-image-preview:large">');
    expect(html).toContain('<meta name="apple-mobile-web-app-title" content="Lịch Ông Trăng">');
    expect(html).toContain('<meta property="og:url" content="https://lichongtrang.com/">');
    expect(html).toContain('<meta property="og:image" content="https://lichongtrang.com/og-image.png">');
    expect(html).not.toContain('og:locale:alternate');
    expect(html).toContain('<meta name="twitter:card" content="summary_large_image">');
    expect(html).not.toMatch(/<meta\s+name="keywords"/i);
    expect(html).not.toMatch(/hreflang=/i);

    const ldDocs = parseJsonLdScripts(html);
    expect(ldDocs).toHaveLength(1);
    const ld = ldDocs[0];
    expect(ld['@context']).toBe('https://schema.org');
    expect(ld['@graph'].map((n) => n['@type'])).toEqual(['WebSite', 'WebApplication']);
    const [siteNode, appNode] = ld['@graph'];
    expect(siteNode.inLanguage).toBe('vi');
    expect(appNode.url).toBe('https://lichongtrang.com/');
    expect(appNode.isAccessibleForFree).toBe(true);
    expect(appNode.inLanguage).toBe('vi');
    expect(appNode.screenshot).toBeUndefined();
    expect(appNode.license).toBe('https://lichongtrang.com/NOTICE.txt');
    expect(appNode.sameAs).toContain('https://github.com/qtdzz/lichongtrang-web');

    const noscript = html.match(/<noscript>([\s\S]*?)<\/noscript>/)?.[1] ?? '';
    expect(noscript).toContain('Trang này cần JavaScript để tính lịch âm.');
    expect(noscript).toContain('Vietnamese Lunar Calendar');
    expect(noscript).toContain('1900');
    expect(noscript).toContain('2100');
    expect(noscript).toContain('LICENSE.txt');
    expect(noscript).toContain('NOTICE.txt');
  });

  it('rejects single-quoted/unquoted/srcset bypasses, spoofed allowlist domains, external <a> event attributes, and malformed JSON-LD blocks', () => {
    expect(() => collectHtmlAssetRefs("<script src='https://lichongtrang.com/tracker.js'></script>")).toThrow();
    expect(() => collectHtmlAssetRefs('<script src=" https://lichongtrang.com/x.js"></script>')).toThrow();
    expect(() => collectHtmlAssetRefs('<link rel=stylesheet href=https://lichongtrang.com/app.css>')).toThrow();
    expect(() => collectHtmlAssetRefs('<link data-rel="canonical" href="https://lichongtrang.com/x.css">')).toThrow();
    expect(() => collectHtmlAssetRefs('<img srcset="https://lichongtrang.com/a.png 1x, icons/b.png 2x">')).toThrow();
    expect(() => collectHtmlAssetRefs('<script>fetch("https://evil.com/x")</script>')).toThrow();
    expect(() => collectHtmlAssetRefs("<script>fetch('//evil.com/x')</script>")).toThrow();

    expect(() => assertNoDisallowedExternalUrls('sw.js', 'https://tracker.evil/schema.org')).toThrow();
    expect(() => assertNoDisallowedExternalUrls('sw.js', 'https://evil.schema.org/')).toThrow();
    expect(() => assertNoDisallowedExternalUrls('sw.js', 'http://localhost:8080/api')).toThrow();
    expect(() => assertNoDisallowedExternalUrls('sw.js', 'https://evil.example.com/')).toThrow();
    expect(() => assertNoDisallowedExternalUrls('index.html', 'https://evil.com/?host=localhost')).toThrow();
    expect(() => assertNoDisallowedExternalUrls('index.html', 'https://lichongtrang.com.evil.com/')).toThrow();
    expect(() =>
      assertNoDisallowedExternalUrls(
        'index.html',
        '<a href="https://github.com/qtdzz/lichongtrang-web" ping="https://evil.com/p" onclick="fetch(\'https://evil.com\')">x</a>',
      ),
    ).toThrow();

    expect(() =>
      parseJsonLdScripts(
        '<script type="application/ld+json">{}</script><script type="application/ld+json">{bad json}</script>',
      ),
    ).toThrow();
  });
});

describe('service worker offline execution', () => {
  it('serves the shell and all precached assets offline and rejects missing subresources', async () => {
    let online = true;
    let networkRequests = 0;
    const stores = new Map();

    class RequestStub {
      constructor(url, method = 'GET', mode = 'cors') {
        this.url = url.startsWith('http') ? url : `${ORIGIN}/${url.replace(/^\.?\//, '')}`;
        this.method = method;
        this.mode = mode;
      }
    }

    class ResponseStub {
      constructor(body, init = 200) {
        const opts = typeof init === 'number' ? { status: init } : init;
        this.body = body;
        this.status = opts.status ?? 200;
        this.statusText = opts.statusText ?? '';
        this.headers = new Headers(opts.headers);
        this.redirected = Boolean(opts.redirected);
        this.ok = this.status >= 200 && this.status < 300;
        this.type = 'basic';
      }
      async arrayBuffer() {
        return this.body;
      }
      clone() {
        return new ResponseStub(this.body, {
          status: this.status,
          statusText: this.statusText,
          headers: this.headers,
          redirected: this.redirected,
        });
      }
    }

    function makeCache(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async addAll(urls) {
          for (const url of urls) {
            const response = await sandbox.fetch(new RequestStub(url, 'GET', 'no-cors'));
            if (!response.ok) throw new Error(`precache failed for ${url}: ${response.status}`);
            entries.set(url, response);
          }
        },
        async put(request, response) {
          entries.set(typeof request === 'string' ? request : request.url, response);
        },
        async match(request) {
          const key = typeof request === 'string' ? request : request.url;
          return entries.get(key) ?? entries.get(key.replace(ORIGIN + '/', '')) ?? undefined;
        },
      };
    }

    const listeners = new Map();
    const sandbox = {
      console,
      URL,
      JSON,
      Promise,
      Map,
      Set,
      Object,
      Array,
      Error,
      Headers,
      Response: ResponseStub,
      location: { origin: ORIGIN },
      self: {
        location: { origin: ORIGIN },
        addEventListener: (type, handler) => {
          if (!listeners.has(type)) listeners.set(type, []);
          listeners.get(type).push(handler);
        },
        skipWaiting: async () => {},
        clients: { claim: async () => {} },
      },
      caches: {
        open: async (name) => makeCache(name),
        keys: async () => [...stores.keys()],
        delete: async (name) => stores.delete(name),
        match: async (request) => {
          const key = typeof request === 'string' ? request : request.url;
          for (const entries of stores.values()) {
            const hit = entries.get(key) ?? entries.get(key.replace(ORIGIN + '/', ''));
            if (hit) return hit;
          }
          return undefined;
        },
      },
      async fetch(request) {
        networkRequests += 1;
        if (!online) throw new TypeError('Failed to fetch (offline)');
        const path = new URL(typeof request === 'string' ? request : request.url, `${ORIGIN}/`).pathname.replace(/^\//, '');
        try {
          const bytes = await readFile(join(DIST, path));
          // Simulate Cloudflare Workers Static Assets redirecting /index.html -> / with Brotli headers
          return new ResponseStub(bytes, {
            status: 200,
            redirected: path === 'index.html',
            headers: path === 'index.html'
              ? { 'content-type': 'text/html; charset=utf-8', 'content-encoding': 'br', 'content-length': '123' }
              : undefined,
          });
        } catch {
          return new ResponseStub('not found', 404);
        }
      },
    };
    sandbox.globalThis = sandbox;

    const code = await readFile(join(DIST, 'sw.js'), 'utf8');
    vm.runInNewContext(code, sandbox, { filename: 'sw.js' });

    async function dispatch(type) {
      const waits = [];
      const event = { waitUntil: (promise) => waits.push(promise) };
      for (const handler of listeners.get(type) ?? []) handler(event);
      await Promise.all(waits);
    }

    await dispatch('install');
    await dispatch('activate');

    expect(networkRequests).toBeGreaterThan(0);
    expect([...stores.keys()].length).toBe(1);

    online = false;

    async function request(url, mode) {
      let responded = null;
      const event = {
        request: new RequestStub(url, 'GET', mode),
        respondWith: (promise) => { responded = promise; },
      };
      for (const handler of listeners.get('fetch') ?? []) handler(event);
      return responded;
    }

    const rootShell = await request('/', 'navigate');
    expect(rootShell?.ok).toBe(true);
    expect(rootShell?.redirected).toBe(false);
    expect(rootShell.headers.get('content-encoding')).toBeNull();
    expect(rootShell.headers.get('content-length')).toBeNull();
    expect(rootShell.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(rootShell.body.toString()).toContain('Lịch Ông Trăng');

    const shell = await request('index.html', 'navigate');
    expect(shell?.ok).toBe(true);
    expect(shell?.redirected).toBe(false);
    expect(shell.headers.get('content-encoding')).toBeNull();
    expect(shell.headers.get('content-length')).toBeNull();
    expect(shell.headers.get('content-type')).toBe('text/html; charset=utf-8');
    expect(shell.body.toString()).toContain('Lịch Ông Trăng');

    const licenseNav = await request('LICENSE.txt', 'navigate');
    expect(licenseNav?.ok).toBe(true);
    expect(licenseNav.body.toString()).toContain('GNU AFFERO GENERAL PUBLIC LICENSE');

    const noticeNav = await request('NOTICE.txt', 'navigate');
    expect(noticeNav?.ok).toBe(true);
    expect(noticeNav.body.toString()).toContain('Copyright (c) 2006 Ho Ngoc Duc');

    const precached = JSON.parse(code.match(/const PRECACHE = (\[[\s\S]*?\]);/)[1]);
    for (const file of precached) {
      const response = await request(file, 'cors');
      expect(response?.ok).toBe(true);
    }

    const missingRes = await request('missing-file.js', 'cors').catch(() => null);
    expect(missingRes?.ok ?? false).toBe(false);

    for (const path of ['robots.txt', 'sitemap.xml', 'llms.txt', 'og-image.png']) {
      expect(await request(path, 'navigate')).toBeNull();
      expect(await request(path, 'cors')).toBeNull();
    }
  });
});
