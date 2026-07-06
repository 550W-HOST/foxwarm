import test, { after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import os from 'os';
import path from 'path';

const DATA_ROOT = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwarm-session-memory-test-'));
process.env.FOXWARM_DATA_DIR = DATA_ROOT;

after(async () => {
  await fs.remove(DATA_ROOT);
});

let modulePromise: Promise<{
  llm: typeof import('../llm');
  sessionManager: typeof import('../sessionManager');
  config: typeof import('../config');
}> | undefined;

async function loadModules() {
  if (!modulePromise) {
    modulePromise = Promise.all([
      import('../llm'),
      import('../sessionManager'),
      import('../config'),
    ]).then(([llm, sessionManager, config]) => ({ llm, sessionManager, config }));
  }
  return modulePromise;
}

function uniqueName(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

test('framework root 00_SYSTEM takes precedence over legacy fallback and dynamic dirs omit agent_memory', async () => {
  const { llm, config } = await loadModules();
  const legacyMainSystemPrompt = path.join(config.MAIN_AGENT_MEMORY_DIR, '00_SYSTEM.md');

  assert.equal(await fs.pathExists(config.AGENTS_SYSTEM_PROMPT_TEMPLATE_PATH), true);
  assert.equal(await fs.pathExists(path.join(config.BASE_DIR, 'templates', 'main', 'memory', '00_SYSTEM.md')), false);

  await fs.ensureDir(config.AGENTS_DIR);
  await fs.ensureDir(path.dirname(legacyMainSystemPrompt));
  await fs.writeFile(config.AGENTS_SYSTEM_PROMPT_PATH, 'ROOT_FRAMEWORK_SYSTEM_PROMPT\n', 'utf8');
  await fs.writeFile(legacyMainSystemPrompt, 'LEGACY_MAIN_SYSTEM_PROMPT\n', 'utf8');

  const rootSnapshot = await llm.buildSessionSystemPromptSnapshot({ agentName: 'main', sessionId: 'main' });
  assert.match(rootSnapshot, /ROOT_FRAMEWORK_SYSTEM_PROMPT/);
  assert.doesNotMatch(rootSnapshot, /LEGACY_MAIN_SYSTEM_PROMPT/);
  assert.match(rootSnapshot, /--- DIRECTORIES ---/);
  assert.match(rootSnapshot, /agent_folder:/);
  assert.doesNotMatch(rootSnapshot, /agent_memory:/);
  assert.match(rootSnapshot, /--- EARLIER CONTEXT RECALL ---/);
  assert.match(rootSnapshot, /layered context/);
  assert.match(rootSnapshot, /compacted into CTX-BLOCK summaries/);
  assert.match(rootSnapshot, /Compaction is system-initiated/);
  assert.match(rootSnapshot, /temporary compact thread/);
  assert.match(rootSnapshot, /foxwarm-system kind="session-boundary" event="compact-completed"/);
  assert.match(rootSnapshot, /Block levels are hierarchical/);
  assert.match(rootSnapshot, /not agent memory/);
  assert.match(rootSnapshot, /routine process notes/);
  assert.match(rootSnapshot, /long-lived stable rules/);

  await fs.remove(config.AGENTS_SYSTEM_PROMPT_PATH);
  const fallbackSnapshot = await llm.buildSessionSystemPromptSnapshot({ agentName: 'main', sessionId: 'main' });
  assert.match(fallbackSnapshot, /LEGACY_MAIN_SYSTEM_PROMPT/);
  assert.doesNotMatch(fallbackSnapshot, /ROOT_FRAMEWORK_SYSTEM_PROMPT/);
});

test('memory frontmatter include-session/exclude-session filters by canonical session id', async () => {
  const { llm, config } = await loadModules();
  const agentName = uniqueName('frontmatter_agent');
  const sessionId = `${agentName}/target-a`;
  const memoryDir = config.getAgentMemoryDir(agentName);

  await fs.ensureDir(memoryDir);
  await fs.writeFile(path.join(memoryDir, 'GENERAL.md'), '# General\nGENERAL_VISIBLE\n', 'utf8');
  await fs.writeFile(path.join(memoryDir, 'INCLUDE.md'), `---\ninclude-session: ${agentName}/target-*\n---\n# Include\nINCLUDE_VISIBLE\n`, 'utf8');
  await fs.writeFile(path.join(memoryDir, 'EXCLUDE.md'), `---\ninclude-session: ${agentName}/target-*\nexclude-session: ${agentName}/target-a\n---\nEXCLUDE_HIDDEN\n`, 'utf8');
  await fs.writeFile(path.join(memoryDir, 'NONMATCH.md'), '---\ninclude-session: other/**\n---\nNONMATCH_HIDDEN\n', 'utf8');
  await fs.writeFile(path.join(memoryDir, 'GLOB.md'), `---\ninclude-session:\n  - ${agentName}/**\n---\nGLOB_VISIBLE\n`, 'utf8');
  await fs.writeFile(path.join(memoryDir, 'PARSEFAIL.md'), '---\ninclude-session: [\n---\nPARSE_FAILURE_VISIBLE\n', 'utf8');
  await fs.writeFile(path.join(memoryDir, 'NODELIMITER.md'), '---\ninclude-session: other\nNO_DELIMITER_VISIBLE\n', 'utf8');

  const snapshot = await llm.buildSessionSystemPromptSnapshot({ agentName, sessionId });
  assert.match(snapshot, /GENERAL_VISIBLE/);
  assert.match(snapshot, /INCLUDE_VISIBLE/);
  assert.match(snapshot, /GLOB_VISIBLE/);
  assert.match(snapshot, /PARSE_FAILURE_VISIBLE/);
  assert.match(snapshot, /NO_DELIMITER_VISIBLE/);
  assert.doesNotMatch(snapshot, /EXCLUDE_HIDDEN/);
  assert.doesNotMatch(snapshot, /NONMATCH_HIDDEN/);
  assert.doesNotMatch(snapshot, /include-session: \[/);
});

test('session creation passes session id to snapshot builder and fork keeps parent snapshot', async () => {
  const { llm, sessionManager, config } = await loadModules();

  const agentName = uniqueName('sessionid_agent');
  const sessionName = 'created';
  const sessionId = `${agentName}/${sessionName}`;
  await sessionManager.createAgentWithMainSession({ agentName, createMainSession: false });
  await fs.writeFile(
    path.join(config.getAgentMemoryDir(agentName), 'SESSION_ONLY.md'),
    `---\ninclude-session: ${sessionId}\n---\nCREATE_SESSION_VISIBLE\n`,
    'utf8',
  );

  await sessionManager.createSessionInAgent({ agentName, sessionName });
  const createdSession = await sessionManager.getSession(sessionId);
  assert.match(createdSession.persistentMemorySnapshot, /CREATE_SESSION_VISIBLE/);

  const parentId = uniqueName('parent_nonfork');
  const childId = `${parentId}_child`;
  await fs.ensureDir(config.MAIN_AGENT_MEMORY_DIR);
  await fs.writeFile(
    path.join(config.MAIN_AGENT_MEMORY_DIR, 'CHILD_ONLY.md'),
    `---\ninclude-session: ${childId}\n---\nNONFORK_CHILD_VISIBLE\n`,
    'utf8',
  );
  const parentSession = await sessionManager.getSession(parentId);
  parentSession.agent = 'main';
  parentSession.persistentMemorySnapshot = await llm.buildSessionSystemPromptSnapshot({ agentName: 'main', sessionId: parentId });
  await sessionManager.saveSession(parentId);

  const actualChildId = await sessionManager.createChildSession(parentId, 'child', false);
  assert.equal(actualChildId, childId);
  const nonForkChild = await sessionManager.getSession(actualChildId);
  assert.match(nonForkChild.persistentMemorySnapshot, /NONFORK_CHILD_VISIBLE/);

  const forkParentId = uniqueName('parent_fork');
  const forkChildId = `${forkParentId}_fork`;
  const forkParent = await sessionManager.getSession(forkParentId);
  forkParent.agent = 'main';
  forkParent.persistentMemorySnapshot = await llm.buildSessionSystemPromptSnapshot({ agentName: 'main', sessionId: forkParentId });
  await sessionManager.saveSession(forkParentId);
  await fs.writeFile(
    path.join(config.MAIN_AGENT_MEMORY_DIR, 'FORK_CHILD_ONLY.md'),
    `---\ninclude-session: ${forkChildId}\n---\nFORK_CHILD_SHOULD_NOT_APPEAR\n`,
    'utf8',
  );

  const actualForkChildId = await sessionManager.createChildSession(forkParentId, 'fork', true);
  assert.equal(actualForkChildId, forkChildId);
  const forkChild = await sessionManager.getSession(actualForkChildId);
  assert.doesNotMatch(forkChild.persistentMemorySnapshot, /FORK_CHILD_SHOULD_NOT_APPEAR/);
});
