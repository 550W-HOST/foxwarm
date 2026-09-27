import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { HTTP_PORT, NODE_TOKEN_FILE } from '../config';

export const NODE_BOOTSTRAP_BASE_URL_PLACEHOLDER = '$BASE_URL';

export interface NodeBootstrapInfoOptions {
  pairingToken: string;
}

export interface NodeBootstrapInfo {
  pairingToken: string;
  baseUrl: {
    placeholder: '$BASE_URL';
    shellAssignmentExample: string;
    requestDerivedDefaultInDownloadedScripts: '$BASE_URL';
    canSystemKnowUniqueExternalBaseUrl: false;
    explanation: string;
    operatorAction: string;
    overrideHint: string;
  };
  endpoints: {
    runShPath: string;
    runDockerShPath: string;
    runInteractiveShPath: string;
    runPs1Path: string;
    composePath: string;
    sourcePath: string;
    runShUrl: string;
    runDockerShUrl: string;
    runInteractiveShUrl: string;
    runPs1Url: string;
    composeUrl: string;
    sourceUrl: string;
  };
  examples: {
    chooseBaseUrl: string;
    bareMetal: string;
    bareMetalBackground: string;
    bareMetalInstall: string;
    docker: string;
    interactive: string;
    explicitHostOverride: string;
    manualCompose: string;
  };
}

function buildEndpointUrls(baseUrlPlaceholder: string) {
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
    runShUrl: `${baseUrlPlaceholder}${runShPath}`,
    runDockerShUrl: `${baseUrlPlaceholder}${runDockerShPath}`,
    runInteractiveShUrl: `${baseUrlPlaceholder}${runInteractiveShPath}`,
    runPs1Url: `${baseUrlPlaceholder}${runPs1Path}`,
    composeUrl: `${baseUrlPlaceholder}${composePath}`,
    sourceUrl: `${baseUrlPlaceholder}${sourcePath}`,
  };
}

export function buildNodeBootstrapInfo(options: NodeBootstrapInfoOptions): NodeBootstrapInfo {
  const endpoints = buildEndpointUrls(NODE_BOOTSTRAP_BASE_URL_PLACEHOLDER);

  return {
    pairingToken: options.pairingToken,
    baseUrl: {
      placeholder: NODE_BOOTSTRAP_BASE_URL_PLACEHOLDER,
      shellAssignmentExample: `BASE_URL=http://YOUR_MASTER:${HTTP_PORT}`,
      requestDerivedDefaultInDownloadedScripts: NODE_BOOTSTRAP_BASE_URL_PLACEHOLDER,
      canSystemKnowUniqueExternalBaseUrl: false,
      explanation: 'Foxwarm cannot reliably know one universally correct external master URL for every node. The reachable URL depends on where the node runs: localhost, LAN IP, Docker host IP, reverse-proxy domain, and so on. This tool therefore uses $BASE_URL as an explicit placeholder instead of pretending to know the unique correct address.',
      operatorAction: 'Choose BASE_URL from the node\'s point of view before running the bootstrap commands below.',
      overrideHint: 'If you fetch a bootstrap script through one address but the node should connect through another, pass --host="$BASE_URL" explicitly when running the script.',
    },
    endpoints,
    examples: {
      chooseBaseUrl: `BASE_URL=http://YOUR_MASTER:${HTTP_PORT}`,
      bareMetal: `curl -fsSL "$BASE_URL/node/run.sh" | bash -s -- \\
  --dir=/opt/foxwarm-node \\
  --pairing=${options.pairingToken} \\
  --node-id=my-node`,
      bareMetalBackground: `curl -fsSL "$BASE_URL/node/run.sh" | bash -s -- \\
  --dir=/opt/foxwarm-node \\
  --pairing=${options.pairingToken} \\
  --node-id=my-node \\
  -d`,
      bareMetalInstall: `curl -fsSL "$BASE_URL/node/run.sh" | bash -s -- \\
  --dir=/opt/foxwarm-node \\
  --pairing=${options.pairingToken} \\
  --node-id=my-node \\
  --install`,
      docker: `curl -fsSL "$BASE_URL/node/run-docker.sh" | bash -s -- \\
  --pairing=${options.pairingToken} \\
  --node-id=my-node`,
      interactive: `curl -fsSL "$BASE_URL/node/run-interactive.sh" | bash -s -- \\
  --pairing=${options.pairingToken} \\
  --node-id=my-cli-node`,
      explicitHostOverride: `curl -fsSL "http://127.0.0.1:${HTTP_PORT}/node/run.sh" | bash -s -- \\
  --dir=/opt/foxwarm-node \\
  --host="$BASE_URL" \\
  --pairing=${options.pairingToken} \\
  --node-id=my-node`,
      manualCompose: `curl -fsSL "$BASE_URL/node/docker-compose.yaml" -o docker-compose.yaml\ncat > .env <<'EOF'\nNODE_HOST=$BASE_URL\nNODE_SOURCE_URL=$BASE_URL/node/source.tar.gz\nNODE_PAIRING_TOKEN=${options.pairingToken}\nNODE_ID=my-node\nNODE_DATA_DIR=./data\nEOF\n\ndocker compose up -d --build`,
    },
  };
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
