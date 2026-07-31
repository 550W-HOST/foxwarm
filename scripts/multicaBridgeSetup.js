'use strict';

const fs = require('node:fs/promises');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const { FoxwarmClient, BridgeError } = require('./multicaBridgeHttp.js');

class SetupUsageError extends Error {}
class SetupError extends Error {}

function setupValue(argv, index, option) {
  if (index + 1 >= argv.length) throw new SetupUsageError(`${option} requires a value.`);
  return argv[index + 1];
}

function parseSetupArgs(argv) {
  const result = {
    url: '', agent: '', tokenFile: '', instance: 'default', displayName: '', multica: '', installRoot: '',
    multicaProfile: null, createAgent: false, dryRun: false, help: false,
  };
  const values = new Map([
    ['--url', 'url'], ['--agent', 'agent'], ['--token-file', 'tokenFile'], ['--instance', 'instance'],
    ['--display-name', 'displayName'], ['--multica', 'multica'], ['--multica-profile', 'multicaProfile'],
    ['--install-root', 'installRoot'],
  ]);
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index];
    if (arg === '--create-agent') result.createAgent = true;
    else if (arg === '--dry-run') result.dryRun = true;
    else if (arg === '--help' || arg === '-h') result.help = true;
    else if (arg === '--token' || arg.startsWith('--token=')) {
      throw new SetupUsageError('Use --token-file or FOXWARM_MULTICA_TOKEN; secrets are not accepted in argv.');
    } else if (values.has(arg)) {
      result[values.get(arg)] = setupValue(argv, index, arg);
      index += 1;
    } else if (arg.startsWith('--') && arg.includes('=')) {
      const [option, ...rest] = arg.split('=');
      const key = values.get(option);
      if (!key) throw new SetupUsageError(`Unsupported setup option: ${option}.`);
      result[key] = rest.join('=');
    } else {
      throw new SetupUsageError(`Unsupported setup option or argument: ${arg}.`);
    }
  }
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]{0,63}$/.test(result.instance)) {
    throw new SetupUsageError('--instance must use 1-64 letters, numbers, dots, underscores, or hyphens.');
  }
  if (result.multicaProfile !== null && /[\0\r\n]/.test(result.multicaProfile)) {
    throw new SetupUsageError('--multica-profile cannot contain control characters.');
  }
  return result;
}

function printSetupHelp(stream) {
  stream.write(`foxwarm-multica setup — configure one Foxwarm target for the current Multica workspace\n\nUsage:\n  foxwarm-multica setup [options]\n\nOptions:\n      --url <url>                 Foxwarm WebUI base URL (default: env, saved value, or http://127.0.0.1:3001)\n      --agent <name>              Dedicated Foxwarm agent (default: env, saved value, or multica)\n      --token-file <path>         Read the Foxwarm token from a file\n      --instance <name>           Local target name (default: default)\n      --display-name <name>       Multica runtime profile label\n      --multica <path>            Multica executable/path (default: saved value or multica)\n      --multica-profile <name>    Named Multica CLI/daemon profile (default: saved value or default profile)\n      --install-root <path>       Local private setup root\n      --create-agent              Create the Foxwarm agent when missing\n      --dry-run                   Validate and print the plan without mutations\n  -h, --help                      Show this help\n\nFOXWARM_MULTICA_TOKEN may supply the token without argv exposure.\n`);
}

function defaultInstallRoot(env) {
  const home = env.HOME || os.homedir();
  return path.join(home, '.local', 'share', 'foxwarm-multica');
}

function validateAgentName(agent) {
  if (!/^[A-Za-z0-9_-]+$/.test(agent)) throw new SetupUsageError('Agent names may contain only letters, numbers, hyphens, and underscores.');
}

function normalizeBaseUrl(raw) {
  let parsed;
  try { parsed = new URL(raw); } catch { throw new SetupUsageError('--url must be a valid HTTP(S) URL.'); }
  if (!['http:', 'https:'].includes(parsed.protocol) || parsed.username || parsed.password || parsed.search || parsed.hash) {
    throw new SetupUsageError('--url must be HTTP(S) without credentials, query, or fragment.');
  }
  return parsed.toString().replace(/\/+$/, '');
}

