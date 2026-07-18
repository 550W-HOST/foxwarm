import assert from 'assert';
import { execFile } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import test from 'node:test';
import { CodeHelperIpcServer, type CodeHelperOpenRequest } from './codeHelperIpc';

const execFileAsync = promisify(execFile);

test('Code helper resolves local files, folders, and goto locations through terminal-scoped IPC', async () => {
  if (process.platform === 'win32') return;
  const tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-code-helper-'));
  const workspace = path.join(tempDir, 'workspace');
  const folder = path.join(workspace, 'src');
  const file = path.join(folder, 'index.ts');
  await fs.ensureDir(folder);
  await fs.writeFile(file, 'first\nsecond\n');
  const requests: Array<{ terminalId: string; request: CodeHelperOpenRequest }> = [];
  const server = new CodeHelperIpcServer(tempDir, async (terminalId, _requestId, request) => {
    requests.push({ terminalId, request });
    return { ok: true, message: request.kind };
  });
  try {
    const registration = await server.registerTerminal('term-test');
    const env = { ...process.env, ...registration.env };
    const fileResult = await execFileAsync('code', ['src/index.ts'], { cwd: workspace, env });
    assert.equal(fileResult.stdout.trim(), 'openFile');
    assert.deepEqual(requests.at(-1), { terminalId: 'term-test', request: { kind: 'openFile', path: file } });

    const folderResult = await execFileAsync('code', ['src'], { cwd: workspace, env });
    assert.equal(folderResult.stdout.trim(), 'addFolder');
    assert.deepEqual(requests.at(-1), { terminalId: 'term-test', request: { kind: 'addFolder', path: folder } });

    await execFileAsync('code', ['--goto', 'src/index.ts:2:3'], { cwd: workspace, env });
    assert.deepEqual(requests.at(-1), {
      terminalId: 'term-test',
      request: { kind: 'openFile', path: file, startLine: 2, startColumn: 3 },
    });

    await assert.rejects(
      execFileAsync('code', ['missing.ts'], { cwd: workspace, env }),
      /Path does not exist/,
    );
    server.unregisterTerminal(registration.capability);
    await assert.rejects(
      execFileAsync('code', [file], { cwd: workspace, env }),
      /capability is invalid or expired/,
    );
  } finally {
    await server.close();
    await fs.remove(tempDir);
  }
});
