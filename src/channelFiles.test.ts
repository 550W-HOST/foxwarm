import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';
import { buildSavedFileText, saveInboundChannelFile, saveInboundSessionFile, saveInboundSessionFileFromPath } from './channelFiles';
import { getAgentDir } from './config';
import * as sessionManager from './sessionManager';
import { nodesManager } from './nodes/manager';
import { read } from './tools';

test('buildSavedFileText emits ordered one-line XML descriptors with captions and escaped attributes', () => {
  const saved = {
    agentName: 'main',
    nodeId: 'master"<&\nnode',
    absolutePath: '/tmp/report.txt',
    promptPath: '/tmp/a&"<\nfile.txt',
    fileName: 'report"<&\n\u0001.txt',
    mimeType: 'text/plain"<&\nnext',
    sizeBytes: 1,
    isImage: false,
  };

  const fileText = buildSavedFileText(saved, 'file', 'caption body');
  assert.equal(
    fileText,
    'caption body\n\n<foxwarm-file name="report&quot;&lt;&amp; .txt" node="master&quot;&lt;&amp; node" path="/tmp/a&amp;&quot;&lt; file.txt" mime="text/plain&quot;&lt;&amp; next" />',
  );
  assert.equal(fileText.split('\n').at(-1)?.startsWith('<foxwarm-file '), true);

  const imageText = buildSavedFileText({ ...saved, fileName: 'photo.png', mimeType: 'image/png', isImage: true }, 'image', 'image');
  assert.equal(
    imageText,
    'image\n\n<foxwarm-image name="photo.png" node="master&quot;&lt;&amp; node" path="/tmp/a&amp;&quot;&lt; file.txt" />',
  );
  assert.doesNotMatch(imageText, / mime=/);
});

test('saveInboundSessionFile reports a master absolute Path that remains readable when session cwd is set', async () => {
  const sessionId = `main/channel_file_abs_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const cwd = path.join(getAgentDir('main'), '.temp', `channel-file-cwd-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const session = await sessionManager.getSession(sessionId);
  session.cwd = cwd;
  let savedPath: string | undefined;

  await fs.ensureDir(cwd);

  try {
    const saved = await saveInboundSessionFile({
      sessionId,
      platform: 'webui',
      buffer: Buffer.from('hello from upload'),
      fileName: 'note.txt',
      mimeType: 'text/plain',
    });

    assert.equal(saved.nodeId, 'master');
    assert.equal(path.isAbsolute(saved.promptPath), true);
    assert.equal(saved.promptPath, saved.absolutePath);
    assert.ok(saved.promptPath.startsWith(getAgentDir('main') + path.sep));
    savedPath = saved.promptPath;

    const text = buildSavedFileText(saved, 'file');
    assert.match(text, /node="master"/);
    assert.match(text, new RegExp(`path="${saved.promptPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}"`));
    assert.doesNotMatch(text, /Tool path|Use read/i);

    const readResult = await read({ filePath: saved.promptPath }, { session } as any);
    assert.equal(readResult, 'hello from upload\n---\nFile has 1 line.\nFile size: 17 bytes.\nFile has no trailing newline.');
    const siblingNames = await fs.readdir(path.dirname(saved.promptPath));
    assert.equal(siblingNames.some(name => name.endsWith('.tmp')), false);
  } finally {
    if (savedPath) await fs.remove(savedPath);
    await fs.remove(cwd);
  }
});