async function readExistingConfig(configPath) {
  let stat;
  try { stat = await fs.lstat(configPath); } catch (error) {
    if (error?.code === 'ENOENT') return {};
    throw new SetupError('The saved instance configuration could not be inspected.');
  }
  if (!stat.isFile() || stat.isSymbolicLink() || (stat.mode & 0o077) !== 0
    || (typeof process.getuid === 'function' && stat.uid !== process.getuid())) {
    throw new SetupError('The saved instance configuration must be a private regular file.');
  }
  let text;
  try { text = await fs.readFile(configPath, 'utf8'); } catch (error) {
    throw new SetupError('The saved instance configuration could not be read.');
  }
  try {
    const parsed = JSON.parse(text);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    throw new SetupError('The saved instance configuration is not valid JSON.');
  }
}

async function readTokenFile(filePath) {
  let stat;
  try { stat = await fs.lstat(filePath); } catch { throw new SetupUsageError('The token file could not be read.'); }
  if (!stat.isFile()) throw new SetupUsageError('The token file must be a regular file.');
  let token;
  try { token = (await fs.readFile(filePath, 'utf8')).trim(); } catch { throw new SetupUsageError('The token file could not be read.'); }
  if (!token || token.includes('\0')) throw new SetupUsageError('The token file is empty or invalid.');
  return token;
}

function shellQuote(value) {
  return `'${String(value).replace(/'/g, `'"'"'`)}'`;
}

function withMulticaProfile(profile, args) {
  return profile ? ['--profile', profile, ...args] : args;
}

function formatMulticaCommand(executable, profile, args) {
  return [executable, ...withMulticaProfile(profile, args)].map(shellQuote).join(' ');
}

async function writePrivateFile(filePath, content, mode) {
  const temporary = `${filePath}.tmp-${process.pid}`;
  await fs.mkdir(path.dirname(filePath), { recursive: true, mode: 0o700 });
  await fs.chmod(path.dirname(filePath), 0o700);
  try {
    await fs.writeFile(temporary, content, { encoding: 'utf8', mode });
    await fs.chmod(temporary, mode);
    await fs.rename(temporary, filePath);
  } finally {
    await fs.rm(temporary, { force: true }).catch(() => {});
  }
}

function runCommand(executable, args, env, spawnImpl = spawn) {
  return new Promise((resolve, reject) => {
    let child;
    try {
      child = spawnImpl(executable, args, { env, stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true });
    } catch {
      reject(new SetupError('The Multica executable could not be started. Install it or pass --multica <path>.'));
      return;
    }
    let stdout = '';
    let stderr = '';
    child.stdout?.on('data', chunk => { if (stdout.length < 1024 * 1024) stdout += chunk.toString(); });
    child.stderr?.on('data', chunk => { if (stderr.length < 1024 * 1024) stderr += chunk.toString(); });
    child.once('error', () => reject(new SetupError('The Multica executable could not be started. Install it or pass --multica <path>.')));
    child.once('exit', (code, signal) => resolve({ code, signal, stdout, stderr }));
  });
}

function multicaProcessEnv(env) {
  const clean = { ...env };
  delete clean.FOXWARM_MULTICA_TOKEN;
  delete clean.FOXWARM_MULTICA_CONFIG;
  delete clean.FOXWARM_MULTICA_BASE_URL;
  delete clean.FOXWARM_MULTICA_AGENT;
  return clean;
}

async function runMulticaJson(executable, args, env, options, action, profile = '') {
  const result = await runCommand(executable, args, env, options.spawnImpl);
  if (result.code !== 0 || result.signal) {
    if (action === 'list') {
      throw new SetupError(`Multica CLI is not ready. Run ${formatMulticaCommand(executable, profile, ['login'])} and ${formatMulticaCommand(executable, profile, ['workspace', 'switch', '<id-or-slug>'])}, then retry.`);
    }
    throw new SetupError(`Multica ${action} failed. Check CLI authentication, workspace permissions, and the selected workspace.`);
  }
  try { return result.stdout.trim() ? JSON.parse(result.stdout) : {}; } catch {
    throw new SetupError(`Multica ${action} returned malformed JSON.`);
  }
}

async function runMulticaMutation(executable, args, env, options, action) {
  const result = await runCommand(executable, args, env, options.spawnImpl);
  if (result.code !== 0 || result.signal) {
    throw new SetupError(`Multica ${action} failed. Check CLI authentication, workspace permissions, and local CLI configuration.`);
  }
}

