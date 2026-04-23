import test from 'node:test';
import assert from 'node:assert/strict';

import { listSkills, loadSkillDocuments } from './skills';

test('global ToolScript skills are visible and loadable', async () => {
  const skills = await listSkills({ agentName: 'main' });
  const names = skills.map(skill => skill.name);

  assert.ok(names.includes('toolscript_automation'));
  assert.ok(names.includes('toolscript_managed_controller'));

  const automation = await loadSkillDocuments('toolscript_automation', { agentName: 'main' });
  const automationText = automation.documents.map(doc => doc.content).join('\n\n');
  assert.match(automationText, /run_script/);
  assert.match(automationText, /start_toolscript_run/);
  assert.match(automationText, /call_tool\(/);

  const managed = await loadSkillDocuments('toolscript_managed_controller', { agentName: 'main' });
  const managedText = managed.documents.map(doc => doc.content).join('\n\n');
  assert.match(managedText, /open_managed_session/);
  assert.match(managedText, /wait_for_managed_event/);
  assert.match(managedText, /session_step/);
});