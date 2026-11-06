// Separate build of the static WebUI demo. The production configuration and its
// output stay untouched; this build adds the demo mock entry ahead of the
// unchanged WebUI entry and writes to its own directory.
import { createRequire } from 'node:module'
import { existsSync } from 'node:fs'
import { dirname, resolve } from 'node:path'
import { fileURLToPath } from 'node:url'
import { defineConfig, mergeConfig, type Plugin } from 'vite'
import base from './vite.config'

const webui = dirname(fileURLToPath(import.meta.url))
const repo = resolve(webui, '../..')
const outDir = process.env.FOXWARM_DEMO_OUT_DIR ? resolve(process.env.FOXWARM_DEMO_OUT_DIR) : resolve(webui, 'dist-demo')

function demoHtmlPlugin(): Plugin {
  return {
    name: 'foxwarm-demo-html',
    transformIndexHtml: {
      order: 'pre',
      handler: html => html
        .replace('<title>Foxwarm</title>', '<meta name="robots" content="noindex, nofollow" />\n    <title>Foxwarm demo</title>')
        .replace('<script type="module" src="/src/main.tsx"></script>', '<script type="module" src="/demo/src/entry.ts"></script>\n    <script type="module" src="/src/main.tsx"></script>'),
    },
  }
}

// Shared sources resolve their packages from the repository root install. A
// website build installs only the WebUI and website packages, so fall back to them.
function sharedPackageFallback(): Plugin {
  const roots = [resolve(repo, 'node_modules'), resolve(webui, 'node_modules'), resolve(repo, 'website/node_modules')]
  return {
    name: 'foxwarm-demo-shared-packages',
    enforce: 'pre',
    async resolveId(source, importer, options) {
      if (!importer?.includes('/packages/shared/') || source.startsWith('.') || source.startsWith('/') || source.startsWith('\0')) return null
      const resolved = await this.resolve(source, importer, { ...options, skipSelf: true })
      if (resolved) return resolved
      for (const root of roots) {
        if (!existsSync(root)) continue
        try {
          return createRequire(resolve(root, 'package.json')).resolve(source)
        } catch {}
      }
      return null
    },
  }
}

const config = mergeConfig(base, defineConfig({
  plugins: [demoHtmlPlugin(), sharedPackageFallback()],
  // The demo is one static page; the production bundle split is unchanged.
  build: { outDir, emptyOutDir: true, chunkSizeWarningLimit: 8192 },
}))
// The demo entry awaits its data before the WebUI starts, which needs top-level await.
config.build!.target = ['es2022', 'edge89', 'firefox89', 'chrome89', 'safari15']

export default config
