import { createServer } from 'vite'
import { readdir, readFile } from 'node:fs/promises'
import { realpathSync } from 'node:fs'
import { fileURLToPath } from 'node:url'

export async function createEditorFixtureServer(source, name) {
  const root = fileURLToPath(new URL('..', import.meta.url))
  const assets = new URL('../dist/assets/', import.meta.url)
  const cssName = (await readdir(assets)).find(asset => /^index-.*\.css$/.test(asset))
  const css = await readFile(new URL(cssName, assets), 'utf8')
  const server = await createServer({
    configLoader: 'runner',
    root,
    css: { postcss: { plugins: [] } },
    cacheDir: fileURLToPath(new URL(`../dist/.vite-${name}`, import.meta.url)),
    server: {
      port: 0,
      host: '127.0.0.1',
      fs: { allow: [fileURLToPath(new URL('../../..', import.meta.url)), realpathSync(root + '/node_modules')] },
    },
    plugins: [{
      name: 'editor-browser-fixture',
      resolveId(id) { if (id === '/editor-fixture.tsx') return id },
      load(id) { if (id === '/editor-fixture.tsx') return source },
      configureServer(vite) {
        vite.middlewares.use(async (request, response, next) => {
          if (request.url !== '/') return next()
          const html = await vite.transformIndexHtml('/', `<!doctype html><html><head><style>${css}</style><style>html,body,#root{width:100%;height:100%;margin:0}.foxwarm-chat-root{height:100%}</style></head><body><div id="root"></div><script type="module" src="/editor-fixture.tsx"></script></body></html>`)
          response.setHeader('Content-Type', 'text/html')
          response.end(html)
        })
      },
    }],
  })
  await server.listen()
  return server
}
