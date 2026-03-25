import fs from 'fs-extra'
import path from 'path'
import crypto from 'crypto'
import { ChannelContext, getChannelId, getChannelType, getConversationId } from './channel'
import { inspectChannelAuthorizationFromContext, formatAuthorizationInspection } from './channelAuth'
import { getManagedChannelIds, getChannelRuntimeStatus, listChannelRuntimeStatuses, restartManagedChannel, startManagedChannel, stopManagedChannel } from './channelRuntime'
import { nodesManager } from './nodes/manager'
import { approvePendingPairing, listApprovedNodes, listPendingPairings, rejectPendingPairing } from './nodes/registry'
import { Session } from './types'
import * as sessionManager from './sessionManager'
import * as skills from './skills'
import * as tools from './tools'
import { estimateSessionTokens } from './tokenCount'
import { AGENTS_DIR, APP_CONFIG_PATH, CONTEXT_LIMIT, COMPACT_PERCENT, getAgentDir, getDefaultChannelIdByType, HTTP_PORT, NODE_TOKEN_FILE, readAppConfigFile, resolveModelConfig, writeAppConfigFile, WEIXIN_CONFIG } from './config'
import { formatSessionMessagesPreview } from './utils/messagePreview'
import * as timers from './timers'
import { DEFAULT_WEIXIN_BASE_URL, DEFAULT_WEIXIN_LOGIN_BOT_TYPE, startWeixinQrLogin, waitForWeixinQrLogin } from './weixin/api'
import { checkTimerPermission } from './isolatedCheck'

export type CommandDef = {
  description: string
  usage?: string
  requiresSession?: boolean
  showInTelegram?: boolean
  autocomplete?: CommandAutocomplete
  handler: (ctx: ChannelContext, args: string[], sessionId?: string, session?: Session) => Promise<void>
}

export type CommandAutocompleteNode = {
  value: string
  kind?: 'literal' | 'placeholder'
  description?: string
  usage?: string
  insertValue?: string
  children?: CommandAutocompleteNode[]
}

export type CommandAutocomplete = {
  children?: CommandAutocompleteNode[]
}

function literalNode(value: string, description: string, extras: Partial<CommandAutocompleteNode> = {}): CommandAutocompleteNode {
  return {
    value,
    kind: 'literal',
    description,
    ...extras,
  }
}

function placeholderNode(value: string, description: string, extras: Partial<CommandAutocompleteNode> = {}): CommandAutocompleteNode {
  return {
    value,
    kind: 'placeholder',
    description,
    ...extras,
  }
}

const TIMER_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  literalNode('list', 'List timers for the current session'),
  literalNode('delete', 'Delete a timer by id', {
    usage: '/timer delete <id>',
    children: [placeholderNode('<id>', 'Timer identifier')],
  }),
  literalNode('after', 'Create a one-time timer after N seconds', {
    usage: '/timer after <seconds> [--new-session] [--prefix <prefix>] [--agent <agent>] [--] <message>',
    children: [placeholderNode('<seconds>', 'Delay in seconds')],
  }),
  literalNode('at', 'Create a one-time timer at an absolute time', {
    usage: '/timer at <ISO-time> [--new-session] [--prefix <prefix>] [--agent <agent>] [--] <message>',
    children: [placeholderNode('<ISO-time>', 'Absolute time like 2026-03-13T12:00:00Z')],
  }),
  literalNode('cron', 'Create a recurring cron timer', {
    usage: '/timer cron <expr> [--new-session] [--prefix <prefix>] [--agent <agent>] -- <message>',
    children: [placeholderNode('<expr>', 'Cron expression (5 or 6 fields)')],
  }),
]

const SESSION_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  literalNode('list', 'List all sessions', {
    usage: '/session list [page]',
    children: [placeholderNode('[page]', 'Optional page number')],
  }),
  literalNode('new', 'Create a new ad-hoc session'),
  literalNode('create', 'Create a session under an existing agent', {
    usage: '/session create <agent> <session>',
    children: [
      placeholderNode('<agent>', 'Existing agent name', {
        children: [placeholderNode('<session>', 'New session name')],
      }),
    ],
  }),
  literalNode('fork', 'Fork the current session'),
  literalNode('delete', 'Delete a session', {
    usage: '/session delete <sessionId>',
    children: [placeholderNode('<sessionId>', 'Target session id')],
  }),
  literalNode('clear', 'Clear the current session history'),
  literalNode('rename', 'Set a session display name', {
    usage: '/session rename <name>',
    children: [placeholderNode('<name>', 'New display name')],
  }),
  literalNode('update-snapshot', 'Refresh a session prompt snapshot', {
    usage: '/session update-snapshot [session-id]',
    children: [placeholderNode('[session-id]', 'Defaults to the current session')],
  }),
  literalNode('compact-threshold', 'Get/set the auto-compact threshold override for the current session', {
    usage: '/session compact-threshold [tokens|Nk|clear|unset]',
    children: [
      placeholderNode('[tokens|Nk]', 'Examples: 8000, 8k'),
      literalNode('clear', 'Clear the session override and inherit the default threshold'),
      literalNode('unset', 'Alias of clear'),
    ],
  }),
  literalNode('index', 'Force archive indexing for the current session'),
  literalNode('move', 'Rename the current session or move it to an existing agent', {
    usage: '/session move <new-session-id>|<existing-agent>/<new-session-id>',
    children: [placeholderNode('<new-session-id|agent/session>', 'Rename target or existing-agent/new-session-id')],
  }),
  literalNode('parent', 'Set a parent session', {
    usage: '/session parent <parent-session-id> [child-session-id]',
    children: [
      placeholderNode('<parent-session-id>', 'Parent session id', {
        children: [placeholderNode('[child-session-id]', 'Defaults to the current session')],
      }),
    ],
  }),
  literalNode('unparent', 'Remove a parent session', {
    usage: '/session unparent [child-session-id]',
    children: [placeholderNode('[child-session-id]', 'Defaults to the current session')],
  }),
  literalNode('archive', 'Archive a session', {
    usage: '/session archive [session-id]',
    children: [placeholderNode('[session-id]', 'Defaults to the current session')],
  }),
  literalNode('unarchive', 'Unarchive a session', {
    usage: '/session unarchive [session-id]',
    children: [placeholderNode('[session-id]', 'Defaults to the current session')],
  }),
]

const AGENT_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  literalNode('list', 'List all agents'),
  literalNode('create', 'Create a new agent', {
    usage: '/agent create <name> [--no-main] [--isolated <node-id>]',
    children: [
      placeholderNode('<name>', 'New agent name', {
        children: [
          literalNode('--no-main', 'Create the agent without a main session'),
          literalNode('--isolated', 'Create the agent in isolated mode bound to a node', {
            children: [placeholderNode('<node-id>', 'Bound non-master node id')],
          }),
        ],
      }),
    ],
  }),
  literalNode('isolated', 'Set or clear agent-level isolation', {
    usage: '/agent isolated <agent> <node-id|off>',
    children: [
      placeholderNode('<agent>', 'Agent name', {
        children: [placeholderNode('<node-id|off>', 'Bind to node id or disable isolation with off')],
      }),
    ],
  }),
  literalNode('inherit', 'Set or clear shared-memory inheritance', {
    usage: '/agent inherit <agent> <parent-agent|none>',
    children: [
      placeholderNode('<agent>', 'Agent to update', {
        children: [placeholderNode('<parent-agent|none>', 'Parent agent name or none')],
      }),
    ],
  }),
  literalNode('delete', 'Delete an agent and all its sessions', {
    usage: '/agent delete <name> [--confirm]',
    children: [
      placeholderNode('<name>', 'Agent to delete', {
        children: [literalNode('--confirm', 'Required confirmation flag')],
      }),
    ],
  }),
]

const SKILL_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  literalNode('list', 'List available skills'),
  literalNode('attach', 'Attach a skill to an agent', {
    usage: '/skill attach <agent> <skill>',
    children: [
      placeholderNode('<agent>', 'Target agent', {
        children: [placeholderNode('<skill>', 'Skill name')],
      }),
    ],
  }),
  literalNode('detach', 'Detach a skill from an agent', {
    usage: '/skill detach <agent> <skill>',
    children: [
      placeholderNode('<agent>', 'Target agent', {
        children: [placeholderNode('<skill>', 'Skill name')],
      }),
    ],
  }),
  literalNode('show', 'Show skill documents', {
    usage: '/skill show <skill>',
    children: [placeholderNode('<skill>', 'Skill name')],
  }),
]

const NODE_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  literalNode('pair', 'Node pairing token, help, and pending requests', {
    children: [
      literalNode('help', 'Show node pairing/bootstrap help'),
      literalNode('list', 'List pending node pairing requests'),
      literalNode('token', 'Show the current node pairing token'),
      literalNode('approve', 'Approve a pending node pairing request', {
        usage: '/node pair approve <pending-id> [node-id]',
        children: [
          placeholderNode('<pending-id>', 'Pending pairing id', {
            children: [placeholderNode('[node-id]', 'Optional final node id')],
          }),
        ],
      }),
      literalNode('reject', 'Reject a pending node pairing request', {
        usage: '/node pair reject <pending-id>',
        children: [placeholderNode('<pending-id>', 'Pending pairing id')],
      }),
    ],
  }),
  literalNode('known', 'List approved nodes, including offline ones'),
  placeholderNode('<node-id>', 'Existing node id; omit it to list nodes'),
]

async function ensureNodePairingToken(): Promise<string> {
  try {
    const token = await fs.readFile(NODE_TOKEN_FILE, 'utf8')
    return token.trim()
  } catch (err: any) {
    if (err?.code === 'ENOENT') {
      const token = crypto.randomBytes(32).toString('hex')
      await fs.ensureDir(path.dirname(NODE_TOKEN_FILE))
      await fs.writeFile(NODE_TOKEN_FILE, token)
      return token
    }
    throw err
  }
}

