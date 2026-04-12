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

test('agent metadata persistence recovers from backup candidate after primary corruption', async () => {
  await withTempDir(async (dirPath) => {
    const filePath = path.join(dirPath, 'agents.json');
    setAgentMetadataStoreForTests(createAgentMetadataStore(filePath));
    resetAgentMetadataForTests();

    await setAgentMetadata('alpha-agent', { isolated: true, isolatedNode: 'sandbox-a', skills: ['ignored-skill'] } as any);
    await setAgentMetadata('beta-agent', { inherit: 'alpha-agent' });

    await fs.writeFile(filePath, '{broken-json');
    resetAgentMetadataForTests();
    await loadAgentMetadata();

    assert.deepEqual(getAgentMetadata('alpha-agent'), {
      isolated: true,
      isolatedNode: 'sandbox-a',
    });
    assert.deepEqual(getAgentMetadata('beta-agent'), {});

    const rewritten = await fs.readJson(filePath);
    assert.deepEqual(Object.keys(rewritten).sort(), ['alpha-agent']);
  });
});
