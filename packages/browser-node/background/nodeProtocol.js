export const NODE_PROTOCOL = Object.freeze({ min: 1, max: 2 });
export const LEGACY_NODE_PROTOCOL = Object.freeze({ min: 1, max: 1 });

function readExactDataObject(value, expected, label) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object.`);
  }
  const descriptors = Object.getOwnPropertyDescriptors(value);
  const keys = Object.entries(descriptors).filter(([, descriptor]) => descriptor.enumerable).map(([key]) => key);
  if (keys.length !== expected.length || keys.some(key => !expected.includes(key))) {
    throw new Error(`${label} contains missing or unsupported fields.`);
  }
  return Object.fromEntries(expected.map(key => {
    const descriptor = descriptors[key];
    if (!descriptor || !('value' in descriptor)) throw new Error(`${label}.${key} must be a plain data field.`);
    return [key, descriptor.value];
  }));
}

export function normalizeNodeProtocolRange(value, label = 'nodeProtocol') {
  const { min, max } = readExactDataObject(value, ['min', 'max'], label);
  if (!Number.isSafeInteger(min) || !Number.isSafeInteger(max) || min < 1 || max < min || max > 1_000_000) {
    throw new Error(`${label} must satisfy 1 <= min <= max <= 1000000 using safe integers.`);
  }
  return Object.freeze({ min, max });
}

export function resolveMasterNodeProtocol(nodeProtocol) {
  if (nodeProtocol === undefined) {
    return { master: LEGACY_NODE_PROTOCOL, negotiated: 1, legacy: true };
  }
  const fields = readExactDataObject(nodeProtocol, ['master', 'negotiated'], 'nodeProtocol');
  const master = normalizeNodeProtocolRange(fields.master, 'nodeProtocol.master');
  const negotiated = fields.negotiated;
  if (!Number.isSafeInteger(negotiated) || negotiated < 1 || negotiated > 1_000_000) {
    throw new Error('nodeProtocol.negotiated must be a safe integer between 1 and 1000000.');
  }
  const lower = Math.max(NODE_PROTOCOL.min, master.min);
  const upper = Math.min(NODE_PROTOCOL.max, master.max);
  if (lower > upper || negotiated !== upper) {
    throw new Error('Master Node protocol selection is incompatible or not the newest shared generation.');
  }
  return { master, negotiated, legacy: false };
}
