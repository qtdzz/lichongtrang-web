import { createHash } from 'node:crypto';
import { readFile, writeFile, readdir } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import { defineConfig } from 'vite';

/** One hash over everything that ships, so any change invalidates the service worker cache. */
export async function hashTree(root, { skip = [] } = {}) {
  const files = [];
  async function walk(dir, prefix) {
    const entries = await readdir(dir, { withFileTypes: true });
    for (const entry of entries.sort((a, b) => a.name.localeCompare(b.name))) {
      const rel = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (skip.some((pattern) => rel === pattern || rel.endsWith('/' + pattern))) continue;
      const full = join(dir, entry.name);
      if (entry.isDirectory()) await walk(full, rel);
      else files.push(rel);
    }
  }
  await walk(root, '');
  const digest = createHash('sha256');
  for (const rel of files) {
    digest.update(rel);
    digest.update(await readFile(join(root, rel)));
  }
  return { hash: digest.digest('hex'), files };
}

export const NON_PRECACHED_FILES = ['_headers', 'robots.txt', 'sitemap.xml', 'llms.txt', 'og-image.png'];

const STATIC_META_RULES = [
  {
    pattern: /^\/+((?:LICENSE|NOTICE)\.txt)(?:\?|$)/,
    rewrite: (m) => `/${m[1]}`,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'X-Robots-Tag': 'noindex' },
  },
  {
    pattern: /^\/+((?:robots|llms)\.txt)(?:\?|$)/,
    rewrite: (m) => `/${m[1]}`,
    headers: { 'Content-Type': 'text/plain; charset=utf-8', 'Cache-Control': 'no-cache' },
  },
  {
    pattern: /^\/+(sitemap\.xml)(?:\?|$)/,
    rewrite: (m) => `/${m[1]}`,
    headers: { 'Content-Type': 'application/xml; charset=utf-8', 'Cache-Control': 'no-cache' },
  },
];

export function staticMetaMimeMiddleware(req, res, next) {
  if (req.url) {
    for (const rule of STATIC_META_RULES) {
      const match = req.url.match(rule.pattern);
      if (!match) continue;
      req.url = rule.rewrite(match);
      for (const [header, value] of Object.entries(rule.headers)) {
        res.setHeader(header, value);
      }
      break;
    }
  }
  next();
}

function pwaBuildPlugin() {
  let outDir = 'dist';
  let rootDir = process.cwd();
  return {
    name: 'lichongtrang-pwa-build',
    configResolved(config) {
      rootDir = config.root;
      outDir = resolve(config.root, config.build.outDir);
    },
    configureServer(server) {
      server.middlewares.use(staticMetaMimeMiddleware);
    },
    configurePreviewServer(server) {
      server.middlewares.use(staticMetaMimeMiddleware);
    },
    async closeBundle() {
      const enginePath = resolve(rootDir, 'src/engine/amlich.js');
      const engineBytes = await readFile(enginePath);
      const engineHash = createHash('sha256').update(engineBytes).digest('hex');

      const web = await hashTree(outDir, { skip: ['build-info.json', 'sw.js', ...NON_PRECACHED_FILES] });
      const info = {
        engineHash,
        engineFiles: ['amlich.js'],
        webHash: web.hash.slice(0, 12),
        built: new Date().toISOString().replace(/\.\d+Z$/, 'Z'),
      };
      await writeFile(join(outDir, 'build-info.json'), JSON.stringify(info, null, 2) + '\n');

      const all = await hashTree(outDir, { skip: ['sw.js', ...NON_PRECACHED_FILES] });
      const version = `lot-web-${all.hash.slice(0, 12)}`;
      const template = await readFile(resolve(rootDir, 'src/sw.template.js'), 'utf8');
      const sw = template
        .replace('__VERSION__', version)
        .replace('__PRECACHE__', JSON.stringify(all.files, null, 2));
      await writeFile(join(outDir, 'sw.js'), sw);
    },
  };
}

export default defineConfig({
  base: './',
  publicDir: 'public',
  esbuild: {
    legalComments: 'inline',
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
    modulePreload: {
      polyfill: false,
    },
  },
  plugins: [pwaBuildPlugin()],
  test: {
    include: ['tests/unit/**/*.test.js'],
  },
});
