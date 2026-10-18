import { fork } from 'node:child_process';
import path from 'node:path';
import type { ArtifactDocument } from '../../packages/shared/dist/artifacts/types';
import { describeImage } from './image';
import { validateImageDocument } from '../../packages/shared/dist/artifacts/image';
export interface PreparedArtifact { compiled?: string; resources?: Record<string, { mimeType: string; bytes: Buffer }> }
export interface ArtifactPreparer { prepare(doc: ArtifactDocument, resources?: Record<string, Buffer>): Promise<PreparedArtifact> }
let activeCompilers = 0;
const react: ArtifactPreparer = { prepare: doc => new Promise((resolve, reject) => {
  if (activeCompilers >= 2) { reject(new Error('React compiler is busy. Retry publication shortly.')); return; }
  activeCompilers++;
  const child = fork(path.join(__dirname, 'reactBuildWorker.js'), [], { execArgv: ['--max-old-space-size=128'], stdio: ['ignore', 'ignore', 'ignore', 'ipc'] });
  let settled = false;
  const finish = (error?: Error, compiled?: string) => {
    if (settled) return; settled = true; activeCompilers--; clearTimeout(timer); child.kill();
    if (error) reject(error); else resolve({ compiled });
  };
  const timer = setTimeout(() => finish(new Error('React compilation exceeded 15 seconds')), 15000);
  child.once('error', err => finish(err));
  child.once('exit', () => { if (!settled) finish(new Error('React compiler exited before completion')); });
  child.once('message', (value: any) => {
    if (typeof value?.compiled === 'string' && Buffer.byteLength(value.compiled) <= 3 * 1024 * 1024) finish(undefined, value.compiled);
    else finish(new Error(typeof value?.error === 'string' ? value.error : 'Invalid compiler response'));
  });
  child.send(doc);
}) };
const image: ArtifactPreparer = { prepare: async (doc, resources) => {
  const imageDoc = validateImageDocument(doc), bytes = resources?.image;
  if (!bytes) throw new Error('Image publication requires a raster file, using type: image');
  const actual = await describeImage(bytes, imageDoc.title, imageDoc.alt);
  if (actual.mimeType !== imageDoc.mimeType || actual.width !== imageDoc.width || actual.height !== imageDoc.height) throw new Error('Image metadata does not match its bytes');
  return { resources: { image: { mimeType: imageDoc.mimeType, bytes } } };
} };
const preparers: Record<string, ArtifactPreparer> = { image, chart: { prepare: async () => ({}) }, react };
export function prepareArtifact(doc: ArtifactDocument, resources?: Record<string, Buffer>) {
  const module = preparers[doc.type]; if (!module) throw new Error('Unsupported artifact type');
  return module.prepare(doc, resources);
}
