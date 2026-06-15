import crypto from 'crypto';
import path from 'path';
import { STATE_DIR } from './config';
import { DiskJsonData } from './utils/diskJsonData';

export type WebUiGuestTokenRecord = {
  tokenId: string;
  tokenHash: string;
  sessionIds: string[];
  label?: string;
  createdAt: number;
  expiresAt?: number;
  revokedAt?: number;
};

export type WebUiGuestTokensStore = {
  tokens: Record<string, WebUiGuestTokenRecord>;
};

export type VerifiedWebUiGuestToken = {
  role: 'guest';
  tokenId: string;
  sessionIds: string[];
  label?: string;
  expiresAt?: number;
};

export type CreateWebUiGuestTokenOptions = {
  sessionIds: string[];
  label?: string;
  expiresAt?: number;
  now?: number;
};

export type WebUiGuestTokenStoreOptions = {
  storePath?: string;
};

const TOKEN_PREFIX = 'fwg';
const TOKEN_ID_BYTES = 9;
const TOKEN_SECRET_BYTES = 32;
const HASH_PREFIX = 'sha256:';
let storePathOverrideForTests: string | undefined;

function createStore(filePath: string): DiskJsonData<WebUiGuestTokensStore> {
  return new DiskJsonData<WebUiGuestTokensStore>(filePath, {
    backup: { rotate: 2, includeLegacyBak: true, bestEffort: true },
    normalizeLoadedData: normalizeWebUiGuestTokensPayload,
  });
}

export function getWebUiGuestTokensPath(stateDir: string = STATE_DIR): string {
  return path.join(stateDir, 'webui-guest-tokens.json');
}

export function setWebUiGuestTokenStorePathForTests(storePath: string | undefined): void {
  storePathOverrideForTests = storePath;
}

function resolveStorePath(options: WebUiGuestTokenStoreOptions = {}): string {
  return options.storePath || storePathOverrideForTests || getWebUiGuestTokensPath();
}

function normalizeSessionIds(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const seen = new Set<string>();
  const result: string[] = [];
  for (const item of input) {
    const value = typeof item === 'string' ? item.trim() : '';
    if (!value || seen.has(value)) continue;
    seen.add(value);
    result.push(value);
  }
  return result;
}

function normalizeOptionalTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && value > 0 ? value : undefined;
}

export function normalizeWebUiGuestTokensPayload(raw: any): WebUiGuestTokensStore {
  const tokens: Record<string, WebUiGuestTokenRecord> = {};
  const rawTokens = raw?.tokens && typeof raw.tokens === 'object' && !Array.isArray(raw.tokens) ? raw.tokens : {};

  for (const [rawId, rawRecord] of Object.entries(rawTokens)) {
    if (!rawRecord || typeof rawRecord !== 'object' || Array.isArray(rawRecord)) continue;
    const record = rawRecord as Partial<WebUiGuestTokenRecord>;
    const tokenId = typeof record.tokenId === 'string' && record.tokenId.trim()
      ? record.tokenId.trim()
      : String(rawId).trim();
    const tokenHash = typeof record.tokenHash === 'string' ? record.tokenHash.trim() : '';
    const sessionIds = normalizeSessionIds(record.sessionIds);
    const createdAt = typeof record.createdAt === 'number' && Number.isFinite(record.createdAt) && record.createdAt > 0
      ? record.createdAt
      : Date.now();

    if (!tokenId || !tokenHash.startsWith(HASH_PREFIX) || sessionIds.length === 0) continue;

    const normalized: WebUiGuestTokenRecord = {
      tokenId,
      tokenHash,
      sessionIds,
      createdAt,
    };

    if (typeof record.label === 'string' && record.label.trim()) {
      normalized.label = record.label.trim();
    }
    const expiresAt = normalizeOptionalTimestamp(record.expiresAt);
    if (expiresAt !== undefined) normalized.expiresAt = expiresAt;
    const revokedAt = normalizeOptionalTimestamp(record.revokedAt);
    if (revokedAt !== undefined) normalized.revokedAt = revokedAt;

    tokens[tokenId] = normalized;
  }

  return { tokens };
}

async function loadWebUiGuestTokensStore(options: WebUiGuestTokenStoreOptions = {}): Promise<WebUiGuestTokensStore> {
  const store = createStore(resolveStorePath(options));
  const loaded = await store.loadFirstAvailable();
  return loaded?.data || { tokens: {} };
}

async function saveWebUiGuestTokensStore(data: WebUiGuestTokensStore, options: WebUiGuestTokenStoreOptions = {}): Promise<void> {
  const store = createStore(resolveStorePath(options));
  await store.write(normalizeWebUiGuestTokensPayload(data));
}

