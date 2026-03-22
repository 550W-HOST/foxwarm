import fs from 'fs-extra';
import path from 'path';
import * as sessionManager from './sessionManager';
import * as skills from './skills';
import * as timers from './timers';
import type { ChannelFile } from './channel';
import { getAgentDir } from './config';
import { logger } from './common';
import { AGENTS_DIR, COMPACT_PERCENT } from './config';
import { clearSessionTodo, normalizeRemindEvery, normalizeTodoText, setSessionTodo } from './session/todo';
import { formatSessionMessagesPreview } from './utils/messagePreview';
import { formatMessagePreviewText, formatPrefixedMultilineText } from './utils/messageFormat';
import { requireNotIsolated, checkChannelPermission, checkSendFilePermission, checkTimerPermission } from './isolatedCheck';

interface ToolContext {
  sessionId?: string;
  session?: any;
  broadcast?: (text: string, options?: any) => Promise<void>;
}

type ToolArgs = Record<string, any>;

function getSubconsciousPrimarySessionId(ctx?: ToolContext): string | undefined {
  return sessionManager.getSubconsciousPrimarySessionId(ctx?.session);
}

function assertAllowedSubconsciousTarget(ctx: ToolContext | undefined, targetSessionId: string | undefined, toolName: string): void {
  const primarySessionId = getSubconsciousPrimarySessionId(ctx);
  if (!primarySessionId) {
    return;
  }

  const resolvedTargetSessionId = targetSessionId || ctx?.sessionId;
  const selfSessionId = ctx?.sessionId;
  if (!resolvedTargetSessionId || (resolvedTargetSessionId !== primarySessionId && resolvedTargetSessionId !== selfSessionId)) {
    throw new Error(`Subconscious side sessions may only use ${toolName} with their primary session or themselves.`);
  }
}

const MIME_TYPE_BY_EXT: Record<string, string> = {
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.png': 'image/png',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.bmp': 'image/bmp',
  '.svg': 'image/svg+xml',
  '.pdf': 'application/pdf',
  '.txt': 'text/plain',
  '.md': 'text/markdown',
  '.json': 'application/json',
  '.zip': 'application/zip',
  '.tar': 'application/x-tar',
  '.gz': 'application/gzip',
};

function formatTimerTimestamp(timestamp?: number | null): string {
  if (!timestamp) return 'n/a';
  const date = new Date(timestamp);
  return Number.isNaN(date.getTime()) ? 'n/a' : date.toISOString();
}

function formatTimerSummary(timer: timers.TimerView): string {
  const mode = timer.mode === 'cron'
    ? `cron: ${timer.cron}`
    : `at: ${formatTimerTimestamp(timer.at)}`;
  const target = timer.newSession
    ? `new session (${timer.agentName || 'main'} / ${timer.sessionPrefix || 'timer'})`
    : `session ${timer.sessionId}`;

  return `Timer \`${timer.id}\` created.\nMode: ${mode}\nTarget: ${target}\nNext run: ${formatTimerTimestamp(timer.nextRunAt)}\nMessage: ${timer.message}`;
}

function resolveAgentPath(filePath: string, agentName: string = 'main'): string {
  if (path.isAbsolute(filePath)) {
    return filePath;
  }

  const agentDir = getAgentDir(agentName);
  const resolved = path.resolve(agentDir, filePath);
  if (!(resolved === agentDir || resolved.startsWith(agentDir + path.sep))) {
    throw new Error('Path traversal detected: cannot access files outside agent folder');
  }

  return resolved;
}

function detectMimeType(filePath: string): string {
  const ext = path.extname(filePath).toLowerCase();
  return MIME_TYPE_BY_EXT[ext] || 'application/octet-stream';
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0;
}

