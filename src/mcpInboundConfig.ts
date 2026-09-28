import { createHash, timingSafeEqual } from 'node:crypto';

export type McpInboundIdentity = { token: string };
export type McpInboundConfig = {
  enabled?: boolean;
  identities?: Record<string, McpInboundIdentity>;
};
export type NormalizedMcpInboundConfig = {
  enabled: boolean;
  identities: Record<string, McpInboundIdentity>;
};

const MAX_IDENTITIES = 64;
const MAX_TOKEN_BYTES = 4096;
const EXTERNAL_ID = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const BEARER_TOKEN = /^[A-Za-z0-9._~+/-]+={0,2}$/;
const verifiedPrincipals = new WeakSet<object>();
const verifiedBrand: unique symbol = Symbol('mcpInboundVerifiedPrincipal');

export type VerifiedMcpInboundPrincipal = Readonly<{
  externalId: string;
  [verifiedBrand]: true;
}>;

function plainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const proto = Object.getPrototypeOf(value);
  return proto === Object.prototype || proto === null;
}

/** Validate the whole block even while disabled, without echoing secret-bearing input in errors. */
export function normalizeMcpInboundConfig(value: unknown): NormalizedMcpInboundConfig {
  if (value === undefined) return { enabled: false, identities: {} };
  if (!plainRecord(value)) throw new Error('mcpInbound must be a YAML object.');
  if (Object.keys(value).some(key => !['enabled', 'identities'].includes(key))) {
    throw new Error('mcpInbound contains an unsupported field.');
  }
  if (value.enabled !== undefined && typeof value.enabled !== 'boolean') {
    throw new Error('mcpInbound.enabled must be a boolean.');
  }
  const enabled = value.enabled === true;
  if (value.identities !== undefined && !plainRecord(value.identities)) {
    throw new Error('mcpInbound.identities must be a YAML object.');
  }
  const entries = Object.entries(value.identities || {});
  if (entries.length > MAX_IDENTITIES) throw new Error(`mcpInbound.identities exceeds ${MAX_IDENTITIES} entries.`);
  if (enabled && entries.length === 0) throw new Error('Enabled mcpInbound requires at least one identity.');

  const identities: Record<string, McpInboundIdentity> = Object.create(null);
  const tokenDigests: Buffer[] = [];
  for (const [externalId, raw] of entries) {
    if (!EXTERNAL_ID.test(externalId)) throw new Error('mcpInbound identity ID is invalid.');
    if (!plainRecord(raw) || Object.keys(raw).some(key => key !== 'token')) {
      throw new Error('mcpInbound identity must be an object containing only token.');
    }
    const token = raw.token;
    if (typeof token !== 'string' || token.length === 0
      || Buffer.byteLength(token, 'utf8') > MAX_TOKEN_BYTES || !BEARER_TOKEN.test(token)) {
      throw new Error('mcpInbound identity token must be a non-empty bounded Bearer token string.');
    }
    const digest = createHash('sha256').update(token).digest();
    if (tokenDigests.some(existing => timingSafeEqual(existing, digest))) {
      throw new Error('mcpInbound identities must use distinct tokens.');
    }
    tokenDigests.push(digest);
    identities[externalId] = { token };
  }
  return { enabled, identities };
}

/** Only a verified HTTP Authorization header supplies an external ID; no cookie or instance-token fallback. */
export function authenticateMcpInboundBearer(
  config: NormalizedMcpInboundConfig,
  authorization: string | string[] | undefined,
): VerifiedMcpInboundPrincipal | null {
  if (!config.enabled || typeof authorization !== 'string') return null;
  const match = /^Bearer ([A-Za-z0-9._~+/-]+={0,2})$/i.exec(authorization);
  if (!match) return null;
  const providedDigest = createHash('sha256').update(match[1]).digest();
  let externalId: string | null = null;
  for (const [id, entry] of Object.entries(config.identities)) {
    const candidateDigest = createHash('sha256').update(entry.token).digest();
    if (timingSafeEqual(candidateDigest, providedDigest)) externalId = id;
  }
  if (externalId === null) return null;
  const principal = Object.freeze({ externalId, [verifiedBrand]: true as const });
  verifiedPrincipals.add(principal);
  return principal;
}

export function requireVerifiedMcpInboundExternalId(principal: VerifiedMcpInboundPrincipal): string {
  if (!principal || !verifiedPrincipals.has(principal)) throw new Error('Verified MCP inbound identity is required.');
  return principal.externalId;
}