function randomTokenPart(bytes: number): string {
  return crypto.randomBytes(bytes).toString('base64url');
}

function randomTokenId(bytes: number): string {
  return crypto.randomBytes(bytes).toString('hex');
}

function hashToken(token: string): string {
  return `${HASH_PREFIX}${crypto.createHash('sha256').update(token, 'utf8').digest('hex')}`;
}

function parseGuestToken(token: string): { tokenId: string } | null {
  const match = token.match(/^fwg_([A-Fa-f0-9]+)_([A-Za-z0-9_-]+)$/);
  if (!match) return null;
  return { tokenId: match[1] };
}

function safeHashEquals(a: string, b: string): boolean {
  const aBuffer = Buffer.from(a, 'utf8');
  const bBuffer = Buffer.from(b, 'utf8');
  if (aBuffer.length !== bBuffer.length) return false;
  return crypto.timingSafeEqual(aBuffer, bBuffer);
}

export async function createWebUiGuestToken(
  options: CreateWebUiGuestTokenOptions,
  storeOptions: WebUiGuestTokenStoreOptions = {},
): Promise<{ token: string; record: WebUiGuestTokenRecord }> {
  const sessionIds = normalizeSessionIds(options.sessionIds);
  if (sessionIds.length === 0) {
    throw new Error('At least one sessionId is required for a guest token.');
  }

  const now = typeof options.now === 'number' && Number.isFinite(options.now) ? options.now : Date.now();
  if (options.expiresAt !== undefined && (!Number.isFinite(options.expiresAt) || options.expiresAt <= now)) {
    throw new Error('expiresAt must be a future timestamp when provided.');
  }

  const data = await loadWebUiGuestTokensStore(storeOptions);
  let tokenId = '';
  for (let attempt = 0; attempt < 16; attempt += 1) {
    const candidate = randomTokenId(TOKEN_ID_BYTES);
    if (!data.tokens[candidate]) {
      tokenId = candidate;
      break;
    }
  }
  if (!tokenId) {
    throw new Error('Unable to allocate a unique guest token id.');
  }

  const secret = randomTokenPart(TOKEN_SECRET_BYTES);
  const token = `${TOKEN_PREFIX}_${tokenId}_${secret}`;
  const record: WebUiGuestTokenRecord = {
    tokenId,
    tokenHash: hashToken(token),
    sessionIds,
    createdAt: now,
  };
  if (typeof options.label === 'string' && options.label.trim()) {
    record.label = options.label.trim();
  }
  if (options.expiresAt !== undefined) {
    record.expiresAt = options.expiresAt;
  }

  data.tokens[tokenId] = record;
  await saveWebUiGuestTokensStore(data, storeOptions);
  return { token, record };
}

export async function verifyWebUiGuestToken(
  token: string | undefined | null,
  storeOptions: WebUiGuestTokenStoreOptions = {},
  now: number = Date.now(),
): Promise<VerifiedWebUiGuestToken | null> {
  const rawToken = typeof token === 'string' ? token.trim() : '';
  if (!rawToken) return null;
  const parsed = parseGuestToken(rawToken);
  if (!parsed) return null;

  const data = await loadWebUiGuestTokensStore(storeOptions);
  const record = data.tokens[parsed.tokenId];
  if (!record) return null;
  if (record.revokedAt) return null;
  if (record.expiresAt && record.expiresAt <= now) return null;
  if (!safeHashEquals(record.tokenHash, hashToken(rawToken))) return null;

  return {
    role: 'guest',
    tokenId: record.tokenId,
    sessionIds: [...record.sessionIds],
    ...(record.label ? { label: record.label } : {}),
    ...(record.expiresAt ? { expiresAt: record.expiresAt } : {}),
  };
}

export async function revokeWebUiGuestToken(
  tokenId: string,
  storeOptions: WebUiGuestTokenStoreOptions = {},
  now: number = Date.now(),
): Promise<boolean> {
  const data = await loadWebUiGuestTokensStore(storeOptions);
  const record = data.tokens[tokenId];
  if (!record) return false;
  if (!record.revokedAt) {
    record.revokedAt = now;
    await saveWebUiGuestTokensStore(data, storeOptions);
  }
  return true;
}

export async function listWebUiGuestTokens(storeOptions: WebUiGuestTokenStoreOptions = {}): Promise<WebUiGuestTokenRecord[]> {
  const data = await loadWebUiGuestTokensStore(storeOptions);
  return Object.values(data.tokens).map(record => ({ ...record, sessionIds: [...record.sessionIds] }));
}