function formatArchivedMessagePreview(
  sessionId: string,
  records: Array<{ seq: number; message: any }>,
  meta: { totalMatched: number; startSeq?: number; endSeq?: number },
  previewLength: number,
): string {
  if (records.length === 0) {
    const rangeLabel = typeof meta.startSeq === 'number' || typeof meta.endSeq === 'number'
      ? ` for ${typeof meta.startSeq === 'number' ? `#${meta.startSeq}` : '?'}-${typeof meta.endSeq === 'number' ? `#${meta.endSeq}` : '?'}`
      : '';
    return `No archived messages found in session \`${sessionId}\`${rangeLabel}.`;
  }

  const rangeBits: string[] = [];
  if (typeof meta.startSeq === 'number') {
    rangeBits.push(`startSeq=#${meta.startSeq}`);
  }
  if (typeof meta.endSeq === 'number') {
    rangeBits.push(`endSeq=#${meta.endSeq}`);
  }
  const rangeLabel = rangeBits.length ? ` (${rangeBits.join(', ')})` : '';

  let result = `Archived messages for session \`${sessionId}\` - showing ${records.length} of ${meta.totalMatched} matched message(s)${rangeLabel}.\n\n`;
  for (const record of records) {
    const roleEmoji = record.message.role === 'user' ? '👤' : record.message.role === 'model' ? '🤖' : '🔧';
    const preview = formatMessagePreviewText(record.message, previewLength, {
      skipEphemeralSystem: true,
      skipRagMemorySnippets: true,
      skipThinking: true,
    });
    result += `${formatPrefixedMultilineText(`[#${record.seq}] ${roleEmoji} ${record.message.role}: `, preview)}\n`;
  }
  return result;
}


function formatArchivedBlockPreview(
  sessionId: string,
  records: Array<{ id: number; level: number; rawStartSeq: number; rawEndSeq: number; summary: string; sourceKind: string; sourceStart: number; sourceEnd: number; }>,
  meta: { totalMatched: number; startId?: number; endId?: number },
  previewLength: number,
): string {
  if (records.length === 0) {
    const rangeLabel = typeof meta.startId === 'number' || typeof meta.endId === 'number'
      ? ` for ${typeof meta.startId === 'number' ? `#${meta.startId}` : '?'}-${typeof meta.endId === 'number' ? `#${meta.endId}` : '?'}`
      : '';
    return `No archived blocks found in session \`${sessionId}\`${rangeLabel}.`;
  }

  const rangeBits: string[] = [];
  if (typeof meta.startId === 'number') rangeBits.push(`startId=#${meta.startId}`);
  if (typeof meta.endId === 'number') rangeBits.push(`endId=#${meta.endId}`);
  const rangeLabel = rangeBits.length ? ` (${rangeBits.join(', ')})` : '';

  let result = `Archived layered-context blocks for session \`${sessionId}\` - showing ${records.length} of ${meta.totalMatched} matched block(s)${rangeLabel}.

`;
  for (const record of records) {
    const prefix = `[B#${record.id}] L${record.level} raw#${record.rawStartSeq}${record.rawStartSeq === record.rawEndSeq ? '' : `-#${record.rawEndSeq}`} from ${record.sourceKind} ${record.sourceStart}-${record.sourceEnd}: `;
    result += `${formatPrefixedMultilineText(prefix, (record.summary || '').slice(0, previewLength) || '[empty summary]')}
`;
  }
  return result;
}

async function prepareChannelFile(filePath: string, ctx?: ToolContext): Promise<ChannelFile> {
  const agentName = ctx?.session?.agent || 'main';
  const fullPath = resolveAgentPath(filePath, agentName);
  const stats = await fs.stat(fullPath);
  if (!stats.isFile()) {
    throw new Error(`Not a file: ${filePath}`);
  }

  const mimeType = detectMimeType(fullPath);
  return {
    path: fullPath,
    name: path.basename(fullPath),
    mimeType,
    sizeBytes: stats.size,
    isImage: mimeType.startsWith('image/'),
  };
}

function formatSendFileSessionResult(targetSessionId: string, file: ChannelFile, result: sessionManager.FileDeliveryResult): string {
  const lines = [
    `File \`${file.name}\` sent for session \`${targetSessionId}\`.`,
    `Delivered: ${result.deliveredChannels.length}`,
  ];

  if (result.deliveredChannels.length) {
    lines.push(`Channels: ${result.deliveredChannels.map(id => `\`${id}\``).join(', ')}`);
  }

  if (result.skippedChannels.length) {
    lines.push(`Skipped: ${result.skippedChannels.map(item => `\`${item.channelId}\` (${item.reason})`).join(', ')}`);
  }

  if (result.failedChannels.length) {
    lines.push(`Failed: ${result.failedChannels.map(item => `\`${item.channelId}\` (${item.error})`).join(', ')}`);
  }

  return lines.join('\n');
}

export async function tool_create_child_session(args: ToolArgs, ctx: ToolContext) {
  await requireNotIsolated(ctx, 'create_child_session');
  const { suffix, fork = true, message, node, noFurtherAssistantReply } = args;

  if (!ctx || !ctx.sessionId) {
    throw new Error('Cannot create child session: missing context');
  }

  const currentSessionId = ctx.sessionId;
  const childSessionId = await sessionManager.createChildSession(currentSessionId, suffix, fork, { node });

  if (message) {
    sessionManager.sendToSession(childSessionId, message, currentSessionId).catch(err => {
      logger.error({ err, childSessionId }, 'Failed to send initial message to child session');
    });
    const output = `Child session created: \`${childSessionId}\` (${fork ? 'forked from parent' : 'new session'}). Initial message sent.`;
    return noFurtherAssistantReply
      ? { output, __toolLoopControl: { stopCurrentTurn: true } }
      : output;
  }

  const output = `Child session created: \`${childSessionId}\` (${fork ? 'forked from parent' : 'new session'})`;
  return noFurtherAssistantReply
    ? { output, __toolLoopControl: { stopCurrentTurn: true } }
    : output;
}

