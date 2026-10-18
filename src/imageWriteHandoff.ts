import fs from 'fs-extra';
import path from 'node:path';
import { getAgentDir } from './config';

/** Private Main-host transport path, not a model-selectable file source. */
export function getImageWriteHandoffRoot(agentName: string, sourceSessionId: string): string {
  const encoded = Buffer.from(sourceSessionId, 'utf8').toString('base64url');
  // Keep each component short even for long or Unicode canonical Session IDs.
  const owner = encoded.match(/.{1,100}/g) || [];
  return path.join(getAgentDir(agentName), '.temp', 'image-write-handoff', ...owner, '.owner');
}

export async function requireImageWriteHandoffRoot(agentName: string, sourceSessionId: string): Promise<string> {
  const agentDir = getAgentDir(agentName);
  const root = getImageWriteHandoffRoot(agentName, sourceSessionId);
  const stat = await fs.lstat(root);
  if (stat.isSymbolicLink() || !stat.isDirectory()) throw new Error('Image handoff root must be a real directory.');
  const [realAgentDir, realRoot] = await Promise.all([fs.realpath(agentDir), fs.realpath(root)]);
  const expected = path.resolve(realAgentDir, path.relative(agentDir, root));
  if (realRoot !== expected) throw new Error('Image handoff root escapes its Session-owned scope.');
  return realRoot;
}

/** Read only this source's operation-private regular image file, never an arbitrary Main path. */
export async function readOwnedImageWriteHandoff(agentName: string, sourceSessionId: string, artifactPath: string): Promise<Buffer> {
  const root = await requireImageWriteHandoffRoot(agentName, sourceSessionId);
  if (!path.isAbsolute(artifactPath)) throw new Error('Image handoff artifact must be an absolute path.');
  const resolved = path.resolve(artifactPath);
  const parts = path.relative(root, resolved).split(path.sep);
  if (parts.length !== 2 || !/^operation-[A-Za-z0-9]+$/.test(parts[0])
    || !/^image(?:\.[^/\\]{0,31})?$/.test(parts[1])) {
    throw new Error('Image handoff artifact is outside this Session-owned operation.');
  }
  const operation = await fs.lstat(path.dirname(resolved));
  const file = await fs.lstat(resolved);
  if (operation.isSymbolicLink() || !operation.isDirectory() || file.isSymbolicLink() || !file.isFile()) {
    throw new Error('Image handoff operation and artifact must be real directories/files.');
  }
  return fs.readFile(resolved);
}
