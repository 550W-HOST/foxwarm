import { createHash, timingSafeEqual } from 'node:crypto';

export type AccessWebUiSurface = {
  sessions: string[];
};

export type AccessIdentity = {
  token: string;
  surfaces: {
    webui?: AccessWebUiSurface;
    mcp?: Record<string, never>;
  };
};

export type AccessConfig = {
  identities?: Record<string, {
    token: string;
    surfaces: {
      webui?: { sessions: string[] };
      mcp?: Record<string, never>;
    };
  }>;
};

export type NormalizedAccessIdentity = Readonly<AccessIdentity>;
export type NormalizedAccessConfig = {
  identities: Record<string, NormalizedAccessIdentity>;
};

const MAX_IDENTITIES = 64;
const MAX_TOKEN_BYTES = 4096;
const MAX_SESSION_IDS = 256;
const MAX_SESSION_ID_LENGTH = 512;
const IDENTITY_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+={0,2}$/;
const verifiedPrincipals = new WeakSet<object>();
const verifiedBrand: unique symbol = Symbol('verifiedAccessIdentity');

export type VerifiedAccessIdentity = Readonly<{
  identityId: string;
  /** Policy rules retain the externalId name; it is exactly this identity ID. */
  externalId: string;
  surfaces: NormalizedAccessIdentity['surfaces'];
  [verifiedBrand]: true;
}>;

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** The only supported scope pattern is an exact Agent name followed by /*. */
export function webUiScopeAgent(binding: string): string | undefined {
  return /^([A-Za-z0-9_-]+)\/\*$/.exec(binding)?.[1];
}

function normalizeSessionIds(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0 || value.length > MAX_SESSION_IDS) {
    throw new Error('access identity webui.sessions must be a non-empty array of Session IDs.');
  }
  const sessions: string[] = [];
  const seen = new Set<string>();
  for (const sessionId of value) {
    if (typeof sessionId !== 'string' || !sessionId.trim() || sessionId.length > MAX_SESSION_ID_LENGTH
      || (sessionId.includes('*') && webUiScopeAgent(sessionId) === undefined)) {
      throw new Error('access identity webui.sessions contains an invalid Session ID.');
    }
    if (seen.has(sessionId)) throw new Error('access identity webui.sessions must contain distinct Session IDs.');
    seen.add(sessionId);
    sessions.push(sessionId);
  }
  return sessions;
}

/** Validate the whole access block without echoing secret-bearing input in errors. */
export function normalizeAccessConfig(value: unknown): NormalizedAccessConfig {
  if (value === undefined) return { identities: {} };
  if (!plainRecord(value)) throw new Error('access must be a YAML object.');
  if (Object.keys(value).some(key => key !== 'identities')) {
    throw new Error('access contains an unsupported field.');
  }
  if (value.identities !== undefined && !plainRecord(value.identities)) {
    throw new Error('access.identities must be a YAML object.');
  }

  const entries = Object.entries(value.identities || {});
  if (entries.length > MAX_IDENTITIES) throw new Error(`access.identities exceeds ${MAX_IDENTITIES} entries.`);

  const identities: Record<string, NormalizedAccessIdentity> = Object.create(null);
  const tokenDigests: Buffer[] = [];
  for (const [identityId, raw] of entries) {
    if (!IDENTITY_ID.test(identityId)) throw new Error('access identity ID is invalid.');
    if (!plainRecord(raw) || Object.keys(raw).some(key => !['token', 'surfaces'].includes(key))) {
      throw new Error('access identity must contain only token and surfaces.');
    }
    const token = raw.token;
    if (typeof token !== 'string' || token.length === 0
      || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES || !BEARER_TOKEN.test(token)) {
      throw new Error('access identity token must be a non-empty bounded Bearer token string.');
    }
    const digest = createHash('sha256').update(token).digest();
    if (tokenDigests.some(existing => timingSafeEqual(existing, digest))) {
      throw new Error('access identities must use distinct tokens.');
    }
    tokenDigests.push(digest);

    const surfacesRaw = raw.surfaces;
    if (!plainRecord(surfacesRaw)) throw new Error('access identity surfaces must be a YAML object.');
    if (Object.keys(surfacesRaw).some(key => !['webui', 'mcp'].includes(key))) {
      throw new Error('access identity surfaces contains an unsupported field.');
    }
    const hasWebUi = surfacesRaw.webui !== undefined;
    const hasMcp = surfacesRaw.mcp !== undefined;
    if (!hasWebUi && !hasMcp) throw new Error('access identity must enable at least one surface.');

    let webui: AccessWebUiSurface | undefined;
    if (hasWebUi) {
      if (!plainRecord(surfacesRaw.webui) || Object.keys(surfacesRaw.webui).some(key => key !== 'sessions')) {
        throw new Error('access identity surfaces.webui must contain only sessions.');
      }
      webui = { sessions: normalizeSessionIds(surfacesRaw.webui.sessions) };
    }

    let mcp: Record<string, never> | undefined;
    if (hasMcp) {
      if (!plainRecord(surfacesRaw.mcp) || Object.keys(surfacesRaw.mcp).length > 0) {
        throw new Error('access identity surfaces.mcp must be an empty object.');
      }
      mcp = {};
    }

    identities[identityId] = Object.freeze({
      token,
      surfaces: Object.freeze({
        ...(webui ? { webui: Object.freeze(webui) } : {}),
        ...(mcp ? { mcp: Object.freeze(mcp) } : {}),
      }),
    });
  }
  return { identities };
}

