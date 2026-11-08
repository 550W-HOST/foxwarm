import crypto from 'crypto';
import fs from 'fs-extra';
import { open } from 'fs/promises';
import http from 'http';
import https from 'https';
import path from 'path';
import { Transform } from 'stream';
import { pipeline } from 'stream/promises';
import { buildNodeTransferFilePayload, resolveNodeTransferPath, type NodeTransferFilePayload, type NodeTransferWriteResult } from '../../shared/dist/nodeFileTransfer';
import { createMasterWebSocketOptions } from './masterProxy';

const STREAM_THRESHOLD = 64 * 1024;
const NO_PROGRESS_MS = 60_000;

type Connection = { host: string; nodeId: string; authToken: string; signal: AbortSignal };
type FileRequest = { transferId: string; filePath: string; agentName: string; restrictToAgentDir: boolean };

function transferRequest(connection: Connection, transferId: string, method: 'GET' | 'PUT', length?: number): http.ClientRequest {
  const url = new URL(connection.host.replace(/\/$/, '') + '/node/transfer/' + encodeURIComponent(transferId));
  const transport = url.protocol === 'https:' ? https : http;
  const { agent } = createMasterWebSocketOptions(url.toString());
  const request = transport.request(url, {
    method,
    agent: agent as http.Agent | undefined,
    headers: {
      'X-Foxwarm-Node': connection.nodeId,
      'Authorization': `Bearer ${connection.authToken}`,
      ...(length === undefined ? {} : { 'Content-Length': String(length) }),
    },
    signal: connection.signal,
  });
  request.setTimeout(NO_PROGRESS_MS, () => request.destroy(new Error('File transfer made no progress.')));
  return request;
}

function counter(length: number, hash?: crypto.Hash): Transform {
  let count = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      count += chunk.length;
      if (count > length) return callback(new Error('File transfer exceeded its declared size.'));
      hash?.update(chunk);
      callback(null, chunk);
    },
    flush(callback) {
      callback(count === length ? undefined : new Error('Source changed or transfer was interrupted.'));
    },
  });
}

function response(request: http.ClientRequest): Promise<http.IncomingMessage> {
  return new Promise((resolve, reject) => {
    request.once('response', resolve);
    request.once('error', reject);
  });
}

function ensureSuccess(reply: http.IncomingMessage): void {
  if (reply.statusCode !== 200) {
    reply.resume();
    throw new Error(`File transfer request failed (HTTP ${reply.statusCode}).`);
  }
}

export async function streamReadFile(connection: Connection, input: FileRequest): Promise<NodeTransferFilePayload | undefined> {
  connection.signal.throwIfAborted();
  const fullPath = resolveNodeTransferPath(input.filePath, input.agentName, input.restrictToAgentDir);
  const file = await open(fullPath, 'r');
  try {
    const stats = await file.stat();
    if (!stats.isFile()) throw new Error(`Not a file: ${input.filePath}`);
    const length = stats.size;
    if (!Number.isSafeInteger(length)) throw new Error('File is too large to transfer.');
    if (length < STREAM_THRESHOLD) {
      const buffer = Buffer.alloc(length);
      let offset = 0;
      while (offset < length) {
        const { bytesRead } = await file.read(buffer, offset, length - offset, offset);
        if (!bytesRead) throw new Error('Source changed or transfer was interrupted.');
        offset += bytesRead;
      }
      connection.signal.throwIfAborted();
      return buildNodeTransferFilePayload(input.filePath, buffer);
    }
    const request = transferRequest(connection, input.transferId, 'PUT', length);
    const received = response(request);
    void received.catch(() => {});
    try {
      await pipeline(file.createReadStream({ autoClose: false, start: 0, end: length - 1 }), counter(length), request);
      const reply = await received;
      ensureSuccess(reply);
      reply.resume();
    } catch (error) {
      request.destroy();
      await received.catch(() => {});
      throw error;
    }
  } finally {
    await file.close();
  }
}

export async function streamWriteFile(connection: Connection, input: FileRequest & { overwrite: boolean; sizeBytes: number }): Promise<NodeTransferWriteResult> {
  connection.signal.throwIfAborted();
  const fullPath = resolveNodeTransferPath(input.filePath, input.agentName, input.restrictToAgentDir);
  if (!Number.isSafeInteger(input.sizeBytes) || input.sizeBytes < 0) throw new Error('Invalid file transfer size.');
  const existed = await fs.pathExists(fullPath);
  if (existed && !input.overwrite) throw new Error(`File already exists: ${input.filePath}. Use overwrite=true to replace it.`);
  await fs.ensureDir(path.dirname(fullPath));
  const temporary = `${fullPath}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  const hash = crypto.createHash('sha256');
  try {
    const request = transferRequest(connection, input.transferId, 'GET');
    const received = response(request);
    request.end();
    const reply = await received;
    ensureSuccess(reply);
    if (reply.headers['content-length'] !== String(input.sizeBytes)) {
      reply.destroy();
      throw new Error('File transfer size is invalid.');
    }
    await pipeline(reply, counter(input.sizeBytes, hash), fs.createWriteStream(temporary, { flags: 'wx' }));
    connection.signal.throwIfAborted();
    if (input.overwrite) await fs.rename(temporary, fullPath);
    else {
      await fs.link(temporary, fullPath);
      await fs.remove(temporary);
    }
    return { filePath: input.filePath, absolutePath: fullPath, sizeBytes: input.sizeBytes, sha256: hash.digest('hex'), overwritten: existed };
  } finally {
    await fs.remove(temporary).catch(() => {});
  }
}
