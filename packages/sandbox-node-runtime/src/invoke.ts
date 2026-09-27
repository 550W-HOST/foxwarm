#!/usr/bin/env node
import fs from 'fs-extra';
import path from 'node:path';
import { createWorktreeFileOperations } from './worktreeFileOperations';

type Request = {
  operation: 'parent' | 'stat' | 'read' | 'readdir' | 'write' | 'mkdir' | 'remove';
  path: string;
  offset?: number;
  count?: number;
  contentBase64?: string;
  flag?: 'w' | 'wx';
  cwd?: string;
};

function rejectParentSegments(value: unknown, label: string): void {
  if (typeof value !== 'string') return;
  if (value.split(/[\\/]+/).includes('..')) throw new Error(`${label} must not contain parent-directory segments.`);
}

async function main(): Promise<void> {
  const rootRaw = process.env.FOXWARM_WORKTREE_ROOT;
  if (!rootRaw) throw new Error('Sandbox runtime is missing FOXWARM_WORKTREE_ROOT.');
  const root = await fs.realpath(path.resolve(rootRaw));
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) chunks.push(Buffer.from(chunk));
  const request = JSON.parse(Buffer.concat(chunks).toString('utf8')) as Request;
  if (!request || typeof request.path !== 'string' || !['parent', 'stat', 'read', 'readdir', 'write', 'mkdir', 'remove'].includes(request.operation)) {
    throw new Error('Sandbox runtime request is invalid.');
  }
  rejectParentSegments(request.path, 'Sandbox file path');
  rejectParentSegments(request.cwd, 'Sandbox session cwd');
  const cwd = typeof request.cwd === 'string' && request.cwd.trim() ? path.resolve(request.cwd) : root;
  const relative = path.relative(root, cwd);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Sandbox session cwd is outside the configured worktree.');
  const target = path.isAbsolute(request.path) ? request.path : path.resolve(cwd, request.path);
  const operations = createWorktreeFileOperations(root);
  let result: unknown;
  if (request.operation === 'parent') result = { path: path.dirname(target) };
  else if (request.operation === 'stat') result = await operations.stat(target);
  else if (request.operation === 'read') {
    if (!Number.isSafeInteger(request.offset) || request.offset! < 0 || !Number.isSafeInteger(request.count) || request.count! < 0) throw new Error('Sandbox read offset/count are invalid.');
    result = { dataBase64: (await operations.read(target, request.offset!, request.count!)).toString('base64') };
  } else if (request.operation === 'readdir') result = await operations.readdir(target);
  else if (request.operation === 'write') {
    if (typeof request.contentBase64 !== 'string' || !['w', 'wx'].includes(request.flag || '')) throw new Error('Sandbox write request is invalid.');
    await operations.write(target, Buffer.from(request.contentBase64, 'base64'), request.flag!);
    result = null;
  } else if (request.operation === 'mkdir') {
    await operations.mkdir(target);
    result = null;
  } else {
    await operations.remove(target);
    result = null;
  }
  process.stdout.write(JSON.stringify({ ok: true, result }));
}

main().catch(error => {
  const code = error && typeof error === 'object' && typeof (error as any).code === 'string' ? (error as any).code : 'SANDBOX_FILESYSTEM_ERROR';
  process.stdout.write(JSON.stringify({ ok: false, error: { code, message: error instanceof Error ? error.message : String(error) } }));
});