export async function tool_send_to_session(args: ToolArgs, ctx: ToolContext) {
  const { sessionId, message, noFurtherAssistantReply } = args;
  const fromSessionId = ctx?.sessionId;

  if (!sessionId || typeof sessionId !== 'string') {
    throw new Error('sessionId is required');
  }

  const subconsciousPrimarySessionId = getSubconsciousPrimarySessionId(ctx);
  if (subconsciousPrimarySessionId && sessionId !== subconsciousPrimarySessionId) {
    throw new Error('Subconscious side sessions may only send hints to their primary session.');
  }

  await sessionManager.sendToSession(sessionId, message, fromSessionId);
  if (subconsciousPrimarySessionId && fromSessionId) {
    await sessionManager.noteSubconsciousHintDelivered(fromSessionId, sessionId);
  }
  const output = `Message sent to session \`${sessionId}\``;
  return noFurtherAssistantReply
    ? { output, __toolLoopControl: { stopCurrentTurn: true } }
    : output;
}

export async function tool_send_to_channel(args: ToolArgs, ctx?: ToolContext) {
  const { channelId, message } = args;
  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required (format: platform:userId)');
  }
  if (!message || typeof message !== 'string') {
    throw new Error('message is required');
  }

  // Check isolated session channel permission
  if (ctx?.sessionId) {
    await checkChannelPermission(ctx.sessionId, channelId);
  }

  await sessionManager.sendToChannelById(channelId, message);
  return `Message sent to channel \`${channelId}\``;
}

export async function tool_send_file(args: ToolArgs, ctx?: ToolContext) {
  const { sessionId, channelId, filePath } = args;
  const hasSessionId = isNonEmptyString(sessionId);
  const hasChannelId = isNonEmptyString(channelId);

  if (hasSessionId === hasChannelId) {
    throw new Error('Exactly one of sessionId or channelId is required');
  }
  if (!isNonEmptyString(filePath)) {
    throw new Error('filePath is required');
  }

  const caption = isNonEmptyString(args.caption)
    ? args.caption.trim()
    : (isNonEmptyString(args.text) ? args.text.trim() : undefined);

  if (ctx?.sessionId) {
    await checkSendFilePermission(ctx.sessionId, {
      channelId: hasChannelId ? channelId.trim() : undefined,
      targetSessionId: hasSessionId ? sessionId.trim() : undefined,
    });
  }

  const file = await prepareChannelFile(filePath.trim(), ctx);

  if (hasChannelId) {
    const normalizedChannelId = channelId.trim();
    await sessionManager.sendFileToChannelById(normalizedChannelId, file, { caption });
    return `File \`${file.name}\` sent to channel \`${normalizedChannelId}\``;
  }

  const normalizedSessionId = sessionId.trim();
  const result = await sessionManager.sendFileToSession(normalizedSessionId, file, { caption });
  if (result.deliveredChannels.length === 0) {
    throw new Error(formatSendFileSessionResult(normalizedSessionId, file, result));
  }

  return formatSendFileSessionResult(normalizedSessionId, file, result);
}

export async function tool_list_sessions(args: ToolArgs = {}, ctx?: ToolContext) {
  await requireNotIsolated(ctx, 'list_sessions');
  const sessions = sessionManager.listSessions();

  if (sessions.length === 0) {
    return 'No sessions found.';
  }

  const total = sessions.length;
  const rawStart = typeof args.start === 'number' && !Number.isNaN(args.start) ? Math.trunc(args.start) : 0;
  const rawCount = typeof args.count === 'number' && !Number.isNaN(args.count) ? Math.trunc(args.count) : 20;
  const start = Math.max(0, Math.min(rawStart, total));
  const count = Math.max(0, rawCount);
  const pageSessions = sessions.slice(start, start + count);

  if (pageSessions.length === 0) {
    return `No sessions found in the requested range. Total sessions: ${total}.`;
  }

  const end = start + pageSessions.length;
  let result = `Found ${total} session(s). Showing ${start + 1}-${end}.`;
  if (end < total) {
    result += ` Use \`start: ${end}\` to see the next page.`;
  }
  result += '\n\n';

  for (const s of pageSessions) {
    const date = s.lastMessageTime ? new Date(s.lastMessageTime).toISOString() : 'never';
    const channel = s.hasChannel ? '📱' : '🤖';
    const displayName = s.displayName ? ` (${s.displayName})` : '';
    const node = s.currentNode || 'master';
    const isolated = s.isolated ? ' isolated' : '';
    const busy = s.busy ? ' 🔄busy' : '';
    const queued = s.queueLength ? ` queue:${s.queueLength}` : '';
    result += `${channel} \`${s.id}\`${displayName} - ${s.messageCount} messages - node: \`${node}\`${isolated}${busy}${queued} - Last: ${date}\n`;
  }

  return result;
}

