import test from 'node:test';
import assert from 'node:assert/strict';

import { listSkills, loadSkillDocuments } from './skills';

test('global ToolScript skills are visible and loadable', async () => {
  const skills = await listSkills({ agentName: 'main' });
  const names = skills.map(skill => skill.name);

  assert.ok(names.includes('toolscript-automation'));
  assert.ok(names.includes('toolscript-managed-controller'));
  assert.ok(names.includes('isolated-worker'));
  assert.ok(names.includes('agent-skill-creator'));
  assert.ok(names.includes('web-search'));
  assert.ok(!names.includes('ask-gemini'));
  assert.ok(!names.includes('agent-skill-creator/references/examples/weekly-crm-report'));
  assert.ok(!names.includes('agent-skill-creator/docs/superpowers/plans/2026-05-27-agent-skill-creator-v5-artifacts-first'));

  const automation = await loadSkillDocuments('toolscript-automation', { agentName: 'main' });
  const automationText = automation.documents.map(doc => doc.content).join('\n\n');
  assert.match(automationText, /run_script/);
  assert.match(automationText, /start_toolscript_run/);
  assert.match(automationText, /call_tool\(/);

  const managed = await loadSkillDocuments('toolscript-managed-controller', { agentName: 'main' });
  const managedText = managed.documents.map(doc => doc.content).join('\n\n');
  assert.match(managedText, /open_managed_session/);
  assert.match(managedText, /wait_for_managed_event/);
  assert.match(managedText, /session_step/);

  const isolatedWorker = await loadSkillDocuments('isolated-worker', { agentName: 'main' });
  assert.match(isolatedWorker.documents[0].content, /create_isolated_worker\.py/);
  assert.match(isolatedWorker.documents[0].content, /createMainSession=false/);
  assert.match(isolatedWorker.documents[0].content, /not a transaction/);
  assert.ok(isolatedWorker.info.resourceFiles.includes('create_isolated_worker.py'));
  assert.ok(isolatedWorker.info.resourceFiles.includes('tests/test_create_isolated_worker.py'));

  const creator = await loadSkillDocuments('agent-skill-creator', { agentName: 'main' });
  assert.deepEqual(creator.info.documentFiles, ['SKILL.md']);
  assert.equal(creator.documents.length, 1);
  assert.match(creator.documents[0].content, /Foxwarm-specific rules/);
  assert.ok(creator.info.resourceFiles.includes('references/examples/weekly-crm-report/SKILL.md'));
  assert.ok(creator.info.resourceFiles.includes('scripts/validate.py'));

  const webSearch = await loadSkillDocuments('web-search', { agentName: 'main' });
  assert.match(webSearch.documents[0].content, /formerly ask-gemini/);
  assert.ok(webSearch.info.resourceFiles.includes('web-search.js'));
});
