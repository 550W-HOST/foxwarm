export type FoxwarmUriTarget = {
  namespace: 'node';
  nodeId: string;
  realPath: string;
};

type UriLike = {
  scheme: string;
  authority: string;
  path: string;
  toString(skipEncoding?: boolean): string;
};

function decodePathSegment(segment: string): string {
  try {
    return decodeURIComponent(segment);
  } catch {
    return segment;
  }
}

export function parseFoxwarmUri(uri: UriLike): FoxwarmUriTarget {
  if (uri.scheme !== 'foxwarm') {
    throw new Error(`Unsupported URI scheme \`${uri.scheme}\`; expected \`foxwarm\`.`);
  }

  if (uri.authority.startsWith('node+')) {
    const nodeId = decodePathSegment(uri.authority.slice('node+'.length));
    if (!nodeId) {
      throw new Error(`Missing node id in foxwarm URI \`${uri.toString(true)}\`.`);
    }
    const realPathSegments = uri.path.split('/').filter(Boolean).map(decodePathSegment);
    return { namespace: 'node', nodeId, realPath: `/${realPathSegments.join('/')}` };
  }

  if (uri.authority !== 'node') {
    throw new Error(`Unsupported foxwarm URI authority \`${uri.authority}\`; expected \`node+<nodeId>\`.`);
  }

  const rawSegments = uri.path.split('/').filter(Boolean);
  if (rawSegments.length === 0) {
    throw new Error(`Missing node id in foxwarm URI \`${uri.toString(true)}\`.`);
  }
  const nodeId = decodePathSegment(rawSegments[0]);
  const realPathSegments = rawSegments.slice(1).map(decodePathSegment);
  return { namespace: 'node', nodeId, realPath: `/${realPathSegments.join('/')}` };
}

export function buildFoxwarmNodeUriString(nodeId: string, realPath: string): string {
  if (!nodeId || nodeId.includes('/')) {
    throw new Error('nodeId must be a non-empty single path segment.');
  }
  if (!realPath.startsWith('/')) {
    throw new Error('realPath must be absolute.');
  }
  const encodedPath = realPath.split('/').map((segment, index) => index === 0 ? '' : encodeURIComponent(segment)).join('/');
  return `foxwarm://node+${encodeURIComponent(nodeId)}${encodedPath}`;
}

export function normalizeGitRelativePath(value: string): string {
  const normalized = value.replace(/\\/g, '/').replace(/^\/+/, '');
  const segments = normalized.split('/').filter(Boolean);
  if (segments.includes('..')) {
    throw new Error('relative path must not contain ..');
  }
  return segments.join('/');
}
