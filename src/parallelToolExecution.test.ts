import assert from 'node:assert/strict';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import fs from 'fs-extra';
import { executeTools } from './llm';
import { nodesManager } from './nodes/manager';
import * as sessionManager from './sessionManager';
import type { FunctionCall, Session } from './types';

function makeSessionId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

async function waitForFiles(paths: string[], timeoutMs = 5000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if ((await Promise.all(paths.map(filePath => fs.pathExists(filePath)))).every(Boolean)) return;
    await new Promise(resolve => setTimeout(resolve, 20));
  }
  assert.fail(`Timed out waiting for files: ${paths.join(', ')}`);
}

function functionResponses(message: any): any[] {
  return message.parts.filter((part: any) => part.functionResponse).map((part: any) => part.functionResponse);
}

async function createSession(sessionId: string, cwd?: string): Promise<Session> {
  const session = await sessionManager.getSession(sessionId) as Session;
  session.currentNode = 'master';
  session.cwd = cwd;
  session.verbose = false;
  session.queue = [];
  session.meta = { lastMessageTime: Date.now() };
  await sessionManager.saveSession(sessionId);
  return session;
}

test('adjacent exec calls run concurrently, preserve result order, then release the read barrier with model-order cwd', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-parallel-tools-'));
  const sessionId = makeSessionId('parallel_exec');
  const firstDir = path.join(root, 'first');
  const secondDir = path.join(root, 'second');
  const firstStarted = path.join(root, 'first.started');
  const secondStarted = path.join(root, 'second.started');
  const firstRelease = path.join(root, 'first.release');
  const secondRelease = path.join(root, 'second.release');
  const secondDone = path.join(root, 'second.done');
  await fs.ensureDir(firstDir);
  await fs.ensureDir(secondDir);
  await fs.writeFile(path.join(firstDir, 'marker.txt'), 'from-first\n');
  await fs.writeFile(path.join(secondDir, 'marker.txt'), 'from-second\n');
  const session = await createSession(sessionId, root);
  const starts: string[] = [];

  const calls: FunctionCall[] = [
    {
      id: 'exec-first',
      name: 'exec',
      args: { command: `touch '${firstStarted}'; while [ ! -f '${firstRelease}' ]; do sleep 0.02; done; cd '${firstDir}'; echo first` },
    },
    {
      id: 'exec-second',
      name: 'exec',
      args: { command: `touch '${secondStarted}'; while [ ! -f '${secondRelease}' ]; do sleep 0.02; done; cd '${secondDir}'; touch '${secondDone}'; echo second` },
    },
    { id: 'read-after', name: 'read', args: { filePath: 'marker.txt' } },
  ];

  try {
    const running = executeTools(calls, {
      sessionId,
      session,
      onToolStart: ({ name }: { name: string }) => { starts.push(name); },
    }, session);

    await waitForFiles([firstStarted, secondStarted]);
    assert.deepEqual(starts.slice(0, 2), ['exec', 'exec']);
    assert.equal(starts.includes('read'), false);

    await fs.writeFile(secondRelease, 'go');
    await waitForFiles([secondDone]);
    await fs.writeFile(firstRelease, 'go');

    const result = await running;
    const responses = functionResponses(result);
    assert.deepEqual(responses.map(item => item.tool_use_id), ['exec-first', 'exec-second', 'read-after']);
    assert.match(responses[0].response.output, /first/);
    assert.match(responses[1].response.output, /second/);
    assert.match(responses[2].response.output, /from-second/);
    assert.deepEqual(starts, ['exec', 'exec', 'read']);
    assert.equal((await sessionManager.getSession(sessionId)).cwd, secondDir);
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(root);
  }
});

test('parallel exec returns ordered success and failure responses without discarding siblings', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-parallel-errors-'));
  const sessionId = makeSessionId('parallel_errors');
  const session = await createSession(sessionId, root);
  try {
    const result = await executeTools([
      { id: 'ok', name: 'exec', args: { command: 'printf ok' } },
      { id: 'bad', name: 'exec', args: { command: 'printf never', cwd: path.join(root, 'missing') } },
    ], { sessionId, session }, session);
    const responses = functionResponses(result);
    assert.deepEqual(responses.map(item => item.tool_use_id), ['ok', 'bad']);
    assert.match(responses[0].response.output, /ok/);
    assert.match(String(responses[1].response.error), /Working directory|does not exist/i);
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(root);
  }
});

