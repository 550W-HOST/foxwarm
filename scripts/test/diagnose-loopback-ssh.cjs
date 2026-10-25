// Focused diagnostic observation of the owned loopback SSH fixture and public adapter.
// This is not application acceptance. Failed initial discovery produces a failing exit.
const fs = require('node:fs/promises');
const path = require('node:path');
const os = require('node:os');
const { sshFixture } = require('./loopbackSshFixture.cjs');
const { execFile } = require('node:child_process');

const repo = path.resolve(__dirname, '../..');
const adapter = path.join(repo, 'skills/node-setup/examples/linux-ssh/provider.py');
// Match ExecutableNodeProvider.EnvironmentKeys without inheriting application state.
const environmentKeys = ['PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP', 'LANG', 'LC_ALL', 'LC_CTYPE', 'SystemRoot', 'COMSPEC', 'PATHEXT'];
const providerEnv = Object.fromEntries(environmentKeys.filter(key => process.env[key] !== undefined).map(key => [key, process.env[key]]));
const envelope = { protocol: 'foxwarm-node-provider', providerId: 'external-ssh', requestId: 'ssh-diagnostic', operation: 'list' };

async function command(label, executable, args, options = {}, input) {
  const observation = await new Promise(resolve => {
    const child = execFile(executable, args, { timeout: 15000, maxBuffer: 1024 * 1024, ...options }, (error, stdout, stderr) => {
      resolve({ label, code: error ? error.code : 0, signal: error?.signal, stdout, stderr });
    });
    child.stdin.on('error', () => {});
    child.stdin.end(input);
  });
  console.log(JSON.stringify(observation));
  return observation;
}

function parsed(observation) {
  try { return JSON.parse(observation.stdout); }
  catch { return null; }
}

function availability(observation) {
  return parsed(observation)?.result?.nodes?.find(node => node.id === 'ssh:fixture')?.availability;
}

(async () => {
  const root = await fs.mkdtemp(path.join(os.homedir(), '.foxwarm-ssh-diagnostic-'));
  let connection;
  try {
    console.log(JSON.stringify({ label: 'diagnostic-environment', node: process.version, platform: process.platform, imageOS: process.env.ImageOS, imageVersion: process.env.ImageVersion }));
    for (const name of ['/', path.dirname(os.homedir()), os.homedir(), root, '/run/sshd']) {
      const info = await fs.stat(name).catch(error => ({ error: error.code }));
      console.log(JSON.stringify({ label: 'path-mode', path: name, mode: info.mode?.toString(8), uid: info.uid, gid: info.gid, error: info.error }));
    }
    const accountBefore = await command('account-status-before-no-hash', 'passwd', ['-S', os.userInfo().username]);
    await command('ssh-version', 'ssh', ['-V']);
    await command('sshd-version', '/usr/sbin/sshd', ['-V']);

    connection = await sshFixture(root);
    const effective = await command('effective-owned-sshd-config', '/usr/sbin/sshd', ['-T', '-f', path.join(root, 'sshd_config')]);
    const settings = new Map(effective.stdout.trim().split('\n').map(line => line.split(/\s+/, 2)));

    const cwd = path.join(root, "target space ü 'quote");
    await fs.mkdir(cwd);
    const config = path.join(root, 'provider.json');
    await fs.writeFile(config, JSON.stringify({ nodes: [{ id: 'ssh:fixture', target: connection.target, sshArgs: connection.sshArgs, cwd, stateDir: path.join(root, 'state') }] }));
    const list = label => command(label, 'python3', [adapter, '--config', config], { env: providerEnv }, JSON.stringify(envelope));
    const discovery = await list('unchanged-provider-list-exact-core-env');
    console.log(JSON.stringify({ label: 'initial-owned-sshd-diagnostics', text: connection.diagnostics }));

    const python = await command('strict-ssh-direct-python', 'ssh', [
      '-oBatchMode=yes', '-oStrictHostKeyChecking=yes', '-oConnectTimeout=10',
      ...connection.sshArgs, '--', connection.target,
      "python3 -c 'import os,sys,json; print(json.dumps({\"cwd\":os.getcwd(),\"python\":sys.executable}))'",
    ], { env: providerEnv });

    // Keep the exact public helper transport; observe only this owned connection's stderr.
    const observe = [
      'import importlib.util,json,sys',
      's=importlib.util.spec_from_file_location("provider",sys.argv[1])',
      'p=importlib.util.module_from_spec(s)',
      's.loader.exec_module(p)',
      'original=p.subprocess.Popen',
      'def capture(*a,**kw):',
      ' kw["stderr"]=None',
      ' return original(*a,**kw)',
      'p.subprocess.Popen=capture',
      'try: print(json.dumps(p.remote(json.load(open(sys.argv[2]))["nodes"][0],"probe")))',
      'except Exception as e: print(type(e).__name__+": "+str(e)); sys.exit(1)',
    ].join('\n');
    const probe = label => command(label, 'python3', ['-c', observe, adapter, config], { env: providerEnv });
    const helper = await probe('exact-helper-probe-observed-stderr');

    // A different refusal control: show the structured target error hidden by list.
    await fs.rmdir(cwd);
    const missingCwd = await list('missing-cwd-provider-list-exact-core-env');
    const missingHelper = await probe('missing-cwd-exact-helper-observed-stderr');
    await fs.mkdir(cwd);

    // Remove only this fixture's exact trust; strict host checking stays enabled.
    const knownHosts = connection.sshArgs.find(arg => arg.startsWith('-oUserKnownHostsFile=')).slice('-oUserKnownHostsFile='.length);
    await fs.writeFile(knownHosts, '');
    const untrusted = await list('untrusted-provider-list-exact-core-env');
    const untrustedHelper = await probe('untrusted-exact-helper-observed-stderr');
    console.log(JSON.stringify({ label: 'final-owned-sshd-diagnostics', text: connection.diagnostics }));

    const accountAfter = await command('account-status-after-no-hash', 'passwd', ['-S', os.userInfo().username]);
    const observations = {
      pamAccountPolicyEnabled: effective.code === 0 && settings.get('usepam') === 'yes',
      keyOnlyAuthentication: settings.get('pubkeyauthentication') === 'yes' && ['passwordauthentication', 'kbdinteractiveauthentication', 'hostbasedauthentication', 'gssapiauthentication'].every(key => settings.get(key) === 'no'),
      strictModesEnabled: settings.get('strictmodes') === 'yes',
      accountStatusUnchanged: accountBefore.code === 0 && accountAfter.code === 0 && accountBefore.stdout === accountAfter.stdout,
      initialDiscoveryReady: discovery.code === 0 && availability(discovery) === 'ready',
      strictPythonSucceeded: python.code === 0 && !!parsed(python)?.python,
      helperSucceeded: helper.code === 0 && parsed(helper)?.ok === true,
      missingCwdRefused: missingCwd.code === 0 && availability(missingCwd) === 'offline' && parsed(missingHelper)?.error?.code === 'ENOTDIR',
      untrustedRefused: untrusted.code === 0 && availability(untrusted) === 'offline' && untrustedHelper.code !== 0 && untrustedHelper.stderr.includes('Host key verification failed'),
    };
    console.log(JSON.stringify({ label: 'diagnostic-summary-not-application-acceptance', observations }));
    if (!Object.values(observations).every(Boolean)) process.exitCode = 1;
  } finally {
    if (connection) await connection.close();
    await fs.rm(root, { recursive: true, force: true });
  }
})().catch(error => { console.error(error.stack); process.exitCode = 1; });
