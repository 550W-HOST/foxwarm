// Owned loopback-only transport shared by the Source and .NET adapter qualifications.
const fs = require('node:fs/promises');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const { spawn, execFile } = require('node:child_process');
const { promisify } = require('node:util');
const execute = promisify(execFile);

exports.sshFixture = async function sshFixture(root) {
  const host = path.join(root, 'host');
  const identity = path.join(root, 'identity');
  await execute('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', host]);
  await execute('ssh-keygen', ['-q', '-t', 'ed25519', '-N', '', '-f', identity]);
  const listener = net.createServer();
  await new Promise(resolve => listener.listen(0, '127.0.0.1', resolve));
  const port = listener.address().port;
  await new Promise(resolve => listener.close(resolve));
  const knownHosts = path.join(root, 'known_hosts');
  await fs.writeFile(knownHosts, `[127.0.0.1]:${port} ${await fs.readFile(`${host}.pub`, 'utf8')}`);
  const authorizedKeys = path.join(root, 'authorized_keys');
  await fs.copyFile(`${identity}.pub`, authorizedKeys);
  await fs.chmod(authorizedKeys, 0o600);
  const pidPath = path.join(root, 'sshd.pid');
  const configPath = path.join(root, 'sshd_config');
  await fs.writeFile(configPath, [
    `Port ${port}`, 'ListenAddress 127.0.0.1', `HostKey ${host}`, `PidFile ${pidPath}`,
    `AuthorizedKeysFile ${authorizedKeys}`, 'PasswordAuthentication no', 'KbdInteractiveAuthentication no',
    'UsePAM yes', 'StrictModes yes', `AllowUsers ${os.userInfo().username}`, 'LogLevel VERBOSE',
  ].join('\n'));
  const daemon = spawn('sudo', ['-n', '/usr/sbin/sshd', '-D', '-e', '-f', configPath], { stdio: ['ignore', 'ignore', 'pipe'] });
  let diagnostics = '';
  const exited = new Promise(resolve => daemon.once('exit', resolve));
  async function close() {
    const pid = (await fs.readFile(pidPath, 'utf8').catch(() => '')).trim();
    if (pid) {
      if (!/^[1-9]\d*$/.test(pid)) throw new Error('Owned sshd PID file is invalid.');
      const args = (await execute('ps', ['-p', pid, '-o', 'args='])).stdout;
      if (!args.includes('/usr/sbin/sshd') || !args.includes(`-f ${configPath}`)) throw new Error('Refusing to terminate a PID that does not match the owned sshd configuration.');
      await execute('sudo', ['-n', 'kill', '-TERM', pid]);
    }
    await exited;
  }
  try {
    await new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Dedicated sshd did not start: ' + diagnostics)), 5000);
      daemon.once('error', error => { clearTimeout(timer); reject(error); });
      daemon.once('exit', code => { clearTimeout(timer); reject(new Error(`Dedicated sshd exited: ${code}: ${diagnostics}`)); });
      daemon.stderr.on('data', chunk => {
        diagnostics = (diagnostics + chunk).slice(-8000);
        if (diagnostics.includes('Server listening')) { clearTimeout(timer); resolve(); }
      });
    });
  } catch (error) {
    if (daemon.exitCode === null && daemon.signalCode === null) await close();
    throw error;
  }
  return {
    get diagnostics() { return diagnostics; },
    target: `${os.userInfo().username}@127.0.0.1`,
    sshArgs: ['-F', '/dev/null', '-p', String(port), '-i', identity, `-oUserKnownHostsFile=${knownHosts}`, '-oIdentitiesOnly=yes'],
    close,
  };
};