test('serial image and error barriers retain per-call image/result ordering', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-tool-images-'));
  const sessionId = makeSessionId('tool_images');
  const imagePath = path.join(root, 'pixel.png');
  await fs.writeFile(imagePath, Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+A8AAQUBAScY42YAAAAASUVORK5CYII=', 'base64'));
  const session = await createSession(sessionId, root);
  try {
    const result = await executeTools([
      { id: 'image-read', name: 'read', args: { filePath: imagePath } },
      { id: 'missing-read', name: 'read', args: { filePath: path.join(root, 'missing.txt') } },
    ], { sessionId, session }, session);
    assert.equal(result.parts[0].imageMeta?.imageId, 'image-read#1');
    assert.equal(result.parts[1].functionResponse?.tool_use_id, 'image-read');
    assert.equal(result.parts[2].functionResponse?.tool_use_id, 'missing-read');
    assert.notEqual(result.parts[2].functionResponse?.response?.error, undefined);
  } finally {
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(root);
  }
});

test('stop waits for the active exec segment and skips the following barrier tool', async () => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-parallel-stop-'));
  const sessionId = makeSessionId('parallel_stop');
  const startedA = path.join(root, 'a.started');
  const startedB = path.join(root, 'b.started');
  const release = path.join(root, 'release');
  await fs.writeFile(path.join(root, 'marker.txt'), 'must-not-read');
  const session = await createSession(sessionId, root);
  try {
    const resultPromise = executeTools([
      { id: 'a', name: 'exec', args: { command: `touch '${startedA}'; while [ ! -f '${release}' ]; do sleep 0.02; done` } },
      { id: 'b', name: 'exec', args: { command: `touch '${startedB}'; while [ ! -f '${release}' ]; do sleep 0.02; done` } },
      { id: 'barrier', name: 'read', args: { filePath: 'marker.txt' } },
    ], { sessionId, session }, session);
    await waitForFiles([startedA, startedB]);
    session.stopping = true;
    await fs.writeFile(release, 'go');
    const result = await resultPromise;
    const responses = functionResponses(result);
    assert.deepEqual(responses.map(item => item.tool_use_id), ['a', 'b', 'barrier']);
    assert.match(String(responses[2].response.error), /not started because the session was stopped/);
  } finally {
    session.stopping = false;
    await sessionManager.deleteSession(sessionId).catch(() => false);
    await fs.remove(root);
  }
});

