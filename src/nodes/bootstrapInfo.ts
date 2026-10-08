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

export interface NodeBootstrapCommandOptions {
  baseUrl: string;
  pairingToken: string;
  nodeId?: string;
  installDir?: string;
  authToken?: string;
}

/** Each command is independent and uses literal addresses and credentials. */
export function buildNodeBootstrapCommands(options: NodeBootstrapCommandOptions) {
  const baseUrl = options.baseUrl.replace(/\/$/, '');
  const nodeId = options.nodeId || 'my-node';
  const host = `  --host=${shellQuote(baseUrl)}`;
  const pairing = `  --pairing=${shellQuote(options.pairingToken)}`;
  const id = `  --node-id=${shellQuote(nodeId)}`;
  const directory = `  --dir=${shellQuote(options.installDir || '/opt/foxwarm-node')}`;
  const download = (file: string) => `curl -fsSL ${shellQuote(`${baseUrl}/node/${file}`)} | bash -s --`;
  return {
    shell: [
      `curl -fsSL ${shellQuote(`${baseUrl}/node/run-shell.sh`)} -o run-shell.sh`,
      `NODE_AUTH_TOKEN=${shellQuote(options.authToken || 'YOUR_PER_NODE_AUTH_TOKEN')} sh ./run-shell.sh --host=${shellQuote(baseUrl)} --node-id=${shellQuote(options.nodeId || 'my-shell')}`,
    ].join('\n'),
    bareMetal: shellCommand([download('run.sh'), directory, host, pairing, id]),
    bareMetalBackground: shellCommand([download('run.sh'), directory, host, pairing, id, '  -d']),
    bareMetalInstall: shellCommand([download('run.sh'), directory, host, pairing, id, '  --install']),
    docker: shellCommand([download('run-docker.sh'), host, pairing, id]),
    interactive: shellCommand([download('run-interactive.sh'), host, pairing, id]),
    manualCompose: buildNodeManualComposeExample(options.pairingToken, baseUrl, nodeId),
    windows: [
      `Invoke-WebRequest ${powershellQuote(`${baseUrl}/node/run.ps1`)} -OutFile .\\run.ps1`,
      `.\\run.ps1 -HostUrl ${powershellQuote(baseUrl)} -Pairing ${powershellQuote(options.pairingToken)} -NodeId ${powershellQuote(nodeId)}`,
    ].join('\n'),
  };
}

/** Quote Compose literals inside a shell-literal heredoc; no variable expansion. */
export function buildNodeManualComposeExample(pairingToken: string, baseUrl = PUBLIC_BASE_URL || `http://YOUR_MASTER:${HTTP_PORT}`, nodeId = 'my-node'): string {
  const composeQuote = (value: string) => `'${value.replace(/'/g, "\\'")}'`;
  return [
    `curl -fsSL ${shellQuote(`${baseUrl}/node/docker-compose.yaml`)} -o docker-compose.yaml`,
    'umask 077',
    "cat > .env <<'FOXWARM_NODE_ENV'",
    `NODE_HOST=${composeQuote(baseUrl)}`,
    `NODE_SOURCE_URL=${composeQuote(`${baseUrl}/node/source.tar.gz`)}`,
    `NODE_PAIRING_TOKEN=${composeQuote(pairingToken)}`,
    `NODE_ID=${composeQuote(nodeId)}`,
    'NODE_DATA_DIR=./data',
    'FOXWARM_NODE_ENV',
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
  const baseUrl = configuredUrl || `http://YOUR_MASTER:${HTTP_PORT}`;
  const commands = buildNodeBootstrapCommands({ baseUrl, pairingToken: options.pairingToken });
  return {
    pairingToken: options.pairingToken,
    baseUrl: {
      placeholder: NODE_BOOTSTRAP_BASE_URL_PLACEHOLDER,
      ...(configuredUrl ? { configuredUrl } : {}),
      shellAssignmentExample: baseUrl,
      requestDerivedDefaultInDownloadedScripts: NODE_BOOTSTRAP_BASE_URL_PLACEHOLDER,
      canSystemKnowUniqueExternalBaseUrl: false,
      explanation: configuredUrl
        ? 'Commands use the configured public address. Check that it is reachable from the new Node.'
        : 'There is no universally reachable address for every Node. Replace the example host with an address reachable from the new Node.',
      operatorAction: configuredUrl
        ? 'Copy a command below, or replace its address if the new Node needs another route.'
        : 'Replace YOUR_MASTER in the command you copy with a reachable host.',
      overrideHint: 'Each command includes its complete address and explicit host, including any deployment path.',
    },
    endpoints: buildEndpointUrls(baseUrl),
    examples: {
      ...commands,
      chooseBaseUrl: configuredUrl ? `# Commands use ${baseUrl}` : '# Replace YOUR_MASTER with a reachable host in the command you copy.',
      explicitHostOverride: buildNodeBootstrapCommands({ baseUrl: `http://192.168.1.50:${HTTP_PORT}`, pairingToken: options.pairingToken }).bareMetal,
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
