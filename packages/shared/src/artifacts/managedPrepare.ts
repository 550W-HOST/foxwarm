/** One data request per bounded managed child. No Session, paths or tool authority. */
import path from 'node:path';
import { validateArtifactDocument } from './registry';
import { compileReact } from './reactCompiler';
import { describeImage } from './rasterMetadata';
async function main() {
  const chunks: Buffer[] = []; let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > 18 * 1024 * 1024) throw new Error('Artifact preparation input is too large');
    chunks.push(Buffer.from(chunk));
  }
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8'));
  if (request.action === 'validate') return { document: validateArtifactDocument(request.document) };
  if (request.action === 'react') return { compiled: await compileReact(request.document, path.resolve(__dirname, '../../../webui/node_modules')) };
  if (request.action === 'image') return { document: await describeImage(Buffer.from(request.bytes, 'base64'), request.title, request.alt) };
  throw new Error('Unsupported artifact preparation request');
}
main().then(value => { process.stdout.write(JSON.stringify(value)); }, (error: any) => {
  process.stdout.write(JSON.stringify({ error: String(error.errors?.[0]?.text || error.message || error).slice(0, 1500) }));
  process.exitCode = 1;
});
