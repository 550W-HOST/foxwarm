import fs from 'fs-extra';
import path from 'node:path';
import { createNativeFileOperations, type FileOperations } from '../../shared/dist/fileOperations';

function inside(root: string, candidate: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function nearestExisting(candidate: string): Promise<string> {
  let current = candidate;
  while (true) {
    if (await fs.pathExists(current)) return current;
    const parent = path.dirname(current);
    if (parent === current) return current;
    current = parent;
  }
}

async function rejectSymlinkComponents(root: string, candidate: string): Promise<void> {
  const relative = path.relative(root, candidate);
  let current = root;
  for (const segment of relative.split(path.sep).filter(Boolean)) {
    current = path.join(current, segment);
    try {
      const stats = await fs.lstat(current);
      if (stats.isSymbolicLink()) throw new Error('Sandbox file path contains a symlink component.');
    } catch (error: any) {
      if (error?.code === 'ENOENT') return;
      throw error;
    }
  }
}

export async function assertWorktreePath(rootInput: string, candidateInput: string, existing: boolean): Promise<string> {
  const root = await fs.realpath(path.resolve(rootInput));
  const candidate = path.resolve(candidateInput);
  if (!inside(root, candidate)) throw new Error('Sandbox file path is outside the configured worktree.');
  await rejectSymlinkComponents(root, candidate);
  const anchor = existing ? candidate : await nearestExisting(candidate);
  let real: string;
  try { real = await fs.realpath(anchor); }
  catch { throw new Error('Sandbox file path could not be resolved safely.'); }
  if (!inside(root, real)) throw new Error('Sandbox file path escapes the configured worktree through a symlink.');
  return candidate;
}

export function createWorktreeFileOperations(root: string): FileOperations {
  const native = createNativeFileOperations();
  return {
    async stat(filePath) { return native.stat(await assertWorktreePath(root, filePath, true)); },
    async read(filePath, offset, count) { return native.read(await assertWorktreePath(root, filePath, true), offset, count); },
    async readdir(filePath) { return native.readdir(await assertWorktreePath(root, filePath, true)); },
    async write(filePath, content, flag) {
      const exists = await fs.pathExists(filePath);
      return native.write(await assertWorktreePath(root, filePath, exists), content, flag);
    },
    async mkdir(filePath) { return native.mkdir(await assertWorktreePath(root, filePath, false)); },
    async remove(filePath) { return native.remove(await assertWorktreePath(root, filePath, true)); },
  };
}