function buildNodePairHelp(token: string): string {
  const baseUrl = `http://localhost:${HTTP_PORT}`

  return [
    '🧩 **Node Pairing / Bootstrap Help**',
    '',
    `Current pairing token: \`${token}\``,
    '',
    'Use `/node pair token` if you only want the raw token for copying.',
    '',
    `Default examples below use \`${baseUrl}\`. If the node runs on another machine or phone, replace \`localhost\` with a reachable host/IP/domain for this Foxwarm master.`,
    '',
    '**Bare metal (recommended Linux host bootstrap)**',
    '```bash',
    `curl -fsSL ${baseUrl}/node/run.sh | bash -s -- \\\n  --host=${baseUrl} \\\n  --pairing=${token} \\\n  --node-id=my-node`,
    '```',
    '',
    '**Docker bootstrap**',
    '```bash',
    `curl -fsSL ${baseUrl}/node/run-docker.sh | bash -s -- \\\n  --host=${baseUrl} \\\n  --pairing=${token} \\\n  --node-id=my-node`,
    '```',
    '',
    '**Manual docker-compose template**',
    '```bash',
    `curl -fsSL ${baseUrl}/node/docker-compose.yaml -o docker-compose.yaml`,
    'cat > .env <<\'EOF\'',
    `NODE_HOST=${baseUrl}`,
    `NODE_SOURCE_URL=${baseUrl}/node/source.tar.gz`,
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
    '/node pair list',
    '/node pair approve <pending-id> my-node',
    '/node known',
    '/node',
    '```',
    '',
    'Notes:',
    '- `/node/run.sh` = bare-metal bootstrap',
    '- `/node/run-docker.sh` = Docker bootstrap',
    '- `/node/docker-compose.yaml` = inspect/customize the self-contained compose template first',
  ].join('\n')
}

const MESSAGES_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  placeholderNode('<num>', 'Positive = oldest messages, negative = newest', {
    children: [placeholderNode('[end]', 'Optional end index for a range')],
  }),
]

const MODEL_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  literalNode('default', 'Reset to the default model'),
  placeholderNode('<name>', 'Model name or partial model name'),
]

const DELETE_MESSAGES_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  placeholderNode('<num>', 'Positive = oldest, negative = newest'),
]

const VERBOSE_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  literalNode('on', 'Show tool calls and verbose details'),
  literalNode('off', 'Hide tool calls and verbose details'),
]

const CHANNEL_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  literalNode('info', 'Show current channel identifiers and attachment state'),
  literalNode('auth', 'Show current channel authorization diagnostics'),
  literalNode('status', 'Show runtime channel status', {
    children: [placeholderNode('[channel-id-or-type]', 'Optional channel id (preferred) or type, e.g. weixin')],
  }),
  literalNode('start', 'Start a managed channel without restarting foxwarm', {
    children: [placeholderNode('<channel-id>', 'Managed channel id, e.g. weixin or mainbot')],
  }),
  literalNode('stop', 'Stop a managed channel', {
    children: [placeholderNode('<channel-id>', 'Managed channel id, e.g. weixin or mainbot')],
  }),
  literalNode('restart', 'Restart a managed channel', {
    children: [placeholderNode('<channel-id>', 'Managed channel id, e.g. weixin or mainbot')],
  }),
  literalNode('mode', 'Set channel mode', {
    children: [
      literalNode('push-only', 'Only accept direct/push-style messages'),
      literalNode('normal', 'Normal interactive mode'),
    ],
  }),
  literalNode('dangerously-allow-all-group-members', 'Allow all group members to use commands', {
    children: [
      literalNode('yes', 'Enable allow-all mode'),
      literalNode('no', 'Disable allow-all mode'),
    ],
  }),
]

function formatChannelInfo(ctx: ChannelContext): string {
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
    `- dangerouslyAllowAllGroupMembers: \`${channelConfig?.dangerouslyAllowAllGroupMembers ? 'yes' : 'no'}\``,
    runtimeStatus ? `- runtime: \`${runtimeStatus.running ? 'running' : 'stopped'}\`` : undefined,
  ].filter(Boolean).join('\n')
}

function formatChannelRuntimeStatus(channelId?: string, typeFilter?: string): string {
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

function getManagedPlatformHelp(): string {
  const platforms = getManagedChannelIds()
  return platforms.length > 0 ? platforms.join(', ') : '(none)'
}

const SEARCH_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  literalNode('--session', 'Restrict search to one session in your allowed scope', {
    children: [placeholderNode('<session-id>', 'Session id within your allowed scope')],
  }),
  literalNode('--agent', 'Restrict search to your current agent', {
    children: [placeholderNode('<agent-name>', 'Current agent only')],
  }),
  literalNode('--limit', 'Maximum number of matches', {
    children: [placeholderNode('<n>', 'Result limit, default 5')],
  }),
  placeholderNode('<query>', 'Search query text'),
]

const messagesUsage = 'Usage: `/messages <num>` | `/messages <start> <end>`'
const deleteMessagesUsage = 'Usage: `/delete-messages <num>` (positive: delete oldest, negative: delete newest)'

function formatTimerDate(timestamp?: number | null): string {
  if (!timestamp) return 'n/a'
  const date = new Date(timestamp)
  return Number.isNaN(date.getTime()) ? 'n/a' : date.toISOString()
}

