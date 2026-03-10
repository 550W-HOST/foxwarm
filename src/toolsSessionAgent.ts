import fs from 'fs-extra';
import path from 'path';
import * as sessionManager from './sessionManager';
import * as skills from './skills';
import * as timers from './timers';
import { logger } from './common';
import { COMPACT_PERCENT } from './config';
import { formatSessionMessagesPreview } from './utils/messagePreview';

interface ToolContext {
  sessionId?: string;
  session?: any;
  broadcast?: (text: string, options?: any) => Promise<void>;
}

type ToolArgs = Record<string, any>;

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

export async function tool_create_child_session(args: ToolArgs, ctx: ToolContext) {
  const { suffix, fork = true, message, node, isolated } = args;

  if (!ctx || !ctx.sessionId) {
    throw new Error('Cannot create child session: missing context');
  }

  const currentSessionId = ctx.sessionId;
  const childSessionId = await sessionManager.createChildSession(currentSessionId, suffix, fork, { node, isolated });

  if (message) {
    sessionManager.sendToSession(childSessionId, message, currentSessionId).catch(err => {
      logger.error({ err, childSessionId }, 'Failed to send initial message to child session');
    });
    return `Child session created: \`${childSessionId}\` (${fork ? 'forked from parent' : 'new session'}). Initial message sent.`;
  }

  return `Child session created: \`${childSessionId}\` (${fork ? 'forked from parent' : 'new session'})`;
}

export async function tool_send_to_session(args: ToolArgs, ctx: ToolContext) {
  const { sessionId, message } = args;
  const fromSessionId = ctx?.sessionId;

  await sessionManager.sendToSession(sessionId, message, fromSessionId);
  return `Message sent to session \`${sessionId}\``;
}

export async function tool_send_to_channel(args: ToolArgs) {
  const { channelId, message } = args;
  if (!channelId || typeof channelId !== 'string') {
    throw new Error('channelId is required (format: platform:userId)');
  }
  if (!message || typeof message !== 'string') {
    throw new Error('message is required');
  }

  await sessionManager.sendToChannelById(channelId, message);
  return `Message sent to channel \`${channelId}\``;
}

export async function tool_list_sessions(args: ToolArgs = {}) {
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

export async function tool_list_agents() {
  const agentsDir = path.join(process.cwd(), 'agents');

  if (!await fs.pathExists(agentsDir)) {
    return 'No agents directory found.';
  }

  const entries = await fs.readdir(agentsDir, { withFileTypes: true });
  const agents: Array<{name: string, hasSessions: boolean, sessionCount: number, inherit?: string, skills?: string[]}> = [];

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
    if (agent.skills && agent.skills.length > 0) {
      result += ` [skills: ${agent.skills.join(', ')}]`;
    }
    result += '\n';
  }

  return result;
}

export async function tool_list_skills() {
  const skillList = await skills.listSkills();

  if (skillList.length === 0) {
    return 'No skills found.';
  }

  let result = `Found ${skillList.length} skill(s):\n\n`;
  for (const skill of skillList) {
    result += `- **${skill.name}**`;
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

export async function tool_attach_agent_skill(args: ToolArgs) {
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

export async function tool_detach_agent_skill(args: ToolArgs) {
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

export async function tool_load_skill(args: ToolArgs) {
  const { skillName } = args;

  if (!skillName || typeof skillName !== 'string') {
    throw new Error('skillName is required');
  }

  const { info, documents } = await skills.loadSkillDocuments(skillName);

  let result = `Skill: ${info.name}`;
  if (info.description) {
    result += `\nDescription: ${info.description}`;
  }
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

export async function tool_get_session_messages(args: ToolArgs) {
  const { sessionId, start, count, previewLength = 100 } = args;

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

export async function tool_delete_session(args: ToolArgs, ctx: ToolContext) {
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

export async function tool_compress_session(args: ToolArgs, ctx: ToolContext) {
  const targetSessionId = args.sessionId || ctx.sessionId;
  const summary = typeof args.summary === 'string' ? args.summary : undefined;
  const keepPercent = normalizeKeepPercent(args.keepPercent);

  if (!targetSessionId) {
    throw new Error('sessionId is required when there is no current session context.');
  }

  const targetSession = await sessionManager.getExistingSession(targetSessionId);
  if (!targetSession) {
    throw new Error(`Session \`${targetSessionId}\` not found.`);
  }

  const isSelf = targetSessionId === ctx.sessionId;
  if (isSelf && (!summary || !summary.trim())) {
    throw new Error('Self compaction requires a non-empty summary.');
  }

  const result = await sessionManager.requestSessionCompaction(targetSessionId, {
    summary: summary?.trim() || undefined,
    keepPercent,
  });

  if (result.alreadyQueued) {
    return `Compaction is already queued for session \`${targetSessionId}\`.`;
  }

  const mode = summary && summary.trim() ? 'provided summary' : 'automatic summary';
  if (result.startedImmediately) {
    return `Compaction started for session \`${targetSessionId}\` using ${mode}.`;
  }

  return `Compaction queued for session \`${targetSessionId}\` using ${mode}. Pending queue length: ${result.queueLength}`;
}

export async function tool_create_timer(args: ToolArgs, ctx: ToolContext) {
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
  const {
    agentName,
    inheritMemory = false,
    sourceSessionId,
    convertSession = false,
    createMainSession = true,
    inherit,
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
  if (result.createdMainSession) {
    message += `\nMain session: ${result.mainSessionId}`;
  } else {
    message += '\nMain session: not created';
  }
  return message;
}

export async function tool_create_session(args: ToolArgs, ctx: ToolContext) {
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

export async function tool_set_agent_inherit(args: ToolArgs) {
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

  if (sourceSession.isolated) {
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
