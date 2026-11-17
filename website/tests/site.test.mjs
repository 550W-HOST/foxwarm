import assert from 'node:assert/strict';
import { readFile, readdir, stat } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { unpackSnapshot } from '../../packages/webui/demo/src/pack.mjs';
import { detectPlatform } from '../src/scripts/platform.mjs';

const websiteRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const repositoryRoot = path.resolve(websiteRoot, '..');
const distRoot = path.join(websiteRoot, 'dist');
const publicRoot = path.join(websiteRoot, 'public');
const siteOrigin = 'https://foxwarm.net';

const requiredRoutes = [
  '/',
  '/zh/',
  '/docs/',
  '/docs/quick-start/',
  '/docs/how-it-works/',
  '/docs/installing/',
  '/docs/model-setup/',
  '/docs/model-options/',
  '/docs/history-search/',
  '/docs/agents-sessions-memory/',
  '/docs/tools-skills-mcp/',
  '/docs/mcp-inbound/',
  '/docs/nodes/',
  '/docs/channels/',
  '/docs/delegation/',
  '/docs/timers/',
  '/docs/webhooks/',
  '/docs/webui/',
  '/docs/access-control/',
  '/docs/typescript-migration/',
  '/docs/data-upgrades-backups/',
  '/docs/faq/',
  '/zh/docs/',
  '/zh/docs/quick-start/',
  '/blog/',
  '/zh/blog/'
];

const blogSource = path.join(websiteRoot, 'src', 'content', 'blog');
const blogPath = (lang, slug = '') => `${lang === 'zh' ? '/zh' : ''}/blog/${slug ? `${slug}/` : ''}`;

