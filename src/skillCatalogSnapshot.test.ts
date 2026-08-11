import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'fs-extra';
import path from 'path';
import { COMMANDS } from './commands';
import * as llm from './llm';
import * as skillCore from './skills';
import * as tools from './tools';
import { tool_skill } from './toolsSessionAgent';
import { getAgentDir } from './config';
import * as sessionManager from './sessionManager';

function makeId(prefix: string): string {
  return `${prefix}_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

test('snapshot injects visible skills catalog, skill(load) loads docs, and attach/detach surfaces are removed or disabled', async () => {
  const agentName = makeId('skill_catalog_agent');
  const agentDir = getAgentDir(agentName);
  const skillName = 'visible-skill';
  const skillDir = path.join(agentDir, 'skills', skillName);
  const memoryOnlySkillName = 'legacy-memory-only-skill';
  const memoryOnlySkillDir = path.join(agentDir, 'skills', memoryOnlySkillName);
  const jsonOnlySkillName = 'json-only-skill';
  const jsonOnlySkillDir = path.join(agentDir, 'skills', jsonOnlySkillName);
  const nestedResourceSkillName = `${skillName}/references/example-child`;
  const uniqueBody = 'UNIQUE FULL SKILL DOC CONTENT';
  const legacyMemoryBody = 'LEGACY MEMORY DETAIL SHOULD NOT LOAD';
  const memoryOnlyBody = 'LEGACY MEMORY SKILL SHOULD NOT BE DISCOVERED';
  const nestedResourceBody = 'NESTED RESOURCE SKILL SHOULD BE A RESOURCE ONLY';
  const replies: string[] = [];

  await fs.ensureDir(path.join(skillDir, 'memory'));
  await fs.writeFile(path.join(skillDir, 'SKILL.md'), `---\nname: ${skillName}\ndescription: Analyze visible-skill tasks\n---\n# ${skillName}\n\n${uniqueBody}\n`, 'utf8');
  await fs.writeFile(path.join(skillDir, 'memory', 'DETAILS.md'), legacyMemoryBody, 'utf8');
  await fs.ensureDir(path.join(skillDir, 'references', 'example-child'));
  await fs.writeFile(path.join(skillDir, 'references', 'example-child', 'SKILL.md'), `---\nname: example-child\ndescription: Should be listed as a resource only\n---\n# example-child\n\n${nestedResourceBody}\n`, 'utf8');
  await fs.writeFile(path.join(skillDir, 'references', 'METHOD.md'), 'Resource method details', 'utf8');
  await fs.ensureDir(path.join(memoryOnlySkillDir, 'memory'));
  await fs.writeFile(path.join(memoryOnlySkillDir, 'memory', 'SKILL.md'), `---\nname: ${memoryOnlySkillName}\ndescription: Should not be visible\n---\n# ${memoryOnlySkillName}\n\n${memoryOnlyBody}\n`, 'utf8');
  await fs.ensureDir(jsonOnlySkillDir);
  await fs.writeJson(path.join(jsonOnlySkillDir, 'skill.json'), { name: jsonOnlySkillName, description: 'Should not be visible' });

  try {
    const snapshot = await llm.buildSessionSystemPromptSnapshot({ agentName, systemPromptFiles: [] });
    assert.match(snapshot, /<available_skills>/);
    assert.match(snapshot, /call skill with action="load"/);
    assert.match(snapshot, new RegExp(`<name>${skillName}</name>`));
    assert.match(snapshot, /<name>timer-automation<\/name>/);
    assert.match(snapshot, /<name>webui-markers<\/name>/);
    assert.match(snapshot, /presenting a real Git commit/);
    assert.match(snapshot, /Analyze visible-skill tasks/);
    assert.doesNotMatch(snapshot, new RegExp(uniqueBody));

    const loadedSkill = await tool_skill({ action: 'load', skillName, agentName }, {});
    assert.match(String(loadedSkill), new RegExp(uniqueBody));
    assert.doesNotMatch(String(loadedSkill), new RegExp(legacyMemoryBody));
    assert.doesNotMatch(String(loadedSkill), new RegExp(nestedResourceBody));
    assert.match(String(loadedSkill), /Skill directory:/);
    assert.match(String(loadedSkill), /Skill resources/);
    assert.match(String(loadedSkill), /references\/METHOD\.md/);
    assert.match(String(loadedSkill), /references\/example-child\/SKILL\.md/);
    assert.match(String(loadedSkill), /FILE:/);

    const loadedTimerSkill = await tool_skill({ action: 'load', skillName: 'timer-automation', agentName }, {});
    assert.match(String(loadedTimerSkill), /create_timer/);
    assert.match(String(loadedTimerSkill), /update_timer/);
    assert.match(String(loadedTimerSkill), /list_timers/);
    assert.match(String(loadedTimerSkill), /day-of-month `L`/);
    assert.match(String(loadedTimerSkill), /`W` .*not supported/);
    assert.doesNotMatch(String(loadedTimerSkill), /memory\//);

    const loadedMarkerSkill = await tool_skill({ action: 'load', skillName: 'webui-markers', agentName }, {});
    assert.match(String(loadedMarkerSkill), /<foxwarm-commit node=/);
    assert.match(String(loadedMarkerSkill), /actually been created/);
    assert.match(String(loadedMarkerSkill), /Malformed markers are inert/);

    const loadedDocuments = await skillCore.loadSkillDocuments(skillName, { agentName });
    assert.deepEqual(loadedDocuments.info.documentFiles, ['SKILL.md']);
    assert.deepEqual(loadedDocuments.documents.map(doc => path.relative(loadedDocuments.info.dir, doc.filePath)), ['SKILL.md']);
    assert.ok(loadedDocuments.info.resourceFiles.includes('references/METHOD.md'));
    assert.ok(loadedDocuments.info.resourceFiles.includes('references/example-child/SKILL.md'));
    assert.ok(!loadedDocuments.info.resourceFiles.includes('memory/DETAILS.md'));

    const skillNames = (await skillCore.listSkills({ agentName })).map(skill => skill.name);
    assert.ok(skillNames.includes(skillName));
    assert.ok(!skillNames.includes(memoryOnlySkillName));
    assert.ok(!skillNames.includes(jsonOnlySkillName));
    assert.ok(!skillNames.includes(nestedResourceSkillName));
    await assert.rejects(
      () => skillCore.loadSkillDocuments(memoryOnlySkillName, { agentName }),
      /not found|Expected/i,
    );
    await assert.rejects(
      () => skillCore.loadSkillDocuments(jsonOnlySkillName, { agentName }),
      /not found|Expected/i,
    );
    await assert.rejects(
      () => skillCore.loadSkillDocuments(nestedResourceSkillName, { agentName }),
      /bundled resource|not independently loadable/i,
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

test('web-search catalog metadata marks the skill as fallback-only', async () => {
  const skill = (await skillCore.listSkills({ agentName: 'main' })).find(entry => entry.name === 'web-search');
  assert.ok(skill, 'bundled web-search skill should be discoverable');
  assert.match(skill.description, /fallback-only/i);
  assert.match(skill.description, /built-in\/native web search/i);
  assert.match(skill.description, /isolated session\/environment/i);

  const loaded = await skillCore.loadSkillDocuments('web-search', { agentName: 'main' });
  const document = loaded.documents.find(entry => entry.filePath.endsWith('/SKILL.md'));
  assert.ok(document, 'bundled web-search entry document should load');
  assert.match(document.content, /Do not load or run this skill when the current model\/provider already exposes built-in\/native web search/i);
  assert.match(document.content, /Do not use this skill from an isolated session or environment/i);
});

test('snapshot skill catalog uses compact escaped XML and reports the selected source after precedence', async () => {
  await sessionManager.loadSessions();

  const inheritedAgentName = makeId('skill_catalog_parent');
  const agentName = makeId('skill_catalog_child');
  const inheritedAgentDir = getAgentDir(inheritedAgentName);
  const agentDir = getAgentDir(agentName);
  const inheritedOnlySkill = 'inherited-only-skill';
  const localOnlySkill = 'local-only-skill';
  const shadowedSkill = 'shadowed-skill';
  const escapedSkill = 'xml&skill';

  async function writeSkill(baseDir: string, name: string, description: string): Promise<void> {
    const skillDir = path.join(baseDir, 'skills', name);
    await fs.ensureDir(skillDir);
    await fs.writeFile(
      path.join(skillDir, 'SKILL.md'),
      `---\ndescription: ${JSON.stringify(description)}\n---\n# ${name}\n`,
      'utf8',
    );
  }

  await fs.ensureDir(inheritedAgentDir);
  await fs.ensureDir(agentDir);
  await writeSkill(inheritedAgentDir, inheritedOnlySkill, 'Inherited description');
  await writeSkill(inheritedAgentDir, shadowedSkill, 'Inherited shadowed description');
  await writeSkill(agentDir, localOnlySkill, 'Local description');
  await writeSkill(agentDir, shadowedSkill, 'Local wins description');
  await writeSkill(agentDir, escapedSkill, 'Use <xml> & keep > escaped');
  await sessionManager.setAgentInherit(agentName, inheritedAgentName);

  try {
    const snapshot = await llm.buildSessionSystemPromptSnapshot({ agentName, systemPromptFiles: [] });
    const catalog = snapshot.match(/<available_skills>\n([\s\S]*?)<\/available_skills>/)?.[1] || '';
    const skillLines = catalog.trimEnd().split('\n');

    assert.ok(skillLines.length > 0);
    assert.ok(skillLines.every(line => /^  <skill><name>.*<\/name><description>.*<\/description><source>(?:agent-local|agent-inherited|global)<\/source><\/skill>$/.test(line)));
    assert.match(catalog, new RegExp(`<skill><name>${localOnlySkill}</name><description>Local description</description><source>agent-local</source></skill>`));
    assert.match(catalog, new RegExp(`<skill><name>${inheritedOnlySkill}</name><description>Inherited description</description><source>agent-inherited</source></skill>`));
    assert.match(catalog, /<skill><name>timer-automation<\/name><description>[^\n]*<\/description><source>global<\/source><\/skill>/);
    assert.match(catalog, new RegExp(`<skill><name>${shadowedSkill}</name><description>Local wins description</description><source>agent-local</source></skill>`));
    assert.doesNotMatch(catalog, /Inherited shadowed description/);
    assert.match(catalog, /<skill><name>xml&amp;skill<\/name><description>Use &lt;xml&gt; &amp; keep &gt; escaped<\/description><source>agent-local<\/source><\/skill>/);
    assert.doesNotMatch(catalog, /<skill>\s+<name>|<\/name>\s+<description>|<\/description>\s+<source>/);
  } finally {
    await sessionManager.setAgentInherit(agentName, undefined).catch(() => {});
    await fs.remove(agentDir).catch(() => {});
    await fs.remove(inheritedAgentDir).catch(() => {});
  }
});