function findReusableProfile(profiles, savedId, commandName) {
  if (savedId) {
    const recorded = profiles.find(profile => profile?.id === savedId);
    if (recorded) return recorded;
  }
  const matches = profiles.filter(profile => profile?.protocol_family === 'qwen' && profile?.command_name === commandName);
  if (matches.length > 1) throw new SetupError('Multiple matching Multica runtime profiles exist; choose a different --instance or repair duplicates first.');
  return matches[0] || null;
}

async function resolveSetup(options, env) {
  const installRoot = path.resolve(options.installRoot || defaultInstallRoot(env));
  const instanceDir = path.join(installRoot, options.instance);
  const configPath = path.join(instanceDir, 'config.json');
  const existing = await readExistingConfig(configPath);
  const token = options.tokenFile
    ? await readTokenFile(path.resolve(options.tokenFile))
    : (env.FOXWARM_MULTICA_TOKEN || existing.token || '');
  if (!token) throw new SetupUsageError('Provide --token-file or FOXWARM_MULTICA_TOKEN.');
  const agent = options.agent || env.FOXWARM_MULTICA_AGENT || existing.agent || 'multica';
  validateAgentName(agent);
  const baseUrl = normalizeBaseUrl(options.url || env.FOXWARM_MULTICA_BASE_URL || existing.baseUrl || 'http://127.0.0.1:3001');
  const displayName = options.displayName || existing.displayName || `Foxwarm (${options.instance})`;
  const multicaExecutable = options.multica || existing.multicaExecutable || 'multica';
  const multicaProfile = options.multicaProfile !== null && options.multicaProfile !== undefined
    ? options.multicaProfile
    : (existing.multicaProfile || '');
  const launcherName = `foxwarm-multica-${options.instance}`;
  return {
    installRoot, instanceDir, configPath, existing, token, agent, baseUrl, displayName, multicaExecutable, multicaProfile,
    launcherName, launcherPath: path.join(instanceDir, launcherName),
  };
}

async function ensureFoxwarmAgent(client, agent, createAgent, dryRun) {
  const response = await client.listAgents();
  if (!Array.isArray(response?.agents)) throw new SetupError('Foxwarm returned a malformed agent list.');
  if (response.agents.some(entry => entry?.id === agent)) return 'existing';
  if (!createAgent) throw new SetupError(`Foxwarm agent "${agent}" does not exist. Create it first or rerun with --create-agent.`);
  if (dryRun) return 'would-create';
  try { await client.createAgent(agent); } catch (error) {
    if (!(error instanceof BridgeError)) throw error;
    throw new SetupError('Foxwarm agent creation failed. Check the agent name and instance permissions.');
  }
  return 'created';
}

