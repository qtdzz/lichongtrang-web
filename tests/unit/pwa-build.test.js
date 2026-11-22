import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'vite';
import { beforeAll, describe, it, expect } from 'vitest';
import { hashTree, NON_PRECACHED_FILES, staticMetaMimeMiddleware } from '../../vite.config.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../..');
const DIST = join(ROOT, 'dist');
const ORIGIN = 'https://lich.example';

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
    expect(nginxText).toMatch(/location = \/build-info\.json \{[\s\S]*?add_header X-Robots-Tag "noindex";[\s\S]*?\}/);
    expect(nginxText).toMatch(/location ~ \^\/\(LICENSE\|NOTICE\)\\\.txt\$ \{[\s\S]*?add_header X-Robots-Tag "noindex";[\s\S]*?\}/);
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
    expect(nginxText).toMatch(/charset_types[^;]*application\/xml/);
    expect(nginxText).toMatch(/gzip_types[^;]*application\/xml/);
    expect(nginxText).toMatch(/gzip_types[^;]*text\/plain/);
    for (const path of ['/robots.txt', '/llms.txt', '/sitemap.xml']) {
      expect(nginxText).toMatch(new RegExp(`location = ${path.replace('.', '\\.')} \\{[\\s\\S]*?add_header Cache-Control "no-cache";[\\s\\S]*?\\}`));
    }

    const html = await readFile(join(DIST, 'index.html'), 'utf8');
    const referenced = new Set();

    for (const m of html.matchAll(/<([a-z0-9-]+)\b[^>]*?\b(?:href|src)="([^"]+)"/gi)) {
      const tag = m[1].toLowerCase();
      const value = m[2];
      if (value.startsWith('#') || value.startsWith('data:')) continue;
      if (tag === 'a' && /^https?:\/\//.test(value)) continue;
      expect(value).not.toMatch(/^https?:|^\/\//);
      referenced.add(value.replace(/^\.?\//, ''));
    }

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
      const text =
        file === 'index.html'
          ? rawText.replace(/<a\b[^>]*\bhref="https?:\/\/[^"]+"[^>]*>/gi, '')
          : rawText;
      for (const m of text.matchAll(/https?:\/\/[^\s"')]+/g)) {
        const url = m[0];
        if (/w3\.org|schema\.org|example\.com|localhost/.test(url)) continue;
        throw new Error(`${file} mentions an external URL: ${url}`);
      }
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
