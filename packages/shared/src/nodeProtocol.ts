export type NodeProtocolRange = Readonly<{ min: number; max: number }>;

export type NodeProtocolCompatibility = {
  status: 'compatible' | 'upgrade-required';
  client: NodeProtocolRange;
  master: NodeProtocolRange;
  legacyClient: boolean;
  negotiated?: number;
};

export const LEGACY_NODE_PROTOCOL_RANGE: NodeProtocolRange = Object.freeze({ min: 1, max: 1 });
export const CURRENT_NODE_PROTOCOL_RANGE: NodeProtocolRange = Object.freeze({ min: 1, max: 2 });

export function normalizeNodeProtocolRange(value: unknown, label = 'nodeProtocol'): NodeProtocolRange {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object with integer min and max fields.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const enumerableKeys = Object.entries(descriptors).filter(([, descriptor]) => descriptor.enumerable).map(([key]) => key);
  if (enumerableKeys.some(key => key !== 'min' && key !== 'max')) {
    throw new Error(`${label} contains unsupported fields.`);
  }
  const read = (key: 'min' | 'max'): unknown => {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor)) throw new Error(`${label}.${key} is required.`);
    return descriptor.value;
  };
  const min = read('min');
  const max = read('max');
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || Number(min) < 1 || Number(max) < Number(min) || Number(max) > 1_000_000) {
    throw new Error(`${label} must satisfy 1 <= min <= max <= 1000000 using safe integers.`);
  }
  return Object.freeze({ min: Number(min), max: Number(max) });
}

export function resolveAdvertisedNodeProtocol(value: unknown): { range: NodeProtocolRange; legacy: boolean } {
  if (value === undefined) return { range: LEGACY_NODE_PROTOCOL_RANGE, legacy: true };
  return { range: normalizeNodeProtocolRange(value), legacy: false };
}

export function negotiateNodeProtocol(
  client: NodeProtocolRange,
  master: NodeProtocolRange = CURRENT_NODE_PROTOCOL_RANGE,
  legacyClient = false,
): NodeProtocolCompatibility {
  const normalizedClient = normalizeNodeProtocolRange(client, 'client node protocol');
  const normalizedMaster = normalizeNodeProtocolRange(master, 'master node protocol');
  const lower = Math.max(normalizedClient.min, normalizedMaster.min);
  const upper = Math.min(normalizedClient.max, normalizedMaster.max);
  if (lower > upper) {
    return { status: 'upgrade-required', client: normalizedClient, master: normalizedMaster, legacyClient };
  }
  return { status: 'compatible', client: normalizedClient, master: normalizedMaster, legacyClient, negotiated: upper };
}

export function describeNodeProtocolCompatibility(compatibility: NodeProtocolCompatibility): string {
  const client = compatibility.legacyClient
    ? `legacy/${compatibility.client.min}`
    : `${compatibility.client.min}-${compatibility.client.max}`;
  const master = `${compatibility.master.min}-${compatibility.master.max}`;
  return compatibility.status === 'compatible'
    ? `Node protocol compatible (client ${client}, Master ${master}, negotiated ${compatibility.negotiated}).`
    : `Node protocol incompatible: client ${client}, Master requires ${master}. Update and restart the Node client.`;
}