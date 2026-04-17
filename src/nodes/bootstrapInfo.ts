import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { HTTP_PORT, NODE_TOKEN_FILE } from '../config';

export interface NodeBootstrapInfoOptions {
  pairingToken: string;
  baseUrl?: string;
  includeExamples?: boolean;
}

export interface NodeBootstrapInfo {
  pairingToken: string;
  baseUrl: {
    providedBaseUrl: string | null;
    normalizedBaseUrl: string | null;
    requestDerivedDefaultBaseUrl: string | null;
    requestDerivedDefaultBaseUrlStatus: 'resolved-from-provided-base-url' | 'unresolved-in-tool-context';
    canSystemKnowUniqueExternalBaseUrl: false;
    explanation: string;
    overrideHint: string;
  };
  endpoints: {
    runShPath: string;
    runDockerShPath: string;
    runInteractiveShPath: string;
    runPs1Path: string;
    composePath: string;
    sourcePath: string;
    runShUrl: string | null;
    runDockerShUrl: string | null;
    runInteractiveShUrl: string | null;
    runPs1Url: string | null;
    composeUrl: string | null;
    sourceUrl: string | null;
  };
  examples?: {
    chooseBaseUrl: string;
    bareMetal: string;
    docker: string;
    interactive: string;
    explicitHostOverride: string;
    manualCompose: string;
  };
}

function stripTrailingSlashes(value: string): string {
  return value.replace(/\/+$/, '');
}

export function normalizeNodeBootstrapBaseUrl(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  if (!trimmed) return undefined;

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('baseUrl must be an absolute URL such as http://HOST:PORT or https://DOMAIN');
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error('baseUrl must use http:// or https://');
  }

  return stripTrailingSlashes(parsed.toString());
}

function buildEndpointUrls(baseUrl?: string) {
  const runShPath = '/node/run.sh';
  const runDockerShPath = '/node/run-docker.sh';
  const runInteractiveShPath = '/node/run-interactive.sh';
  const runPs1Path = '/node/run.ps1';
  const composePath = '/node/docker-compose.yaml';
  const sourcePath = '/node/source.tar.gz';

  return {
    runShPath,
    runDockerShPath,
    runInteractiveShPath,
    runPs1Path,
    composePath,
    sourcePath,
    runShUrl: baseUrl ? `${baseUrl}${runShPath}` : null,
    runDockerShUrl: baseUrl ? `${baseUrl}${runDockerShPath}` : null,
    runInteractiveShUrl: baseUrl ? `${baseUrl}${runInteractiveShPath}` : null,
    runPs1Url: baseUrl ? `${baseUrl}${runPs1Path}` : null,
    composeUrl: baseUrl ? `${baseUrl}${composePath}` : null,
    sourceUrl: baseUrl ? `${baseUrl}${sourcePath}` : null,
  };
}

export function buildNodeBootstrapInfo(options: NodeBootstrapInfoOptions): NodeBootstrapInfo {
  const normalizedBaseUrl = normalizeNodeBootstrapBaseUrl(options.baseUrl);
  const includeExamples = options.includeExamples !== false;
  const endpoints = buildEndpointUrls(normalizedBaseUrl);
  const exampleBaseUrl = normalizedBaseUrl || `http://YOUR_MASTER:${HTTP_PORT}`;

  const info: NodeBootstrapInfo = {
    pairingToken: options.pairingToken,
    baseUrl: {
      providedBaseUrl: options.baseUrl?.trim() || null,
      normalizedBaseUrl: normalizedBaseUrl || null,
      requestDerivedDefaultBaseUrl: normalizedBaseUrl || null,
      requestDerivedDefaultBaseUrlStatus: normalizedBaseUrl
        ? 'resolved-from-provided-base-url'
        : 'unresolved-in-tool-context',
      canSystemKnowUniqueExternalBaseUrl: false,
      explanation: normalizedBaseUrl
        ? 'Tool calls do not carry the original bootstrap HTTP request. Because you provided a reachable baseUrl, the downloaded bootstrap scripts would use that same URL as their request-derived default host when fetched from it.'
        : 'Tool calls do not carry the original bootstrap HTTP request, so this tool cannot infer a universally correct external base URL by itself. Choose a reachable master URL from the node\'s point of view and, if desired, call this tool again with baseUrl set to that URL.',
      overrideHint: 'If the script is fetched through one address but the node should connect through another reachable address, pass --host=... explicitly when running the script.',
    },
    endpoints,
  };

  if (includeExamples) {
    info.examples = {
      chooseBaseUrl: `BASE_URL=${exampleBaseUrl}`,
      bareMetal: `curl -fsSL \"${normalizedBaseUrl || '$BASE_URL'}/node/run.sh\" | bash -s -- \\\n+  --pairing=${options.pairingToken} \\\n+  --node-id=my-node`,
      docker: `curl -fsSL \"${normalizedBaseUrl || '$BASE_URL'}/node/run-docker.sh\" | bash -s -- \\\n+  --pairing=${options.pairingToken} \\\n+  --node-id=my-node`,
      interactive: `curl -fsSL \"${normalizedBaseUrl || '$BASE_URL'}/node/run-interactive.sh\" | bash -s -- \\\n+  --pairing=${options.pairingToken} \\\n+  --node-id=my-interactive-node`,
      explicitHostOverride: `curl -fsSL \"http://127.0.0.1:${HTTP_PORT}/node/run.sh\" | bash -s -- \\\n+  --host=${exampleBaseUrl} \\\n+  --pairing=${options.pairingToken} \\\n+  --node-id=my-node`,
      manualCompose: `curl -fsSL \"${normalizedBaseUrl || '$BASE_URL'}/node/docker-compose.yaml\" -o docker-compose.yaml\ncat > .env <<'EOF'\nNODE_HOST=${normalizedBaseUrl || '$BASE_URL'}\nNODE_SOURCE_URL=${normalizedBaseUrl || '$BASE_URL'}/node/source.tar.gz\nNODE_PAIRING_TOKEN=${options.pairingToken}\nNODE_ID=my-node\nNODE_DATA_DIR=./data\nEOF\n\ndocker compose up -d --build`,
    };
  }

  return info;
}

export async function ensureNodePairingToken(): Promise<string> {
  try {
    const token = await fs.readFile(NODE_TOKEN_FILE, 'utf8');
    return token.trim();
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      const token = crypto.randomBytes(32).toString('hex');
      await fs.ensureDir(path.dirname(NODE_TOKEN_FILE));
      await fs.writeFile(NODE_TOKEN_FILE, token);
      return token;
    }
    throw err;
  }
}