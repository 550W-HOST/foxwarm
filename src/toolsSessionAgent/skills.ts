import * as skills from '../skills';
import * as sessionManager from '../sessionManager';
import { ToolArgs, ToolContext } from './helpers';

function resolveSkillAgentName(args: ToolArgs, ctx?: ToolContext): string {
  return typeof args.agentName === 'string' && args.agentName.trim()
    ? args.agentName.trim()
    : (ctx?.session?.agent || 'main');
}

async function assertCanUseSkillAgent(agentName: string, ctx: ToolContext | undefined, operation: string): Promise<void> {
  if (!ctx?.sessionId) return;
  const session = ctx.session || await sessionManager.getExistingSession(ctx.sessionId);
  if (!sessionManager.isSessionEffectivelyIsolated(session)) return;

  const callerAgent = session?.agent || 'main';
  if (agentName !== callerAgent) {
    throw new Error(`Isolated session cannot ${operation} for agent "${agentName}". Use the current agent "${callerAgent}".`);
  }
}

function formatSkillResources(info: skills.SkillInfo): string {
  let result = `\nSkill directory: ${info.dir}`;
  result += '\nRelative paths in this skill are relative to the skill directory.';

  if (info.resourceFiles.length === 0) {
    return result;
  }

  result += '\n\nSkill resources (supporting files, not eagerly loaded):';
  for (const file of info.resourceFiles) {
    result += `\n- ${file}`;
  }
  if (info.resourceFilesTruncated) {
    result += '\n- ... (resource listing truncated)';
  }

  return result;
}

export async function tool_list_skills(args: ToolArgs = {}, ctx?: ToolContext) {
  const agentName = resolveSkillAgentName(args, ctx);
  await assertCanUseSkillAgent(agentName, ctx, 'list skills');
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
  const { skillName } = args;
  const agentName = resolveSkillAgentName(args, ctx);
  await assertCanUseSkillAgent(agentName, ctx, 'load skills');

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
  result += formatSkillResources(info);

  if (documents.length === 0) {
    return result + '\n\n(No skill documents found.)';
  }

  result += '\n\n';
  for (const document of documents) {
    result += `FILE: ${document.filePath}\n${document.content}\n\n`;
  }

  return result.trimEnd();
}
