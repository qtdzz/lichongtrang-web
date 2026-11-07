import { existsSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import vm from 'node:vm';
import { build } from 'vite';
import { beforeAll, describe, it, expect } from 'vitest';
import { hashTree } from '../../vite.config.js';

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
    const dir = await mkdtemp(join(tmpdir(), 'lot-hash-'));
    try {
      await mkdir(join(dir, 'assets'), { recursive: true });
      await writeFile(join(dir, 'sw.js'), 'worker');
      await writeFile(join(dir, 'assets/index-a1b2_sw.js'), 'bundle');
      const { files } = await hashTree(dir, { skip: ['sw.js'] });
      expect(files).toEqual(['assets/index-a1b2_sw.js']);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('keeps project structure and config clean and deterministic', async () => {
    expect(existsSync(join(ROOT, 'tools'))).toBe(false);
    const pkg = JSON.parse(await readFile(join(ROOT, 'package.json'), 'utf8'));
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

    const html = await readFile(join(DIST, 'index.html'), 'utf8');
    const referenced = new Set();

    for (const m of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const value = m[1];
      if (value.startsWith('#') || value.startsWith('data:')) continue;
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
      const text = await readFile(join(DIST, file), 'utf8');
      for (const m of text.matchAll(/https?:\/\/[^\s"')]+/g)) {
        const url = m[0];
        if (/w3\.org|schema\.org|example\.com|localhost/.test(url)) continue;
        throw new Error(`${file} mentions an external URL: ${url}`);
      }
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
      constructor(body, status = 200) {
        this.body = body;
        this.status = status;
        this.ok = status >= 200 && status < 300;
        this.type = 'basic';
      }
      clone() {
        return new ResponseStub(this.body, this.status);
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
        const path = new URL(typeof request === 'string' ? request : request.url).pathname.replace(/^\//, '');
        try {
          const bytes = await readFile(join(DIST, path));
          return new ResponseStub(bytes, 200);
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

    const shell = await request('index.html', 'navigate');
    expect(shell?.ok).toBe(true);
    expect(shell.body.toString()).toContain('Lịch Ông Trăng');

    const precached = JSON.parse(code.match(/const PRECACHE = (\[[\s\S]*?\]);/)[1]);
    for (const file of precached) {
      const response = await request(file, 'cors');
      expect(response?.ok).toBe(true);
    }

    const missingRes = await request('missing-file.js', 'cors').catch(() => null);
    expect(missingRes?.ok ?? false).toBe(false);
  });
});
