import * as skills from '../skills';
import { requireNotIsolated } from '../isolatedCheck';
import { ToolArgs, ToolContext } from './helpers';

export async function tool_list_skills(args: ToolArgs = {}, ctx?: ToolContext) {
  const agentName = typeof args.agentName === 'string' && args.agentName.trim()
    ? args.agentName.trim()
    : (ctx?.session?.agent || 'main');
  const skillList = await skills.listSkills({ agentName });

  if (skillList.length === 0) {
    return `No skills found for agent "${agentName}".`;
  }

  let result = `Found ${skillList.length} skill(s) for agent "${agentName}":\n\n`;
  for (const skill of skillList) {
    result += `- **${skill.name}**`;
    result += ` [${skills.formatSkillSourceLabel(skill)}]`;
    if (skill.description) {
      result += ` - ${skill.description}`;
    }
    if (skill.documentFiles.length > 0) {
      result += ` (${skill.documentFiles.length} document${skill.documentFiles.length > 1 ? 's' : ''})`;
    }
    result += '\n';
  }

  return result;
}

export async function tool_load_skill(args: ToolArgs, ctx?: ToolContext) {
  await requireNotIsolated(ctx, 'load_skill');
  const { skillName } = args;
  const agentName = typeof args.agentName === 'string' && args.agentName.trim()
    ? args.agentName.trim()
    : (ctx?.session?.agent || 'main');

  if (!skillName || typeof skillName !== 'string') {
    throw new Error('skillName is required');
  }

  const { info, documents } = await skills.loadSkillDocuments(skillName, { agentName });

  let result = `Skill: ${info.name}`;
  if (info.description) {
    result += `\nDescription: ${info.description}`;
  }
  result += `\nSource: ${skills.formatSkillSourceLabel(info)}`;
  result += `\nMetadata: ${info.metadataPath}`;

  if (documents.length === 0) {
    return result + '\n\n(No skill documents found.)';
  }

  result += '\n\n';
  for (const document of documents) {
    result += `FILE: ${document.filePath}\n${document.content}\n\n`;
  }

  return result.trimEnd();
}
