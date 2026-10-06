import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import type { FunctionCall, Session } from '../types';

const root = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-compact-repair-'));
process.env.FOXWARM_DATA_DIR = root;
const loaded = Promise.all([import('./compactPlanRepair'), import('../config'), import('../toolAuthorization'), import('./agentMetadata')]);

test.after(async () => { await fs.remove(root); });

async function fixture(rawArgsText = ' {"replaceAsBlocks": [] }\r\n') {
  const [repair, config, policy] = await loaded;
  policy.setToolAuthorizationPolicyForTests({ version: 1, defaultAction: 'allow', rules: [] });
  const session = { id: 'repair-owner', agent: 'repair-test', currentNode: 'remote-node' } as Session;
  const operation = {};
  await fs.ensureDir(config.getAgentDir(session.agent));
  const file = await repair.CompactPlanRepairFile.create({ id: 'call', name: 'submit_compact_plan', args: {}, rawArgsText }, session, operation);
  return { file, session, operation, repair, config, policy };
}

function edit(filePath: string): FunctionCall {
  return { id: 'edit', name: 'edit', args: { filePath, oldText: '[]', newText: '[1]' } };
}

test('raw text is retained verbatim; exact master edits honor isolated Agent and generic deny rules', async () => {
  const { file, session, operation, policy } = await fixture();
  const [, , , metadata] = await loaded;
  try {
    assert.equal(await file.read(file.filePath, session, operation), ' {"replaceAsBlocks": [] }\r\n');
    assert.equal(file.structuredFallback, false);
    assert.equal((await fs.stat(file.filePath)).mode & 0o777, 0o600);
    assert.equal((await fs.stat(path.dirname(file.filePath))).mode & 0o777, 0o700);
    metadata.installAgentMetadataSnapshotForWorker(session.agent, { isolated: true, isolatedNode: 'remote-node' });
    await file.edit(edit(file.filePath), session, operation);
    assert.match(await file.read(file.filePath, session, operation), /\[1\]/);
    policy.setToolAuthorizationPolicyForTests({ version: 1, defaultAction: 'allow', rules: [{
      id: 'deny-master-edit', enabled: true, action: 'deny', match: { tool: { source: 'node', name: 'edit' }, targetNode: 'master' },
    }] });
    await assert.rejects(file.edit({ ...edit(file.filePath), args: { filePath: file.filePath, oldText: '[1]', newText: '[]' } }, session, operation), /denies/);
    assert.match(await file.read(file.filePath, session, operation), /\[1\]/);
    policy.setToolAuthorizationPolicyForTests({ version: 1, defaultAction: 'allow', rules: [] });
    metadata.installAgentMetadataSnapshotForWorker(session.agent, { isolated: true, isolatedNode: 'remote-node', toolRules: [{ source: 'node', node: 'master', tool: 'edit', effect: 'deny' }] });
    await assert.rejects(file.edit(edit(file.filePath), session, operation), /Agent tool rule denies/);
  } finally {
    metadata.installAgentMetadataSnapshotForWorker(session.agent, {});
    policy.setToolAuthorizationPolicyForTests(undefined);
    await file.cleanup();
  }
});

test('only the current exact path, Session object and operation can read or edit; patches cannot add/delete/mix targets', async () => {
  const { file, session, operation } = await fixture();
  try {
    for (const wrongPath of [path.join(path.dirname(file.filePath), 'other.json'), file.filePath.replace('/plan.json', '/sub/../plan.json'), `${file.filePath}/../plan.json`]) {
      await assert.rejects(file.read(wrongPath, session, operation), /Only the pending/);
      await assert.rejects(file.edit(edit(wrongPath), session, operation), /Only the pending/);
    }
    await assert.rejects(file.read(file.filePath, { ...session }, operation), /Only the pending/);
    await assert.rejects(file.read(file.filePath, session, {}), /Only the pending/);
    for (const body of [`*** Delete File: ${file.filePath}`, `*** Add File: ${file.filePath}\n+oops`, `*** Update File: ${file.filePath}\n@@\n-[]\n+[1]\n*** Delete File: other`]) {
      await assert.rejects(file.edit({ id: 'patch', name: 'apply_patch', args: { input: `*** Begin Patch\n${body}\n*** End Patch` } }, session, operation), /Repair patches/);
    }
    await file.edit({ id: 'patch', name: 'apply_patch', args: { input: `*** Begin Patch\n*** Update File: ${file.filePath}\n@@\n- {"replaceAsBlocks": [] }\n+ {"replaceAsBlocks": [1] }\n*** End Patch` } }, session, operation);
    assert.match(await file.read(file.filePath, session, operation), /\[1\]/);
  } finally { await file.cleanup(); }
  assert.equal(await fs.pathExists(file.filePath), false);
  assert.equal(await fs.pathExists(path.dirname(file.filePath)), false);
  await assert.rejects(file.read(file.filePath, session, operation), /Only the pending/);
});

