import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { getAgentDir } from './config';
import { expandHomePath } from './utils/pathResolve';
import { expandAgentPathVariable } from '../packages/shared/dist/agentPathVariables';

import { buildNodeTransferFilePayload, buildNodeTransferWriteResult, type NodeTransferFilePayload, type NodeTransferWriteResult } from '../packages/shared/dist/nodeFileTransfer';

export function resolveNodeTransferPath(filePath: string, agentName: string, restrictToAgentDir = true): string {
  if (!filePath || typeof filePath !== 'string') {
    throw new Error('filePath is required');
  }

  const agentDir = getAgentDir(agentName);
  const expandedPath = expandHomePath(expandAgentPathVariable(filePath, agentDir));
  const resolved = path.isAbsolute(expandedPath)
    ? path.resolve(expandedPath)
    : path.resolve(agentDir, expandedPath);

  if (restrictToAgentDir && !(resolved === agentDir || resolved.startsWith(agentDir + path.sep))) {
    throw new Error('Path traversal detected: cannot access files outside agent folder');
  }

  return resolved;
}

export async function readNodeTransferFile(filePath: string, agentName: string, restrictToAgentDir = true): Promise<NodeTransferFilePayload> {
  const fullPath = resolveNodeTransferPath(filePath, agentName, restrictToAgentDir);
  const stats = await fs.stat(fullPath);
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }

  const buffer = await fs.readFile(fullPath);
  return buildNodeTransferFilePayload(filePath, buffer);
}

export async function writeNodeTransferFile(filePath: string, agentName: string, dataBase64: string, overwrite = false, restrictToAgentDir = true): Promise<NodeTransferWriteResult> {
  if (typeof dataBase64 !== 'string') {
    throw new Error('dataBase64 is required');
  }

  const fullPath = resolveNodeTransferPath(filePath, agentName, restrictToAgentDir);
  const exists = await fs.pathExists(fullPath);
  if (exists && !overwrite) {
    throw new Error(`File already exists: ${filePath}. Use overwrite=true to replace it.`);
  }

  const buffer = Buffer.from(dataBase64, 'base64');
  await fs.ensureDir(path.dirname(fullPath));
  await fs.writeFile(fullPath, buffer);

  return buildNodeTransferWriteResult(filePath, buffer, exists, fullPath);
}

/** Decode the existing authenticated transfer payload without accepting partial data. */
export function decodeNodeTransferFile(file: Pick<NodeTransferFilePayload, 'dataBase64' | 'sizeBytes' | 'sha256'>): Buffer {
  if (!file || typeof file.dataBase64 !== 'string') {
    throw new Error('Node file source returned invalid base64 data.');
  }
  const decoded = Buffer.from(file.dataBase64, 'base64');
  if (decoded.toString('base64') !== file.dataBase64) throw new Error('Node file source returned non-canonical base64 data.');
  if (!Number.isSafeInteger(file.sizeBytes) || file.sizeBytes < 0 || file.sizeBytes !== decoded.length) throw new Error('Node file source returned an invalid sizeBytes.');
  if (typeof file.sha256 !== 'string' || !/^[a-f0-9]{64}$/i.test(file.sha256)
    || crypto.createHash('sha256').update(decoded).digest('hex').toLowerCase() !== file.sha256.toLowerCase()) {
    throw new Error('Node file source returned an invalid sha256.');
  }
  return decoded;
}