function parseTimerFlags(tokens: string[]) {
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

function parseTimerMessage(tokens: string[]): string {
  if (tokens[0] === '--') {
    return tokens.slice(1).join(' ')
  }
  return tokens.join(' ')
}

function parseSessionMoveTarget(rawTarget: string): { newSessionId: string; newAgentName?: string } {
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

function parseCompactThresholdInput(raw: string): number | null {
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

async function handleCompactCommand(ctx: ChannelContext, args: string[], sessionId?: string, session?: Session) {
  if (!sessionId || !session) return
  if (session.history.length === 0) {
    ctx.reply('History is empty.')
    return
  }

  if (args[0] === 'tools') {
    let keepPercent = COMPACT_PERCENT
    if (args.length >= 2) {
      const pct = parseFloat(args[1])
      if (!isNaN(pct) && pct > 0 && pct <= 100) {
        keepPercent = pct / 100
      }
    }

    const result = await sessionManager.compactSessionToolMessages(sessionId, keepPercent)
    ctx.reply(
      `🧹 Tool-noise compaction finished. Replaced ${result.replacedFunctionCalls} tool call(s) and ${result.replacedFunctionResponses} tool response(s) across ${result.touchedMessages} message(s). `
      + `Inspected ${result.inspectedMessages} older message(s); kept the most recent ${Math.max(0, session.history.length - result.keepStartIndex)} message(s) untouched.`
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

  const result = await sessionManager.requestSessionCompaction(sessionId, { keepPercent, requestedBy: 'command' })

  if (result.alreadyQueued) {
    ctx.reply('ℹ️ Compaction is already queued for this session.')
    return
  }

  if (result.startedImmediately) {
    ctx.reply('🗜️ Compaction requested. It runs in parallel, so this chat can continue normally.')
    return
  }

  ctx.reply(`⏳ Background compaction queued. Once it starts, it will run without blocking this chat. Pending queue length: ${result.queueLength}`)
}

export const COMMANDS: Record<string, CommandDef> = {
  '/help': {
    description: 'Show help',
    requiresSession: false,
    handler: async (ctx) => {
      let resp = '📖 *Commands*\n\n'
      for (const [cmd, def] of Object.entries(COMMANDS)) {
        if (def.showInTelegram === false) continue
        resp += `\`${cmd}\` - ${def.description}`
        if (def.usage) resp += ` ${def.usage}`
        resp += '\n'
      }
      ctx.reply(resp)
    }
  },
  '/compact': {
    description: 'Compact history. `args: [keep%]` or `/compact tools [keep%]`',
    requiresSession: true,
    autocomplete: {
      children: [
        placeholderNode('[keep%]', 'Optional keep percentage, e.g. 20 or 50'),
        literalNode('tools', 'Compact oversized historical tool calls/results without running full history compaction', {
          usage: '/compact tools [keep%]',
          children: [placeholderNode('[keep%]', 'Optional keep percentage for recent messages left untouched')],
        }),
      ],
    },
    handler: handleCompactCommand,
  },
  '/compress': {
    description: 'Alias of /compact. `args: [keep%]` or `/compress tools [keep%]`',
    requiresSession: true,
    autocomplete: {
      children: [
        placeholderNode('[keep%]', 'Optional keep percentage, e.g. 20 or 50'),
        literalNode('tools', 'Compact oversized historical tool calls/results without running full history compaction', {
          usage: '/compress tools [keep%]',
          children: [placeholderNode('[keep%]', 'Optional keep percentage for recent messages left untouched')],
        }),
      ],
    },
    handler: handleCompactCommand,
    showInTelegram: false,
  },
  '/timer': {
    description: 'Manage session timers: help, list, create, delete',
    requiresSession: true,
    autocomplete: { children: TIMER_AUTOCOMPLETE },
    handler: async (ctx, args, sessionId, session) => {
      if (!sessionId || !session) return

      const subcommand = args[0]
      const subArgs = args.slice(1)

      if (!subcommand) {
        let resp = '⏰ *Timer Commands*\n\n'
        resp += '`/timer list` - List timers for current session\n'
        resp += '`/timer delete <id>` - Delete a timer\n'
        resp += '`/timer after <seconds> [--new-session] [--prefix <prefix>] [--agent <agent>] [--] <message>` - Create a one-time timer after N seconds\n'
        resp += '`/timer at <ISO-time> [--new-session] [--prefix <prefix>] [--agent <agent>] [--] <message>` - Create a one-time timer at an absolute time\n'
        resp += '`/timer cron <expr> [--new-session] [--prefix <prefix>] [--agent <agent>] -- <message>` - Create a recurring cron timer (5 or 6 field cron)\n'
        ctx.reply(resp)
        return
      }

      switch (subcommand) {
        case 'list': {
          await checkTimerPermission(sessionId, { targetSessionId: sessionId })
          const sessionTimers = timers.listTimers(sessionId)
          if (sessionTimers.length === 0) {
            ctx.reply('No timers found for this session.')
            return
          }

          let resp = `⏰ *Timers* (${sessionTimers.length})\n\n`
          for (const timer of sessionTimers) {
            const nextRun = formatTimerDate(timer.nextRunAt)
            const mode = timer.mode === 'cron' ? `cron: \`${timer.cron}\`` : `once: \`${formatTimerDate(timer.at)}\``
            const target = timer.newSession
              ? `new session (agent: \`${timer.agentName || 'main'}\`, prefix: \`${timer.sessionPrefix || 'timer'}\`)`
              : 'current session'
            resp += `- \`${timer.id}\` - ${mode} - next: ${nextRun} - ${target}\n`
            resp += `  ${timer.message}\n`
          }

          ctx.reply(resp)
          return
        }

        case 'delete': {
          await checkTimerPermission(sessionId, { targetSessionId: sessionId })
          const timerId = subArgs[0]
          if (!timerId) {
            ctx.reply('Usage: /timer delete <id>')
            return
          }

          try {
            const deleted = await timers.deleteTimer(timerId, sessionId)
            if (!deleted) {
              ctx.reply(`❌ Timer \`${timerId}\` not found.`)
              return
            }

            ctx.reply(`✅ Timer \`${timerId}\` deleted.`)
          } catch (e: any) {
            ctx.reply(`❌ Timer delete failed: ${e.message}`)
          }
          return
        }

        case 'after': {
          if (subArgs.length < 2) {
            ctx.reply('Usage: /timer after <seconds> [--new-session] [--prefix <prefix>] [--agent <agent>] [--] <message>')
            return
          }

          const afterSeconds = parseFloat(subArgs[0])
          try {
            const flags = parseTimerFlags(subArgs.slice(1))
            await checkTimerPermission(sessionId, { targetSessionId: sessionId, newSession: flags.newSession, agentName: flags.agentName, sessionPrefix: flags.sessionPrefix })
            const message = parseTimerMessage(subArgs.slice(1 + flags.index))
            if (!message) {
              ctx.reply('Usage: /timer after <seconds> [--new-session] [--prefix <prefix>] [--agent <agent>] [--] <message>')
              return
            }

            const timer = await timers.createTimer({
              sessionId,
              afterSeconds,
              message,
              newSession: flags.newSession,
              sessionPrefix: flags.sessionPrefix,
              agentName: flags.agentName,
              currentNode: session.currentNode,
              model: session.model,
            })
            ctx.reply(`✅ Timer created: \`${timer.id}\`\nNext run: ${formatTimerDate(timer.nextRunAt)}`)
          } catch (e: any) {
            ctx.reply(`❌ Timer create failed: ${e.message}`)
          }
          return
        }

        case 'at': {
          if (subArgs.length < 2) {
            ctx.reply('Usage: /timer at <ISO-time> [--new-session] [--prefix <prefix>] [--agent <agent>] [--] <message>')
            return
          }

          const at = subArgs[0]
          try {
            const flags = parseTimerFlags(subArgs.slice(1))
            await checkTimerPermission(sessionId, { targetSessionId: sessionId, newSession: flags.newSession, agentName: flags.agentName, sessionPrefix: flags.sessionPrefix })
            const message = parseTimerMessage(subArgs.slice(1 + flags.index))
            if (!message) {
              ctx.reply('Usage: /timer at <ISO-time> [--new-session] [--prefix <prefix>] [--agent <agent>] [--] <message>')
              return
            }

            const timer = await timers.createTimer({
              sessionId,
              at,
              message,
              newSession: flags.newSession,
              sessionPrefix: flags.sessionPrefix,
              agentName: flags.agentName,
              currentNode: session.currentNode,
              model: session.model,
            })
            ctx.reply(`✅ Timer created: \`${timer.id}\`\nNext run: ${formatTimerDate(timer.nextRunAt)}`)
          } catch (e: any) {
            ctx.reply(`❌ Timer create failed: ${e.message}`)
          }
          return
        }

        case 'cron': {
          let cronEnd = 0
          while (cronEnd < subArgs.length && subArgs[cronEnd] !== '--' && !subArgs[cronEnd].startsWith('--')) {
            cronEnd += 1
          }

          const cron = subArgs.slice(0, cronEnd).join(' ')
          if (!cron) {
            ctx.reply('Usage: /timer cron <expr> [--new-session] [--prefix <prefix>] [--agent <agent>] -- <message>')
            return
          }

          try {
            const flags = parseTimerFlags(subArgs.slice(cronEnd))
            await checkTimerPermission(sessionId, { targetSessionId: sessionId, newSession: flags.newSession, agentName: flags.agentName, sessionPrefix: flags.sessionPrefix })
            const message = parseTimerMessage(subArgs.slice(cronEnd + flags.index))
            if (!message) {
              ctx.reply('Usage: /timer cron <expr> [--new-session] [--prefix <prefix>] [--agent <agent>] -- <message>')
              return
            }

            const timer = await timers.createTimer({
              sessionId,
              cron,
              message,
              newSession: flags.newSession,
              sessionPrefix: flags.sessionPrefix,
              agentName: flags.agentName,
              currentNode: session.currentNode,
              model: session.model,
            })
            ctx.reply(`✅ Cron timer created: \`${timer.id}\`\nCron: \`${cron}\`\nNext run: ${formatTimerDate(timer.nextRunAt)}`)
          } catch (e: any) {
            ctx.reply(`❌ Timer create failed: ${e.message}`)
          }
          return
        }

        default:
          ctx.reply('Usage: /timer | /timer list | /timer delete <id> | /timer after <seconds> [--new-session] [--prefix <prefix>] [--agent <agent>] [--] <message> | /timer at <ISO-time> [--new-session] [--prefix <prefix>] [--agent <agent>] [--] <message> | /timer cron <expr> [--new-session] [--prefix <prefix>] [--agent <agent>] -- <message>')
      }
    }
  },
  '/status': {
    description: 'Show current session status',
    requiresSession: true,
    handler: async (ctx, _args, sessionId, session) => {
      if (!sessionId || !session) return
      const historyLen = session.history.length
      const tokenCount = estimateSessionTokens(session)
      const usage = session.stats.lastUsage

      let resp = `📊 *Foxwarm Status*\n`
      resp += `\n*Session:* \`${sessionId}\``
      resp += `\n*Channel:* ${getChannelId(ctx)}:${getConversationId(ctx)} (type=${getChannelType(ctx)})`
      resp += `\n- Messages: ${historyLen}`
      const { currentKey, contextLimit } = resolveModelConfig(session.model)

      resp += `\n- Model: ${currentKey}`
      resp += `\n- Size: ~${(tokenCount / 1000).toFixed(1)}K tokens / ${(contextLimit / 1000).toFixed(1)}K tokens`
      if (usage) {
        resp += `\n*Last Turn Usage: - Cached: ${usage.cachedTokens || 0} / Input: ${usage.inputTokens} / Output: ${usage.outputTokens}`
      }
      resp += `\n*Total Session Usage - Cached: ${session.stats.totalCachedTokens || 0} / Input: ${session.stats.totalInputTokens} / Output: ${session.stats.totalOutputTokens}`

      ctx.reply(resp)
    }
  },
  '/session': {
    description: 'Manage sessions: list, fork, move, parent/unparent, archive',
    requiresSession: false,
    autocomplete: { children: SESSION_AUTOCOMPLETE },
    handler: async (ctx, args, sessionId, session) => {
      // Manually get session for subcommands that need it
      if (!sessionId) {
        sessionId = sessionManager.getSessionByChannel(getChannelId(ctx), getConversationId(ctx));
      }
      if (!session && sessionId) {
        session = await sessionManager.getSession(sessionId);
      }
      
      const subcommand = args[0]
      const subArgs = args.slice(1)
      if (!subcommand) {
        let resp = '📋 *Session Commands*\n\n'
        resp += '`/session list` - List all sessions\n'
        resp += '`/session new` - Create new ad-hoc session\n'
        resp += '`/session create <agent> <session>` - Create session under an existing agent\n'
        resp += '`/session fork [suffix]` - Fork current session as a child session (default suffix: `fork`)\n'
        resp += '`/session delete <sessionId>` - Delete session\n'
        resp += '`/session clear` - Clear current session history\n'
        resp += '`/session rename <name>` - Rename session\n'
        resp += '`/session update-snapshot [session-id]` - Refresh session prompt snapshot\n'
        resp += '`/session compact-threshold [tokens|Nk|clear|unset]` - Get/set auto-compact threshold override for current session\n'
        resp += '`/session subconscious <on|off|status>` - Manage the reflective subconscious side session for current session\n'
        resp += '`/session index` - Index messages to vector database\n'
        resp += '`/session move <new-session-id>|<existing-agent>/<new-session-id>` - Move/rename session\n'
        resp += '`/session parent <parent-session-id> [child-session-id]` - Set parent session\n'
        resp += '`/session unparent [child-session-id]` - Remove parent session\n'
        resp += '`/session archive [session-id]` - Archive session (default: current)\n'
        resp += '`/session unarchive [session-id]` - Unarchive session (default: current)\n'
        ctx.reply(resp)
        return
      }

      switch (subcommand) {
        case 'list': {
          const allSessions = sessionManager.getAllSessions()
          const allAttachments = sessionManager.getAllAttachments()

          let page = 1
          if (subArgs.length >= 1) {
            const p = parseInt(subArgs[0])
            if (!isNaN(p) && p > 0) {
              page = p
            }
          }

          const PAGE_SIZE = 20
          const sessionEntries = Array.from(allSessions.entries())
            .sort((a, b) => {
              const timeA = a[1].meta?.lastMessageTime || 0
              const timeB = b[1].meta?.lastMessageTime || 0
              return timeB - timeA
            })
          const totalPages = Math.ceil(sessionEntries.length / PAGE_SIZE)

          if (page > totalPages && totalPages > 0) {
            ctx.reply(`Page ${page} not found. Total pages: ${totalPages}`)
            return
          }

          const startIdx = (page - 1) * PAGE_SIZE
          const endIdx = Math.min(startIdx + PAGE_SIZE, sessionEntries.length)
          const pageEntries = sessionEntries.slice(startIdx, endIdx)

          let resp = `📋 *All Sessions* (Page ${page}/${totalPages || 1})\n\n`
          for (const [sid, sess] of pageEntries) {
            const attachedChannels = Array.from(allAttachments.entries())
              .filter(([_, info]) => info.sessionId === sid)
              .map(([channelKey, _]) => channelKey)

            const msgCount = sess.meta?.messageCount || sess.history.length
            const displayName = sess.displayName ? ` (${sess.displayName})` : ''
            const node = sess.currentNode || 'master'
            const isolated = sessionManager.isSessionEffectivelyIsolated(sess) ? ' isolated' : ''
            resp += `\`${sid}\`${displayName} - ${msgCount} msgs - node: \`${node}\`${isolated}\n`
            if (attachedChannels.length) {
              resp += `    - channels: \`${attachedChannels.join(', ')}\`\n`
            }
          }

          if (totalPages > 1) {
            resp += `\nUse \`/session list <page>\` to view other pages.`
          }

          ctx.reply(resp)
          break
        }

        case 'new': {
          sessionManager.detachChannel(getChannelId(ctx), getConversationId(ctx))
          const newSessionId = sessionManager.attachChannel(getChannelId(ctx), getConversationId(ctx))
          ctx.reply(`✅ Created and attached to new session \`${newSessionId}\``)
          break
        }

        case 'create': {
          if (subArgs.length < 2) {
            ctx.reply('Usage: /session create <agent> <session>')
            return
          }

          const agentName = subArgs[0]
          const newSessionName = subArgs[1]

          try {
            const result = await sessionManager.createSessionInAgent({
              agentName,
              sessionName: newSessionName,
              currentNode: session?.currentNode,
              model: session?.model,
            })

            sessionManager.detachChannel(getChannelId(ctx), getConversationId(ctx))
            sessionManager.attachChannel(getChannelId(ctx), getConversationId(ctx), result.sessionId)
            ctx.reply(`✅ Created session \`${result.sessionId}\` under agent \`${agentName}\` and attached current channel.`)
          } catch (e: any) {
            ctx.reply(`❌ Session create failed: ${e.message}`)
          }
          break
        }

        case 'fork': {
          if (!sessionId || !session) {
            ctx.reply('❌ No active session to fork.')
            return
          }
          const suffix = subArgs[0]
          const forkedSessionId = await sessionManager.forkSession(sessionId, suffix)
          sessionManager.detachChannel(getChannelId(ctx), getConversationId(ctx))
          sessionManager.attachChannel(getChannelId(ctx), getConversationId(ctx), forkedSessionId)
          ctx.reply(`✅ Forked child session \`${sessionId}\` → \`${forkedSessionId}\`\nMessages: ${session.history.length}`)
          break
        }

        case 'delete': {
          if (subArgs.length === 0) {
            ctx.reply('Usage: /session delete <sessionId>\nUse /session list to see available sessions.')
            return
          }

          const targetSessionId = subArgs[0]

          if (targetSessionId === sessionId) {
            ctx.reply('❌ Cannot delete current session. Use /session clear to clear history or /attach to switch to another session first.')
            return
          }

          try {
            const prep = await sessionManager.prepareSessionForDestructiveAction(targetSessionId)
            if (prep.requiresRetry) {
              const queueNote = prep.droppedQueueItems > 0
                ? ` Cleared ${prep.droppedQueueItems} queued item(s).`
                : ''
              const stopNote = prep.abortedInFlight
                ? ' The in-flight LLM request was aborted.'
                : ' It will stop after the current tool call completes.'
              ctx.reply(`🛑 Session \`${targetSessionId}\` is busy. Stop signal sent.${stopNote}${queueNote} Retry delete after it becomes idle.`)
              return
            }
          } catch (e: any) {
            ctx.reply(`❌ ${e.message}`)
            return
          }

          const deleted = await sessionManager.deleteSession(targetSessionId)

          if (deleted) {
            ctx.reply(`✅ Session \`${targetSessionId}\` deleted.`)
          } else {
            ctx.reply(`❌ Session \`${targetSessionId}\` not found.`)
          }
          break
        }

        case 'clear': {
          if (!sessionId) {
            ctx.reply('❌ No active session to clear.')
            return
          }

          const prep = await sessionManager.prepareSessionForDestructiveAction(sessionId)
          if (prep.requiresRetry) {
            const queueNote = prep.droppedQueueItems > 0
              ? ` Cleared ${prep.droppedQueueItems} queued item(s).`
              : ''
            const stopNote = prep.abortedInFlight
              ? ' The in-flight LLM request was aborted.'
              : ' It will stop after the current tool call completes.'
            ctx.reply(`🛑 Current session is busy. Stop signal sent.${stopNote}${queueNote} Retry /session clear after it becomes idle.`)
            return
          }

          await sessionManager.clearSession(sessionId)
          ctx.reply('Session cleared.')
          break
        }

        case 'rename': {
          if (!sessionId || !session) {
            ctx.reply('❌ No active session to rename.')
            return
          }
          if (subArgs.length === 0) {
            ctx.reply('Usage: /session rename <new name>\nExample: /session rename My Project\nUse /session rename - to clear the name.')
            return
          }

          const newName = subArgs.join(' ')

          try {
            if (newName === '-') {
              session.displayName = undefined
              await sessionManager.saveSession(sessionId)
              ctx.reply('✅ Session display name cleared.')
            } else {
              session.displayName = newName.trim()
              await sessionManager.saveSession(sessionId)
              ctx.reply(`✅ Session renamed to "${session.displayName}".`)
            }
          } catch (e: any) {
            ctx.reply(`❌ Rename failed: ${e.message}`)
          }
          break
        }

        case 'update-snapshot': {
          const targetSessionId = subArgs[0] || sessionId

          if (!targetSessionId) {
            ctx.reply('❌ No active session. Usage: /session update-snapshot [session-id]')
            return
          }

          try {
            const result = await sessionManager.refreshSessionSnapshot(targetSessionId)
            ctx.reply(`✅ Session \`${result.sessionId}\` snapshot updated.\nAgent: \`${result.agentName}\``)
          } catch (e: any) {
            ctx.reply(`❌ Snapshot update failed: ${e.message}`)
          }
          break
        }

        case 'compact-threshold': {
          if (!sessionId || !session) {
            ctx.reply('❌ No active session.')
            return
          }

          if (subArgs.length === 0) {
            const effective = sessionManager.getEffectiveCompactThresholdTokens(session)
            if (typeof session.compactThresholdTokens === 'number') {
              ctx.reply(`🧮 Compact threshold override: \`${session.compactThresholdTokens}\` tokens\nEffective auto-compact threshold: \`${effective}\` tokens`)
            } else {
              ctx.reply(`🧮 Compact threshold override: inherit global default\nEffective auto-compact threshold: \`${effective}\` tokens`)
            }
            return
          }

          const rawValue = subArgs[0].trim().toLowerCase()
          try {
            if (rawValue === 'clear' || rawValue === 'unset') {
              const result = await sessionManager.setSessionCompactThreshold(sessionId)
              ctx.reply(`✅ Compact threshold override cleared.\nEffective auto-compact threshold: \`${result.effectiveThresholdTokens}\` tokens`)
              return
            }

            const thresholdTokens = parseCompactThresholdInput(subArgs[0])
            const result = await sessionManager.setSessionCompactThreshold(sessionId, thresholdTokens)
            ctx.reply(`✅ Compact threshold updated to \`${result.thresholdTokens}\` tokens.\nEffective auto-compact threshold: \`${result.effectiveThresholdTokens}\` tokens`)
          } catch (e: any) {
            ctx.reply(`❌ Compact threshold update failed: ${e.message}`)
          }
          break
        }

        case 'subconscious': {
          if (!sessionId || !session) {
            ctx.reply('❌ No active session.')
            return
          }
          if (sessionManager.isSubconsciousSession(session)) {
            ctx.reply(`🧠 This session is itself a subconscious side session for \`${sessionManager.getSubconsciousPrimarySessionId(session) || 'unknown'}\`.`)
            return
          }

          const action = (subArgs[0] || 'status').toLowerCase()
          if (action === 'status') {
            const status = sessionManager.getSubconsciousStatus(session)
            const lines = [
              `🧠 Subconscious side session: ${status.enabled ? 'enabled' : 'disabled'}`,
              `Side session: ${status.sideSessionId ? `\`${status.sideSessionId}\`` : 'not created'}`,
              `Pending counted messages: ${status.pendingMessageCount}`,
              `Trigger every: ${status.triggerEveryMessages} counted message(s)`,
              'Cooldown: message-based via counted-message reset (no wall-clock cooldown)',
            ]
            if (typeof status.lastTriggeredAt === 'number') {
              lines.push(`Last triggered: ${new Date(status.lastTriggeredAt).toISOString()}`)
            }
            if (typeof status.lastHintAt === 'number') {
              lines.push(`Last hint sent: ${new Date(status.lastHintAt).toISOString()}`)
            }

            if (status.sideSessionId) {
              const sideSession = await sessionManager.getExistingSession(status.sideSessionId)
              if (sideSession) {
                lines.push(`Side compact threshold: ${sideSession.compactThresholdTokens || sessionManager.getEffectiveCompactThresholdTokens(sideSession)} tokens`)
              }
            }

            ctx.reply(lines.join('\n'))
            return
          }

          if (action === 'on' || action === 'enable') {
            const result = await sessionManager.setSubconsciousEnabled(sessionId, true)
            ctx.reply([
              `✅ Subconscious side session enabled.`,
              `Side session: \`${result.sideSessionId}\`${result.created ? ' (created)' : ''}`,
              `Side compact threshold: ${result.compactThresholdTokens} tokens`,
            ].join('\n'))
            return
          }

          if (action === 'off' || action === 'disable') {
            const result = await sessionManager.setSubconsciousEnabled(sessionId, false)
            ctx.reply(`✅ Subconscious side session disabled. Side session remains stored as \`${result.sideSessionId}\`.`)
            return
          }

          ctx.reply('Usage: /session subconscious <on|off|status>')
          return
        }

        case 'isolated': {
          if (!sessionId || !session) {
            ctx.reply('❌ No active session.')
            return
          }

          const agentIsolationNode = sessionManager.getAgentIsolationNode(session.agent || 'main')
          if (agentIsolationNode) {
            ctx.reply(`🔒 Session-level isolated mode has been removed. This session inherits agent isolation on node \`${agentIsolationNode}\`. Use \`/agent isolated\` to change it.`)
            return
          }

          ctx.reply('ℹ️ Session-level isolated mode has been removed. Use `currentNode` for ordinary node selection, or `/agent isolated <agent> <node-id|off>` for agent-level isolation.')
          break
        }

        case 'index': {
          if (!sessionId || !session) {
            ctx.reply('❌ No active session to index.')
            return
          }

          const latestSeq = Math.max(0, (session.nextMessageSeq || 1) - 1)
          ctx.reply(`🔄 Indexing session archive up to seq ${latestSeq}...`)

          try {
            await sessionManager.forceIndexSession(sessionId)
            ctx.reply(`✅ Archive indexing completed up to seq ${latestSeq}.`)
          } catch (e: any) {
            ctx.reply(`❌ Indexing failed: ${e.message}`)
          }
          break
        }

        case 'move': {
          if (!sessionId || !session) {
            ctx.reply('❌ No active session to move.')
            return
          }
          if (subArgs.length === 0) {
            ctx.reply('Usage: /session move <new-session-id>|<existing-agent>/<new-session-id>\nExample: /session move my-project\nExample: /session move my-agent/main\nNote: /session move only renames the current session or moves it to an existing agent. It does not create agents.')
            return
          }

          const targetId = subArgs[0]
          
          try {
            const { newSessionId, newAgentName } = parseSessionMoveTarget(targetId)
            const result = await sessionManager.moveSessionToTarget({
              sourceSessionId: sessionId,
              newSessionId,
              newAgentName,
            })

            let message = `✅ Session \`${sessionId}\` moved to \`${result.targetSessionId}\`.`
            if (result.createdAgent) {
              message += `\nAgent \`${result.targetAgent}\` created.`
            }
            if (result.aliases.length > 0) {
              message += `\nAliases: ${result.aliases.map(alias => `\`${alias}\``).join(', ')}`
            }
            if (result.updatedChildren.length > 0) {
              message += `\nUpdated ${result.updatedChildren.length} child session parent reference(s).`
            }
            ctx.reply(message)
          } catch (e: any) {
            ctx.reply(`❌ Move failed: ${e.message}`)
          }
          break
        }

        case 'parent': {
          if (subArgs.length === 0) {
            ctx.reply('Usage: /session parent <parent-session-id> [child-session-id]')
            return
          }

          const parentSessionId = subArgs[0]
          const targetChildSessionId = subArgs[1] || sessionId

          if (!targetChildSessionId) {
            ctx.reply('❌ No active session. Specify [child-session-id] explicitly.')
            return
          }

          try {
            const result = await sessionManager.setSessionParent(targetChildSessionId, parentSessionId)
            const childLabel = targetChildSessionId === sessionId
              ? 'Current session'
              : `Session \`${result.childSessionId}\``

            if (result.previousParentSessionId === result.parentSessionId) {
              ctx.reply(`ℹ️ ${childLabel} already uses parent \`${result.parentSessionId}\`.`)
              return
            }

            let resp = `✅ ${childLabel} parent set to \`${result.parentSessionId}\`.`
            if (result.previousParentSessionId) {
              resp += `\nPrevious parent: \`${result.previousParentSessionId}\``
            }
            ctx.reply(resp)
          } catch (e: any) {
            ctx.reply(`❌ Parent update failed: ${e.message}`)
          }
          break
        }

        case 'unparent': {
          const targetChildSessionId = subArgs[0] || sessionId

          if (!targetChildSessionId) {
            ctx.reply('❌ No active session. Specify [child-session-id] explicitly.')
            return
          }

          try {
            const result = await sessionManager.setSessionParent(targetChildSessionId)
            const childLabel = targetChildSessionId === sessionId
              ? 'Current session'
              : `Session \`${result.childSessionId}\``

            if (!result.previousParentSessionId) {
              ctx.reply(`ℹ️ ${childLabel} has no parent session.`)
              return
            }

            ctx.reply(`✅ ${childLabel} detached from parent session \`${result.previousParentSessionId}\`.`)
          } catch (e: any) {
            ctx.reply(`❌ Unparent failed: ${e.message}`)
          }
          break
        }

        case 'archive': {
          const targetSessionId = subArgs.length > 0 ? subArgs[0] : sessionId
          
          if (!targetSessionId) {
            ctx.reply('❌ No session specified and no active session.')
            return
          }

          const targetSession = await sessionManager.getSession(targetSessionId)
          if (!targetSession) {
            ctx.reply(`❌ Session \`${targetSessionId}\` not found.`)
            return
          }

          // Archive by setting the archived flag
          targetSession.archived = true
          await sessionManager.saveSession(targetSessionId)

          ctx.reply(`✅ Session \`${targetSessionId}\` archived.`)
          break
        }

        case 'unarchive': {
          const targetSessionId = subArgs.length > 0 ? subArgs[0] : sessionId
          
          if (!targetSessionId) {
            ctx.reply('❌ No session specified and no active session.')
            return
          }

          const targetSession = await sessionManager.getSession(targetSessionId)
          if (!targetSession) {
            ctx.reply(`❌ Session \`${targetSessionId}\` not found.`)
            return
          }

          // Unarchive by removing the archived flag
          targetSession.archived = false
          await sessionManager.saveSession(targetSessionId)

          ctx.reply(`✅ Session \`${targetSessionId}\` unarchived.`)
          break
        }

        default:
          ctx.reply(`❌ Unknown subcommand: ${subcommand}\nUse \`/session\` to see available commands.`)
      }
    }
  },
  '/attach': {
    description: 'Attach to session. `args: <sessionId>`',
    requiresSession: false,
    autocomplete: {
      children: [placeholderNode('<sessionId>', 'Existing session id')],
    },
    handler: async (ctx, args) => {
      const currentSessionId = sessionManager.getSessionByChannel(getChannelId(ctx), getConversationId(ctx))
      if (args.length === 0) {
        ctx.reply('Usage: /attach <sessionId>\nUse /sessions to see available sessions.')
        return
      }

      const targetSessionId = args[0]
      const allSessions = sessionManager.getAllSessions()

      if (!allSessions.has(targetSessionId)) {
        ctx.reply(`Session \`${targetSessionId}\` not found. Use /sessions to see available sessions.`)
        return
      }

      sessionManager.detachChannel(getChannelId(ctx), getConversationId(ctx))
      sessionManager.attachChannel(getChannelId(ctx), getConversationId(ctx), targetSessionId)

      ctx.reply(`✅ Attached to session \`${targetSessionId}\``)
    }
  },
  '/agent': {
    description: 'Manage agents',
    requiresSession: false,
    autocomplete: { children: AGENT_AUTOCOMPLETE },
    handler: async (ctx, args) => {
      const currentSessionId = sessionManager.getSessionByChannel(getChannelId(ctx), getConversationId(ctx))
      const subcommand = args[0]
      const subArgs = args.slice(1)

      if (!subcommand) {
        let resp = '🤖 *Agent Commands*\n\n'
        resp += '`/agent list` - List all agents\n'
        resp += '`/agent create <name> [--no-main] [--isolated <node-id>]` - Create new agent\n'
        resp += '`/agent isolated <agent> <node-id|off>` - Set or clear agent isolation\n'
        resp += '`/agent inherit <agent> <parent-agent|none>` - Set or clear shared memory inheritance\n'
        resp += '`/agent delete <name> [--confirm]` - Delete agent (requires confirmation)\n'
        ctx.reply(resp)
        return
      }

      switch (subcommand) {
        case 'list': {
          const agentsDir = AGENTS_DIR
          
          if (!await fs.pathExists(agentsDir)) {
            ctx.reply('No agents found.')
            return
          }
          
          const entries = await fs.readdir(agentsDir, { withFileTypes: true })
          const agents: Array<{name: string, sessionCount: number, inherit?: string, skills?: string[], isolated?: boolean, isolatedNode?: string}> = []
          
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const agentName = entry.name
              const sessions = Array.from(sessionManager.getAllSessions().values())
                .filter(sess => (sess.agent || 'main') === agentName)
              
              agents.push({
                name: agentName,
                sessionCount: sessions.length,
                inherit: sessionManager.getAgentMetadata(agentName).inherit,
                skills: sessionManager.getAgentSkills(agentName),
                isolated: sessionManager.getAgentMetadata(agentName).isolated,
                isolatedNode: sessionManager.getAgentIsolationNode(agentName),
              })
            }
          }
          
          if (agents.length === 0) {
            ctx.reply('No agents found.')
            return
          }
          
          let resp = `🤖 *Agents* (${agents.length})\n\n`
          for (const agent of agents) {
            resp += `\`${agent.name}\``
            if (agent.sessionCount > 0) {
              resp += ` - ${agent.sessionCount} session${agent.sessionCount > 1 ? 's' : ''}`
            }
            if (agent.inherit) {
              resp += ` - inherits \`${agent.inherit}\``
            }
            if (agent.isolated) {
              resp += ` - isolated${agent.isolatedNode ? ` on \`${agent.isolatedNode}\`` : ''}`
            }
            if (agent.skills && agent.skills.length > 0) {
              resp += ` - skills: ${agent.skills.map(skill => `\`${skill}\``).join(', ')}`
            }
            resp += '\n'
          }
          ctx.reply(resp)
          break
        }

        case 'create': {
          if (subArgs.length === 0) {
            ctx.reply('Usage: /agent create <name> [--no-main] [--isolated <node-id>]\nExample: /agent create my-assistant\nExample: /agent create my-agent --no-main\nExample: /agent create sandbox-agent --isolated sandbox-node')
            return
          }

          const agentName = subArgs[0]
          const createMainSession = !subArgs.includes('--no-main')
          const isolatedFlagIndex = subArgs.indexOf('--isolated')
          const isolatedNode = isolatedFlagIndex >= 0 ? subArgs[isolatedFlagIndex + 1] : undefined
          
          try {
            sessionManager.validateAgentName(agentName)

            const soulContent = `# SOUL.md - Who You Are

*You are ${agentName}, an AI assistant.*

## Core Identity
- Helpful and precise
- Focus on your assigned tasks

## Working Style
- Think before acting
- Collaborate using send_to_session when needed
`

            const result = await sessionManager.createAgentWithMainSession({
              agentName,
              initialMemoryFiles: { 'SOUL.md': soulContent },
              currentNode: 'master',
              createMainSession,
              isolatedNode,
            })

            let resp = `✅ Agent "${agentName}" created successfully!\n\nAgent folder: \`agents/${agentName}\``
            resp += createMainSession
              ? `\nMain session: \`${result.mainSessionId}\``
              : '\nMain session: not created (`--no-main`)'
            if (isolatedNode) {
              resp += `\nIsolation: enabled on \`${isolatedNode}\``
            }
            ctx.reply(resp)
          } catch (e: any) {
            ctx.reply(`❌ Failed to create agent: ${e.message}`)
          }
          break
        }

        case 'isolated': {
          if (subArgs.length < 2) {
            ctx.reply('Usage: /agent isolated <agent> <node-id|off>')
            break
          }

          const agentName = subArgs[0]
          const mode = subArgs[1]
          try {
            const result = await sessionManager.setAgentIsolation(agentName, mode === 'off' ? undefined : mode)
            let resp = result.isolated
              ? `✅ Agent "${agentName}" is now isolated on node \`${result.node}\`.`
              : `✅ Agent "${agentName}" isolation cleared.`
            if (result.affectedSessions.length > 0) {
              resp += `\nUpdated ${result.affectedSessions.length} session(s).`
            }
            ctx.reply(resp)
          } catch (e: any) {
            ctx.reply(`❌ Failed to update agent isolation: ${e.message}`)
          }
          break
        }

        case 'inherit': {
          if (subArgs.length < 2) {
            ctx.reply('Usage: /agent inherit <agent> <parent-agent|none>')
            return
          }

          const agentName = subArgs[0]
          const inheritArg = subArgs[1]
          const inheritAgentName = inheritArg === 'none' ? undefined : inheritArg

          try {
            const result = await sessionManager.setAgentInherit(agentName, inheritAgentName)
            const chain = sessionManager.getAgentInheritanceChain(agentName)
            let resp = inheritAgentName
              ? `✅ Agent "${agentName}" now inherits shared memory from \`${inheritAgentName}\`.`
              : `✅ Cleared shared memory inheritance for agent "${agentName}".`

            resp += `\nInheritance chain: ${chain.map(name => `\`${name}\``).join(' -> ')}`
            if (result.affectedSessions.length > 0) {
              resp += `\nUpdated ${result.affectedSessions.length} session snapshot(s).`
            }
            ctx.reply(resp)
          } catch (e: any) {
            ctx.reply(`❌ Failed to update inherit: ${e.message}`)
          }
          break
        }

        case 'delete': {
          if (subArgs.length === 0) {
            ctx.reply('Usage: /agent delete <name> [--confirm]\nExample: /agent delete my-assistant --confirm\n\n⚠️ This will delete the agent and all its sessions permanently!')
            return
          }

          const agentName = subArgs[0]
          const confirmed = subArgs.includes('--confirm')

          if (!confirmed) {
            ctx.reply(`⚠️ Are you sure you want to delete agent "${agentName}"?\n\nThis will:\n- Delete all sessions for this agent\n- Delete the agent folder and memory\n- Cannot be undone\n\nTo confirm, run:\n\`/agent delete ${agentName} --confirm\``)
            return
          }

          const agentDir = getAgentDir(agentName)
          
          if (!await fs.pathExists(agentDir)) {
            ctx.reply(`❌ Agent "${agentName}" not found.`)
            return
          }

          try {
            // Delete all sessions for this agent
            const sessionsToDelete = Array.from(sessionManager.getAllSessions().keys())
              .filter(sid => sid.startsWith(`${agentName}/`))
            
            for (const sid of sessionsToDelete) {
              await sessionManager.deleteSession(sid)
            }
            
            // Delete agent directory
            await fs.remove(agentDir)
            
            ctx.reply(`✅ Agent "${agentName}" deleted successfully.\n\nDeleted ${sessionsToDelete.length} session(s).`)
          } catch (e: any) {
            ctx.reply(`❌ Failed to delete agent: ${e.message}`)
          }
          break
        }

        default:
          ctx.reply(`❌ Unknown subcommand: ${subcommand}\nUse \`/agent\` to see available commands.`)
      }
    }
  },

  '/skill': {
    description: 'Manage skills: list, attach, detach, show',
    requiresSession: false,
    autocomplete: { children: SKILL_AUTOCOMPLETE },
    handler: async (ctx, args, _sessionId, session) => {
      const subcommand = args[0]
      const subArgs = args.slice(1)
      const agentName = session?.agent || 'main'

      if (!subcommand) {
        let resp = '🧩 *Skill Commands*\n\n'
        resp += '`/skill list` - List available skills\n'
        resp += '`/skill attach <agent> <skill>` - Attach a skill to an agent\n'
        resp += '`/skill detach <agent> <skill>` - Detach a skill from an agent\n'
        resp += '`/skill show <skill>` - Show skill documents\n'
        ctx.reply(resp)
        return
      }

      switch (subcommand) {
        case 'list': {
          const skillList = await skills.listSkills({ agentName })
          if (skillList.length === 0) {
            ctx.reply(`No skills found for agent \`${agentName}\`.`)
            return
          }

          let resp = `🧩 *Skills for ${agentName}* (${skillList.length})\n\n`
          for (const skill of skillList) {
            resp += `\`${skill.name}\``
            resp += ` [${skills.formatSkillSourceLabel(skill)}]`
            if (skill.description) {
              resp += ` - ${skill.description}`
            }
            if (skill.documentFiles.length > 0) {
              resp += ` (${skill.documentFiles.length} file${skill.documentFiles.length > 1 ? 's' : ''})`
            }
            resp += '\n'
          }
          ctx.reply(resp)
          break
        }

        case 'attach': {
          if (subArgs.length < 2) {
            ctx.reply('Usage: /skill attach <agent> <skill>')
            return
          }

          const agentName = subArgs[0]
          const skillName = subArgs[1]

          try {
            const result = await sessionManager.attachAgentSkill(agentName, skillName)
            let resp = result.changed
              ? `✅ Skill \`${skillName}\` attached to agent \`${agentName}\`.`
              : `ℹ️ Agent \`${agentName}\` already has skill \`${skillName}\`.`
            resp += result.skills.length > 0
              ? `\nSkills: ${result.skills.map(skill => `\`${skill}\``).join(', ')}`
              : '\nSkills: (none)'
            if (result.affectedSessions.length > 0) {
              resp += `\nUpdated ${result.affectedSessions.length} session snapshot(s).`
            }
            ctx.reply(resp)
          } catch (e: any) {
            ctx.reply(`❌ Skill attach failed: ${e.message}`)
          }
          break
        }

        case 'detach': {
          if (subArgs.length < 2) {
            ctx.reply('Usage: /skill detach <agent> <skill>')
            return
          }

          const agentName = subArgs[0]
          const skillName = subArgs[1]

          try {
            const result = await sessionManager.detachAgentSkill(agentName, skillName)
            let resp = result.changed
              ? `✅ Skill \`${skillName}\` detached from agent \`${agentName}\`.`
              : `ℹ️ Agent \`${agentName}\` does not have skill \`${skillName}\`.`
            resp += result.skills.length > 0
              ? `\nSkills: ${result.skills.map(skill => `\`${skill}\``).join(', ')}`
              : '\nSkills: (none)'
            if (result.affectedSessions.length > 0) {
              resp += `\nUpdated ${result.affectedSessions.length} session snapshot(s).`
            }
            ctx.reply(resp)
          } catch (e: any) {
            ctx.reply(`❌ Skill detach failed: ${e.message}`)
          }
          break
        }

        case 'show': {
          if (subArgs.length < 1) {
            ctx.reply('Usage: /skill show <skill>')
            return
          }

          const skillName = subArgs[0]

          try {
            const { info, documents } = await skills.loadSkillDocuments(skillName, { agentName })
            let resp = `🧩 *Skill:* \`${info.name}\``
            if (info.description) {
              resp += `\n${info.description}`
            }
            resp += `\nSource: \`${skills.formatSkillSourceLabel(info)}\``
            resp += `\nMetadata: \`${info.metadataPath}\``

            if (documents.length === 0) {
              resp += '\n\n(No skill memory documents found.)'
            } else {
              for (const document of documents) {
                resp += `\n\nFILE: \`${document.filePath}\`\n\n${document.content}`
              }
            }

            ctx.reply(resp)
          } catch (e: any) {
            ctx.reply(`❌ Skill show failed: ${e.message}`)
          }
          break
        }

        default:
          ctx.reply(`❌ Unknown subcommand: ${subcommand}\nUse \`/skill\` to see available commands.`)
      }
    }
  },

  '/stop': {
    description: 'Stop current run',
    requiresSession: true,
    handler: async (ctx, _args, sessionId, session) => {
      if (!sessionId || !session) return
      if (!session.busy) {
        ctx.reply('⚠️ Session is not currently running.')
        return
      }

      try {
        const { abortedInFlight } = await sessionManager.requestSessionStop(sessionId)
        if (abortedInFlight) {
          ctx.reply('🛑 Stop signal sent. The in-flight LLM request was aborted.')
        } else {
          ctx.reply('🛑 Stop signal sent. The session will stop after the current tool call completes.')
        }
      } catch (e: any) {
        ctx.reply(`❌ Stop failed: ${e.message}`)
      }
    }
  },
  '/retry': {
    description: 'Retry last request (reactivate session without adding new message)',
    requiresSession: true,
    handler: async (ctx, _args, sessionId, session) => {
      if (!sessionId || !session) return
      if (session.busy) {
        ctx.reply('⚠️ Session is already running.')
        return
      }

      if (session.history.length === 0) {
        ctx.reply('⚠️ No history to retry.')
        return
      }

      try {
        ctx.reply('🔄 Retrying last request...')
        await sessionManager.retrySession(sessionId)
      } catch (e: any) {
        ctx.reply(`❌ Retry failed: ${e.message}`)
      }
    }
  },
  '/node': {
    description: 'List or switch node. `args: [node-id]`',
    requiresSession: true,
    autocomplete: { children: NODE_AUTOCOMPLETE },
    handler: async (ctx, args, sessionId, session) => {
      if (!sessionId || !session) return
      const boundNode = sessionManager.getAgentIsolationNode(session.agent || 'main')

      if (args[0] === 'pair') {
        const sub = args[1]

        if (sub === 'token') {
          try {
            const token = await ensureNodePairingToken()
            const baseUrl = `http://localhost:${HTTP_PORT}`
            ctx.reply(
              `🔑 **Current node pairing token**\n\n` +
              `\`${token}\`\n\n` +
              `Direct copy:\n` +
              `\`--pairing=${token}\`\n\n` +
              `Default local master URL: \`${baseUrl}\`\n` +
              `If the node is on another machine/device, replace \`localhost\` with a reachable host/IP/domain.\n\n` +
              `Pairing/bootstrap examples: \`/node pair help\``
            )
          } catch (e: any) {
            ctx.reply(`❌ Failed to read node pairing token: ${e.message}`)
          }
          return
        }

        if (sub === 'help') {
          try {
            const token = await ensureNodePairingToken()
            ctx.reply(buildNodePairHelp(token))
          } catch (e: any) {
            ctx.reply(`❌ Failed to build node pairing help: ${e.message}`)
          }
          return
        }

        if (!sub || sub === 'list') {
          const pending = await listPendingPairings()
          if (pending.length === 0) {
            ctx.reply('📭 No pending node pairing requests.')
            return
          }

          let reply = `📥 **Pending Node Pairings** (${pending.length})\n\n`
          for (const entry of pending) {
            const requestedName = entry.requestedName ? ` requested=\`${entry.requestedName}\`` : ''
            const connected = entry.connected ? ' online' : ' offline'
            reply += `- \`${entry.id}\` [${entry.nodeType}]${requestedName} code=\`${entry.pairCode}\`${connected}\n`
          }
          reply += '\nApprove: `/node pair approve <pending-id> [node-id]`\nReject: `/node pair reject <pending-id>`\nToken: `/node pair token`\nBootstrap help: `/node pair help`'
          ctx.reply(reply)
          return
        }

        if (sub === 'approve') {
          const pendingId = args[2]
          const requestedNodeId = args[3]
          if (!pendingId) {
            ctx.reply('Usage: `/node pair approve <pending-id> [node-id]`')
            return
          }

          try {
            const approved = await approvePendingPairing(pendingId, requestedNodeId)
            ctx.reply(
              `✅ Approved pending pairing \`${pendingId}\`\n\n` +
              `Node id: \`${approved.nodeId}\`\n` +
              `Requested name: \`${approved.pending.requestedName || '-'}\`\n` +
              `Delivered live: \`${approved.deliveredLive ? 'yes' : 'no'}\`\n\n` +
              `Per-node token (save securely):\n\`${approved.authToken}\``
            )
          } catch (e: any) {
            ctx.reply(`❌ Failed to approve pairing: ${e.message}`)
          }
          return
        }

        if (sub === 'reject') {
          const pendingId = args[2]
          if (!pendingId) {
            ctx.reply('Usage: `/node pair reject <pending-id>`')
            return
          }

          try {
            await rejectPendingPairing(pendingId)
            ctx.reply(`✅ Rejected pending pairing \`${pendingId}\``)
          } catch (e: any) {
            ctx.reply(`❌ Failed to reject pairing: ${e.message}`)
          }
          return
        }

        ctx.reply('Usage: `/node pair help` | `/node pair token` | `/node pair list` | `/node pair approve <pending-id> [node-id]` | `/node pair reject <pending-id>`')
        return
      }

      if (args[0] === 'known') {
        const approved = await listApprovedNodes()
        if (approved.length === 0) {
          ctx.reply('📋 No approved nodes yet.')
          return
        }

        let reply = `📋 **Approved Nodes** (${approved.length})\n\n`
        for (const node of approved) {
          const online = nodesManager.getNode(node.nodeId) ? 'online' : 'offline'
          const requestedName = node.requestedName ? ` requested=\`${node.requestedName}\`` : ''
          const lastSeen = node.lastSeenAt ? ` lastSeen=${new Date(node.lastSeenAt).toLocaleString()}` : ''
          reply += `- \`${node.nodeId}\` [${node.nodeType}] ${online}${requestedName}${lastSeen}\n`
        }
        ctx.reply(reply)
        return
      }
      
      // No args: list nodes
      if (args.length === 0) {
        const nodes = nodesManager.listNodes()
        const remoteNodes = nodes.filter(node => node.id !== 'master')
        const currentNode = boundNode || session.currentNode || 'master'

        let reply = `📋 **Available Nodes** (${remoteNodes.length + 1} total):\n\n`

        reply += currentNode === 'master' ? '✅ ' : '  '
        reply += '`master` (local)\n'

        for (const node of remoteNodes) {
          reply += currentNode === node.id ? '✅ ' : '  '
          reply += `\`${node.id}\` - Last activity: ${new Date(node.lastActivity).toLocaleString()}\n`
        }

        if (remoteNodes.length === 0) {
          reply += '\n(No remote nodes currently online)'
        }

        reply += `\n\n💡 Current node: \`${currentNode}\``
        if (boundNode) {
          reply += `\n🔒 Runtime is bound by agent isolation to \`${boundNode}\`.`
        }

        ctx.reply(reply)
        return
      }

      // With args: switch node
      const nodeId = args[0]

      if (boundNode) {
        ctx.reply(`🔒 Current session belongs to an isolated agent bound to node \`${boundNode}\`. Changing \`currentNode\` here would not affect runtime execution. Use \`/agent isolated <agent> off\` first if you really want to unbind it.`)
        return
      }

      if (nodeId !== 'master' && !nodesManager.getNode(nodeId)) {
        ctx.reply(`❌ Node \`${nodeId}\` not found.\n\nUse \`/node\` to list available nodes.`)
        return
      }

      try {
        nodesManager.setCurrentNode(sessionId, nodeId)
        session.currentNode = nodeId
        await sessionManager.saveSession(sessionId)
        ctx.reply(`✅ Switched to node \`${nodeId}\`\n\nAll file/exec/browser tools will now execute on this node.`)
      } catch (e: any) {
        ctx.reply(`❌ Failed to switch node: ${e.message}`)
      }
    }
  },
  '/search': {
    description: 'Search archived messages within your allowed memory scope',
    requiresSession: true,
    autocomplete: { children: SEARCH_AUTOCOMPLETE },
    handler: async (ctx, args, sessionId, session) => {
      if (!sessionId || !session) {
        ctx.reply('❌ No active session.')
        return
      }

      let limit = 5
      let targetSessionId: string | undefined
      let targetAgentName: string | undefined
      const queryParts: string[] = []

      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i]
        if (arg === '--limit' && i + 1 < args.length) {
          const parsed = parseInt(args[i + 1], 10)
          if (!Number.isNaN(parsed) && parsed > 0) {
            limit = parsed
          }
          i += 1
          continue
        }
        if (arg === '--session' && i + 1 < args.length) {
          targetSessionId = args[i + 1]
          i += 1
          continue
        }
        if (arg === '--agent' && i + 1 < args.length) {
          targetAgentName = args[i + 1]
          i += 1
          continue
        }
        queryParts.push(arg)
      }

      const query = queryParts.join(' ').trim()
      if (!query) {
        ctx.reply('Usage: /search [--session <session-id>] [--agent <agent-name>] [--limit <n>] <query>')
        return
      }

      try {
        const result = await tools.search_memory({
          query,
          limit,
          sessionId: targetSessionId,
          agentName: targetAgentName,
        }, { sessionId, session })
        ctx.reply(result)
      } catch (e: any) {
        ctx.reply(`❌ Search failed: ${e.message}`)
      }
    }
  },
  '/messages': {
    description: 'Show message previews. `args: <num> | <start> <end>`',
    requiresSession: true,
    showInTelegram: false,
    autocomplete: { children: MESSAGES_AUTOCOMPLETE },
    handler: async (ctx, args, sessionId, session) => {
      if (!sessionId || !session) return
      const totalMessages = session.history.length
      const previewLength = 100

      let start: number | undefined
      let end: number | undefined

      if (args.length === 0) {
        ctx.reply(messagesUsage)
        return
      }

      const n1 = parseInt(args[0], 10)
      if (isNaN(n1)) {
        ctx.reply(messagesUsage)
        return
      }

      if (args.length === 1) {
        if (n1 === 0) {
          ctx.reply(messagesUsage)
          return
        }
        if (n1 > 0) {
          start = 0
          end = Math.min(n1, totalMessages)
        } else {
          const count = Math.min(Math.abs(n1), totalMessages)
          start = Math.max(0, totalMessages - count)
          end = totalMessages
        }
      } else {
        const n2 = parseInt(args[1], 10)
        if (isNaN(n2)) {
          ctx.reply(messagesUsage)
          return
        }

        start = n1 < 0 ? totalMessages + n1 : n1
        end = n2 < 0 ? totalMessages + n2 : n2

        start = Math.max(0, Math.min(start, totalMessages))
        end = Math.max(0, Math.min(end, totalMessages))
      }

      if (end === undefined || start === undefined || end < start) {
        ctx.reply('No messages found in the specified range.')
        return
      }

      const messages = await sessionManager.getSessionMessages(sessionId, start, end - start)
      const preview = formatSessionMessagesPreview(sessionId, messages, start, totalMessages, previewLength)
      ctx.reply(preview)
    }
  },
  '/model': {
    description: 'List or switch model. `args: [name|default]`',
    requiresSession: true,
    autocomplete: { children: MODEL_AUTOCOMPLETE },
    handler: async (ctx, args, sessionId, session) => {
      if (!sessionId || !session) return
      const { modelsConfig, defaultKey, currentKey } = resolveModelConfig(session.model)
      const modelKeys = modelsConfig.displayModels || Object.keys(modelsConfig.models || {})

      if (args.length === 0) {
        let resp = `🤖 *Models*\n\n`
        resp += modelKeys.map(k => {
          const tags: string[] = []
          if (k === defaultKey) tags.push('default')
          if (k === currentKey) tags.push('current')
          const suffix = tags.length ? ` (${tags.join(', ')})` : ''
          return `- \`${k}\`${suffix}`
        }).join('\n')
        ctx.reply(resp)
        return
      }

      const target = args[0]
      if (target === 'default') {
        session.model = undefined
        await sessionManager.saveSession(sessionId)
        ctx.reply('✅ Model reset to default.')
        return
      }

      // Try exact match first
      if (modelsConfig.models[target]) {
        session.model = target
        await sessionManager.saveSession(sessionId)
        ctx.reply(`✅ Model switched to \`${target}\`.`)
        return
      }

      // Try partial match
      const normalizedInput = target.toLowerCase()
      const matches = modelKeys.filter(k => k.toLowerCase().includes(normalizedInput))

      if (matches.length === 0) {
        ctx.reply(`❌ No models matching \`${target}\`. Use /model to list available models.`)
        return
      }

      if (matches.length === 1) {
        session.model = matches[0]
        await sessionManager.saveSession(sessionId)
        ctx.reply(`✅ Model switched to \`${matches[0]}\`.`)
        return
      }

      // Multiple matches
      let resp = `❌ Multiple models match \`${target}\`:\n\n`
      resp += matches.map(k => `- \`${k}\``).join('\n')
      resp += `\n\nPlease be more specific.`
      ctx.reply(resp)
    }
  },
  '/delete-messages': {
    description: 'Delete messages from current session. `args: <num>` (positive: oldest, negative: newest)',
    requiresSession: true,
    showInTelegram: false,
    autocomplete: { children: DELETE_MESSAGES_AUTOCOMPLETE },
    handler: async (ctx, args, sessionId) => {
      if (!sessionId) return
      if (args.length === 0) {
        ctx.reply(deleteMessagesUsage)
        return
      }

      const num = parseInt(args[0], 10)
      if (isNaN(num) || num === 0) {
        ctx.reply(deleteMessagesUsage)
        return
      }

      const result = await sessionManager.deleteMessages(sessionId, num)
      ctx.reply(`✅ Deleted ${result.deleted} messages. Remaining: ${result.remaining}.`)
    }
  },
  '/verbose': {
    description: 'Toggle verbose mode (show tool calls). `args: [on|off]`',
    requiresSession: true,
    autocomplete: { children: VERBOSE_AUTOCOMPLETE },
    handler: async (ctx, args, sessionId) => {
      if (!sessionId) return
      const session = await sessionManager.getSession(sessionId)
      
      if (args.length === 0) {
        const current = session.verbose ? 'on' : 'off'
        ctx.reply(`Verbose mode is currently *${current}*.`)
        return
      }
      
      const target = args[0].toLowerCase()
      if (target === 'on') {
        session.verbose = true
        await sessionManager.saveSession(sessionId)
        ctx.reply('✅ Verbose mode enabled. Tool calls will be shown.')
      } else if (target === 'off') {
        session.verbose = false
        await sessionManager.saveSession(sessionId)
        ctx.reply('✅ Verbose mode disabled. Tool calls will be hidden.')
      } else {
        ctx.reply('Usage: /verbose [on|off]')
      }
    }
  },
  '/weixin': {
    description: 'Manage foxwarm-native Weixin channel MVP. `args: status|login|wait <sessionKey>`',
    requiresSession: false,
    handler: async (ctx, args) => {
      const subcommand = args[0]?.toLowerCase() || 'status'
      const currentConfig = readAppConfigFile()
      const weixinChannelId = getDefaultChannelIdByType('weixin', currentConfig)
      const weixinConfig = (currentConfig.channels?.[weixinChannelId] || WEIXIN_CONFIG || {}) as any
      const baseUrl = (weixinConfig.baseUrl || DEFAULT_WEIXIN_BASE_URL).trim()
      const routeTag = weixinConfig.routeTag?.trim() || undefined
      const loginBotType = weixinConfig.loginBotType?.trim() || DEFAULT_WEIXIN_LOGIN_BOT_TYPE

      if (subcommand === 'status') {
        const tokenState = weixinConfig.token?.trim() ? 'configured' : 'missing'
        const allowMode = weixinConfig.allowAllUsers ? 'all users' : ((weixinConfig.allowedUsers || []).length > 0 ? (weixinConfig.allowedUsers || []).join(', ') : 'none')
        const runtimeStatus = getChannelRuntimeStatus(weixinChannelId)
        ctx.reply(
          [
            '*Weixin channel MVP status*',
            `- channelId: \`${weixinChannelId}\``,
            `- config: \`${APP_CONFIG_PATH}\``,
            `- enabled: \`${weixinConfig.enabled === false ? 'false' : 'true/auto'}\``,
            `- baseUrl: \`${baseUrl}\``,
            `- token: \`${tokenState}\``,
            `- routeTag: \`${routeTag || 'unset'}\``,
            `- allow: \`${allowMode}\``,
            runtimeStatus ? `- runtime: \`${runtimeStatus.running ? 'running' : 'stopped'}\`` : undefined,
            '',
            'Usage:',
            '- `/weixin login`',
            '- `/weixin wait <sessionKey>`',
            `- \`/channel start ${weixinChannelId}\``,
          ].filter(Boolean).join('\n')
        )
        return
      }

      if (subcommand === 'login') {
        try {
          const result = await startWeixinQrLogin({
            baseUrl,
            botType: loginBotType,
            routeTag,
          })
          ctx.reply(
            [
              '✅ Weixin QR login started.',
              `- sessionKey: \`${result.sessionKey}\``,
              result.qrcodeUrl ? `- qrcodeUrl: ${result.qrcodeUrl}` : '- qrcodeUrl: (none)',
              '',
              'After scanning, run:',
              `\`/weixin wait ${result.sessionKey}\``,
            ].join('\n')
          )
        } catch (e: any) {
          const cause = e?.cause
          const causeText = cause?.message ? ` (${cause.message}${cause?.code ? `; code=${cause.code}` : ''})` : ''
          ctx.reply(`❌ Failed to start Weixin login: ${e.message}${causeText}`)
        }
        return
      }

      if (subcommand === 'wait') {
        const sessionKey = args[1]?.trim()
        if (!sessionKey) {
          ctx.reply('Usage: /weixin wait <sessionKey>')
          return
        }

        try {
          const result = await waitForWeixinQrLogin({
            sessionKey,
            baseUrl,
            routeTag,
            timeoutMs: 60_000,
          })

          if (!result.connected || !result.botToken) {
            ctx.reply(`⏳ ${result.message}`)
            return
          }

          const current = readAppConfigFile()
          const next = {
            ...current,
            channels: {
              ...(current.channels || {}),
              [weixinChannelId]: {
                ...(((current.channels || {}) as any)[weixinChannelId] || {}),
                enabled: true,
                type: (((current.channels || {}) as any)[weixinChannelId]?.type || (weixinChannelId === 'weixin' ? undefined : 'weixin')),
                baseUrl: result.baseUrl || baseUrl,
                token: result.botToken,
                routeTag,
              },
            },
          }
          writeAppConfigFile(next)

          let runtimeNote = 'Weixin channel config updated; channel start not attempted.'
          try {
            const runtimeResult = await restartManagedChannel(weixinChannelId)
            runtimeNote = runtimeResult.status.running
              ? 'Weixin channel started immediately; no foxwarm restart needed.'
              : 'Weixin channel config updated, but runtime status is still stopped.'
          } catch (runtimeError: any) {
            runtimeNote = `Weixin config updated, but runtime start failed: ${runtimeError?.message || String(runtimeError)}`
          }

          ctx.reply(
            [
              '✅ Weixin login completed and config file updated.',
              `- config: \`${APP_CONFIG_PATH}\``,
              `- channelId: \`${weixinChannelId}\``,
              `- baseUrl: \`${result.baseUrl || baseUrl}\``,
              result.userId ? `- ownerUserId: \`${result.userId}\`` : undefined,
              `- runtime: ${runtimeNote}`,
              '',
              `You can also inspect runtime state with \`/channel status ${weixinChannelId}\`.`,
            ].filter(Boolean).join('\n')
          )
        } catch (e: any) {
          ctx.reply(`❌ Failed while waiting for Weixin login: ${e.message}`)
        }
        return
      }

      ctx.reply('Usage: /weixin status\n       /weixin login\n       /weixin wait <sessionKey>')
    }
  },
  '/channel': {
    description: 'Manage channel settings and channel runtime. `args: info|auth|status|start|stop|restart|mode ...`',
    requiresSession: false,
    autocomplete: { children: CHANNEL_AUTOCOMPLETE },
    handler: async (ctx, args) => {
      if (args.length === 0) {
        ctx.reply([
          'Usage: /channel info',
          '       /channel auth',
          '       /channel status [channel-id-or-type]',
          '       /channel start <channel-id>',
          '       /channel stop <channel-id>',
          '       /channel restart <channel-id>',
          '       /channel mode <push-only|normal>',
          '       /channel dangerously-allow-all-group-members <yes|no>',
        ].join('\n'))
        return
      }

      const subcommand = args[0].toLowerCase()

      if (subcommand === 'info') {
        ctx.reply(formatChannelInfo(ctx))
        return
      }

      if (subcommand === 'auth') {
        const inspection = inspectChannelAuthorizationFromContext(ctx)
        ctx.reply(formatAuthorizationInspection(inspection, { title: '*Channel authorization diagnostics*' }))
        return
      }

      if (subcommand === 'status') {
        const channelIdOrType = args[1]?.trim() || undefined
        const statusText = channelIdOrType && !getChannelRuntimeStatus(channelIdOrType)
          ? formatChannelRuntimeStatus(undefined, channelIdOrType)
          : formatChannelRuntimeStatus(channelIdOrType)
        ctx.reply(statusText)
        return
      }

      if (subcommand === 'start' || subcommand === 'stop' || subcommand === 'restart') {
        const channelId = args[1]?.trim()
        if (!channelId) {
          ctx.reply(`Usage: /channel ${subcommand} <channel-id>\nManaged channel ids: ${getManagedPlatformHelp()}`)
          return
        }

        try {
          if (subcommand === 'start') {
            const result = await startManagedChannel(channelId)
            ctx.reply(`✅ Channel \`${channelId}\` ${result.started ? 'started' : 'was already running'}.\n${formatChannelRuntimeStatus(channelId)}`)
            return
          }

          if (subcommand === 'stop') {
            const result = await stopManagedChannel(channelId)
            ctx.reply(`✅ Channel \`${channelId}\` ${result.stopped ? 'stopped' : 'was already stopped'}.\n${formatChannelRuntimeStatus(channelId)}`)
            return
          }

          const result = await restartManagedChannel(channelId)
          ctx.reply(`✅ Channel \`${channelId}\` restarted.\n${formatChannelRuntimeStatus(channelId)}`)
        } catch (e: any) {
          ctx.reply(`❌ Failed to ${subcommand} channel: ${e.message}`)
        }
        return
      }
      
      if (subcommand === 'mode') {
        if (args.length < 2) {
          // Show current mode
          const config = sessionManager.getChannelConfig(getChannelId(ctx), getConversationId(ctx))
          const currentMode = config?.mode || 'normal'
          ctx.reply(`Current channel mode: *${currentMode}*\nUsage: /channel mode <push-only|normal>`)
          return
        }

        const mode = args[1].toLowerCase()
        if (mode !== 'push-only' && mode !== 'normal') {
          ctx.reply('Invalid mode. Use: push-only or normal')
          return
        }

        try {
          sessionManager.setChannelMode(getChannelId(ctx), getConversationId(ctx), mode === 'push-only' ? 'push-only' : undefined)
          ctx.reply(`✅ Channel mode set to *${mode}*`)
        } catch (e: any) {
          ctx.reply(`❌ Failed to set channel mode: ${e.message}`)
        }
      } else if (subcommand === 'dangerously-allow-all-group-members') {
        if (args.length < 2) {
          // Show current setting
          const currentValue = sessionManager.getChannelDangerouslyAllowAllGroupMembers(getChannelId(ctx), getConversationId(ctx))
          ctx.reply(`Current dangerouslyAllowAllGroupMembers: *${currentValue ? 'yes' : 'no'}*\nUsage: /channel dangerously-allow-all-group-members <yes|no>`)
          return
        }

        const value = args[1].toLowerCase()
        if (value !== 'yes' && value !== 'no') {
          ctx.reply('Invalid value. Use: yes or no')
          return
        }

        try {
          sessionManager.setChannelDangerouslyAllowAllGroupMembers(getChannelId(ctx), getConversationId(ctx), value === 'yes')
          ctx.reply(`✅ dangerouslyAllowAllGroupMembers set to *${value}*`)
        } catch (e: any) {
          ctx.reply(`❌ Failed to set dangerouslyAllowAllGroupMembers: ${e.message}`)
        }
      } else {
        ctx.reply([
          'Unknown subcommand. Usage:',
          '/channel info',
          '/channel auth',
          '/channel status [channel-id-or-type]',
          '/channel start <channel-id>',
          '/channel stop <channel-id>',
          '/channel restart <channel-id>',
          '/channel mode <push-only|normal>',
          '/channel dangerously-allow-all-group-members <yes|no>',
        ].join('\n'))
      }
    }
  }
}