export async function tool_list_agents(args: ToolArgs = {}, ctx?: ToolContext) {
  await requireNotIsolated(ctx, 'list_agents');
  const agentsDir = AGENTS_DIR;

  if (!await fs.pathExists(agentsDir)) {
    return 'No agents directory found.';
  }

  const entries = await fs.readdir(agentsDir, { withFileTypes: true });
  const agents: Array<{name: string, hasSessions: boolean, sessionCount: number, inherit?: string, skills?: string[], isolated?: boolean, isolatedNode?: string}> = [];

  for (const entry of entries) {
    if (entry.isDirectory()) {
      const agentName = entry.name;
      const sessions = Array.from(sessionManager.getAllSessions().values())
        .filter(sess => (sess.agent || 'main') === agentName);

      agents.push({
        name: agentName,
        hasSessions: sessions.length > 0,
        sessionCount: sessions.length,
        inherit: sessionManager.getAgentMetadata(agentName).inherit,
        skills: sessionManager.getAgentSkills(agentName),
        isolated: sessionManager.getAgentMetadata(agentName).isolated,
        isolatedNode: sessionManager.getAgentIsolationNode(agentName),
      });
    }
  }

  if (agents.length === 0) {
    return 'No agents found.';
  }

  let result = `Found ${agents.length} agent(s):\n\n`;
  for (const agent of agents) {
    result += `- **${agent.name}**`;
    if (agent.hasSessions) {
      result += ` (${agent.sessionCount} session${agent.sessionCount > 1 ? 's' : ''})`;
    }
    if (agent.inherit) {
      result += ` [inherits: ${agent.inherit}]`;
    }
    if (agent.isolated) {
      result += ` [isolated${agent.isolatedNode ? `:${agent.isolatedNode}` : ''}]`;
    }
    if (agent.skills && agent.skills.length > 0) {
      result += ` [skills: ${agent.skills.join(', ')}]`;
    }
    result += '\n';
  }

  return result;
}

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

export async function tool_attach_agent_skill(args: ToolArgs, ctx?: ToolContext) {
  await requireNotIsolated(ctx, 'attach_agent_skill');
  const { agentName, skillName } = args;

  if (!agentName || typeof agentName !== 'string') {
    throw new Error('agentName is required');
  }
  if (!skillName || typeof skillName !== 'string') {
    throw new Error('skillName is required');
  }

  const result = await sessionManager.attachAgentSkill(agentName, skillName);
  if (!result.changed) {
    return `Agent "${agentName}" already has skill "${skillName}" attached.`;
  }

  let message = `Skill "${skillName}" attached to agent "${agentName}".`;
  if (result.skills.length > 0) {
    message += `\nCurrent skills: ${result.skills.join(', ')}`;
  }
  if (result.affectedSessions.length > 0) {
    message += `\nUpdated ${result.affectedSessions.length} session snapshot(s).`;
  }
  return message;
}

export async function tool_detach_agent_skill(args: ToolArgs, ctx?: ToolContext) {
  await requireNotIsolated(ctx, 'detach_agent_skill');
  const { agentName, skillName } = args;

  if (!agentName || typeof agentName !== 'string') {
    throw new Error('agentName is required');
  }
  if (!skillName || typeof skillName !== 'string') {
    throw new Error('skillName is required');
  }

  const result = await sessionManager.detachAgentSkill(agentName, skillName);
  if (!result.changed) {
    return `Agent "${agentName}" does not have skill "${skillName}" attached.`;
  }

  let message = `Skill "${skillName}" detached from agent "${agentName}".`;
  message += result.skills.length > 0
    ? `\nCurrent skills: ${result.skills.join(', ')}`
    : '\nCurrent skills: (none)';
  if (result.affectedSessions.length > 0) {
    message += `\nUpdated ${result.affectedSessions.length} session snapshot(s).`;
  }
  return message;
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
    return result + '\n\n(No skill memory documents found.)';
  }

  result += '\n\n';
  for (const document of documents) {
    result += `FILE: ${document.filePath}\n${document.content}\n\n`;
  }

  return result.trimEnd();
}

export async function tool_get_session_messages(args: ToolArgs, ctx?: ToolContext) {
  await requireNotIsolated(ctx, 'get_session_messages');
  const { sessionId, start, count, previewLength = 100 } = args;

  assertAllowedSubconsciousTarget(ctx, sessionId, 'get_session_messages');

  const session = await sessionManager.getExistingSession(sessionId);
  if (!session) {
    return `Session \`${sessionId}\` not found.`;
  }

  const totalMessages = session.history.length;
  let actualStart = start;
  let actualCount = count;

  if (actualStart === undefined && actualCount === undefined) {
    actualCount = 10;
    actualStart = Math.max(0, totalMessages - actualCount);
  } else if (actualStart === undefined) {
    actualStart = 0;
  } else if (actualCount === undefined) {
    actualCount = totalMessages - actualStart;
  }

  if (actualStart < 0) {
    actualStart = Math.max(0, totalMessages + actualStart);
  }

  actualStart = Math.max(0, Math.min(actualStart, totalMessages));
  actualCount = Math.min(actualCount, totalMessages - actualStart);

  const messages = await sessionManager.getSessionMessages(sessionId, actualStart, actualCount);

  if (messages.length === 0) {
    return `No messages found in session \`${sessionId}\` (total: ${totalMessages} messages).`;
  }

  return formatSessionMessagesPreview(sessionId, messages, actualStart, totalMessages, previewLength);
}

