/** Native identities remain unqualified; executable-provider identities have one namespace segment. */
export const MAX_CORE_NODE_ID_LENGTH = 193;
export function isCoreNodeId(value: unknown): value is string {
  return typeof value === 'string' && value.length <= MAX_CORE_NODE_ID_LENGTH
    && /^(?:[A-Za-z0-9][A-Za-z0-9._:-]{0,63}\/)?[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/.test(value);
}

export function splitProviderNodeId(nodeId: string): { providerId: string; localId: string } | undefined {
  if (!isCoreNodeId(nodeId)) return undefined;
  const separator = nodeId.indexOf('/');
  return separator < 0 ? undefined : { providerId: nodeId.slice(0, separator), localId: nodeId.slice(separator + 1) };
}
