import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import * as sessionManager from '../sessionManager';
import { artifact, call_tool } from '../tools';
import { tool_run_script } from '../toolscript';
import { createMainManagementToolServiceHandler } from '../mainManagementToolService';
import { shutdownMainManagementTools, resetMainManagementToolsForTests } from '../mainManagementTools';
import { artifactStore, tool_artifact } from './tool';
import * as nodeExecution from '../nodeExecution';
import fs from 'node:fs/promises';
const manifest = path.resolve('skills/data-visualization/examples/training-metrics.json');
test('direct, unified and ToolScript publication use Main authority and return persisted receipts', async () => {
  const id = `artifact_tool_${Date.now()}`, session = await sessionManager.getSession(id);
  const ctx: any = { sessionId: id, session, sessionPlacement: 'session-worker', persistCurrentSession: async () => {} };
  try {
    const a = await artifact({ action: 'publish', filePath: manifest }, ctx);
    const b: any = await call_tool({ toolId: 'builtin:artifact', args: { action: 'publish', filePath: manifest } }, ctx);
    const script = await tool_run_script({ code: 'return call_tool("builtin:artifact", {"action":"publish", "filePath":args["path"]})', args: { path: manifest } }, ctx);
    assert.equal(script.status, 'completed');
    const c: any = script.result;
    for (const result of [a, b, c]) {
      assert.equal(result.artifact.sessionId, id);
      assert.equal((await artifactStore.read(result.artifact.artifactId, 1, id)).document.title, 'Training success rate');
    }
    const prepared: any = await call_tool({ toolId: 'builtin:artifact', args: { action: 'prepare', filePath: manifest } }, ctx);
    assert.equal(prepared.artifact, undefined); assert.equal(prepared.preparedArtifact.sessionId, id);
    assert.match(prepared.marker, /^<foxwarm-artifact id="art_[a-f0-9]{32}" revision="1" \/>$/);
    const sharp = (await import('sharp')).default;
    const imagePath = path.join(process.env.FOXWARM_DATA_DIR!, 'test-artifact.png');
    const imageBytes = await sharp({ create: { width: 32, height: 24, channels: 3, background: '#397eee' } }).png().toBuffer();
    await fs.writeFile(imagePath, imageBytes);
    const image: any = await call_tool({ toolId: 'builtin:artifact', args: { action: 'prepare', type: 'image', title: 'Figure', filePath: imagePath } }, ctx);
    assert.equal(image.artifact, undefined); assert.equal(image.preparedArtifact.type, 'image');
    await fs.rm(imagePath);
    assert.deepEqual((await artifactStore.resource(image.preparedArtifact.artifactId, 1, id, 'image')).bytes, imageBytes, 'snapshot survives source deletion');
    const got: any = await call_tool({ toolId: 'builtin:artifact', args: { action: 'get', artifactId: a.artifact.artifactId } }, ctx);
    assert.equal(JSON.parse(got.output).revision, 1); assert.equal(got.artifact, undefined);
    const revised = await artifact({ action: 'publish', filePath: manifest, artifactId: a.artifact.artifactId, expectedRevision: 1 }, ctx);
    assert.equal(revised.artifact.revision, 2);
    await assert.rejects(artifact({ action: 'publish', filePath: manifest, artifactId: a.artifact.artifactId, expectedRevision: 1 }, ctx), /Revision conflict/);
    const handler = createMainManagementToolServiceHandler({ expectedSourceSessionId: id });
    await assert.rejects((handler.execute as any)({ sourceSessionId: 'not-owner', operation: 'artifact', args: { action: 'publish', filePath: manifest } }), /source|Source/);
  } finally {
    await shutdownMainManagementTools(); resetMainManagementToolsForTests();
    await sessionManager.deleteSession(id);
  }
});
test('remote manifests use Node read facade with exact source cwd; explicit other Node does not inherit cwd', async () => {
  const original = nodeExecution.readNodeFile, calls: any[] = [];
  (nodeExecution as any).readNodeFile = async (...args: any[]) => { calls.push(args); return fs.readFile(manifest, 'utf8'); };
  try {
    const ctx: any = { sessionId: 'test-routing', session: { id: 'test-routing', agent: 'main', currentNode: 'remote-a', cwd: '/project' } };
    const a = await tool_artifact({ action: 'publish', filePath: 'plot.json' }, ctx);
    assert.equal(a.artifact.sessionId, 'test-routing');
    assert.deepEqual(calls[0].slice(0, 4), ['test-routing', 'remote-a', 'plot.json', { currentNode: 'remote-a', cwd: '/project' }]);
    await tool_artifact({ action: 'publish', node: 'remote-b', filePath: 'plot.json' }, ctx);
    assert.deepEqual(calls[1][3], { currentNode: 'remote-b' });
  } finally { (nodeExecution as any).readNodeFile = original; }
});