export async function tool_get_archived_messages(args: ToolArgs, ctx?: ToolContext) {
  await requireNotIsolated(ctx, 'get_archived_messages');
  const targetSessionId = args.sessionId || getSubconsciousPrimarySessionId(ctx) || ctx?.sessionId;
  assertAllowedSubconsciousTarget(ctx, targetSessionId, 'get_archived_messages');
  const previewLength = typeof args.previewLength === 'number' && args.previewLength > 0 ? args.previewLength : 1000;

  if (!targetSessionId) {
    throw new Error('sessionId is required when there is no current session context.');
  }

  const result = await sessionManager.getArchivedMessages(targetSessionId, {
    startSeq: typeof args.startSeq === 'number' ? args.startSeq : undefined,
    endSeq: typeof args.endSeq === 'number' ? args.endSeq : undefined,
  });

  if (result.totalMatched === 0) {
    const availableRange = typeof result.availableRange.startSeq === 'number' || typeof result.availableRange.endSeq === 'number'
      ? ` Available archived seq range: ${typeof result.availableRange.startSeq === 'number' ? `#${result.availableRange.startSeq}` : '?'}-${typeof result.availableRange.endSeq === 'number' ? `#${result.availableRange.endSeq}` : '?'}.`
      : '';
    return `No archived messages matched for session \`${targetSessionId}\`.${availableRange}`;
  }

  return formatArchivedMessagePreview(targetSessionId, result.records, {
    totalMatched: result.totalMatched,
    startSeq: result.requestedRange.startSeq,
    endSeq: result.requestedRange.endSeq,
  }, previewLength);
}


export async function tool_get_archived_blocks(args: ToolArgs, ctx?: ToolContext) {
  await requireNotIsolated(ctx, 'get_archived_blocks');
  const targetSessionId = args.sessionId || getSubconsciousPrimarySessionId(ctx) || ctx?.sessionId;
  assertAllowedSubconsciousTarget(ctx, targetSessionId, 'get_archived_blocks');
  const previewLength = typeof args.previewLength === 'number' && args.previewLength > 0 ? args.previewLength : 1000;

  if (!targetSessionId) {
    throw new Error('sessionId is required when there is no current session context.');
  }

  const result = await sessionManager.getArchivedBlocks(targetSessionId, {
    startId: typeof args.startId === 'number' ? args.startId : undefined,
    endId: typeof args.endId === 'number' ? args.endId : undefined,
  });

  return formatArchivedBlockPreview(targetSessionId, result.records, {
    totalMatched: result.totalMatched,
    startId: result.requestedRange.startId,
    endId: result.requestedRange.endId,
  }, previewLength);
}

export async function tool_delete_session(args: ToolArgs, ctx: ToolContext) {
  await requireNotIsolated(ctx, 'delete_session');
  const { sessionId } = args;

  if (ctx && ctx.sessionId === sessionId) {
    throw new Error('Cannot delete current session. Use /clear to clear history or switch to another session first.');
  }

  const prep = await sessionManager.prepareSessionForDestructiveAction(sessionId);
  const session = prep.session;

  if (prep.requiresRetry) {
    const queueNote = prep.droppedQueueItems > 0
      ? ` Cleared ${prep.droppedQueueItems} queued item(s).`
      : '';
    if (prep.abortedInFlight) {
      return `Stop signal sent to busy session \`${sessionId}\`. The in-flight LLM request was aborted.${queueNote} Retry delete after the session becomes idle.`;
    }
    return `Stop signal sent to busy session \`${sessionId}\`. It will stop after the current tool call completes.${queueNote} Retry delete after the session becomes idle.`;
  }

  const deleted = await sessionManager.deleteSession(sessionId);

  if (deleted) {
    return `Session \`${sessionId}\` deleted successfully.`;
  }

  return `Session \`${sessionId}\` not found.`;
}

export async function tool_update_session_name(args: ToolArgs, ctx: ToolContext) {
  const { sessionId, name } = args;
  const targetId = sessionId || ctx?.sessionId;

  if (!targetId) {
    throw new Error('Session ID is required.');
  }

  const session = await sessionManager.getExistingSession(targetId);
  if (!session) {
    throw new Error(`Session \`${targetId}\` not found.`);
  }

  if (name && name.trim()) {
    session.displayName = name.trim();
  } else {
    session.displayName = undefined;
  }

  await sessionManager.saveSession(session.id);

  if (session.displayName) {
    return `Session \`${session.id}\` renamed to "${session.displayName}".`;
  }
  return `Session \`${session.id}\` display name cleared.`;
}

