import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';
import {
  createAgentMetadataStore,
  getAgentMetadata,
  loadAgentMetadata,
  resetAgentMetadataForTests,
  setAgentMetadata,
  setAgentMetadataStoreForTests,
} from './agentMetadata';

async function withTempDir(run: (dirPath: string) => Promise<void>): Promise<void> {
  const dirPath = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-agent-metadata-'));
  try {
    await run(dirPath);
  } finally {
    resetAgentMetadataForTests();
    setAgentMetadataStoreForTests(null);
    await fs.remove(dirPath).catch(() => {});
  }
}

async function listBackupMatches(filePath: string): Promise<string[]> {
  const dir = path.dirname(filePath);
  const base = path.basename(filePath);
  const entries = await fs.readdir(dir).catch(() => [] as string[]);
  return entries.filter((name) => name === `${base}.bak` || name.startsWith(`${base}.`) && name.endsWith('.bak')).map((name) => path.join(dir, name));
}

test('agent metadata persistence uses lightweight no-backup writes', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'agents.json');
    setAgentMetadataStoreForTests(createAgentMetadataStore(filePath));
    resetAgentMetadataForTests();

    await setAgentMetadata('alpha-agent', { isolated: true, isolatedNode: 'sandbox-a', skills: ['ignored-skill'] } as any);
    await setAgentMetadata('beta-agent', { inherit: 'alpha-agent' });
    resetAgentMetadataForTests();
    await loadAgentMetadata();

    assert.deepEqual(getAgentMetadata('alpha-agent'), {
      isolated: true,
      isolatedNode: 'sandbox-a',
    });
    assert.deepEqual(getAgentMetadata('beta-agent'), {
      inherit: 'alpha-agent',
    });

    const rewritten = await fs.readJson(filePath);
    assert.deepEqual(Object.keys(rewritten).sort(), ['alpha-agent', 'beta-agent']);
    assert.deepEqual(createAgentMetadataStore(filePath).listCandidatePaths(), [filePath]);
    assert.deepEqual(await listBackupMatches(filePath), []);
  });
});
