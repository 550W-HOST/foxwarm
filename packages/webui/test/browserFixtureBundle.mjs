import { build as esbuild } from 'esbuild'

// Standalone rendering fixtures have no Vite worker/asset pipeline. Editor behavior
// is covered separately by the Vite-backed JSON inspector and Setup fixtures.
export function build(options) {
  return esbuild({
    ...options,
    // Fixtures load the built stylesheet separately, including component CSS.
    loader: { ...options.loader, '.css': 'empty' },
    plugins: [...(options.plugins || []), {
      name: 'standalone-editor-fallback',
      setup(builder) {
        builder.onResolve({ filter: /yamlMonacoSupport$/ }, () => ({ path: 'editor-loader', namespace: 'fixture' }))
        builder.onLoad({ filter: /.*/, namespace: 'fixture' }, () => ({
          contents: 'export async function loadYamlMonacoSupport() { throw new Error("This fixture uses the plain-text editor") }',
        }))
      },
    }],
  })
}