export async function tool_update_session_snapshot(args: ToolArgs, ctx: ToolContext) {
  const { sessionId } = args;
  const targetId = sessionId || ctx?.sessionId;

  if (!targetId) {
    throw new Error('Session ID is required.');
  }

  const result = await sessionManager.refreshSessionSnapshot(targetId);
  return `Session \`${result.sessionId}\` snapshot updated.\nAgent: \`${result.agentName}\``;
}

export async function tool_set_todo(args: ToolArgs, ctx: ToolContext) {
  const targetId = ctx?.sessionId;
  if (!targetId) {
    throw new Error('Current session context is required.');
  }

  const session = ctx.session ?? await sessionManager.getSession(targetId);
  const clear = args.clear === true;

  if (clear) {
    const cleared = clearSessionTodo(session);
    await sessionManager.saveSession(session.id);
    return cleared
      ? `Cleared todo reminder for session \`${session.id}\`.`
      : `Session \`${session.id}\` has no todo reminder to clear.`;
  }

  const todo = normalizeTodoText(args.todo);
  if (!todo) {
    const cleared = clearSessionTodo(session);
    await sessionManager.saveSession(session.id);
    return cleared
      ? `Cleared todo reminder for session \`${session.id}\` via empty todo.`
      : `Ignored empty todo because session \`${session.id}\` has no todo reminder configured.`;
  }

  const remindEvery = normalizeRemindEvery(args.remindEvery);
  setSessionTodo(session, todo, remindEvery);
  await sessionManager.saveSession(session.id);

  return [
    `Todo reminder updated for session \`${session.id}\`.`,
    `remindEvery: ${remindEvery}`,
    'todo:',
    todo,
  ].join('\n');
}

export async function tool_set_session_compact_threshold(args: ToolArgs, ctx: ToolContext) {
  const targetId = args.sessionId || ctx?.sessionId;
  if (!targetId) {
    throw new Error('sessionId is required when there is no current session context.');
  }

  const clear = args.clear === true;
  if (clear) {
    const result = await sessionManager.setSessionCompactThreshold(targetId);
    return [
      `Session \`${result.sessionId}\` compact threshold cleared.`,
      `Now inheriting default auto-compact threshold: ${result.effectiveThresholdTokens} tokens.`,
    ].join('\n');
  }

  if (typeof args.thresholdTokens !== 'number' || !Number.isFinite(args.thresholdTokens) || args.thresholdTokens <= 0) {
    const session = await sessionManager.getExistingSession(targetId);
    if (!session) {
      throw new Error(`Session \`${targetId}\` not found.`);
    }
    const effective = sessionManager.getEffectiveCompactThresholdTokens(session);
    const override = typeof session.compactThresholdTokens === 'number'
      ? `${session.compactThresholdTokens} tokens`
      : 'inherit global default';
    return [
      `Session \`${session.id}\` compact threshold status:`,
      `override: ${override}`,
      `effective: ${effective} tokens`,
    ].join('\n');
  }

  const result = await sessionManager.setSessionCompactThreshold(targetId, args.thresholdTokens);
  return [
    `Session \`${result.sessionId}\` compact threshold updated.`,
    `override: ${result.thresholdTokens} tokens`,
    `effective: ${result.effectiveThresholdTokens} tokens`,
  ].join('\n');
}

export async function tool_stop_session(args: ToolArgs) {
  const { sessionId } = args;

  const session = await sessionManager.getSession(sessionId);
  if (!session) {
    throw new Error(`Session \`${sessionId}\` not found.`);
  }

  if (!session.busy) {
    return `Session \`${sessionId}\` is not currently running.`;
  }

  const { abortedInFlight } = await sessionManager.requestSessionStop(sessionId);

  if (abortedInFlight) {
    return `Stop signal sent to session \`${sessionId}\`. The in-flight LLM request was aborted.`;
  }

  return `Stop signal sent to session \`${sessionId}\`. It will stop after the current tool call completes.`;
}

function normalizeKeepPercent(value: unknown, defaultPercent = COMPACT_PERCENT): number {
  if (typeof value !== 'number' || Number.isNaN(value)) {
    return defaultPercent;
  }

  if (value > 1 && value <= 100) {
    return value / 100;
  }

  if (value > 0 && value <= 1) {
    return value;
  }

  return defaultPercent;
}

