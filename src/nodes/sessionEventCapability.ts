import crypto from 'node:crypto';
import fs from 'fs-extra';
import path from 'node:path';
import { NODE_EVENT_CAPABILITY_SECRET_FILE } from '../config';

type RemoteExecCompletionCapability = {
  v: 1;
  purpose: 'remote-exec-completion';
  nodeId: string;
  sessionId: string;
  execId: string;
  issuedAt: number;
};

let cachedSecret: Buffer | null = null;

function loadOrCreateSecret(): Buffer {
  if (cachedSecret) return cachedSecret;
  fs.ensureDirSync(path.dirname(NODE_EVENT_CAPABILITY_SECRET_FILE));
  try {
    const value = fs.readFileSync(NODE_EVENT_CAPABILITY_SECRET_FILE, 'utf8').trim();
    if (/^[a-f0-9]{64}$/i.test(value)) {
      cachedSecret = Buffer.from(value, 'hex');
      return cachedSecret;
    }
    throw new Error('Node event capability secret is malformed.');
  } catch (error: any) {
    if (error?.code !== 'ENOENT') throw error;
  }

  const value = crypto.randomBytes(32).toString('hex');
  try {
    fs.writeFileSync(NODE_EVENT_CAPABILITY_SECRET_FILE, `${value}\n`, { flag: 'wx', mode: 0o600 });
    cachedSecret = Buffer.from(value, 'hex');
  } catch (error: any) {
    if (error?.code !== 'EEXIST') throw error;
    const existing = fs.readFileSync(NODE_EVENT_CAPABILITY_SECRET_FILE, 'utf8').trim();
    if (!/^[a-f0-9]{64}$/i.test(existing)) throw new Error('Node event capability secret is malformed.');
    cachedSecret = Buffer.from(existing, 'hex');
  }
  return cachedSecret;
}

function signature(payload: string): Buffer {
  return crypto.createHmac('sha256', loadOrCreateSecret()).update(payload).digest();
}

export function issueRemoteExecCompletionCapability(nodeId: string, sessionId: string, execId: string): string {
  const payload: RemoteExecCompletionCapability = {
    v: 1,
    purpose: 'remote-exec-completion',
    nodeId,
    sessionId,
    execId,
    issuedAt: Date.now(),
  };
  const encoded = Buffer.from(JSON.stringify(payload), 'utf8').toString('base64url');
  return `${encoded}.${signature(encoded).toString('base64url')}`;
}

export function verifyRemoteExecCompletionCapability(
  token: string,
  expected: { nodeId: string; sessionId: string; execId: string },
): boolean {
  if (typeof token !== 'string') return false;
  const [encoded, encodedSignature, extra] = token.split('.');
  if (!encoded || !encodedSignature || extra !== undefined) return false;
  let suppliedSignature: Buffer;
  let payload: RemoteExecCompletionCapability;
  try {
    suppliedSignature = Buffer.from(encodedSignature, 'base64url');
    payload = JSON.parse(Buffer.from(encoded, 'base64url').toString('utf8'));
  } catch {
    return false;
  }
  const expectedSignature = signature(encoded);
  if (suppliedSignature.length !== expectedSignature.length
    || !crypto.timingSafeEqual(suppliedSignature, expectedSignature)) return false;
  return payload?.v === 1
    && payload.purpose === 'remote-exec-completion'
    && payload.nodeId === expected.nodeId
    && payload.sessionId === expected.sessionId
    && payload.execId === expected.execId
    && Number.isFinite(payload.issuedAt);
}

export function setNodeEventCapabilitySecretForTests(secret?: Buffer): void {
  cachedSecret = secret ? Buffer.from(secret) : null;
}