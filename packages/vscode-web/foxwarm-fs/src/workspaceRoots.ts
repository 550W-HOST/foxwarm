import { parseFoxwarmUri } from './foxwarmUri';
import { normalizeFoxwarmAbsolutePath } from './openRequest';

export type FoxwarmWorkspaceRootKind = 'app' | 'data';

export type FoxwarmWorkspaceRoot = {
  kind: FoxwarmWorkspaceRootKind;
  nodeId: 'master';
  path: string;
  name: string;
};

export type FoxwarmConfigFileKind = 'app' | 'models';

export type FoxwarmConfigFile = {
  kind: FoxwarmConfigFileKind;
  nodeId: 'master';
  path: string;
};

type UriLike = Parameters<typeof parseFoxwarmUri>[0];

function normalizeRoot(value: unknown, kind: FoxwarmWorkspaceRootKind): Omit<FoxwarmWorkspaceRoot, 'name'> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Foxwarm ${kind} workspace root is missing.`);
  }
  const root = value as Record<string, unknown>;
  if (root.nodeId !== 'master') {
    throw new Error(`Foxwarm ${kind} workspace root must use the master node.`);
  }
  return {
    kind,
    nodeId: 'master',
    path: normalizeFoxwarmAbsolutePath(root.path),
  };
}

function normalizeConfigFile(value: unknown, kind: FoxwarmConfigFileKind): FoxwarmConfigFile {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`Foxwarm ${kind} config file is missing.`);
  }
  const file = value as Record<string, unknown>;
  if (file.nodeId !== 'master') {
    throw new Error(`Foxwarm ${kind} config file must use the master node.`);
  }
  return {
    kind,
    nodeId: 'master',
    path: normalizeFoxwarmAbsolutePath(file.path),
  };
}

export function normalizeWorkspaceRootsResponse(value: unknown): Record<FoxwarmWorkspaceRootKind, FoxwarmWorkspaceRoot> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Foxwarm workspace roots response.');
  }
  const response = value as Record<string, unknown>;
  if (response.version !== 1 || !response.roots || typeof response.roots !== 'object' || Array.isArray(response.roots)) {
    throw new Error('Unsupported Foxwarm workspace roots response.');
  }
  const roots = response.roots as Record<string, unknown>;
  const app = normalizeRoot(roots.app, 'app');
  const data = normalizeRoot(roots.data, 'data');
  if (app.path === data.path) {
    const sharedName = 'Foxwarm App & Data';
    return {
      app: { ...app, name: sharedName },
      data: { ...data, name: sharedName },
    };
  }
  return {
    app: { ...app, name: 'Foxwarm App' },
    data: { ...data, name: 'Foxwarm Data' },
  };
}

export function normalizeConfigFilesResponse(value: unknown): Record<FoxwarmConfigFileKind, FoxwarmConfigFile> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error('Invalid Foxwarm workspace roots response.');
  }
  const response = value as Record<string, unknown>;
  if (response.version !== 1 || !response.configFiles || typeof response.configFiles !== 'object' || Array.isArray(response.configFiles)) {
    throw new Error('Unsupported Foxwarm config files response.');
  }
  const files = response.configFiles as Record<string, unknown>;
  return {
    app: normalizeConfigFile(files.app, 'app'),
    models: normalizeConfigFile(files.models, 'models'),
  };
}

export function isExactWorkspaceRoot(uri: UriLike, target: { nodeId: string; path: string }): boolean {
  try {
    const parsed = parseFoxwarmUri(uri);
    return parsed.nodeId === target.nodeId
      && normalizeFoxwarmAbsolutePath(parsed.realPath) === normalizeFoxwarmAbsolutePath(target.path);
  } catch {
    return false;
  }
}