export async function tool_compact_session(args: ToolArgs, ctx: ToolContext) {
  const targetSessionId = args.sessionId || ctx.sessionId;
  const compactGuidance = typeof args.summary === 'string' && args.summary.trim()
    ? args.summary.trim()
    : undefined;
  const keepPercent = normalizeKeepPercent(args.keepPercent);

  if (!targetSessionId) {
    throw new Error('sessionId is required when there is no current session context.');
  }

  const targetSession = await sessionManager.getExistingSession(targetSessionId);
  if (!targetSession) {
    throw new Error(`Session \`${targetSessionId}\` not found.`);
  }

  const isSelf = targetSessionId === ctx.sessionId;
  if (!isSelf && (targetSession.busy || targetSession.queue.length > 0)) {
    throw new Error(`Session \`${targetSessionId}\` must be idle with an empty queue before another session can request compaction.`);
  }

  const result = await sessionManager.requestSessionCompaction(targetSessionId, {
    compactGuidance,
    keepPercent,
    completionMarker: isSelf
      ? 'Compaction completed. You can continue working now.'
      : 'Compaction completed.',
    // Self-compaction requested from inside an active agent turn should resume
    // the normal loop with the newly compacted history instead of halting after
    // the compact flow finishes.
    stopAfterCurrentTurn: false,
    requestedBy: compactGuidance ? 'manual' : 'tool',
  });

  if (result.alreadyQueued) {
    return `Compaction is already queued for session \`${targetSessionId}\`.`;
  }

  const mode = compactGuidance ? 'guided compaction plan' : 'automatic compaction plan';
  if (result.startedImmediately) {
    return `Compaction requested for session \`${targetSessionId}\`. It is entering the compact planning flow now using ${mode}.`;
  }

  return `Compaction requested for session \`${targetSessionId}\` using ${mode}. Pending queue length: ${result.queueLength}`;
}

export const tool_compress_session = tool_compact_session;

export async function tool_create_timer(args: ToolArgs, ctx: ToolContext) {
  await checkTimerPermission(ctx, {
    targetSessionId: args.sessionId,
    newSession: args.newSession,
    agentName: args.agentName,
    sessionPrefix: args.sessionPrefix,
  });

  const targetSessionId = args.sessionId || ctx.sessionId;
  if (!targetSessionId) {
    throw new Error('sessionId is required when there is no current session context.');
  }

  const targetSession = await sessionManager.getExistingSession(targetSessionId);
  if (!targetSession) {
    throw new Error(`Session \`${targetSessionId}\` not found.`);
  }

  const timer = await timers.createTimer({
    sessionId: targetSessionId,
    at: args.at,
    afterSeconds: args.afterSeconds,
    cron: args.cron,
    message: args.message,
    newSession: args.newSession,
    sessionPrefix: args.sessionPrefix,
    agentName: args.agentName,
    currentNode: targetSession.currentNode,
    model: targetSession.model,
  });

  return formatTimerSummary(timer);
}

export async function tool_list_timers(args: ToolArgs, ctx: ToolContext) {
  await checkTimerPermission(ctx, { targetSessionId: args.sessionId });

  const targetSessionId = args.sessionId || ctx.sessionId;
  const timerList = timers.listTimers(targetSessionId);

  if (timerList.length === 0) {
    return targetSessionId
      ? `No timers found for session \`${targetSessionId}\`.`
      : 'No timers found.';
  }

  let result = `Found ${timerList.length} timer(s):\n\n`;
  for (const timer of timerList) {
    const mode = timer.mode === 'cron'
      ? `cron: ${timer.cron}`
      : `at: ${formatTimerTimestamp(timer.at)}`;
    const target = timer.newSession
      ? `new session (${timer.agentName || 'main'} / ${timer.sessionPrefix || 'timer'})`
      : `session ${timer.sessionId}`;
    result += `- \`${timer.id}\` - ${mode} - next: ${formatTimerTimestamp(timer.nextRunAt)} - ${target}\n`;
    result += `  ${timer.message}\n`;
  }

  return result.trimEnd();
}

export async function tool_delete_timer(args: ToolArgs, ctx: ToolContext) {
  await checkTimerPermission(ctx, { targetSessionId: args.sessionId });

  const { timerId } = args;
  const targetSessionId = args.sessionId || ctx.sessionId;

  if (!timerId || typeof timerId !== 'string') {
    throw new Error('timerId is required');
  }

  const deleted = await timers.deleteTimer(timerId, targetSessionId);
  if (!deleted) {
    return `Timer \`${timerId}\` not found.`;
  }

  return `Timer \`${timerId}\` deleted.`;
}

export async function tool_create_agent(args: ToolArgs, ctx: ToolContext) {
  await requireNotIsolated(ctx, 'create_agent');
  const {
    agentName,
    inheritMemory = false,
    sourceSessionId,
    convertSession = false,
    createMainSession = true,
    inherit,
    isolatedNode,
  } = args;

  if (!agentName || typeof agentName !== 'string') {
    throw new Error('agentName is required');
  }

  const normalizedInherit = inherit && String(inherit).trim()
    ? String(inherit).trim()
    : undefined;
  const sourceId = sourceSessionId || ctx.sessionId || ctx.session?.id;
  const result = await sessionManager.createAgentWithMainSession({
    agentName,
    inheritMemory,
    sourceSessionId: sourceId,
    convertSessionId: convertSession ? sourceId : undefined,
    currentNode: ctx.session?.currentNode,
    model: ctx.session?.model,
    createMainSession,
    inherit: normalizedInherit,
    isolatedNode,
  });

  if (result.convertedFromSessionId) {
    let message = `Session "${result.convertedFromSessionId}" converted to agent "${agentName}".\nAgent folder: ${result.agentDir}\nMain session: ${result.mainSessionId}`;
    if (normalizedInherit) {
      message += `\nShared memory inherits from: ${normalizedInherit}`;
    }
    if (result.aliases.length > 0) {
      message += `\nAliases: ${result.aliases.join(', ')}`;
    }
    if (result.updatedChildren.length > 0) {
      message += `\nUpdated ${result.updatedChildren.length} child session parent reference(s).`;
    }
    return message;
  }

  let message = `Agent "${agentName}" created successfully.\nAgent folder: ${result.agentDir}`;
  if (normalizedInherit) {
    message += `\nShared memory inherits from: ${normalizedInherit}`;
  }
  if (isolatedNode) {
    message += `\nIsolation: enabled on node ${isolatedNode}`;
  }
  if (result.createdMainSession) {
    message += `\nMain session: ${result.mainSessionId}`;
  } else {
    message += '\nMain session: not created';
  }
  return message;
}

