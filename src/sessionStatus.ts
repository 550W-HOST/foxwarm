import { getAgentDir, resolveModelConfig } from './config';
import { nodesManager } from './nodes/manager';
import * as sessionManager from './sessionManager';
import * as sessionRuntime from './sessionRuntime';
import { estimateSessionSummary } from './tokenCount';
import type { Message, Session, TokenUsage } from './types';
import type { SessionRuntimeSessionDto } from './sessionRuntimeService';
import { formatSessionRuntimeStateSummary, type SessionRuntimeState } from './sessionRuntimeState';

type SessionListItem = ReturnType<typeof sessionManager.listSessions>[number] | SessionRuntimeSessionDto;

export interface SessionStatusInfo {
  sessionId: string;
  displayName?: string;
  agentName: string;
  agentDir: string;
  parentSessionId?: string;
  archived: boolean;
  modelKey: string;
  messageCount: number;
  tokenEstimate: number;
  imageCount: number;
  contextLimit: number;
  autoCompactThresholdTokens: number;
  compactThresholdOverrideTokens?: number;
  lastUsage: TokenUsage | null;
  lastUsageTotalTokens: number;
  lastMessageTime?: number;
  currentNode: {
    id: string;
    type?: string;
    connected: boolean;
    lastActivity?: number;
  };
  cwd?: string;
  defaultCwdDescription: string;
  isolated: boolean;
  busy: boolean;
  queueLength: number;
  runtimeState: SessionRuntimeState;
  childSessions: SessionListItem[];
}

function formatNumber(value: number): string {
  return Math.floor(value).toLocaleString();
}

function formatDate(timestamp?: number | null): string {
  return timestamp ? new Date(timestamp).toISOString() : 'never';
}

function getUsageTotalTokens(usage: TokenUsage | null | undefined): number {
  return usage ? sessionManager.getUsageTotalTokens(usage) : 0;
}

function formatUsage(usage: TokenUsage | null, total: number): string {
  if (!usage) {
    return 'none';
  }

  const reasoning = usage.reasoningTokens === undefined
    ? ''
    : ` (reasoning=${formatNumber(usage.reasoningTokens)})`;
  return `cached=${formatNumber(usage.cachedTokens || 0)}, input=${formatNumber(usage.inputTokens || 0)}, output=${formatNumber(usage.outputTokens || 0)}${reasoning}, total=${formatNumber(total)}`;
}

function getNodeInfo(nodeId: string): SessionStatusInfo['currentNode'] {
  const node = nodesManager.getNode(nodeId) as any;
  if (nodeId === 'master') {
    return {
      id: 'master',
      type: node?.type || 'master',
      connected: true,
      lastActivity: typeof node?.lastActivity === 'number' ? node.lastActivity : undefined,
    };
  }

  return {
    id: nodeId,
    type: typeof node?.type === 'string' ? node.type : undefined,
    connected: !!node?.ws,
    lastActivity: typeof node?.lastActivity === 'number' ? node.lastActivity : undefined,
  };
}

export function formatSessionListRow(s: SessionListItem, currentSessionId?: string): string {
  const date = formatDate(s.lastMessageTime);
  const channel = sessionManager.getChannelsBySession(s.id).length > 0 ? '📱' : '🤖';
  const displayName = s.displayName ? ` (${s.displayName})` : '';
  const node = s.currentNode || 'master';
  const isolated = s.isolated ? ' isolated' : '';
  const busy = s.busy ? ' 🔄busy' : '';
  const runtime = s.runtimeState && s.runtimeState.state !== 'idle'
    ? ` state:${formatSessionRuntimeStateSummary(s.runtimeState)}`
    : '';
  const queued = s.queueLength ? ` queue:${s.queueLength}` : '';
  const current = s.id === currentSessionId ? ' **CURRENT**' : '';
  return `${channel} \`${s.id}\`${displayName}${current} - ${s.messageCount} messages - node: \`${node}\`${isolated}${runtime || busy}${queued} - Last: ${date}`;
}