// Posts from src/content/blog/<slug>/<lang>.md, newest first, with the title of each language version.
async function blogPosts() {
  const posts = [];
  for (const entry of await readdir(blogSource, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const versions = {};
    let date = null;
    for (const lang of ['en', 'zh']) {
      const file = path.join(blogSource, entry.name, `${lang}.md`);
      if (!await exists(file)) continue;
      const frontmatter = (await readFile(file, 'utf8')).match(/^---\n([\s\S]*?)\n---\n/)?.[1] ?? '';
      const field = (name) => {
        const value = frontmatter.match(new RegExp(`^${name}:\\s*(.+)$`, 'm'))?.[1].trim();
        // A value containing ": ", such as most English titles, has to be quoted in YAML.
        if (value?.length > 1 && value.startsWith('"') && value.endsWith('"')) return JSON.parse(value);
        if (value?.length > 1 && value.startsWith("'") && value.endsWith("'")) return value.slice(1, -1).replaceAll("''", "'");
        return value;
      };
      versions[lang] = { title: field('title') };
      date ??= field('date');
    }
    posts.push({ slug: entry.name, date, versions });
  }
  return posts.sort((a, b) => b.date.localeCompare(a.date) || a.slug.localeCompare(b.slug));
}

const escapeRegExp = (text) => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const decodeEntities = (text) => text.replace(/&#(\d+);/g, (_, code) => String.fromCodePoint(Number(code))).replace(/&#x([0-9a-f]+);/gi, (_, code) => String.fromCodePoint(parseInt(code, 16))).replace(/&quot;/g, '"').replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&amp;/g, '&');

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

test('the homepage documentation action opens an ordinary docs page with navigation', async () => {
  const homepage = await readFile(routeToFile('/'), 'utf8');
  assert.match(homepage, /<nav class="primary-nav"[^>]*>\s*<a href="\/docs\/">Docs<\/a>/);
  const zhHomepage = await readFile(routeToFile('/zh/'), 'utf8');
  assert.match(zhHomepage, /<nav class="primary-nav"[^>]*>\s*<a href="\/zh\/docs\/">文档<\/a>/);

  const docsHome = await readFile(routeToFile('/docs/'), 'utf8');
  assert.doesNotMatch(docsHome, /data-has-hero/);
  assert.match(docsHome, /class="sidebar-pane/);
  assert.match(docsHome, /id="starlight__sidebar"/);
  assert.match(docsHome, /href="\/docs\/" aria-current="page"/);
  assert.match(docsHome, /class="sl-menu-button/);
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

test('in-site links to page sections point at existing headings', async () => {
  const idsByFile = new Map();
  const missing = [];
  for (const filePath of await htmlFiles()) {
    const html = await readFile(filePath, 'utf8');
    for (const match of html.matchAll(/href="([^"]*#[^"]+)"/g)) {
      const [pagePart, hash] = match[1].split('#', 2);
      if (!hash || hash === '_top' || hash === 'main' || hash === 'install' || hash === 'features') continue;
      // The demo WebUI routes its own hash (`#session/<id>`); it is not a heading anchor.
      if (pagePart === '/demo/') continue;
      const target = pagePart ? localTarget(pagePart) : filePath;
      if (!target || !await exists(target)) continue;
      if (!idsByFile.has(target)) {
        const targetHtml = await readFile(target, 'utf8');
        idsByFile.set(target, new Set([...targetHtml.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1])));
      }
      if (!idsByFile.get(target).has(decodeURIComponent(hash))) missing.push(`${path.relative(distRoot, filePath)} -> ${match[1]}`);
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

test('the WebUI demo is built, unindexed, and linked from both homepages', async () => {
  // Crawlers may fetch the demo, so every page it serves must carry noindex.
  const demoPages = (await htmlFiles(path.join(distRoot, 'demo'))).map((filePath) => path.relative(distRoot, filePath)).sort();
  assert.ok(demoPages.includes('demo/index.html'), 'demo has an entry page');
  for (const page of demoPages) {
    assert.match(await readFile(path.join(distRoot, page), 'utf8'), /<meta name="robots" content="noindex, nofollow"/, `${page} is noindex`);
  }
  const html = await readFile(path.join(distRoot, 'demo', 'index.html'), 'utf8');
  const moduleEntries = [...html.matchAll(/<script\b([^>]*)>/g)]
    .map(([, attributes]) => attributes)
    .filter((attributes) => /\btype="module"/.test(attributes))
    .map((attributes) => attributes.match(/\bsrc="(\.\/assets\/[^"]+\.js)"/)?.[1])
    .filter(Boolean);
  assert.ok(moduleEntries.length > 0, 'demo has a relative module entry under ./assets/');
  for (const src of moduleEntries) {
    assert.ok((await stat(path.join(distRoot, 'demo', src))).isFile(), `${src} exists`);
  }

  // Session links must name Sessions that the replayed recording contains.
  const snapshotPath = path.join(repositoryRoot, 'packages', 'webui', 'demo', 'fixtures', 'snapshot.json');
  const recorded = new Set(unpackSnapshot(JSON.parse(await readFile(snapshotPath, 'utf8'))).sessions);
  for (const [route, navLabel] of [['/', 'Demo'], ['/zh/', '演示']]) {
    const homepage = await readFile(routeToFile(route), 'utf8');
    const nav = homepage.match(/<nav class="primary-nav"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? '';
    assert.match(nav, new RegExp(`<a href="/demo/">${navLabel}</a>`), `${route} navigation opens the demo`);
    const hero = homepage.match(/<section class="hero"[\s\S]*?<\/section>/)?.[0] ?? '';
    assert.match(hero, /<a class="demo-link" href="\/demo\/#session\/tidepool%2Ffix-ci">/, `${route} hero opens the screenshot's Session in the demo`);
    const featureLinks = [...homepage.matchAll(/<section class="feature [^"]*"[\s\S]*?<\/section>/g)]
      .flatMap(([section]) => [...section.matchAll(/href="\/demo\/#session\/([^"]+)"/g)].map((link) => decodeURIComponent(link[1])));
    assert.ok(featureLinks.length > 0, `${route} features link into the demo`);
    const sessionLinks = [...homepage.matchAll(/href="\/demo\/#session\/([^"]+)"/g)].map((link) => decodeURIComponent(link[1]));
    assert.deepEqual(sessionLinks.filter((id) => !recorded.has(id)), [], `${route} links only recorded Sessions`);
  }
});

test('the blog lists every post in both languages and declares each article\'s translation', async () => {
  const posts = await blogPosts();
  assert.ok(posts.length > 0, 'the blog has posts');
  const sitemap = await readFile(path.join(distRoot, 'sitemap-0.xml'), 'utf8');
  for (const lang of ['en', 'zh']) {
    const other = lang === 'en' ? 'zh' : 'en';
    const index = await readFile(routeToFile(blogPath(lang)), 'utf8');
    // Every post appears in both indexes, newest first; a post not yet in this language links to the version that exists.
    const listed = [...index.matchAll(/<li class="post-item">([\s\S]*?)<\/li>/g)].map(([, item]) => item);
    assert.equal(listed.length, posts.length, `${blogPath(lang)} lists every post`);
    posts.forEach((post, position) => {
      const shown = post.versions[lang] ? lang : other;
      const item = listed[position];
      assert.match(item, new RegExp(`<a href="${escapeRegExp(blogPath(shown, post.slug))}"`), `${blogPath(lang)} links ${post.slug}`);
      assert.ok(decodeEntities(item).includes(post.versions[shown].title), `${blogPath(lang)} shows the title of ${post.slug}`);
      assert.equal(item.includes('class="post-badge"'), shown !== lang, `${blogPath(lang)} marks ${post.slug} only when it is in the other language`);
    });
    for (const target of [blogPath(lang), `${blogPath(lang)}rss.xml`]) assert.ok(index.includes(`href="${target}"`), `${blogPath(lang)} links ${target}`);
    const feed = await readFile(path.join(distRoot, blogPath(lang).slice(1), 'rss.xml'), 'utf8');
    for (const post of posts) assert.ok(feed.includes(`<link>${siteOrigin}${blogPath(post.versions[lang] ? lang : other, post.slug)}</link>`), `${lang} feed lists ${post.slug}`);

    for (const post of posts.filter((candidate) => candidate.versions[lang])) {
      const route = blogPath(lang, post.slug);
      const html = await readFile(routeToFile(route), 'utf8');
      const canonical = `${siteOrigin}${route}`;
      assert.match(html, new RegExp(`<link rel="canonical" href="${escapeRegExp(canonical)}"`), `${route} canonical`);
      assert.doesNotMatch(html, /<meta[^>]+name="robots"[^>]+noindex/i, `${route} is indexable`);
      assert.ok(sitemap.includes(`<loc>${canonical}</loc>`), `${route} is in the sitemap`);
      assert.match(html, new RegExp(`<meta property="og:url" content="${escapeRegExp(canonical)}"`), `${route} og:url`);
      assert.match(html, /<meta property="og:type" content="article"/, `${route} og:type`);
      assert.match(html, /<meta property="og:image" content="https:\/\/foxwarm\.net\/[^"]+"/, `${route} og:image`);
      assert.ok(decodeEntities(html.match(/<title>([^<]*)<\/title>/)?.[1] ?? '').startsWith(post.versions[lang].title), `${route} title`);
      assert.match(html, /<time datetime="\d{4}-\d{2}-\d{2}">/, `${route} shows its date`);
      // Translations link to each other and declare hreflang alternates; a single-language post declares none.
      const alternates = [...html.matchAll(/<link rel="alternate" hreflang="([^"]+)" href="([^"]+)"/g)].map(([, hreflang, href]) => `${hreflang} ${href}`);
      if (post.versions[other]) {
        const translation = `${siteOrigin}${blogPath(other, post.slug)}`;
        assert.ok(alternates.includes(`${lang === 'en' ? 'en' : 'zh-CN'} ${canonical}`) && alternates.includes(`${other === 'en' ? 'en' : 'zh-CN'} ${translation}`), `${route} hreflang alternates`);
      } else {
        assert.deepEqual(alternates, [], `${route} has no translation to declare`);
      }
      // Readers can get back to the homepage, the docs, the demo and the blog.
      for (const target of [lang === 'zh' ? '/zh/' : '/', `${lang === 'zh' ? '/zh' : ''}/docs/`, '/demo/', blogPath(lang)]) {
        assert.ok(html.includes(`href="${target}"`), `${route} links ${target}`);
      }
    }
  }

  // Homepages link the blog from the navigation and the footer.
  for (const [route, lang, label] of [['/', 'en', 'Blog'], ['/zh/', 'zh', '博客']]) {
    const homepage = await readFile(routeToFile(route), 'utf8');
    const nav = homepage.match(/<nav class="primary-nav"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? '';
    assert.match(nav, new RegExp(`<a href="${escapeRegExp(blogPath(lang))}">${label}</a>`), `${route} navigation opens the blog`);
    const footer = homepage.match(/<footer class="site-footer">([\s\S]*?)<\/footer>/)?.[1] ?? '';
    assert.match(footer, new RegExp(`<a href="${escapeRegExp(blogPath(lang))}">${label}</a>`), `${route} footer links the blog`);
  }
});

// The header language menu lists English and 中文; the current language links to this page and the
// other to the translation, or to the nearest equivalent page when there is none.
test('the header language menu offers every page in both languages', async () => {
  const otherLang = (lang) => (lang === 'en' ? 'zh' : 'en');
  const htmlLang = { en: 'en', zh: 'zh-CN' };
  const pages = [];
  for (const lang of ['en', 'zh']) {
    pages.push({ route: lang === 'zh' ? '/zh/' : '/', lang, targets: { en: '/', zh: '/zh/' } });
    pages.push({ route: blogPath(lang), lang, targets: { en: blogPath('en'), zh: blogPath('zh') } });
    for (const post of (await blogPosts()).filter((candidate) => candidate.versions[lang])) {
      const other = otherLang(lang);
      pages.push({ route: blogPath(lang, post.slug), lang, targets: { [lang]: blogPath(lang, post.slug), [other]: post.versions[other] ? blogPath(other, post.slug) : blogPath(other) } });
    }
  }
  // An attribute's value in a tag's attribute text: '' for a bare boolean attribute, undefined when absent.
  const attribute = (attributes, name) => {
    const match = attributes.match(new RegExp(`(?:^|\\s)${name}(?:="([^"]*)")?(?=[\\s/]|$)`));
    return match ? (match[1] ?? '') : undefined;
  };
  for (const { route, lang, targets } of pages) {
    const html = await readFile(routeToFile(route), 'utf8');
    const menu = html.match(/<div class="language-menu"[^>]*>([\s\S]*?)<\/div>/)?.[1];
    assert.ok(menu, `${route} has a language menu`);
    const button = menu.match(/<button ([^>]*)>/)?.[1] ?? '';
    assert.equal(attribute(button, 'aria-expanded'), 'false', `${route} language button starts collapsed`);
    const list = menu.match(/<ul ([^>]*)>([\s\S]*?)<\/ul>/);
    assert.ok(list && attribute(list[1], 'id') === attribute(button, 'aria-controls'), `${route} language button controls the list`);
    assert.equal(attribute(list[1], 'hidden'), '', `${route} language list starts hidden`);
    const items = [...list[2].matchAll(/<a ([^>]*)>([\s\S]*?)<\/a>/g)].map(([, attributes, label]) => ({ attributes, label: decodeEntities(label.replace(/<[^>]*>/g, '')).trim() }));
    assert.deepEqual(items.map((item) => item.label), ['English', '中文'], `${route} lists both languages in their own names`);
    ['en', 'zh'].forEach((code, index) => {
      const { attributes } = items[index];
      assert.equal(attribute(attributes, 'href'), targets[code], `${route} ${code} target`);
      assert.equal(attribute(attributes, 'hreflang'), htmlLang[code], `${route} ${code} hreflang`);
      assert.equal(attribute(attributes, 'lang'), htmlLang[code], `${route} ${code} lang`);
      assert.equal(attribute(attributes, 'aria-current'), code === lang ? 'true' : undefined, `${route} marks only ${lang} as current`);
    });
    // Without scripting, the menu is replaced by a link to the other language.
    const fallback = menu.match(/<a ([^>]*\blanguage-fallback\b[^>]*)>/)?.[1] ?? '';
    assert.equal(attribute(fallback, 'href'), targets[otherLang(lang)], `${route} fallback link target`);
    assert.equal(attribute(fallback, 'hreflang'), htmlLang[otherLang(lang)], `${route} fallback hreflang`);
  }
});

test('demo Session links outside the demo name recorded Sessions', async () => {
  const snapshotPath = path.join(repositoryRoot, 'packages', 'webui', 'demo', 'fixtures', 'snapshot.json');
  const recorded = new Set(unpackSnapshot(JSON.parse(await readFile(snapshotPath, 'utf8'))).sessions);
  const unknown = [];
  for (const filePath of await htmlFiles()) {
    if (path.relative(distRoot, filePath).startsWith(`demo${path.sep}`)) continue;
    const html = await readFile(filePath, 'utf8');
    for (const [, id] of html.matchAll(/href="\/demo\/#session\/([^"]+)"/g)) {
      if (!recorded.has(decodeURIComponent(id))) unknown.push(`${path.relative(distRoot, filePath)} -> ${decodeURIComponent(id)}`);
    }
  }
  assert.deepEqual(unknown, []);
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
  // The demo is excluded by its noindex meta, which crawlers can only read if they may fetch it.
  assert.doesNotMatch(robots, /^Disallow:/m);
  assert.match(robots, new RegExp(`Sitemap: ${siteOrigin.replaceAll('.', '\\.')}\/sitemap-index\\.xml`));

  const sitemapIndex = await readFile(path.join(distRoot, 'sitemap-index.xml'), 'utf8');
  assert.match(sitemapIndex, /sitemap-0\.xml/);
  const sitemap = await readFile(path.join(distRoot, 'sitemap-0.xml'), 'utf8');
  for (const route of requiredRoutes) assert.match(sitemap, new RegExp(`${siteOrigin.replaceAll('.', '\\.')}${route}`));
  assert.doesNotMatch(sitemap, /\/404\//);
  assert.doesNotMatch(sitemap, /\/demo\//);

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


// Homepage downloads use stable latest-release URLs (the APK through /android). The page marks no
// option as this device's until the browser reports its platform.
test('the homepage downloads each app from the latest release and marks none before the platform is known', async () => {
  const latest = 'https://github.com/550W-HOST/foxwarm/releases/latest/download';
  const downloads = [
    { platform: 'windows', file: 'foxwarm-desktop-win-x64.zip', href: `${latest}/foxwarm-desktop-win-x64.zip` },
    { platform: 'macos', file: 'foxwarm-desktop-osx-arm64.zip', href: `${latest}/foxwarm-desktop-osx-arm64.zip` },
    { platform: 'android', file: 'foxwarm-android-node.apk', href: '/android' }
  ];
  // The release workflow publishes every file in dist/, so each download must be built there.
  const releaseWorkflow = await readFile(path.join(repositoryRoot, '.github', 'workflows', 'release.yml'), 'utf8');
  for (const { file } of downloads) assert.ok(releaseWorkflow.includes(`dist/${file}`), `the release workflow builds ${file}`);
  const redirect = await readFile(routeToFile('/android/'), 'utf8');
  assert.ok(redirect.includes(`${latest}/foxwarm-android-node.apk`), '/android serves the latest APK');

  for (const [route, label] of [['/', 'Download'], ['/zh/', '下载']]) {
    const homepage = await readFile(routeToFile(route), 'utf8');
    const section = homepage.match(/<section class="downloads" id="download"[\s\S]*?<\/section>/)?.[0];
    assert.ok(section, `${route} has a download section`);
    const options = [...section.matchAll(/<div class="download-option" data-platform="([^"]+)">([\s\S]*?)<\/div>/g)]
      .map(([, platform, body]) => ({
        platform,
        href: body.match(/<a class="download-button" href="([^"]+)"/)?.[1],
        file: body.match(/<code>([^<]+)<\/code>/)?.[1],
        markedHidden: /<span class="download-current" hidden>/.test(body)
      }));
    assert.deepEqual(options.map(({ markedHidden, ...option }) => option), downloads, `${route} download targets`);
    assert.ok(options.every((option) => option.markedHidden), `${route} marks no download as this device's in the HTML`);
    assert.doesNotMatch(section, /class="download-option current"/, `${route} emphasizes no download in the HTML`);
    assert.match(section, /href="#install"/, `${route} points server installs at the install commands`);

    const nav = homepage.match(/<nav class="primary-nav"[^>]*>([\s\S]*?)<\/nav>/)?.[1] ?? '';
    assert.match(nav, new RegExp(`<a class="nav-download" href="${escapeRegExp(route)}#download">${label}</a>`), `${route} navigation opens the downloads`);
    const footer = homepage.match(/<footer class="site-footer">([\s\S]*?)<\/footer>/)?.[1] ?? '';
    assert.match(footer, new RegExp(`<a href="${escapeRegExp(route)}#download">${label}</a>`), `${route} footer opens the downloads`);
    const install = homepage.match(/<div class="install" id="install"[\s\S]*?<p class="install-more"><a href="#download">/);
    assert.ok(install, `${route} install commands point at the other downloads`);
  }
});

test('the visitor platform is read from what the browser reports', () => {
  const cases = [
    [{ userAgentData: { platform: 'Windows' }, platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/142.0' }, 'windows'],
    [{ platform: 'Win32', userAgent: 'Mozilla/5.0 (Windows NT 10.0; Win64; x64; rv:145.0) Gecko/20100101 Firefox/145.0' }, 'windows'],
    [{ userAgentData: { platform: 'macOS' }, platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Chrome/142.0', maxTouchPoints: 0 }, 'macos'],
    [{ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/26.0 Safari/605.1.15', maxTouchPoints: 0 }, 'macos'],
    [{ platform: 'MacIntel', userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) Version/26.0 Safari/605.1.15', maxTouchPoints: 5 }, 'ios'],
    [{ platform: 'iPhone', userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 26_0 like Mac OS X) Mobile/15E148', maxTouchPoints: 5 }, 'ios'],
    [{ userAgentData: { platform: 'Android' }, platform: 'Linux armv81', userAgent: 'Mozilla/5.0 (Linux; Android 10; K) Chrome/142.0 Mobile' }, 'android'],
    [{ platform: 'Linux aarch64', userAgent: 'Mozilla/5.0 (Android 15; Mobile; rv:145.0) Gecko/145.0 Firefox/145.0' }, 'android'],
    [{ userAgentData: { platform: 'Linux' }, platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; Linux x86_64) Chrome/142.0' }, 'linux'],
    [{ userAgentData: { platform: 'Chrome OS' }, platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) Chrome/142.0' }, ''],
    [{ platform: 'Linux x86_64', userAgent: 'Mozilla/5.0 (X11; CrOS x86_64 16000.0.0) Chrome/142.0' }, ''],
    [{}, '']
  ];
  for (const [browser, expected] of cases) assert.equal(detectPlatform(browser), expected, JSON.stringify(browser));
});

test('Android download redirects to the release APK and both install locales include its QR and certificate', async () => {
  const redirect = await readFile(routeToFile('/android/'), 'utf8');
  assert.match(redirect, /http-equiv="refresh"[^>]*content="0;url=https:\/\/github\.com\/550W-HOST\/foxwarm\/releases\/latest\/download\/foxwarm-android-node\.apk"/i);
  const qr = await readFile(path.join(distRoot, 'android-download.svg'), 'utf8');
  assert.match(qr, /<svg[^>]*viewBox=/);
  const fingerprint = (await readFile(path.join(repositoryRoot, 'packages/android-node/release-certificate.sha256'), 'utf8')).trim();
  for (const locale of ['', '/zh']) {
    const html = await readFile(routeToFile(`${locale}/docs/installing/`), 'utf8');
    assert.match(html, /href="https:\/\/foxwarm\.net\/android"/);
    assert.match(html, /src="\/android-download\.svg"/);
    assert.ok(html.includes('foxwarm-android-node.apk'));
    assert.ok(html.includes(fingerprint));
  }
});
