import { ChannelContext, getChannelId, getChannelType, getConversationId } from '../channel';
import { getManagedChannelIds, getChannelRuntimeStatus, listChannelRuntimeStatuses } from '../channelRuntime';
import { nodesManager } from '../nodes/manager';
import { listApprovedNodes, listPendingPairings } from '../nodes/registry';
import * as sessionManager from '../sessionManager';
import * as sessionRuntime from '../sessionRuntime';
import { COMPACT_PERCENT, HTTP_PORT, MODEL_EFFORTS, resolveModelConfig, type ModelEffort } from '../config';
import { commandSessionMessageCount, type CommandSession } from './types';

export function formatTimerDate(timestamp?: number | null): string {
  if (!timestamp) return 'n/a'
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? 'n/a' : date.toISOString()
}

export function parseEffortFlag(tokens: string[]): { remaining: string[]; present: boolean; effort?: ModelEffort; error?: string } {
  const remaining: string[] = [];
  let present = false;
  let effort: ModelEffort | undefined;
  for (let index = 0; index < tokens.length; index += 1) {
    if (tokens[index] !== '--effort') { remaining.push(tokens[index]); continue; }
    if (present) return { remaining, present, error: '--effort may be specified only once.' };
    present = true;
    const raw = tokens[++index]?.trim().toLowerCase();
    if (!raw) return { remaining, present, error: '--effort requires a value.' };
    if (raw === 'default' || raw === 'unset') effort = undefined;
    else if (MODEL_EFFORTS.includes(raw as ModelEffort)) effort = raw as ModelEffort;
    else return { remaining, present, error: `Effort must be one of: ${MODEL_EFFORTS.join(', ')}, default, or unset.` };
  }
  return { remaining, present, effort };
}

export function parseTimerFlags(tokens: string[]) {
  let index = 0
  let newSession = false
  let sessionPrefix: string | undefined
  let agentName: string | undefined

  while (index < tokens.length) {
    const token = tokens[index]
    if (token === '--') break
    if (token === '--new-session') {
      newSession = true
      index += 1
      continue
    }
    if (token === '--prefix') {
      if (index + 1 >= tokens.length) throw new Error('Missing value for --prefix')
      sessionPrefix = tokens[index + 1]
      index += 2
      continue
    }
    if (token === '--agent') {
      if (index + 1 >= tokens.length) throw new Error('Missing value for --agent')
      agentName = tokens[index + 1]
      index += 2
      continue
    }
    break
  }

  return {
    newSession,
    sessionPrefix,
    agentName,
    index,
  }
}

export function parseTimerMessage(tokens: string[]): string {
  if (tokens[0] === '--') {
    return tokens.slice(1).join(' ')
  }
  return tokens.join(' ')
}

