import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';
import { FunctionSnapshot, Monty } from '@pydantic/monty';

import { listSkills, loadSkillDocuments } from './skills';
import { definitions } from './tools/definitions';

test('global ToolScript skills are visible and loadable', async () => {
  const skills = await listSkills({ agentName: 'main' });
  const names = skills.map(skill => skill.name);

  assert.ok(names.includes('toolscript-automation'));
  assert.ok(names.includes('toolscript-managed-controller'));
  assert.ok(names.includes('isolated-worker'));
  assert.ok(names.includes('agent-skill-creator'));
  assert.ok(names.includes('web-search'));
  assert.ok(names.includes('mcp-management'));
  assert.ok(!names.includes('ask-gemini'));
  assert.ok(!names.includes('agent-skill-creator/references/examples/weekly-crm-report'));
  assert.ok(!names.includes('agent-skill-creator/docs/superpowers/plans/2026-05-27-agent-skill-creator-v5-artifacts-first'));

  const automation = await loadSkillDocuments('toolscript-automation', { agentName: 'main' });
  const automationText = automation.documents.map(doc => doc.content).join('\n\n');
  assert.match(automationText, /run_script/);
  assert.match(automationText, /mode:\s*["']background["']/);
  assert.doesNotMatch(automationText, /start_toolscript_run/);
  assert.match(automationText, /call_tool\(/);
  assert.match(automationText, /Every ToolScript defines `main\(args\)`/);
  assert.match(automationText, /helpers may be defined before or after `main\(args\)`/i);
  assert.match(automationText, /operations that ask the host for files, environment, working-directory, clock, or process state are rejected/i);
  assert.doesNotMatch(automationText, /200,000 allocations/i);
  assert.doesNotMatch(automationText, /should now|\blegacy\b|\bformerly\b|\bstill\b/i);

  const automationExample = await fs.readFile(
    path.join(__dirname, '..', 'examples', 'toolscript', 'automation_basic.py'),
    'utf8',
  );
  const builtinReferences = Array.from(
    `${automationText}\n${automationExample}`.matchAll(/builtin:([A-Za-z0-9_-]+)/g),
    match => match[1],
  );
  const knownBuiltins = new Set(definitions.map(definition => definition.name));
  assert.deepEqual(
    builtinReferences.filter(name => !knownBuiltins.has(name)),
    [],
    'ToolScript skill/examples must not reference removed builtin tools',
  );
  assert.doesNotMatch(automationExample, /builtin:list_files/);

  const managed = await loadSkillDocuments('toolscript-managed-controller', { agentName: 'main' });
  const managedText = managed.documents.map(doc => doc.content).join('\n\n');
  assert.match(managedText, /open_managed_session/);
  assert.match(managedText, /wait_for_managed_event/);
  assert.match(managedText, /session_step/);

  const isolatedWorker = await loadSkillDocuments('isolated-worker', { agentName: 'main' });
  assert.match(isolatedWorker.documents[0].content, /create_isolated_worker\.py/);
  assert.match(isolatedWorker.documents[0].content, /createMainSession:\s*false/);
  assert.match(isolatedWorker.documents[0].content, /not transactional/);
  assert.ok(isolatedWorker.info.resourceFiles.includes('create_isolated_worker.py'));
  assert.ok(isolatedWorker.info.resourceFiles.includes('tests/test_create_isolated_worker.py'));

  const creator = await loadSkillDocuments('agent-skill-creator', { agentName: 'main' });
  assert.deepEqual(creator.info.documentFiles, ['SKILL.md']);
  assert.equal(creator.documents.length, 1);
  assert.match(creator.documents[0].content, /Foxwarm-specific rules/);
  assert.ok(creator.info.resourceFiles.includes('references/examples/weekly-crm-report/SKILL.md'));
  assert.ok(creator.info.resourceFiles.includes('scripts/validate.py'));

  const webSearch = await loadSkillDocuments('web-search', { agentName: 'main' });
  assert.match(webSearch.documents[0].content, /direct CLI.*forbidden from isolated/is);
  assert.match(webSearch.documents[0].content, /mcp:betabot-web-search\/web_search/);
  assert.match(webSearch.documents[0].content, /no secrets, credentials, private data/i);
  assert.match(webSearch.documents[0].content, /untrusted external reference/i);
  assert.ok(webSearch.info.resourceFiles.includes('web-search.js'));
  assert.ok(webSearch.info.resourceFiles.includes('web-search-mcp.js'));
  assert.ok(webSearch.info.resourceFiles.includes('web-search-mcp.test.js'));

  const mcpManagement = await loadSkillDocuments('mcp-management', { agentName: 'main' });
  const mcpText = mcpManagement.documents[0].content;
  assert.match(mcpText, /builtin:mcp_config/);
  assert.match(mcpText, /no Foxwarm restart is required/i);
  assert.match(mcpText, /Do \*\*not\*\* manually edit the MCP state\/config file/i);
  assert.match(mcpText, /builtin:list_mcp_servers/);
  assert.match(mcpText, /streamable-http/);
  assert.match(mcpText, /Never print.*real tokens/i);
});

test('bundled code-index ToolScript starts under the locked Monty runtime', async () => {
  const codeIndex = await loadSkillDocuments('code-index', { agentName: 'main' });
  const scriptPath = path.join(codeIndex.info.dir, 'generate_code_index.py');
  const source = await fs.readFile(scriptPath, 'utf8');
  const pool = await Monty.create({ minProcesses: 1, maxProcesses: 1 });
  const session = await pool.checkout({ scriptName: 'generate_code_index.py' });

  try {
    let progress: any = await session.feedStart(`${source.trimEnd()}\n\nmain(args)\n`, {
      inputs: {
        args: {
          source: 'project',
          phase: 'plan',
          files: ['src/main.ts'],
        },
      },
      printCallback: () => {},
    });

    assert.ok(progress instanceof FunctionSnapshot);
    assert.equal(progress.functionName, 'call_tool');
    assert.equal(progress.args[0], 'exec');
    assert.equal((progress.args[1] as Map<string, unknown>)?.get('command'), 'pwd -P');

    progress = await progress.resume('/workspace\n');
    assert.ok(progress instanceof FunctionSnapshot);
    assert.equal(progress.functionName, 'call_tool');
    assert.equal(progress.args[0], 'exec');
    assert.match(String((progress.args[1] as Map<string, unknown>)?.get('command')), /\$HOME/);

    progress = await progress.resume('/home/toolscript\n');
    assert.ok(progress instanceof FunctionSnapshot);
    assert.equal(progress.functionName, 'call_tool');
    assert.equal(progress.args[0], 'exec');
    assert.equal(
      (progress.args[1] as Map<string, unknown>)?.get('command'),
      "mkdir -p '/home/toolscript/code-index/project/units' '/home/toolscript/code-index/project/modules' '/home/toolscript/code-index/project/threads'",
    );

    progress = await progress.resume('');
    assert.ok(progress instanceof FunctionSnapshot);
    assert.equal(progress.functionName, 'call_tool');
    assert.equal(progress.args[0], 'exec');
    assert.equal(
      (progress.args[1] as Map<string, unknown>)?.get('command'),
      "wc -l < '/workspace/project/src/main.ts' 2>/dev/null || echo 0",
    );
  } finally {
    await session.close();
    await pool.close();
  }
});
