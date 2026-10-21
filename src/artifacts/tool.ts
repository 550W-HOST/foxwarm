import fs from 'node:fs/promises';
import { isCoreNodeId } from '../../packages/shared/dist/nodeIdentity';
import path from 'node:path';
import { STATE_DIR } from '../config';
import { readNodeFile } from '../nodeExecution';
import { requireNodeExecutionAccess } from '../nodeExecutionService';
import { nodeProviderRegistry } from '../nodes/providers';
import { IMAGE_ARTIFACT_MAX_BYTES } from '../../packages/shared/dist/artifacts/image';
import { formatArtifactMarker } from '../../packages/shared/dist/artifacts/marker';
import { describeImage } from './image';
import { resolveAgentPath, shouldEnforceIsolatedMasterPathAccess } from '../toolsSessionAgent/helpers';
import { checkPathAccess } from '../utils/agentPathAccess';
import { checkToolPermissionForSession } from '../isolatedCheck';
import { MAX_ARTIFACT_BYTES } from '../../packages/shared/dist/artifacts/types';
import type { ToolArgs, ToolContext } from '../tools/helpers';
import { ArtifactStore } from './store';
export const artifactStore = new ArtifactStore(path.join(STATE_DIR, 'artifacts'));
/** Main-owned publishing: immutable data only; no generated code executes here. */
export async function tool_artifact(args: ToolArgs, ctx: ToolContext) {
  if (!ctx.sessionId || !ctx.session) throw new Error('Artifact requires an exact source Session');
  if (args.action === 'get') {
    if (Object.keys(args).some(k => !['action', 'artifactId', 'revision'].includes(k))) throw new Error('get accepts only artifactId and optional revision');
    const revision = args.revision ?? await artifactStore.latestRevision(args.artifactId, ctx.sessionId);
    const record = await artifactStore.read(args.artifactId, revision, ctx.sessionId);
    return { output: JSON.stringify({ ...record.receipt, createdAt: record.createdAt }), marker: formatArtifactMarker(record.receipt) };
  }
  if (!['publish', 'prepare'].includes(args.action)) throw new Error('Supported actions: prepare, publish, get');
  if (Object.keys(args).some(k => !['action', 'filePath', 'node', 'artifactId', 'expectedRevision', 'type', 'title', 'alt'].includes(k))) throw new Error('Unsupported artifact argument');
  if (typeof args.filePath !== 'string' || !args.filePath || args.filePath.length > 4096) throw new Error('A bounded filePath is required');
  if (args.node !== undefined && !isCoreNodeId(args.node)) throw new Error('Invalid source Node');
  if (args.type !== undefined && args.type !== 'image') throw new Error('type is only needed for raster image files; other types come from the manifest');
  if (args.type !== 'image' && (args.title !== undefined || args.alt !== undefined)) throw new Error('title and alt apply only to raster image files');
  const limit = args.type === 'image' ? IMAGE_ARTIFACT_MAX_BYTES : MAX_ARTIFACT_BYTES;
  const nodeId = args.node || ctx.session.currentNode || 'master';
  const cwd = nodeId === (ctx.session.currentNode || 'master') ? ctx.session.cwd : undefined;
  await checkToolPermissionForSession({ ...ctx.session, cwd }, { source: 'node', node: nodeId, tool: 'read' }, nodeId, { filePath: args.filePath });
  let bytes: Buffer;
  if (nodeId === 'master') {
    const file = await fs.realpath(resolveAgentPath(args.filePath, ctx.session.agent, cwd));
    if (shouldEnforceIsolatedMasterPathAccess({ ...ctx, runtimeNodeId: 'master' })) checkPathAccess(file, ctx.session.agent);
    const handle = await fs.open(file, 'r');
    try {
      const stat = await handle.stat(); if (!stat.isFile() || stat.size > limit) throw new Error(`Artifact source must be a regular file of at most ${limit / 1024 / 1024} MiB`);
      bytes = Buffer.alloc(limit + 1); const read = await handle.read(bytes, 0, bytes.length, 0); bytes = bytes.subarray(0, read.bytesRead);
    } finally { await handle.close(); }
  } else if (args.type === 'image') {
    await requireNodeExecutionAccess(ctx.sessionId, nodeId);
    bytes = await nodeProviderRegistry.readFile({ sourceSessionId: ctx.sessionId, nodeId, toolName: 'read', args: { filePath: args.filePath }, context: { agent: ctx.session.agent || 'main', currentNode: nodeId, ...(cwd !== undefined ? { cwd } : {}) } }, { signal: ctx.signal, maxBytes: limit });
  } else {
    const content = await readNodeFile(ctx.sessionId, nodeId, args.filePath, { currentNode: nodeId, ...(cwd !== undefined ? { cwd } : {}) }, ctx.signal, limit);
    if (Buffer.byteLength(content, 'utf8') > MAX_ARTIFACT_BYTES) throw new Error('Artifact exceeds 2 MiB');
    bytes = Buffer.from(content, 'utf8');
  }
  if (bytes.length > limit) throw new Error(`Artifact exceeds ${limit / 1024 / 1024} MiB`);
  const doc = args.type === 'image' ? await describeImage(bytes, args.title === undefined ? args.filePath.split(/[\\/]/).pop().slice(0, 160) : args.title, args.alt) : JSON.parse(bytes.toString('utf8'));
  const stored = await artifactStore.publish(ctx.sessionId, doc, args.artifactId, args.expectedRevision, args.type === 'image' ? { image: bytes } : undefined);
  const marker = formatArtifactMarker(stored.receipt);
  return args.action === 'prepare'
    ? { output: `Prepared ${stored.receipt.type}: ${stored.receipt.title}. Place the marker on its own line between blank lines in assistant prose to display it.`, preparedArtifact: stored.receipt, marker }
    : { output: `Published ${stored.receipt.type}: ${stored.receipt.title} (revision ${stored.receipt.revision}).`, artifact: stored.receipt, marker };
}
