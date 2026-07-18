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
    return {
      namespace: 'node',
      nodeId,
      realPath: `/${realPathSegments.join('/')}`,
    };
  }

  if (uri.authority !== 'node') {
    throw new Error(`Unsupported foxwarm URI authority \`${uri.authority}\`; expected \`node+<nodeId>\`.`);
  }

  const rawSegments = uri.path.split('/').filter(Boolean);
  if (rawSegments.length === 0) {
    throw new Error(`Missing node id in foxwarm URI \`${uri.toString(true)}\`.`);
  }

  const nodeId = decodePathSegment(rawSegments[0]);
  if (!nodeId) {
    throw new Error(`Missing node id in foxwarm URI \`${uri.toString(true)}\`.`);
  }

  const realPathSegments = rawSegments.slice(1).map(decodePathSegment);
  const realPath = `/${realPathSegments.join('/')}`;

  return {
    namespace: 'node',
    nodeId,
    realPath,
  };
}

export function getWorkspaceTerminalTarget(workspaceFolders: readonly { uri: UriLike }[] | undefined): FoxwarmUriTarget {
  const folder = workspaceFolders?.[0];
  if (!folder) {
    return { namespace: 'node', nodeId: 'master', realPath: '/' };
  }
  return parseFoxwarmUri(folder.uri);
}