export async function buildSessionListOutput(args: Record<string, any> = {}, currentSessionId?: string): Promise<string> {
  const sessions = await sessionRuntime.listSessions();

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
  const currentSession = currentSessionId ? await sessionRuntime.getSession(currentSessionId) : undefined;
  const parentSessionId = currentSession?.parentSessionId;

  let result = '';
  if (currentSessionId) {
    result += `Current session: \`${currentSessionId}\`\n`;
  }
  if (parentSessionId) {
    result += `Parent session: \`${parentSessionId}\`\n`;
  }
  if (result) {
    result += '\n';
  }

  result += `Found ${total} session(s). Showing ${start + 1}-${end}.`;
  if (end < total) {
    result += ` Use \`start: ${end}\` to see the next page.`;
  }
  result += '\n\n';

  result += pageSessions.map(s => formatSessionListRow(s, currentSessionId)).join('\n');
  result += '\n';
  return result;
}

export async function buildSessionStatusInfo(
  sessionId: string,
  suppliedSession?: Session | SessionRuntimeSessionDto,
  exactOwner = false,
  historyMessages?: Message[],
): Promise<SessionStatusInfo> {
  const session = suppliedSession || await sessionManager.getSession(sessionId);
  const realSessionId = session.id || sessionId;
  const agentName = session.agent || 'main';
  const agentDir = getAgentDir(agentName);
  const runtimeDto = 'tokenUsage' in session ? session : undefined;
  const summarySource = runtimeDto
    ? {
        ...runtimeDto,
        history: historyMessages || [],
        stats: {
          totalCachedTokens: runtimeDto.tokenUsage.cachedTokens,
          totalInputTokens: runtimeDto.tokenUsage.inputTokens,
          totalOutputTokens: runtimeDto.tokenUsage.outputTokens,
          lastUsage: runtimeDto.tokenUsage.lastUsage,
        },
        meta: { lastMessageTime: runtimeDto.lastMessageTime },
        queue: [],
      } as unknown as Session
    : session as Session;
  const sessionSummary = estimateSessionSummary(summarySource);
  const { currentKey, contextLimit } = resolveModelConfig(session.model);
  const currentNodeId = session.currentNode || 'master';
  const allSessions = exactOwner ? [] : runtimeDto ? await sessionRuntime.listSessions() : sessionManager.listSessions();
  const childSessions = allSessions
    .filter(s => s.parentSessionId === realSessionId)
    .slice(0, 10);
  const cwd = typeof session.cwd === 'string' && session.cwd.trim().length > 0
    ? session.cwd.trim()
    : undefined;
  const defaultCwdDescription = cwd
    ? `\`${cwd}\``
    : `not set (defaults to current node agent directory; master: \`${agentDir}\`)`;
  const lastUsage = runtimeDto ? runtimeDto.tokenUsage.lastUsage : (session as Session).stats?.lastUsage || null;

  return {
    sessionId: realSessionId,
    displayName: session.displayName,
    agentName,
    agentDir,
    parentSessionId: session.parentSessionId,
    archived: !!session.archived,
    modelKey: currentKey,
    messageCount: runtimeDto ? runtimeDto.messageCount : (session as Session).history.length,
    tokenEstimate: sessionSummary.tokens,
    imageCount: sessionSummary.imageCount,
    contextLimit,
    autoCompactThresholdTokens: sessionManager.getEffectiveCompactThresholdTokens(summarySource),
    compactThresholdOverrideTokens: typeof session.compactThresholdTokens === 'number' ? session.compactThresholdTokens : undefined,
    lastUsage,
    lastUsageTotalTokens: getUsageTotalTokens(lastUsage),
    lastMessageTime: runtimeDto ? runtimeDto.lastMessageTime : (session as Session).meta?.lastMessageTime,
    currentNode: exactOwner ? { id: currentNodeId, connected: currentNodeId === 'master', ...(currentNodeId === 'master' ? { type: 'master' } : {}) } : getNodeInfo(currentNodeId),
    cwd,
    defaultCwdDescription,
    isolated: runtimeDto ? runtimeDto.isolated : sessionManager.isSessionEffectivelyIsolated(session as Session),
    busy: !!session.busy,
    queueLength: runtimeDto ? runtimeDto.queueLength : (session as Session).queue?.length || 0,
    runtimeState: runtimeDto ? runtimeDto.runtimeState : sessionManager.buildSessionRuntimeState(session as Session),
    childSessions,
  };
}