test('parallel remote exec calls may resolve in reverse order while responses keep model order and one routing snapshot', async () => {
  const sessionId = makeSessionId('parallel_remote');
  const session = await createSession(sessionId, '/snapshot/cwd');
  session.currentNode = 'remote-test';
  await sessionManager.saveSession(sessionId);
  const originalGetCurrentNode = nodesManager.getCurrentNode.bind(nodesManager);
  const originalGetNode = nodesManager.getNode.bind(nodesManager);
  const originalExecuteTool = nodesManager.executeTool.bind(nodesManager);
  const pending: Array<{ id: string; snapshot: any; resolve: (value: any) => void }> = [];
  (nodesManager as any).getCurrentNode = async () => 'remote-test';
  (nodesManager as any).getNode = () => ({ id: 'remote-test', ws: {}, tools: new Set(['exec']) });
  (nodesManager as any).executeTool = async (_nodeId: string, _name: string, args: any, _sessionId: string, snapshot: any) => {
    return await new Promise(resolve => pending.push({ id: args.command, snapshot, resolve }));
  };

  try {
    const running = executeTools([
      { id: 'remote-a', name: 'exec', args: { command: 'a' } },
      { id: 'remote-b', name: 'exec', args: { command: 'b' } },
    ], { sessionId, session }, session);
    while (pending.length < 2) await new Promise(resolve => setTimeout(resolve, 5));
    pending[1].resolve('second');
    pending[0].resolve('first');
    const result = await running;
    assert.deepEqual(functionResponses(result).map(item => item.response.output), ['first', 'second']);
    assert(pending.every(item => item.snapshot.currentNode === 'remote-test' && item.snapshot.cwd === '/snapshot/cwd'));
  } finally {
    (nodesManager as any).getCurrentNode = originalGetCurrentNode;
    (nodesManager as any).getNode = originalGetNode;
    (nodesManager as any).executeTool = originalExecuteTool;
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});

test('legacy parallel routing snapshots only the authoritative global owner, not same-ID clones', async () => {
  const sessionId = makeSessionId('parallel_owner');
  const session = await createSession(sessionId, '/authoritative/cwd');
  session.currentNode = 'remote-owner';
  await sessionManager.saveSession(sessionId);
  const clone = { ...session, currentNode: 'remote-clone', cwd: '/clone/cwd' };
  const originalGetCurrentNode = nodesManager.getCurrentNode.bind(nodesManager);
  const originalGetNode = nodesManager.getNode.bind(nodesManager);
  const originalExecuteTool = nodesManager.executeTool.bind(nodesManager);
  const snapshots: any[] = [];
  (nodesManager as any).getCurrentNode = () => { throw new Error('parallel routing re-read current node'); };
  (nodesManager as any).getNode = (nodeId: string) => ({ id: nodeId, ws: {}, tools: new Set(['exec']) });
  (nodesManager as any).executeTool = async (nodeId: string, _name: string, args: any, sourceSessionId: string, snapshot: any) => {
    snapshots.push({ nodeId, command: args.command, sourceSessionId, snapshot });
    return args.command || nodeId;
  };

  try {
    const result = await executeTools([
      { id: 'owner-a', name: 'exec', args: { command: 'a' } },
      { id: 'owner-b', name: 'exec', args: { command: 'b' } },
    ], { sessionId, session: clone }, clone as any);
    assert.deepEqual(functionResponses(result).map(item => item.response.output), ['a', 'b']);
    assert.deepEqual(snapshots.map(item => item.nodeId), ['remote-owner', 'remote-owner']);
    assert(snapshots.every(item => item.sourceSessionId === sessionId));
    assert(snapshots.every(item => item.snapshot.currentNode === 'remote-owner' && item.snapshot.cwd === '/authoritative/cwd'));
  } finally {
    (nodesManager as any).getCurrentNode = originalGetCurrentNode;
    (nodesManager as any).getNode = originalGetNode;
    (nodesManager as any).executeTool = originalExecuteTool;
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});

test('adjacent exec segment enforces the internal concurrency limit of four', async () => {
  const sessionId = makeSessionId('parallel_limit');
  const session = await createSession(sessionId, '/snapshot/cwd');
  session.currentNode = 'remote-limit';
  await sessionManager.saveSession(sessionId);
  const originalGetCurrentNode = nodesManager.getCurrentNode.bind(nodesManager);
  const originalGetNode = nodesManager.getNode.bind(nodesManager);
  const originalExecuteTool = nodesManager.executeTool.bind(nodesManager);
  const releases: Array<() => void> = [];
  let active = 0;
  let maxActive = 0;
  let started = 0;
  (nodesManager as any).getCurrentNode = async () => 'remote-limit';
  (nodesManager as any).getNode = () => ({ id: 'remote-limit', ws: {}, tools: new Set(['exec']) });
  (nodesManager as any).executeTool = async () => {
    started++;
    active++;
    maxActive = Math.max(maxActive, active);
    return await new Promise(resolve => releases.push(() => {
      active--;
      resolve(`done-${started}`);
    }));
  };

  try {
    const running = executeTools(Array.from({ length: 6 }, (_, index) => ({
      id: `limited-${index}`,
      name: 'exec',
      args: { command: String(index) },
    })), { sessionId, session }, session);
    while (started < 4) await new Promise(resolve => setTimeout(resolve, 5));
    await new Promise(resolve => setTimeout(resolve, 20));
    assert.equal(started, 4);
    releases[0]();
    while (started < 5) await new Promise(resolve => setTimeout(resolve, 5));
    releases[1]();
    while (started < 6) await new Promise(resolve => setTimeout(resolve, 5));
    for (const release of releases.slice(2)) release();
    await running;
    assert.equal(maxActive, 4);
  } finally {
    (nodesManager as any).getCurrentNode = originalGetCurrentNode;
    (nodesManager as any).getNode = originalGetNode;
    (nodesManager as any).executeTool = originalExecuteTool;
    await sessionManager.deleteSession(sessionId).catch(() => false);
  }
});
