import { readFile } from 'node:fs/promises'
import { fileURLToPath } from 'node:url'
import { build } from 'esbuild'
import type { Plugin } from 'vite'

const webui = new URL('../', import.meta.url)

/** Keep the recovery screen independent of every network-loaded app asset. */
export async function renderBootHtml(html: string): Promise<string> {
  if (!html.includes('<!-- foxwarm-boot-head -->')) return html
  const [bundle, loaderCss, recoveryCss, drawingJson] = await Promise.all([
    build({
      entryPoints: [fileURLToPath(new URL('src/boot.ts', webui))],
      bundle: true,
      format: 'iife',
      platform: 'browser',
      target: 'es2020',
      minify: true,
      write: false,
      logLevel: 'silent',
    }),
    readFile(new URL('src/components/FoxLoaders.css', webui), 'utf8'),
    readFile(new URL('src/boot.css', webui), 'utf8'),
    readFile(new URL('src/components/foxDrawing.json', webui), 'utf8'),
  ])
  const { paths: fox, viewBox } = JSON.parse(drawingJson)
  const path = (name: string, delay: number, className = '') => `<path d="${fox[name]}" pathLength="1" class="fw-fox-draw ${className}" style="--fw-fox-delay:${delay}ms"/>`
  const screen = `<div id="foxwarm-boot" class="fw-fox-splash" data-state="shown" data-fox-splash role="status" aria-label="Loading Foxwarm">
    <svg viewBox="${viewBox}" width="200" height="200" class="fw-fox fw-fox-cub fw-fox-live" aria-hidden="true">
      <g class="fw-fox-body">${path('back', 130)}${path('haunch', 450, 'fw-fox-mid')}${path('tailTop', 310)}${path('tailTip', 525, 'fw-fox-thin')}</g>
      <g class="fw-fox-head">${path('head', 0)}${path('chest', 410, 'fw-fox-mid')}${path('eyeLeft', 575, 'fw-fox-mid')}${path('eyeRight', 600, 'fw-fox-mid')}<ellipse cx="51" cy="64.5" rx="4.6" ry="3.4" transform="rotate(-20 51 64.5)" class="fw-fox-nose"/></g>
    </svg>
    <div id="foxwarm-boot-recovery" hidden>
      <h1 id="foxwarm-boot-title">Foxwarm couldn’t load</h1>
      <p id="foxwarm-boot-description">Check your connection, then reload to try again.</p>
      <pre id="foxwarm-boot-error"></pre>
      <button id="foxwarm-boot-reload" type="button">Reload</button>
      <button id="foxwarm-boot-dismiss" type="button" hidden>Dismiss</button>
    </div>
  </div>`
  // Escape the HTML parser's script terminator, including in bundled theme data.
  const script = bundle.outputFiles[0].text.replace(/<\/script/gi, '<\\/script')
  // Entry CSS must not prevent the inline screen's first paint. The inline
  // load handler enables each sheet and includes it in the existing ready gate.
  const nonBlockingHtml = html.replace(/<link\b[^>]*\brel="stylesheet"[^>]*>/g,
    tag => tag.replace(/>$/, ' media="not all" data-foxwarm-boot-style>'))
  return nonBlockingHtml.replace('<!-- foxwarm-boot-head -->', `<style>${loaderCss}\n${recoveryCss}</style><script>${script}</script>`)
    .replace('<!-- foxwarm-boot-screen -->', screen)
}

export function bootHtmlPlugin(): Plugin {
  return {
    name: 'foxwarm-boot-html',
    transformIndexHtml: { order: 'post', handler: renderBootHtml },
  }
}