export function formatSessionStatus(info: SessionStatusInfo): string {
  const displayName = info.displayName ? `\n- name: ${info.displayName}` : '';
  const parent = info.parentSessionId ? `\n- parent session id: \`${info.parentSessionId}\`` : '';
  const archived = info.archived ? '\n- 📦 archived' : '';
  const images = info.imageCount > 0 ? ` (Images: ${info.imageCount})` : '';
  const thresholdSource = info.compactThresholdOverrideTokens !== undefined
    ? `override: ${formatNumber(info.compactThresholdOverrideTokens)} tokens`
    : 'model default';
  const nodeStatus = info.currentNode.connected ? 'connected' : 'not connected';
  const nodeType = info.currentNode.type ? `, type=\`${info.currentNode.type}\`` : '';
  const nodeActivity = info.currentNode.lastActivity ? `, lastActivity=${formatDate(info.currentNode.lastActivity)}` : '';
  const isolated = info.isolated ? ' (isolated)' : '';
  const busy = info.busy ? '\n- busy: yes' : '';
  const queue = info.queueLength ? `\n- queue: ${info.queueLength}` : '';
  const runtimeState = formatSessionRuntimeStateSummary(info.runtimeState);
  const waitReason = info.runtimeState.waiting?.reason ? `\n- wait reason: ${info.runtimeState.waiting.reason}` : '';
  const pendingSessions = info.runtimeState.waiting?.pendingSessions?.length
    ? `\n- pending wait sessions: ${info.runtimeState.waiting.pendingSessions.map(sessionId => `\`${sessionId}\``).join(', ')}`
    : '';
  const waitExecIds = info.runtimeState.waiting?.waitExecIds?.length
    ? `\n- wait exec ids: ${info.runtimeState.waiting.waitExecIds.map(execId => `\`${execId}\``).join(', ')}`
    : '';

  let result = '📊 *Session Status*\n\n';
  result += `- session id: \`${info.sessionId}\`${displayName}\n`;
  result += `- agent id/name: \`${info.agentName}\`\n`;
  result += `- agent dir: \`${info.agentDir}\`${parent}${archived}\n`;
  result += `- model: \`${info.modelKey}\`\n`;
  result += `- messages: ${info.messageCount}\n`;
  result += `- token estimate: ~${formatNumber(info.tokenEstimate)} / ${formatNumber(info.contextLimit)}${images}\n`;
  result += `- last usage: ${formatUsage(info.lastUsage, info.lastUsageTotalTokens)}\n`;
  result += `- last message: ${formatDate(info.lastMessageTime)}\n`;
  result += `- auto-compact threshold: ~${formatNumber(info.autoCompactThresholdTokens)} tokens (${thresholdSource})\n`;
  result += `- current node: \`${info.currentNode.id}\` (${nodeStatus}${nodeType}${nodeActivity})${isolated}\n`;
  result += `- current cwd: ${info.defaultCwdDescription}\n`;
  result += `- runtime state: ${runtimeState}${busy}${queue}${waitReason}${pendingSessions}${waitExecIds}\n`;

  if (info.childSessions.length > 0) {
    result += '\nRecent child sessions (max 10):\n';
    result += info.childSessions.map(child => formatSessionListRow(child)).join('\n');
    result += '\n';
  } else {
    result += '\nRecent child sessions (max 10): none\n';
  }

  return result;
}