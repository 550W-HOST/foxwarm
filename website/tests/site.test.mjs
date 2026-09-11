import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(websiteRoot, '..');
const distRoot = path.join(websiteRoot, 'dist');
const publicRoot = path.join(websiteRoot, 'public');
const siteOrigin = 'https://foxwarm.550w.host';

const requiredRoutes = [
  '/',
  '/docs/',
  '/docs/installing/',
  '/docs/model-setup/',
  '/docs/agents-sessions-memory/',
  '/docs/tools-skills-mcp/',
  '/docs/nodes/',
  '/docs/channels/',
  '/docs/data-upgrades-backups/',
  '/docs/faq/'
];

function routeToFile(route) {
  if (route === '/') return path.join(distRoot, 'index.html');
  return path.join(distRoot, route.replace(/^\//, ''), 'index.html');
}

async function exists(filePath) {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function htmlFiles(dir = distRoot) {
  const found = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const child = path.join(dir, entry.name);
    if (entry.isDirectory()) found.push(...await htmlFiles(child));
    if (entry.isFile() && entry.name.endsWith('.html')) found.push(child);
  }
  return found;
}

function localTarget(url) {
  const clean = url.split('#', 1)[0].split('?', 1)[0];
  if (!clean || !clean.startsWith('/') || clean.startsWith('//')) return null;
  if (clean === '/') return path.join(distRoot, 'index.html');
  if (path.extname(clean)) return path.join(distRoot, clean.slice(1));
  return path.join(distRoot, clean.slice(1), 'index.html');
}

test('build contains every public page with the canonical custom-domain URL', async () => {
  for (const route of requiredRoutes) {
    const filePath = routeToFile(route);
    assert.equal(await exists(filePath), true, `missing ${route}`);
    const html = await readFile(filePath, 'utf8');
    assert.match(html, new RegExp(`<link rel="canonical" href="${siteOrigin.replaceAll('.', '\\.')}${route}"`));
    assert.doesNotMatch(html, /<meta[^>]+(?:name|http-equiv)="robots"[^>]+noindex/i, `${route} must be indexable`);
  }
});

test('built local links and assets resolve inside dist', async () => {
  const missing = [];
  for (const filePath of await htmlFiles()) {
    const html = await readFile(filePath, 'utf8');
    for (const match of html.matchAll(/(?:href|src)="([^"]+)"/g)) {
      const url = match[1];
      const target = localTarget(url);
      if (!target || url.startsWith('/404')) continue;
      if (!await exists(target)) missing.push(`${path.relative(distRoot, filePath)} -> ${url}`);
    }
  }
  assert.deepEqual(missing, []);
});

test('installer downloads are byte-exact copies of repository scripts', async () => {
  for (const name of ['install-foxwarm.sh', 'install-foxwarm.ps1']) {
    const source = await readFile(path.join(repositoryRoot, name));
    const staged = await readFile(path.join(publicRoot, name));
    const built = await readFile(path.join(distRoot, name));
    assert.deepEqual(staged, source, `${name} staged copy differs`);
    assert.deepEqual(built, source, `${name} built copy differs`);
    assert.doesNotMatch(built.subarray(0, 100).toString('utf8'), /<!doctype html>/i);
  }
});

test('the custom 404 is excluded from indexing', async () => {
  const html = await readFile(path.join(distRoot, '404.html'), 'utf8');
  assert.match(html, /<meta name="robots" content="noindex"/);
  assert.match(html, new RegExp(`<link rel="canonical" href="${siteOrigin.replaceAll('.', '\\.')}/404/"`));
});

test('robots, sitemap, and search artifacts are present', async () => {
  const robots = await readFile(path.join(distRoot, 'robots.txt'), 'utf8');
  assert.match(robots, /^User-agent: \*$/m);
  assert.match(robots, /^Allow: \/$/m);
  assert.match(robots, new RegExp(`Sitemap: ${siteOrigin.replaceAll('.', '\\.')}\/sitemap-index\\.xml`));

  const sitemapIndex = await readFile(path.join(distRoot, 'sitemap-index.xml'), 'utf8');
  assert.match(sitemapIndex, /sitemap-0\.xml/);
  const sitemap = await readFile(path.join(distRoot, 'sitemap-0.xml'), 'utf8');
  for (const route of requiredRoutes) assert.match(sitemap, new RegExp(`${siteOrigin.replaceAll('.', '\\.')}${route}`));
  assert.doesNotMatch(sitemap, /\/404\//);

  assert.equal(await exists(path.join(distRoot, 'pagefind', 'pagefind.js')), true, 'missing Pagefind search bundle');
  const docsHome = await readFile(routeToFile('/docs/'), 'utf8');
  assert.match(docsHome, /<site-search/);
  assert.match(docsHome, /aria-keyshortcuts="Control\+K"/);
});

test('public content has no unresolved installer host placeholders', async () => {
  const files = [
    path.join(repositoryRoot, 'README.md'),
    path.join(repositoryRoot, 'install-foxwarm.ps1'),
    ...await htmlFiles()
  ];
  for (const filePath of files) {
    const text = await readFile(filePath, 'utf8');
    assert.doesNotMatch(text, /YOUR_PUBLIC_FOXWARM_HOST|YOUR_DOMAIN/, path.relative(repositoryRoot, filePath));
  }
});