async function runSetup(argv, runtimeOptions = {}) {
  const stdout = runtimeOptions.stdout || process.stdout;
  const stderr = runtimeOptions.stderr || process.stderr;
  const env = runtimeOptions.env || process.env;
  let args;
  try { args = parseSetupArgs(argv); } catch (error) {
    stderr.write(`Usage error: ${error.message}\n`);
    return 2;
  }
  if (args.help) { printSetupHelp(stdout); return 0; }

  try {
    const setup = await resolveSetup(args, env);
    const client = new FoxwarmClient({ baseUrl: setup.baseUrl, token: setup.token, fetchImpl: runtimeOptions.fetchImpl });
    const processEnv = multicaProcessEnv(env);
    const commandArgs = values => withMulticaProfile(setup.multicaProfile, values);
    const list = await runMulticaJson(setup.multicaExecutable, commandArgs(['runtime', 'profile', 'list', '--output', 'json']), processEnv, runtimeOptions, 'list', setup.multicaProfile);
    if (!Array.isArray(list)) throw new SetupError('Multica profile list returned malformed JSON.');
    const agentStatus = await ensureFoxwarmAgent(client, setup.agent, args.createAgent, args.dryRun);
    let profile = findReusableProfile(list, setup.existing.runtimeProfileId, setup.launcherName);
    if (profile && profile.protocol_family !== 'qwen') throw new SetupError('The saved Multica runtime profile is not a Qwen-family profile.');
    const profileAction = profile ? 'reuse' : 'create';

    if (args.dryRun) {
      stdout.write(`Dry run passed for Foxwarm Multica target "${args.instance}".\n`);
      stdout.write(`Foxwarm: ${setup.baseUrl} (agent: ${setup.agent}${agentStatus === 'would-create' ? ', would create' : ''})\n`);
      stdout.write(`Multica CLI profile: ${setup.multicaProfile || '(default)'}\n`);
      stdout.write(`Launcher: ${setup.launcherPath}\n`);
      stdout.write(`Multica profile: ${profile ? `reuse ${profile.id}` : `would create "${setup.displayName}"`}\nNo files, agents, profiles, or path overrides were changed.\n`);
      return 0;
    }

    if (!profile) {
      profile = await runMulticaJson(setup.multicaExecutable, commandArgs([
        'runtime', 'profile', 'create', '--protocol-family', 'qwen', '--command-name', setup.launcherName,
        '--display-name', setup.displayName, '--description', `Foxwarm bridge target ${args.instance}`, '--output', 'json',
      ]), processEnv, runtimeOptions, 'profile create', setup.multicaProfile);
      if (!profile || typeof profile.id !== 'string' || !profile.id) throw new SetupError('Multica profile creation returned no profile ID.');
    } else {
      const updateArgs = ['runtime', 'profile', 'update', profile.id];
      if (profile.command_name !== setup.launcherName) updateArgs.push('--command-name', setup.launcherName);
      if (profile.display_name !== setup.displayName) updateArgs.push('--display-name', setup.displayName);
      if (profile.enabled === false) updateArgs.push('--enabled=true');
      if (updateArgs.length > 4) {
        updateArgs.push('--output', 'json');
        profile = await runMulticaJson(setup.multicaExecutable, commandArgs(updateArgs), processEnv, runtimeOptions, 'profile update', setup.multicaProfile);
      }
    }

    const bridgePath = await fs.realpath(path.join(__dirname, 'multicaBridge.js'));
    const config = {
      version: 1, baseUrl: setup.baseUrl, agent: setup.agent, token: setup.token,
      runtimeProfileId: profile.id, displayName: setup.displayName, multicaExecutable: setup.multicaExecutable,
      multicaProfile: setup.multicaProfile,
    };
    const launcher = `#!/bin/sh\nunset FOXWARM_MULTICA_BASE_URL FOXWARM_MULTICA_TOKEN FOXWARM_MULTICA_AGENT FOXWARM_MULTICA_REQUEST_TIMEOUT_MS\nexport FOXWARM_MULTICA_CONFIG=${shellQuote(setup.configPath)}\nexec ${shellQuote(process.execPath)} ${shellQuote(bridgePath)} "$@"\n`;
    await writePrivateFile(setup.configPath, `${JSON.stringify(config, null, 2)}\n`, 0o600);
    await writePrivateFile(setup.launcherPath, launcher, 0o700);
    await runMulticaMutation(setup.multicaExecutable, commandArgs([
      'runtime', 'profile', 'set-path', profile.id, '--path', setup.launcherPath,
    ]), processEnv, runtimeOptions, 'profile path pin');

    stdout.write(`Configured Foxwarm Multica target "${args.instance}".\n`);
    stdout.write(`Foxwarm: ${setup.baseUrl} (agent: ${setup.agent}${agentStatus === 'created' ? ', created' : ''})\n`);
    stdout.write(`Multica CLI profile: ${setup.multicaProfile || '(default)'}\n`);
    stdout.write(`Launcher: ${setup.launcherPath}\nRuntime profile: ${profile.id} (${profileAction === 'create' ? 'created' : 'reused'})\n`);
    stdout.write(`Next: ${formatMulticaCommand(setup.multicaExecutable, setup.multicaProfile, ['daemon', 'restart'])}\nIf the daemon is not running: ${formatMulticaCommand(setup.multicaExecutable, setup.multicaProfile, ['daemon', 'start'])}\n`);
    stdout.write('For Docker, mount the launcher/config/bridge and task workspaces at paths the daemon can access; Foxwarm and Multica must see the same working directories.\n');
    return 0;
  } catch (error) {
    const message = error instanceof SetupUsageError || error instanceof SetupError || error instanceof BridgeError
      ? error.message
      : 'Multica bridge setup failed unexpectedly.';
    stderr.write(`${error instanceof SetupUsageError ? 'Usage error' : 'Error'}: ${message}\n`);
    return error instanceof SetupUsageError ? 2 : 1;
  }
}

module.exports = {
  SetupError,
  SetupUsageError,
  findReusableProfile,
  formatMulticaCommand,
  multicaProcessEnv,
  parseSetupArgs,
  printSetupHelp,
  resolveSetup,
  runSetup,
  shellQuote,
  withMulticaProfile,
  writePrivateFile,
};
