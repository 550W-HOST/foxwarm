#!/usr/bin/env node
import fs from 'fs-extra';
import path from 'node:path';
import { apply_patch, edit, read, write } from '../../shared/dist/nodeTools';
import { parseApplyPatchInput } from '../../shared/dist/applyPatch';
import { assertWorktreePath, createWorktreeFileOperations } from './worktreeFileOperations';

type Request = { toolName: string; args: Record<string, unknown>; cwd?: string };

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
  if (!request || !request.args || typeof request.args !== 'object' || Array.isArray(request.args)) throw new Error('Sandbox runtime request is invalid.');
  if (!['read', 'write', 'edit', 'apply_patch'].includes(request.toolName)) throw new Error(`Unsupported sandbox capability: ${request.toolName}`);
  if (request.toolName === 'write' && Object.prototype.hasOwnProperty.call(request.args, 'contentRef')) {
    throw new Error('Sandbox Node write does not support contentRef; provide literal content instead.');
  }
  if (request.toolName === 'apply_patch') {
    if (typeof request.args.input !== 'string') throw new Error('apply_patch requires input string.');
    for (const operation of parseApplyPatchInput(request.args.input)) rejectParentSegments(operation.filePath, 'Sandbox patch path');
  } else {
    rejectParentSegments(request.args.filePath, 'Sandbox file path');
  }
  rejectParentSegments(request.cwd, 'Sandbox session cwd');
  const cwd = typeof request.cwd === 'string' && request.cwd.trim() ? path.resolve(request.cwd) : root;
  const relative = path.relative(root, cwd);
  if (relative === '..' || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative)) throw new Error('Sandbox session cwd is outside the configured worktree.');
  await assertWorktreePath(root, cwd, true);
  const ctx = { session: { agent: 'main', cwd }, fileOperations: createWorktreeFileOperations(root) };
  const tools: Record<string, Function> = { read, write, edit, apply_patch };
  const result = await tools[request.toolName](request.args, ctx);
  process.stdout.write(JSON.stringify({ ok: true, result }));
}

main().catch(error => {
  process.stdout.write(JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }));
});