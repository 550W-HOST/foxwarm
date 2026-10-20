/** Compiles authored files as data; never evaluates the output. */
import path from 'node:path';
import { build } from 'esbuild';
import { validateReactDocument } from './react';
export async function compileReact(input: unknown, runtimeRoot: string): Promise<string> {
  const doc = validateReactDocument(input);
    const entry = `import React from 'react'; import {createRoot} from 'react-dom/client'; import App from './${doc.entry}'; createRoot(document.getElementById('root')).render(React.createElement(App));`;
    const result = await build({
      stdin: { contents: entry, resolveDir: '/', sourcefile: '__entry.tsx', loader: 'tsx' },
      bundle: true, write: false, platform: 'browser', format: 'iife', target: 'es2020', jsx: 'automatic',
      define: { 'process.env.NODE_ENV': '"production"' }, minify: true, logLevel: 'silent',
      plugins: [{ name: 'artifact-files', setup(b) {
        b.onResolve({ filter: /.*/ }, args => {
          // Only trusted runtime dependencies can use the ordinary package resolver.
          if (args.namespace === 'file' && args.importer.startsWith(runtimeRoot + path.sep)) return;
          if (['react', 'react/jsx-runtime', 'react/jsx-dev-runtime', 'react-dom/client'].includes(args.path)) {
            return { path: require.resolve(args.path, { paths: [runtimeRoot] }) };
          }
          if (!args.path.startsWith('.')) throw new Error(`Import not allowed: ${args.path}. Available packages: react.`);
          const base = path.posix.normalize(path.posix.join(path.posix.dirname(args.namespace === 'artifact' ? args.importer : '__entry.tsx'), args.path));
          const name = [base, ...['.tsx', '.ts', '.jsx', '.js', '/index.tsx', '/index.ts'].map(ext => base + ext)].find(p => Object.prototype.hasOwnProperty.call(doc.files, p));
          if (!name) throw new Error(`Source file not found: ${args.path}`);
          return { path: name, namespace: 'artifact' };
        });
        b.onLoad({ filter: /.*/, namespace: 'artifact' }, args => {
          const contents = doc.files[args.path], ext = path.posix.extname(args.path).slice(1);
          if (ext === 'css') return { contents: `const s=document.createElement('style');s.textContent=${JSON.stringify(contents)};document.head.append(s);`, loader: 'js' };
          return { contents, loader: ext as 'tsx' | 'ts' | 'jsx' | 'js' | 'json' };
        });
      } }],
    });
    const compiled = result.outputFiles[0].text;
    if (Buffer.byteLength(compiled) > 3 * 1024 * 1024) throw new Error('Compiled output exceeds 3 MiB');
  return compiled;
}
