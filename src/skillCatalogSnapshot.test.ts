import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';
import { COMMANDS } from './commands';
import * as llm from './llm';
import * as skillCore from './skills';
import * as tools from './tools';
import { tool_load_skill } from './toolsSessionAgent';
import { getAgentDir } from './config';

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

test('snapshot injects visible skills catalog, load_skill still loads docs, and attach/detach surfaces are removed or disabled', async () => {
  const agentName = makeId('skill_catalog_agent');
  const agentDir = getAgentDir(agentName);
  const skillName = 'visible-skill';
  const skillDir = path.join(agentDir, 'skills', skillName);
  const memoryOnlySkillName = 'legacy-memory-only-skill';
  const memoryOnlySkillDir = path.join(agentDir, 'skills', memoryOnlySkillName);
  const uniqueBody = 'UNIQUE FULL SKILL DOC CONTENT';
  const legacyMemoryBody = 'LEGACY MEMORY DETAIL SHOULD NOT LOAD';
  const memoryOnlyBody = 'LEGACY MEMORY SKILL SHOULD NOT BE DISCOVERED';
  const replies: string[] = [];

  await fs.ensureDir(path.join(skillDir, 'memory'));
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: ${skillName}\ndescription: Analyze visible-skill tasks\n---\n# ${skillName}\n\n${uniqueBody}\n`, 'utf8');
  await fs.writeFile(path.join(skillDir, 'memory', 'DETAILS.md'), legacyMemoryBody, 'utf8');
  await fs.ensureDir(path.join(memoryOnlySkillDir, 'memory'));
  await fs.writeFile(path.join(memoryOnlySkillDir, 'memory', 'SKILL.md'), `---\nname: ${memoryOnlySkillName}\ndescription: Should not be visible\n---\n# ${memoryOnlySkillName}\n\n${memoryOnlyBody}\n`, 'utf8');

  try {
    const snapshot = await llm.buildSessionSystemPromptSnapshot({ agentName, systemPromptFiles: [] });
    assert.match(snapshot, /<available_skills>/);
    assert.match(snapshot, new RegExp(`<name>${skillName}</name>`));
    assert.match(snapshot, /Analyze visible-skill tasks/);
    assert.doesNotMatch(snapshot, new RegExp(uniqueBody));

    const loadedSkill = await tool_load_skill({ skillName, agentName }, {});
    assert.match(String(loadedSkill), new RegExp(uniqueBody));
    assert.doesNotMatch(String(loadedSkill), new RegExp(legacyMemoryBody));
    assert.match(String(loadedSkill), /FILE:/);

    const loadedDocuments = await skillCore.loadSkillDocuments(skillName, { agentName });
    assert.deepEqual(loadedDocuments.info.documentFiles, ['SKILL.md']);
    assert.deepEqual(loadedDocuments.documents.map(doc => path.relative(loadedDocuments.info.dir, doc.filePath)), ['SKILL.md']);

    const skillNames = (await skillCore.listSkills({ agentName })).map(skill => skill.name);
    assert.ok(skillNames.includes(skillName));
    assert.ok(!skillNames.includes(memoryOnlySkillName));
    await assert.rejects(
      () => skillCore.loadSkillDocuments(memoryOnlySkillName, { agentName }),
      /not found|Expected one of/i,
    );

    assert.equal(tools.definitions.some(def => def.name === 'attach_agent_skill'), false);
    assert.equal(tools.definitions.some(def => def.name === 'detach_agent_skill'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(tools, 'attach_agent_skill'), false);
    assert.equal(Object.prototype.hasOwnProperty.call(tools, 'detach_agent_skill'), false);

    await COMMANDS['/skill'].handler({ reply: (text: string) => { replies.push(String(text)); } } as any, [], undefined, undefined);
    const helpText = replies.pop() || '';
    assert.match(helpText, /\/skill list/);
    assert.doesNotMatch(helpText, /attach/i);

    await COMMANDS['/skill'].handler({ reply: (text: string) => { replies.push(String(text)); } } as any, ['attach', agentName, skillName], undefined, undefined);
    assert.match(replies.pop() || '', /no longer supported/i);
  } finally {
    await fs.remove(agentDir).catch(() => {});
  }
});