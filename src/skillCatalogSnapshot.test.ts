import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';
import { COMMANDS } from './commands';
import * as llm from './llm';
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
  const uniqueBody = 'UNIQUE FULL SKILL DOC CONTENT';
  const replies: string[] = [];

  await fs.ensureDir(path.join(skillDir, 'memory'));
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: ${skillName}\ndescription: Analyze visible-skill tasks\n---\n# ${skillName}\n\n${uniqueBody}\n`, 'utf8');
  await fs.writeFile(path.join(skillDir, 'memory', 'DETAILS.md'), 'Extra details', 'utf8');

  try {
    const snapshot = await llm.buildSessionSystemPromptSnapshot({ agentName, systemPromptFiles: [] });
    assert.match(snapshot, /<available_skills>/);
    assert.match(snapshot, new RegExp(`<name>${skillName}</name>`));
    assert.match(snapshot, /Analyze visible-skill tasks/);
    assert.doesNotMatch(snapshot, new RegExp(uniqueBody));

    const loadedSkill = await tool_load_skill({ skillName, agentName }, {});
    assert.match(String(loadedSkill), new RegExp(uniqueBody));
    assert.match(String(loadedSkill), /FILE:/);

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