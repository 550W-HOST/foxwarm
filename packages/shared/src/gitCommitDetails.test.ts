import assert from 'assert';
import { execFile } from 'child_process';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import { promisify } from 'util';
import test from 'node:test';
import { normalizeVscodeGitContentRef, readVscodeGitCommitDetails } from './gitCommitDetails';
import { CLI_NODE_CAPABILITIES } from './nodeCapabilities';

const execFileAsync = promisify(execFile);

async function git(cwd: string, args: string[]): Promise<Buffer> {
  const result = await execFileAsync('git', ['-c', 'safe.directory=*', ...args], { cwd, encoding: 'buffer', maxBuffer: 30 * 1024 * 1024 });
  return result.stdout as Buffer;
}

async function commit(cwd: string, message: string): Promise<string> {
  await git(cwd, ['add', '-A']);
  await git(cwd, ['commit', '-m', message]);
  return (await git(cwd, ['rev-parse', 'HEAD'])).toString('utf8').trim();
}

test('reads root, rename, binary, and first-parent merge commit details', async () => {
  const repo = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-git-commit-'));
  try {
    await git(repo, ['init', '-q']);
    await git(repo, ['config', 'user.name', 'Foxwarm Test']);
    await git(repo, ['config', 'user.email', 'foxwarm@example.test']);
    await fs.writeFile(path.join(repo, 'old.txt'), 'one\n');
    const rootOid = await commit(repo, 'root subject\n\nroot body');
    await git(repo, ['tag', '-a', 'annotated', '-m', 'annotated tag', rootOid]);
    const tagOid = (await git(repo, ['rev-parse', 'annotated'])).toString('utf8').trim();
    await assert.rejects(
      () => readVscodeGitCommitDetails(repo, tagOid, (cwd, args) => git(cwd, args)),
      /does not name a commit directly/,
    );
    const root = await readVscodeGitCommitDetails(repo, rootOid.slice(0, 8), (cwd, args) => git(cwd, args));
    assert.equal(root.commit.oid, rootOid);
    assert.equal(root.comparison.mode, 'empty-tree');
    assert.equal(root.files[0].kind, 'added');
    assert.equal(root.commit.author.name, 'Foxwarm Test');
    assert.match(root.commit.message, /root body/);

    await fs.rename(path.join(repo, 'old.txt'), path.join(repo, 'new.txt'));
    await fs.appendFile(path.join(repo, 'new.txt'), 'two\n');
    await fs.writeFile(path.join(repo, 'binary.bin'), Buffer.from([0, 1, 2, 0, 3]));
    const secondOid = await commit(repo, 'rename and binary');
    const baseBranch = (await git(repo, ['branch', '--show-current'])).toString('utf8').trim();
    const second = await readVscodeGitCommitDetails(repo, secondOid.slice(0, 10), (cwd, args) => git(cwd, args));
    assert.equal(second.workspace, repo);
    assert.equal(second.comparison.parentOid, rootOid);
    const renamed = second.files.find((file) => file.path === 'new.txt');
    assert.equal(renamed?.kind, 'renamed');
    assert.equal(renamed?.oldPath, 'old.txt');
    assert.equal(second.files.find((file) => file.path === 'binary.bin')?.binary, true);
    assert.equal(second.stats.binaryFiles, 1);

    await git(repo, ['checkout', '-q', '-b', 'feature']);
    await fs.writeFile(path.join(repo, 'feature.txt'), 'feature\n');
    await commit(repo, 'feature');
    await git(repo, ['checkout', '-q', baseBranch]);
    await fs.writeFile(path.join(repo, 'master.txt'), 'master\n');
    const firstParent = await commit(repo, 'master');
    await git(repo, ['merge', '--no-ff', '-m', 'merge feature', 'feature']);
    const mergeOid = (await git(repo, ['rev-parse', 'HEAD'])).toString('utf8').trim();
    const merge = await readVscodeGitCommitDetails(repo, mergeOid, (cwd, args) => git(cwd, args));
    assert.equal(merge.comparison.mode, 'first-parent');
    assert.equal(merge.comparison.parentOid, firstParent);
    assert.deepEqual(merge.files.map((file) => file.path), ['feature.txt']);
    assert.equal(merge.commit.parents.length, 2);
  } finally {
    await fs.remove(repo);
  }
});

test('validates commit ids and immutable content refs', () => {
  assert.equal(CLI_NODE_CAPABILITIES.services['vscode-git'], 2);
  assert.equal(normalizeVscodeGitContentRef(undefined), 'HEAD');
  assert.equal(normalizeVscodeGitContentRef('A'.repeat(40)), 'a'.repeat(40));
  assert.throws(() => normalizeVscodeGitContentRef('HEAD~1'), /full 40\/64-character/);
  assert.throws(() => normalizeVscodeGitContentRef('--help'), /full 40\/64-character/);
});