export function parseSessionMoveTarget(rawTarget: string): { newSessionId: string; newAgentName?: string } {
  const target = rawTarget.trim()

  if (!target) {
    throw new Error('Missing move target.')
  }

  const slashCount = (target.match(/\//g) || []).length
  if (slashCount === 0) {
    sessionManager.validateSessionName(target)
    return { newSessionId: target }
  }

  if (slashCount !== 1) {
    throw new Error('Move target must be `<new-session-id>` or `<existing-agent>/<new-session-id>`.')
  }

  const [newAgentName, newSessionId] = target.split('/')
  sessionManager.validateAgentName(newAgentName)
  sessionManager.validateSessionName(newSessionId)

  return { newAgentName, newSessionId }
}

export function parseSessionMoveArgs(tokens: string[]): {
  newSessionId: string;
  newAgentName?: string;
  parentSessionId?: string;
} {
  if (tokens.length === 0) throw new Error('Missing move target.')
  const target = parseSessionMoveTarget(tokens[0])
  let parentSessionId: string | undefined

  for (let index = 1; index < tokens.length; index += 1) {
    const token = tokens[index]
    if (token !== '--parent') throw new Error(`Unknown /session move option: ${token}`)
    if (parentSessionId !== undefined) throw new Error('--parent may be specified only once.')
    const value = tokens[index + 1]?.trim()
    if (!value) throw new Error('Missing parent session ID after --parent.')
    parentSessionId = value
    index += 1
  }

  return { ...target, ...(parentSessionId ? { parentSessionId } : {}) }
}

export function parseCompactThresholdInput(raw: string): number | null {
  const value = raw.trim().toLowerCase()
  if (!value) {
    throw new Error('Compact threshold cannot be empty.')
  }

  const match = value.match(/^(\d+(?:\.\d+)?)(k)?$/)
  if (!match) {
    throw new Error('Compact threshold must be a positive integer token count or use the `k` suffix, e.g. `8000` or `8k`.')
  }

  const base = parseFloat(match[1])
  if (!isFinite(base) || base <= 0) {
    throw new Error('Compact threshold must be greater than 0.')
  }

  const multiplier = match[2] ? 1000 : 1
  return Math.floor(base * multiplier)
}

export function getDisplayModelKeys(currentModel?: string): string[] {
  const { modelsConfig } = resolveModelConfig(currentModel)
  return modelsConfig.displayModels || Object.keys(modelsConfig.models || {})
}

export function resolveCommandModelSelection(input: string, currentModel?: string): { key?: string; error?: string } {
  const target = input.trim()
  const { modelsConfig } = resolveModelConfig(currentModel)
  const modelKeys = getDisplayModelKeys(currentModel)

  if (modelsConfig.models[target]) {
    return { key: target }
  }

  const normalizedInput = target.toLowerCase()
  const matches = modelKeys.filter(k => k.toLowerCase().includes(normalizedInput))

  if (matches.length === 0) {
    return { error: `❌ No models matching \`${target}\`. Use /model to list available models.` }
  }

  if (matches.length === 1) {
    return { key: matches[0] }
  }

  let resp = `❌ Multiple models match \`${target}\`:\n\n`
  resp += matches.map(k => `- \`${k}\``).join('\n')
  resp += `\n\nPlease be more specific.`
  return { error: resp }
}

export function formatChannelInfo(ctx: ChannelContext): string {
  const channelId = getChannelId(ctx)
  const channelType = getChannelType(ctx)
  const conversationId = getConversationId(ctx)
  const sessionId = sessionManager.getSessionByChannel(channelId, conversationId)
  const channelConfig = sessionManager.getChannelConfig(channelId, conversationId)
  const runtimeStatus = getChannelRuntimeStatus(channelId)
  return [
    '*Channel info*',
    `- channelId: \`${channelId}\``,
    `- channelType: \`${channelType}\``,
    `- conversationId: \`${conversationId}\``,
    `- senderId: \`${ctx.senderId || '(none)'}\``,
    ctx.username ? `- username: \`${ctx.username}\`` : undefined,
    `- attachedSession: \`${sessionId || '(none)'}\``,
    `- mode: \`${channelConfig?.mode || 'normal'}\``,
    `- dangerouslyAllowAllUsers: \`${sessionManager.getChannelDangerouslyAllowAllUsers(channelId, conversationId) ? 'yes' : 'no'}\``,
    runtimeStatus ? `- runtime: \`${runtimeStatus.running ? 'running' : 'stopped'}\`` : undefined,
  ].filter(Boolean).join('\n')
}

export function formatChannelRuntimeStatus(channelId?: string, typeFilter?: string): string {
  const statuses = channelId
    ? [getChannelRuntimeStatus(channelId)].filter(Boolean)
    : listChannelRuntimeStatuses(typeFilter ? { type: typeFilter } : undefined)
  if (statuses.length === 0) {
    return 'No known channel runtime status found.'
  }

  return [
    '*Channel runtime status*',
    ...statuses.map(status => {
      const detailSuffix = status.details.length > 0 ? `; ${status.details.join('; ')}` : ''
      const errorSuffix = status.lastError ? `; lastError=${status.lastError}` : ''
      return `- \`${status.channelId}\` (type=\`${status.type}\`): running=\`${status.running ? 'yes' : 'no'}\`, managed=\`${status.managed ? 'yes' : 'no'}\`, configured=\`${status.configured ? 'yes' : 'no'}\`, enabled=\`${status.enabled ? 'yes' : 'no'}\`${detailSuffix}${errorSuffix}`
    }),
  ].join('\n')
}

export function getManagedPlatformHelp(): string {
  const platforms = getManagedChannelIds()
  return platforms.length > 0 ? platforms.join(', ') : '(none)'
}

export function buildNodePairHelp(token: string): string {
  return [
    '🧩 **Node Pairing / Bootstrap Help**',
    '',
    `Current pairing token: \`${token}\``,
    '',
    'Use the pairing token below directly as `--pairing=...` when bootstrapping a node.',
    '',
    'First choose a **reachable base URL** for this Foxwarm master from the node\'s point of view.',
    'There is no single globally correct external URL that Foxwarm can always know in advance — it might be localhost, a LAN IP, a Docker host IP, or a reverse-proxy domain depending on where the node runs.',
    '',
    'If you fetch `/node/run.sh`, `/node/run-docker.sh`, or `/node/run.ps1` from that reachable URL, the downloaded script uses that same request URL as its default `--host`/`HostUrl` value.',
    'Override `--host=...` only when the script was fetched through one address but the node should connect to another reachable address.',
    '',
    '**Pick a reachable URL first**',
    '```bash',
    'BASE_URL=http://YOUR_MASTER:3001',
    '```',
    '',
    '**Bare metal (recommended Linux host bootstrap)**',
    '```bash',
    `curl -fsSL "$BASE_URL/node/run.sh" | bash -s -- \
  --dir=/opt/foxwarm-node \
  --pairing=${token} \
  --node-id=my-node`,
    '```',
    '',
    '**Bare metal with systemd boot startup**',
    '```bash',
    `curl -fsSL "$BASE_URL/node/run.sh" | bash -s -- \
  --dir=/opt/foxwarm-node \
  --pairing=${token} \
  --node-id=my-node \
  --install`,
    '```',
    '',
    '**Docker bootstrap**',
    '```bash',
    `curl -fsSL "$BASE_URL/node/run-docker.sh" | bash -s -- \
  --pairing=${token} \
  --node-id=my-node`,
    '```',
    '',
    '**Explicit host override example**',
    '```bash',
    `curl -fsSL "http://127.0.0.1:${HTTP_PORT}/node/run.sh" | bash -s -- \
  --dir=/opt/foxwarm-node \
  --host=http://192.168.1.50:${HTTP_PORT} \
  --pairing=${token} \
  --node-id=my-node`,
    '```',
    '',
    '**Manual docker-compose template**',
    '```bash',
    'curl -fsSL "$BASE_URL/node/docker-compose.yaml" -o docker-compose.yaml',
    'cat > .env <<\'EOF\'',
    'NODE_HOST=$BASE_URL',
    'NODE_SOURCE_URL=$BASE_URL/node/source.tar.gz',
    `NODE_PAIRING_TOKEN=${token}`,
    'NODE_ID=my-node',
    'NODE_DATA_DIR=./data',
    'EOF',
    '',
    'docker compose up -d --build',
    '```',
    '',
    '**Approve the pending node from Foxwarm**',
    '```text',
    '/node',
    '/node approve <pending-id> my-node',
    '```',
    '',
    'Notes:',
    '- `/node/run.sh` = bare-metal bootstrap; requires `--dir`; runs in foreground by default, use `-d` for tmux/nohup background mode or `--install` for a systemd service',
    '- `/node/run-docker.sh` = Docker bootstrap; starts containers and follows logs by default, use `-d` to skip log following',
    '- `/node/run-interactive.sh` = cli-node TUI mode (tool approvals plus bound-session chat)',
    '- `/node/docker-compose.yaml` = inspect/customize the self-contained compose template first',
    '- `/node` = list current node, approved nodes, and pending approvals',
    '- `/node approve` / `/node reject` = act on pending approvals',
    '- agent/tool workflows can use the `node_bootstrap_info` tool for structured bootstrap info',
  ].join('\n')
}

export async function buildNodeListReply(currentNode: string, boundNode?: string): Promise<string> {
  const approved = await listApprovedNodes()
  const pending = await listPendingPairings()

  let reply = '📋 **Nodes**\n\n'
  reply += `💡 Current node: \`${currentNode}\`\n`
  if (boundNode) {
    reply += `🔒 Runtime is bound by agent isolation to \`${boundNode}\`.\n`
  }

  reply += '\n**Approved Nodes**\n'
  reply += currentNode === 'master' ? '- ✅ `master` (local)\n' : '- `master` (local)\n'

  if (approved.length === 0) {
    reply += '- (No approved remote nodes yet)\n'
  } else {
    for (const node of approved) {
      const online = nodesManager.getNode(node.nodeId) ? 'online' : 'offline'
      const requestedName = node.requestedName ? ` requested=\`${node.requestedName}\`` : ''
      const lastSeen = node.lastSeenAt ? ` lastSeen=${new Date(node.lastSeenAt).toLocaleString()}` : ''
      const currentMarker = currentNode === node.nodeId ? '✅ ' : ''
      reply += `- ${currentMarker}\`${node.nodeId}\` [${node.nodeType}] ${online}${requestedName}${lastSeen}\n`
    }
  }

  reply += '\n**Pending Approvals**\n'
  if (pending.length === 0) {
    reply += '- (No pending pairing requests)\n'
  } else {
    for (const entry of pending) {
      const requestedName = entry.requestedName ? ` requested=\`${entry.requestedName}\`` : ''
      const connected = entry.connected ? ' online' : ' offline'
      const approvedMarker = entry.approvedNodeId ? ` approved→\`${entry.approvedNodeId}\`` : ''
      reply += `- \`${entry.id}\` [${entry.nodeType}] code=\`${entry.pairCode}\`${requestedName}${connected}${approvedMarker}\n`
    }
  }

  reply += '\nCommands:\n'
  reply += '- `/node` or `/node list` — list nodes and pending approvals\n'
  reply += '- `/node approve <pending-id> [node-id]` — approve a pending node\n'
  reply += '- `/node reject <pending-id>` — reject a pending node\n'
  reply += '- `/node remove <node-id>` — remove an approved node and invalidate its credentials\n'
  reply += '- `/node move <old-id> <new-id>` — rename an approved node id (node-side credentials must be updated)\n'
  reply += '- `/node pair-help` — show pairing/bootstrap help\n'
  reply += '- `/node <node-id>` — switch current node\n'

  return reply
}

export async function handleCompactCommand(ctx: ChannelContext, args: string[], sessionId?: string, session?: CommandSession) {
  if (!sessionId || !session) return

  if (args[0] === 'tools') {
    let keepPercent = COMPACT_PERCENT
    if (args.length >= 2) {
      const pct = parseFloat(args[1])
      if (!isNaN(pct) && pct > 0 && pct <= 100) {
        keepPercent = pct / 100
      }
    }

    const compact = await sessionRuntime.requestCompaction(sessionId, keepPercent, true)
    if (compact.kind === 'empty') { ctx.reply('History is empty.'); return }
    if (compact.kind === 'unsupported') { ctx.reply(`⚠️ ${compact.message}`); return }
    if (compact.kind !== 'tool-noise') throw new Error('Unexpected tool-noise compaction result.')
    const result = compact.result
    ctx.reply(
      `🧹 Tool-noise compaction finished. Replaced ${result.replacedFunctionCalls} tool call(s) and ${result.replacedFunctionResponses} tool response(s) across ${result.touchedMessages} message(s). `
      + `Inspected ${result.inspectedMessages} older message(s); kept the most recent ${Math.max(0, commandSessionMessageCount(session) - result.keepStartIndex)} message(s) untouched.`
    )
    return
  }

  let keepPercent = COMPACT_PERCENT
  if (args.length >= 1) {
    const pct = parseFloat(args[0])
    if (!isNaN(pct) && pct > 0 && pct <= 100) {
      keepPercent = pct / 100
    }
  }

  const result = await sessionRuntime.requestCompaction(sessionId, keepPercent)

  if (result.kind === 'empty') { ctx.reply('History is empty.'); return }
  if (result.kind === 'worker') {
    ctx.reply(result.compacted ? '🗜️ Compaction completed.' : 'ℹ️ No compactable history was found.')
    return
  }
  if (result.kind !== 'local') throw new Error('Unexpected compaction result.')

  if (result.alreadyQueued) {
    ctx.reply('ℹ️ Compaction is already pending for this session.')
    return
  }

  if (result.startedImmediately) {
    ctx.reply(result.runsInBackground
      ? '🗜️ Compaction requested. It runs in parallel, so this chat can continue normally.'
      : '🗜️ Compaction started. This session will remain busy until awaited compaction finishes.')
    return
  }

  ctx.reply('⚠️ This model disables background compaction. Stop or wait for the current run to finish, then request compaction again.')
}