export async function tool_create_session(args: ToolArgs, ctx: ToolContext) {
  await requireNotIsolated(ctx, 'create_session');
  const { agentName, sessionName, displayName, parentSessionId } = args;

  if (!agentName || typeof agentName !== 'string') {
    throw new Error('agentName is required');
  }
  if (!sessionName || typeof sessionName !== 'string') {
    throw new Error('sessionName is required');
  }

  const result = await sessionManager.createSessionInAgent({
    agentName,
    sessionName,
    displayName,
    parentSessionId,
    currentNode: ctx.session?.currentNode,
    model: ctx.session?.model,
  });

  let message = `Session "${result.sessionId}" created under agent "${agentName}".`;
  if (displayName) {
    message += `\nDisplay name: ${displayName}`;
  }
  if (parentSessionId) {
    message += `\nParent session: ${parentSessionId}`;
  }
  return message;
}

export async function tool_set_agent_inherit(args: ToolArgs, ctx?: ToolContext) {
  await requireNotIsolated(ctx, 'set_agent_inherit');
  const { agentName, inheritAgentName } = args;

  if (!agentName || typeof agentName !== 'string') {
    throw new Error('agentName is required');
  }

  const normalizedInherit = inheritAgentName && String(inheritAgentName).trim()
    ? String(inheritAgentName).trim()
    : undefined;

  const result = await sessionManager.setAgentInherit(agentName, normalizedInherit);
  const chain = sessionManager.getAgentInheritanceChain(agentName);

  let message = normalizedInherit
    ? `Agent "${agentName}" now inherits shared memory from "${normalizedInherit}".`
    : `Cleared shared memory inheritance for agent "${agentName}".`;

  message += `\nInheritance chain: ${chain.join(' -> ')}`;
  if (result.affectedSessions.length > 0) {
    message += `\nUpdated ${result.affectedSessions.length} session snapshot(s).`;
  }

  return message;
}

export async function tool_set_agent_isolated(args: ToolArgs, ctx?: ToolContext) {
  await requireNotIsolated(ctx, 'set_agent_isolated');
  const { agentName, nodeId } = args;

  if (!agentName || typeof agentName !== 'string') {
    throw new Error('agentName is required');
  }

  const result = await sessionManager.setAgentIsolation(
    agentName,
    typeof nodeId === 'string' && nodeId.trim() ? nodeId.trim() : undefined,
  );

  let message = result.isolated
    ? `Agent "${agentName}" is now isolated on node "${result.node}".`
    : `Agent "${agentName}" isolation cleared.`;
  if (result.affectedSessions.length > 0) {
    message += `\nUpdated ${result.affectedSessions.length} session(s).`;
  }
  return message;
}

export async function tool_move_session(args: ToolArgs, ctx: ToolContext) {
  const {
    sessionId,
    newSessionId,
    createAgent = false,
    newAgentName,
    createAgentInheritMemory,
  } = args;

  const sourceId = sessionId || ctx.sessionId;
  if (!sourceId) {
    throw new Error('sessionId is required');
  }

  const sourceSession = await sessionManager.getExistingSession(sourceId);
  if (!sourceSession) {
    throw new Error(`Session "${sourceId}" not found.`);
  }

  if (sessionManager.isSessionEffectivelyIsolated(sourceSession)) {
    throw new Error('Isolated session cannot use move_session tool.');
  }

  const result = await sessionManager.moveSessionToTarget({
    sourceSessionId: sourceId,
    newSessionId,
    createAgent,
    newAgentName,
    createAgentInheritMemory,
  });

  let message = `Session "${sourceId}" moved to "${result.targetSessionId}".`;
  if (result.createdAgent) {
    message += `\nAgent "${result.targetAgent}" created.`;
  }
  if (result.aliases.length > 0) {
    message += `\nAliases: ${result.aliases.join(', ')}`;
  }
  if (result.updatedChildren.length > 0) {
    message += `\nUpdated ${result.updatedChildren.length} child session parent reference(s).`;
  }

  return message;
}
