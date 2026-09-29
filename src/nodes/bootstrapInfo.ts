import crypto from 'crypto';
import fs from 'fs-extra';
import path from 'path';
import { HTTP_PORT, NODE_TOKEN_FILE, PUBLIC_BASE_URL } from '../config';

export const NODE_BOOTSTRAP_BASE_URL_PLACEHOLDER = '$BASE_URL';

export interface NodeBootstrapInfoOptions {
  pairingToken: string;
  publicUrl?: string;
}

export interface NodeBootstrapInfo {
  pairingToken: string;
  baseUrl: {
    placeholder: '$BASE_URL';
    configuredUrl?: string;
    shellAssignmentExample: string;
    requestDerivedDefaultInDownloadedScripts: '$BASE_URL';
    canSystemKnowUniqueExternalBaseUrl: false;
    explanation: string;
    operatorAction: string;
    overrideHint: string;
  };
  endpoints: {
    runShellShPath: string;
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
    runShellShUrl: string;
  };
  examples: {
    shell: string;
    chooseBaseUrl: string;
    bareMetal: string;
    bareMetalBackground: string;
    bareMetalInstall: string;
    docker: string;
    interactive: string;
    explicitHostOverride: string;
    manualCompose: string;
    windows: string;
  };
}

function shellCommand(lines: string[]): string {
  return lines.join(' \\\n');
}

function shellQuote(value: string): string {
  return `'${value.replace(/'/g, `'"'"'`)}'`;
}

function powershellQuote(value: string): string {
  return `'${value.replace(/'/g, "''")}'`;
}

/** Generate a Compose .env without re-interpreting a URL path as interpolation. */
export function buildNodeManualComposeExample(pairingToken: string): string {
  return [
    'curl -fsSL "$BASE_URL/node/docker-compose.yaml" -o docker-compose.yaml',
    String.raw`COMPOSE_BASE_URL=$(printf '%s' "$BASE_URL" | sed "s/'/\\\\'/g")`,
    'cat > .env <<EOF',
    "NODE_HOST='$COMPOSE_BASE_URL'",
    "NODE_SOURCE_URL='$COMPOSE_BASE_URL/node/source.tar.gz'",
    `NODE_PAIRING_TOKEN=${pairingToken}`,
    'NODE_ID=my-node',
    'NODE_DATA_DIR=./data',
    'EOF',
    'chmod 600 .env',
    '',
    'docker compose up -d --build',
  ].join('\n');
}

function buildEndpointUrls(baseUrlPlaceholder: string) {
  const runShellShPath = '/node/run-shell.sh';
  const runShPath = '/node/run.sh';
  const runDockerShPath = '/node/run-docker.sh';
  const runInteractiveShPath = '/node/run-interactive.sh';
  const runPs1Path = '/node/run.ps1';
  const composePath = '/node/docker-compose.yaml';
  const sourcePath = '/node/source.tar.gz';

  return {
    runShellShPath,
    runShellShUrl: `${baseUrlPlaceholder}${runShellShPath}`,
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
  const configuredUrl = options.publicUrl ?? PUBLIC_BASE_URL;
  const baseUrl = configuredUrl || NODE_BOOTSTRAP_BASE_URL_PLACEHOLDER;
  const endpoints = buildEndpointUrls(baseUrl);
  const pathPrefix = !!configuredUrl && new URL(configuredUrl).pathname !== '/';
  const hostFlag = pathPrefix ? ['  --host="$BASE_URL"'] : [];
  const chooseBaseUrl = configuredUrl ? `BASE_URL=${shellQuote(configuredUrl)}` : `BASE_URL=http://YOUR_MASTER:${HTTP_PORT}`;

  return {
    pairingToken: options.pairingToken,
    baseUrl: {
      placeholder: NODE_BOOTSTRAP_BASE_URL_PLACEHOLDER,
      ...(configuredUrl ? { configuredUrl } : {}),
      shellAssignmentExample: chooseBaseUrl,
      requestDerivedDefaultInDownloadedScripts: NODE_BOOTSTRAP_BASE_URL_PLACEHOLDER,
      canSystemKnowUniqueExternalBaseUrl: false,
      explanation: configuredUrl
        ? 'The configured public URL is used as the bootstrap base URL. Downloaded scripts still default to the origin inferred from their own HTTP request.'
        : 'Foxwarm cannot reliably know one universally correct external master URL for every node. The reachable URL depends on where the node runs: localhost, LAN IP, Docker host IP, reverse-proxy domain, and so on. This tool therefore uses $BASE_URL as an explicit placeholder instead of pretending to know the unique correct address.',
      operatorAction: configuredUrl
        ? 'Check that this URL is reachable from the new Node; override BASE_URL if needed.'
        : 'Choose BASE_URL from the node\'s point of view before running the bootstrap commands below.',
      overrideHint: pathPrefix
        ? 'A URL with a path prefix is passed explicitly as --host so the Node keeps that prefix. If fetched through another address, override --host as needed.'
        : 'If you fetch a bootstrap script through one address but the node should connect through another, pass --host="$BASE_URL" explicitly when running the script.',
    },
    endpoints,
    examples: {
      shell: 'curl -fsSL "$BASE_URL/node/run-shell.sh" -o run-shell.sh\n# First run /node create my-shell on the master; use its per-node token here.\nNODE_AUTH_TOKEN=YOUR_PER_NODE_AUTH_TOKEN sh ./run-shell.sh --host="$BASE_URL" --node-id=my-shell',
      chooseBaseUrl,
      bareMetal: shellCommand(['curl -fsSL "$BASE_URL/node/run.sh" | bash -s --', '  --dir=/opt/foxwarm-node', ...hostFlag, `  --pairing=${options.pairingToken}`, '  --node-id=my-node']),
      bareMetalBackground: shellCommand(['curl -fsSL "$BASE_URL/node/run.sh" | bash -s --', '  --dir=/opt/foxwarm-node', ...hostFlag, `  --pairing=${options.pairingToken}`, '  --node-id=my-node', '  -d']),
      bareMetalInstall: shellCommand(['curl -fsSL "$BASE_URL/node/run.sh" | bash -s --', '  --dir=/opt/foxwarm-node', ...hostFlag, `  --pairing=${options.pairingToken}`, '  --node-id=my-node', '  --install']),
      docker: shellCommand(['curl -fsSL "$BASE_URL/node/run-docker.sh" | bash -s --', ...hostFlag, `  --pairing=${options.pairingToken}`, '  --node-id=my-node']),
      interactive: shellCommand(['curl -fsSL "$BASE_URL/node/run-interactive.sh" | bash -s --', ...hostFlag, `  --pairing=${options.pairingToken}`, '  --node-id=my-cli-node']),
      explicitHostOverride: `curl -fsSL "http://127.0.0.1:${HTTP_PORT}/node/run.sh" | bash -s -- \\
  --dir=/opt/foxwarm-node \\
  --host="$BASE_URL" \\
  --pairing=${options.pairingToken} \\
  --node-id=my-node`,
      manualCompose: buildNodeManualComposeExample(options.pairingToken),
      windows: [
        `$BASE_URL = ${powershellQuote(configuredUrl || `http://YOUR_MASTER:${HTTP_PORT}`)}`,
        'Invoke-WebRequest "$BASE_URL/node/run.ps1" -OutFile .\\run.ps1',
        `.\\run.ps1 ${pathPrefix ? '-HostUrl "$BASE_URL" ' : ''}-Pairing ${powershellQuote(options.pairingToken)} -NodeId my-node`,
      ].join('\n'),
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