test('symlink, hardlink, replaced inode and permissions are rejected before file submission or edit', async () => {
  for (const change of ['symlink', 'hardlink', 'replace', 'mode'] as const) {
    const { file, session, operation } = await fixture();
    const victim = path.join(root, `victim-${change}.json`);
    await fs.writeFile(victim, 'victim');
    try {
      if (change === 'symlink') { await fs.unlink(file.filePath); await fs.symlink(victim, file.filePath); }
      if (change === 'hardlink') await fs.link(file.filePath, `${file.filePath}.link`);
      if (change === 'replace') { await fs.unlink(file.filePath); await fs.writeFile(file.filePath, 'replacement', { mode: 0o600 }); }
      if (change === 'mode') await fs.chmod(file.filePath, 0o644);
      await assert.rejects(file.read(file.filePath, session, operation), /replaced or its permissions/);
      await assert.rejects(file.edit(edit(file.filePath), session, operation), /replaced or its permissions/);
      assert.equal(await fs.readFile(victim, 'utf8'), 'victim');
    } finally {
      await fs.remove(`${file.filePath}.link`);
      await file.cleanup();
    }
  }
});

test('descriptor writes never follow a symlink substituted between the last check and write', async () => {
  const { file, session, operation } = await fixture();
  const victim = path.join(root, 'race-victim.json');
  await fs.writeFile(victim, 'victim');
  const handle = (file as any).file;
  const write = handle.write.bind(handle);
  let swapped = false;
  handle.write = async (...args: any[]) => {
    if (!swapped) {
      swapped = true;
      await fs.unlink(file.filePath);
      await fs.symlink(victim, file.filePath);
    }
    return write(...args);
  };
  try {
    await assert.rejects(file.edit(edit(file.filePath), session, operation), /replaced or its permissions/);
    assert.equal(swapped, true);
    assert.equal(await fs.readFile(victim, 'utf8'), 'victim');
  } finally { await file.cleanup(); }
});

test('structured-only providers have an explicit fallback, while malformed calls without raw text do not fabricate it', async () => {
  const { file, session, operation, repair } = await fixture();
  await file.cleanup();
  const fallback = await repair.CompactPlanRepairFile.create({ id: 'structured', name: 'submit_compact_plan', args: { replaceAsBlocks: [] as unknown[] } }, session, operation);
  try {
    assert.equal(fallback.structuredFallback, true);
    assert.deepEqual(JSON.parse(await fallback.read(fallback.filePath, session, operation)), { replaceAsBlocks: [] });
    await assert.rejects(repair.CompactPlanRepairFile.create({ id: 'broken', name: 'submit_compact_plan', args: {}, argsParseError: 'invalid' }, session, operation), /Raw compact arguments are unavailable/);
  } finally { await fallback.cleanup(); }
  assert.equal(repair.compactPlanSubmissionUsesFile({ replaceAsBlocks: [] as unknown[] }), false);
  assert.equal(repair.compactPlanSubmissionUsesFile({ argsFilePath: '/pending.json' }), true);
  for (const args of [{ argsFilePath: '/pending.json', replaceAsBlocks: [] as unknown[] }, { argsFilePath: '/pending.json', preserveMessages: [] as number[] }, { argsFilePath: '' }, { argsFilePath: null }]) {
    assert.throws(() => repair.compactPlanSubmissionUsesFile(args), /Supply argsFilePath alone/);
  }
});

test('repair creation rejects an Agent temporary-directory symlink rather than saving arguments outside it', async () => {
  const { file, session, operation, repair, config } = await fixture();
  await file.cleanup();
  const temp = path.join(config.getAgentDir(session.agent), '.temp');
  const moved = `${temp}-original`;
  const external = path.join(root, 'outside-agent');
  await fs.ensureDir(external);
  await fs.rename(temp, moved);
  await fs.symlink(external, temp);
  try {
    await assert.rejects(repair.CompactPlanRepairFile.create({ id: 'raw', name: 'submit_compact_plan', args: {}, rawArgsText: '{' }, session, operation), /must be inside the current agent directory/);
    assert.deepEqual(await fs.readdir(external), []);
  } finally { await fs.unlink(temp); await fs.rename(moved, temp); }
});