test('saveInboundSessionFileFromPath publishes a master spool atomically without a base64 buffer API', async () => {
  const sessionId = `main/channel_file_spool_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
  const tempDir = path.join(getAgentDir('main'), '.temp', `channel-file-spool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);
  const sourcePath = path.join(tempDir, 'spool.bin');
  let savedPath: string | undefined;
  await fs.ensureDir(tempDir);

  try {
    await fs.writeFile(sourcePath, Buffer.from('spooled media'));
    const saved = await saveInboundSessionFileFromPath({
      sessionId,
      platform: 'qqbot',
      sourcePath,
      sizeBytes: 13,
      fileName: 'spool.bin',
      mimeType: 'application/octet-stream',
    });
    savedPath = saved.promptPath;
    assert.equal(await fs.readFile(saved.promptPath, 'utf8'), 'spooled media');
    assert.equal((await fs.readdir(path.dirname(saved.promptPath))).some(name => name.endsWith('.tmp')), false);
  } finally {
    if (savedPath) await fs.remove(savedPath);
    await fs.remove(tempDir);
  }
});

test('saveInboundSessionFile stores isolated WebUI uploads on the isolated node and reports its absolute node Path', async () => {
  const originalGetSessionCatalog = sessionManager.getSessionCatalog;
  const originalIsSessionEffectivelyIsolated = sessionManager.isSessionEffectivelyIsolated;
  const originalGetAgentIsolationNode = sessionManager.getAgentIsolationNode;
  const originalWriteFileToNode = nodesManager.writeFileToNode.bind(nodesManager);

  let captured: { nodeId?: string; filePath?: string; sessionId?: string } = {};

  try {
    (sessionManager as any).getSessionCatalog = () => ({
      id: 'isolated/session',
      agent: 'isolated-agent',
      currentNode: 'sandbox-node',
      cwd: '/workspace/project',
    });
    (sessionManager as any).isSessionEffectivelyIsolated = () => true;
    (sessionManager as any).getAgentIsolationNode = () => 'sandbox-node';
    (nodesManager as any).writeFileToNode = async (nodeId: string, filePath: string, _dataBase64: string, _overwrite: boolean, sessionId: string) => {
      captured = { nodeId, filePath, sessionId };
      return { filePath, absolutePath: `/node/agents/isolated-agent/${filePath}`, sizeBytes: 5, sha256: 'hash', overwritten: false };
    };

    const saved = await saveInboundSessionFile({
      sessionId: 'isolated/session',
      platform: 'webui',
      buffer: Buffer.from('hello'),
      fileName: 'note.txt',
      mimeType: 'text/plain',
    });

    assert.equal(captured.nodeId, 'sandbox-node');
    assert.equal(captured.sessionId, 'isolated/session');
    assert.match(String(captured.filePath), /^\.temp[\\/]channel-files[\\/]webui[\\/]/);
    assert.equal(saved.nodeId, 'sandbox-node');
    assert.equal(saved.promptPath, `/node/agents/isolated-agent/${captured.filePath}`);
    assert.equal(path.isAbsolute(saved.promptPath), true);
    assert.match(buildSavedFileText(saved, 'file'), /node="sandbox-node"/);
    assert.match(buildSavedFileText(saved, 'file'), /path="\/node\/agents\/isolated-agent\/\.temp[\\/]channel-files[\\/]webui[\\/]/);
    assert.doesNotMatch(buildSavedFileText(saved, 'file'), /Tool path|Use read/i);
  } finally {
    (sessionManager as any).getSessionCatalog = originalGetSessionCatalog;
    (sessionManager as any).isSessionEffectivelyIsolated = originalIsSessionEffectivelyIsolated;
    (sessionManager as any).getAgentIsolationNode = originalGetAgentIsolationNode;
    (nodesManager as any).writeFileToNode = originalWriteFileToNode;
  }
});

test('path-based inbound media rejects isolated-node whole-buffer transfer instead of claiming streaming support', async () => {
  const originalGetSessionCatalog = sessionManager.getSessionCatalog;
  const originalIsSessionEffectivelyIsolated = sessionManager.isSessionEffectivelyIsolated;
  const originalGetAgentIsolationNode = sessionManager.getAgentIsolationNode;
  const sourcePath = path.join(getAgentDir('main'), '.temp', `qq-media-spool-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.bin`);

  try {
    await fs.ensureDir(path.dirname(sourcePath));
    await fs.writeFile(sourcePath, Buffer.from('bounded'));
    (sessionManager as any).getSessionCatalog = () => ({ id: 'isolated/session', agent: 'isolated-agent', currentNode: 'sandbox-node' });
    (sessionManager as any).isSessionEffectivelyIsolated = () => true;
    (sessionManager as any).getAgentIsolationNode = () => 'sandbox-node';

    await assert.rejects(
      saveInboundSessionFileFromPath({
        sessionId: 'isolated/session',
        platform: 'qqbot',
        sourcePath,
        sizeBytes: 7,
        fileName: 'bounded.bin',
        mimeType: 'application/octet-stream',
      }),
      /whole-buffer only and has no bounded streaming boundary/,
    );
  } finally {
    await fs.remove(sourcePath);
    (sessionManager as any).getSessionCatalog = originalGetSessionCatalog;
    (sessionManager as any).isSessionEffectivelyIsolated = originalIsSessionEffectivelyIsolated;
    (sessionManager as any).getAgentIsolationNode = originalGetAgentIsolationNode;
  }
});

test('saveInboundChannelFile stores isolated channel uploads on the isolated node via the shared helper', async () => {
  const originalGetSessionByChannel = sessionManager.getSessionByChannel;
  const originalGetSessionCatalog = sessionManager.getSessionCatalog;
  const originalIsSessionEffectivelyIsolated = sessionManager.isSessionEffectivelyIsolated;
  const originalGetAgentIsolationNode = sessionManager.getAgentIsolationNode;
  const originalWriteFileToNode = nodesManager.writeFileToNode.bind(nodesManager);

  let captured: { nodeId?: string; filePath?: string; sessionId?: string } = {};

  try {
    (sessionManager as any).getSessionByChannel = () => 'isolated/session';
    (sessionManager as any).getSessionCatalog = () => ({
      id: 'isolated/session',
      agent: 'isolated-agent',
      currentNode: 'master',
    });
    (sessionManager as any).isSessionEffectivelyIsolated = () => true;
    (sessionManager as any).getAgentIsolationNode = () => 'sandbox-node';
    (nodesManager as any).writeFileToNode = async (nodeId: string, filePath: string, _dataBase64: string, _overwrite: boolean, sessionId: string) => {
      captured = { nodeId, filePath, sessionId };
      return { filePath, absolutePath: `/node/agents/isolated-agent/${filePath}`, sizeBytes: 3, sha256: 'hash', overwritten: false };
    };

    const saved = await saveInboundChannelFile({
      platform: 'telegram',
      channelUserId: 'chat-1',
      buffer: Buffer.from('abc'),
      fileName: 'photo.jpg',
      mimeType: 'image/jpeg',
      isImage: true,
    });

    assert.equal(captured.nodeId, 'sandbox-node');
    assert.equal(captured.sessionId, 'isolated/session');
    assert.match(String(captured.filePath), /^\.temp[\\/]channel-files[\\/]telegram[\\/]/);
    assert.equal(saved.nodeId, 'sandbox-node');
    assert.equal(saved.promptPath, `/node/agents/isolated-agent/${captured.filePath}`);
    assert.equal(path.isAbsolute(saved.promptPath), true);
    assert.match(buildSavedFileText(saved, 'image'), /node="sandbox-node"/);
    assert.match(buildSavedFileText(saved, 'image'), /path="\/node\/agents\/isolated-agent\/\.temp[\\/]channel-files[\\/]telegram[\\/]/);
  } finally {
    (sessionManager as any).getSessionByChannel = originalGetSessionByChannel;
    (sessionManager as any).getSessionCatalog = originalGetSessionCatalog;
    (sessionManager as any).isSessionEffectivelyIsolated = originalIsSessionEffectivelyIsolated;
    (sessionManager as any).getAgentIsolationNode = originalGetAgentIsolationNode;
    (nodesManager as any).writeFileToNode = originalWriteFileToNode;
  }
});