export function assertAccessTokensDoNotMatch(config: NormalizedAccessConfig, reservedToken: string): void {
  if (typeof reservedToken !== 'string' || reservedToken.length === 0) return;
  const reservedDigest = createHash('sha256').update(reservedToken).digest();
  for (const identity of Object.values(config.identities)) {
    const identityDigest = createHash('sha256').update(identity.token).digest();
    if (timingSafeEqual(identityDigest, reservedDigest)) {
      throw new Error('access identity tokens must not reuse the instance superuser token.');
    }
  }
}

export function hasAccessSurface(config: NormalizedAccessConfig, surface: 'webui' | 'mcp'): boolean {
  return Object.values(config.identities).some(identity => identity.surfaces[surface] !== undefined);
}

export function accessIdentityHasSurface(identity: NormalizedAccessIdentity, surface: 'webui' | 'mcp'): boolean {
  return identity.surfaces[surface] !== undefined;
}

/** Verify one configured identity for one transport surface. */
export function authenticateAccessToken(
  config: NormalizedAccessConfig,
  token: string | undefined,
  surface: 'webui' | 'mcp',
): VerifiedAccessIdentity | null {
  if (typeof token !== 'string' || token.length === 0) return null;
  const providedDigest = createHash('sha256').update(token).digest();
  let matched: [string, NormalizedAccessIdentity] | null = null;
  for (const [identityId, identity] of Object.entries(config.identities)) {
    if (!accessIdentityHasSurface(identity, surface)) continue;
    const candidateDigest = createHash('sha256').update(identity.token).digest();
    if (timingSafeEqual(candidateDigest, providedDigest)) matched = [identityId, identity];
  }
  if (!matched) return null;
  const [identityId, identity] = matched;
  const principal = Object.freeze({
    identityId,
    externalId: identityId,
    surfaces: identity.surfaces,
    [verifiedBrand]: true as const,
  });
  verifiedPrincipals.add(principal);
  return principal;
}

/** Strict Bearer-only authentication for inbound MCP. */
export function authenticateAccessBearer(
  config: NormalizedAccessConfig,
  authorization: string | string[] | undefined,
  surface: 'mcp' = 'mcp',
): VerifiedAccessIdentity | null {
  if (Array.isArray(authorization) || typeof authorization !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9._~+/-]+={0,2})$/i.exec(authorization);
  return match ? authenticateAccessToken(config, match[1], surface) : null;
}

export function requireVerifiedAccessIdentity(principal: VerifiedAccessIdentity): string {
  if (!principal || !verifiedPrincipals.has(principal)) throw new Error('Verified access identity is required.');
  return principal.externalId;
}
