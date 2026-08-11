import { getChannelId, getConversationId } from './channel';
import { logger } from './common';
import { nodesManager } from './nodes/manager';
import { approvePendingPairing, isReservedNodeId, moveApprovedNode, rejectPendingPairing, removeApprovedNode } from './nodes/registry';
import * as sessionManager from './sessionManager';
import * as sessionRuntime from './sessionRuntime';
import * as skills from './skills';
import * as tools from './tools';
import { APP_CONFIG_PATH, getDefaultChannelIdByType, readAppConfigFile, resolveModelConfig, writeAppConfigFile, WEIXIN_CONFIG } from './config';
import { formatSessionMessagesPreview } from './utils/messagePreview';
import { buildSessionStatusInfo, formatSessionStatus } from './sessionStatus';
import { BTW_USAGE } from './btw';
import { DEFAULT_WEIXIN_BASE_URL, DEFAULT_WEIXIN_LOGIN_BOT_TYPE, startWeixinQrLogin, waitForWeixinQrLogin } from './weixin/api';
import { ensureNodePairingToken } from './nodes/bootstrapInfo';
import { getChannelRuntimeStatus, restartManagedChannel } from './channelRuntime';

// Re-export types
export { CommandDef, CommandAutocompleteNode, CommandAutocomplete, literalNode, placeholderNode } from './commands/types';
import { commandSessionMessageCount, CommandDef } from './commands/types';
import { placeholderNode } from './commands/types';

// Import autocomplete trees
import {
  TIMER_AUTOCOMPLETE, BTW_AUTOCOMPLETE, SESSION_AUTOCOMPLETE, AGENT_AUTOCOMPLETE,
  SKILL_AUTOCOMPLETE, NODE_AUTOCOMPLETE, MESSAGES_AUTOCOMPLETE, MODEL_AUTOCOMPLETE,
  DELETE_MESSAGES_AUTOCOMPLETE, VERBOSE_AUTOCOMPLETE, CHANNEL_AUTOCOMPLETE, SEARCH_AUTOCOMPLETE,
} from './commands/autocomplete';

// Import extracted command handlers
import { handleSessionCommand } from './commands/sessionCmd';
import { handleAgentCommand } from './commands/agentCmd';
import { handleTimerCommand } from './commands/timerCmd';
import { handleChannelCommand } from './commands/channelCmd';

// Import helpers
import { handleCompactCommand, getDisplayModelKeys, resolveCommandModelSelection, buildNodePairHelp, buildNodeListReply } from './commands/helpers';

const messagesUsage = 'Usage: `/messages <num>` | `/messages <start> <end>`'
const deleteMessagesUsage = 'Usage: `/delete-messages <num>` (positive: delete oldest, negative: delete newest)'

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
        { value: 'tools', kind: 'literal', description: 'Compact oversized historical tool calls/results without running full history compaction', usage: '/compact tools [keep%]', children: [placeholderNode('[keep%]', 'Optional keep percentage for recent messages left untouched')] },
      ],
    },
    handler: handleCompactCommand,
  },
  '/btw': {
    description: 'Run a side/background model request without executing tools',
    usage: BTW_USAGE,
    requiresSession: true,
    autocomplete: { children: BTW_AUTOCOMPLETE },
    handler: async (ctx, args, sessionId) => {
      if (!sessionId) {
        ctx.reply('❌ No active session.')
        return
      }
      const message = args.join(' ').trim()
      if (!message) {
        ctx.reply(BTW_USAGE)
        return
      }
      void sessionRuntime.runBtw(sessionId, message).catch((err: any) => {
        logger.error({ err, sessionId }, 'BTW background request failed')
      })
      ctx.reply('📝 BTW request started. I’ll post the result here when it finishes.')
    },
  },
  '/timer': {
    description: 'Manage session timers: help, list, create, delete',
    requiresSession: true,
    autocomplete: { children: TIMER_AUTOCOMPLETE },
    handler: handleTimerCommand,
  },
  '/status': {
    description: 'Show current session status',
    requiresSession: true,
    handler: async (ctx, _args, sessionId, session) => {
      if (!sessionId || !session) return
      const history = await sessionRuntime.getHistory(sessionId)
      ctx.reply(formatSessionStatus(await buildSessionStatusInfo(sessionId, session, false, history?.messages)))
    }
  },
  '/session': {
    description: 'Manage sessions: list, fork, move, parent/unparent, archive',
    requiresSession: false,
    autocomplete: { children: SESSION_AUTOCOMPLETE },
    handler: handleSessionCommand,
  },
  '/fork': {
    description: 'Fork current session. `args: [suffix] [message]`',
    requiresSession: true,
    handler: async (ctx, _args, sessionId, session, rawArgs) => {
      if (!sessionId || !session) return;

      const parsed = (rawArgs ?? _args.join(' ')).match(/^(\S+)(?:\s+([\s\S]*))?$/);
      const suffix = parsed?.[1] || sessionManager.generateSessionId();
      const initialMessage = parsed?.[2] === '' || parsed?.[2] === undefined ? undefined : parsed[2];

      try {
        sessionManager.validateChildSessionSuffix(suffix);
        const requestedSessionId = sessionManager.buildChildSessionId(sessionId, suffix);
        if (sessionManager.getSessionCatalog(requestedSessionId)) {
          ctx.reply(`❌ Session \`${requestedSessionId}\` already exists.`);
          return;
        }

        const childSessionId = await sessionManager.createChildSession(sessionId, suffix, true);
        if (initialMessage !== undefined) {
          await sessionManager.sendToSession(childSessionId, initialMessage, sessionId);
        }
        await sessionRuntime.notifyManualForkCreated(sessionId, childSessionId, initialMessage);
        ctx.reply(`✅ Forked session \`${sessionId}\` → \`${childSessionId}\`${initialMessage === undefined ? '' : '\nInitial message sent.'}`);
      } catch (e: any) {
        ctx.reply(`❌ Fork failed: ${e.message}`);
      }
    },
  },
  '/attach': {
    description: 'Attach to session. `args: <sessionId>`',
    requiresSession: false,
    autocomplete: {
      children: [placeholderNode('<sessionId>', 'Existing session id')],
    },
    handler: async (ctx, args) => {
      if (args.length === 0) {
        ctx.reply('Usage: /attach <sessionId>')
        return
      }
      const targetSessionId = args[0]
      const targetSession = sessionManager.getSessionCatalog(targetSessionId)
      if (!targetSession) {
        ctx.reply(`❌ Session \`${targetSessionId}\` not found.`)
        return
      }
      sessionManager.detachChannel(getChannelId(ctx), getConversationId(ctx))
      await sessionManager.attachChannelDurably(getChannelId(ctx), getConversationId(ctx), targetSessionId)
      const displayName = targetSession.displayName ? ` (${targetSession.displayName})` : ''
      ctx.reply(`✅ Attached to session \`${targetSessionId}\`${displayName}`)
    },
  },
  '/agent': {
    description: 'Manage agents',
    requiresSession: false,
    autocomplete: { children: AGENT_AUTOCOMPLETE },
    handler: handleAgentCommand,
  },
  '/skill': {
    description: 'Manage skills: list visible skills or show full skill documents',
    requiresSession: false,
    autocomplete: { children: SKILL_AUTOCOMPLETE },
    handler: async (ctx, args, _sessionId, session) => {
      const subcommand = args[0]
      const subArgs = args.slice(1)
      const agentName = session?.agent || 'main'

      if (!subcommand) {
        ctx.reply('🧩 *Skill Commands*\n\n`/skill list` - List available skills\n`/skill show <skill>` - Show skill documents\n')
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
            resp += `\`${skill.name}\` [${skills.formatSkillSourceLabel(skill)}]`
            if (skill.description) resp += ` - ${skill.description}`
            if (skill.documentFiles.length > 0) resp += ` (${skill.documentFiles.length} file${skill.documentFiles.length > 1 ? 's' : ''})`
            resp += '\n'
          }
          ctx.reply(resp)
          break
        }
        case 'attach':
        case 'detach':
          ctx.reply('❌ Skill attach/detach is no longer supported. Visible skills are cataloged automatically in session snapshots; use `/skill show <skill>` or `skill({ action: "load", skillName: "<skill>" })` to load full instructions on demand.')
          break
        case 'show': {
          if (subArgs.length < 1) { ctx.reply('Usage: /skill show <skill>'); return }
          const skillName = subArgs[0]
          try {
            const { info, documents } = await skills.loadSkillDocuments(skillName, { agentName })
            let resp = `🧩 *Skill:* \`${info.name}\``
            if (info.description) resp += `\n${info.description}`
            resp += `\nSource: \`${skills.formatSkillSourceLabel(info)}\`\nMetadata: \`${info.metadataPath}\``
            resp += `\nSkill directory: \`${info.dir}\``
            resp += '\nRelative paths in this skill are relative to the skill directory.'
            if (info.resourceFiles.length > 0) {
              resp += '\n\nResources (supporting files, not eagerly loaded):'
              for (const file of info.resourceFiles) resp += `\n- \`${file}\``
              if (info.resourceFilesTruncated) resp += '\n- ... (resource listing truncated)'
            }
            if (documents.length === 0) { resp += '\n\n(No skill documents found.)' }
            else { for (const doc of documents) { resp += `\n\nFILE: \`${doc.filePath}\`\n\n${doc.content}` } }
            ctx.reply(resp)
          } catch (e: any) { ctx.reply(`❌ Skill show failed: ${e.message}`) }
          break
        }
        default:
          ctx.reply(`❌ Unknown subcommand: ${subcommand}\nUse \`/skill\` to see available commands.`)
      }
    }
  },
  '/stop': {
    description: 'Stop current run and commit queued inputs to history without running them',
    requiresSession: true,
    handler: async (ctx, _args, sessionId, session) => {
      if (!sessionId || !session) return
      // Use the placement-neutral runtime view: under Session-worker placement
      // the raw catalog stub's busy flag is only refreshed at handback, so it
      // would falsely report "not running" mid-turn.
      const runtime = await sessionRuntime.getSession(sessionId)
      if (!runtime?.busy) { ctx.reply('⚠️ Session is not currently running.'); return }
      try {
        const { abortedInFlight } = await sessionRuntime.control(sessionId, 'stop')
        const queuedNote = (runtime.queueLength ?? 0) > 0
          ? ' Queued inputs will be added to history without being run.'
          : ''
        ctx.reply(abortedInFlight
          ? `🛑 Stop signal sent. The in-flight LLM request was aborted.${queuedNote}`
          : `🛑 Stop signal sent. The session will stop after the current tool call completes.${queuedNote}`)
      } catch (e: any) { ctx.reply(`❌ Stop failed: ${e.message}`) }
    }
  },
  '/dequeue': {
    description: 'Run queued items, stopping the current run first if needed',
    requiresSession: true,
    handler: async (ctx, _args, sessionId) => {
      if (!sessionId) return
      try {
        const { queuedItems = 0, stoppedCurrent, abortedInFlight } = await sessionRuntime.control(sessionId, 'dequeue')
        if (queuedItems === 0) { ctx.reply('⚠️ No queued items to run.'); return }
        if (stoppedCurrent) {
          ctx.reply(abortedInFlight
            ? `▶️ Running ${queuedItems} queued item${queuedItems > 1 ? 's' : ''}. The in-flight LLM request was aborted first.`
            : `▶️ Running ${queuedItems} queued item${queuedItems > 1 ? 's' : ''} after the current tool call stops.`)
          return
        }
        ctx.reply(`▶️ Running ${queuedItems} queued item${queuedItems > 1 ? 's' : ''}.`)
      } catch (e: any) { ctx.reply(`❌ Dequeue failed: ${e.message}`) }
    }
  },
  '/continue': {
    description: 'Continue an interrupted turn without adding a new message',
    requiresSession: true,
    handler: async (ctx, _args, sessionId, session) => {
      if (!sessionId || !session) return
      try {
        const runtime = await sessionRuntime.getSession(sessionId)
        if (!runtime) { ctx.reply('⚠️ No active session to continue.'); return }
        if (runtime.busy) { ctx.reply('⚠️ Session is already running.'); return }
        if (runtime.runtimeState?.state === 'waiting') {
          ctx.reply('⚠️ Session is waiting and cannot be continued manually.')
          return
        }
        ctx.reply('▶️ Continuing interrupted turn...')
        await sessionRuntime.control(sessionId, 'retry', ctx)
      } catch (e: any) {
        if (e?.code === 'SESSION_WORKER_RETRY_OUTCOME_UNKNOWN') {
          ctx.reply('⚠️ Continue outcome is unknown: it may already be committed or delivered. Inspect session history before continuing again.')
        } else if (e?.code === 'SESSION_CONTINUATION_NOT_AVAILABLE') {
          ctx.reply(`⚠️ ${e.message}`)
        } else {
          ctx.reply(`❌ Continue failed: ${e.message}`)
        }
      }
    }
  },
  '/node': {
    description: 'Manage nodes: list, approve/reject pairings, remove/move approved nodes, pair-help, or switch with `/node <node-id>`.',
    requiresSession: true,
    autocomplete: { children: NODE_AUTOCOMPLETE },
    handler: async (ctx, args, sessionId, session) => {
      if (!sessionId || !session) return
      const boundNode = sessionManager.getAgentIsolationNode(session.agent || 'main')

      if (args.length === 0 || args[0] === 'list') {
        const currentNode = boundNode || session.currentNode || 'master'
        ctx.reply(await buildNodeListReply(currentNode, boundNode))
        return
      }
      if (args[0] === 'pair-help') {
        try {
          const token = await ensureNodePairingToken()
          ctx.reply(buildNodePairHelp(token))
        } catch (e: any) { ctx.reply(`❌ Failed to build node pairing help: ${e.message}`) }
        return
      }
      if (args[0] === 'approve') {
        const pendingId = args[1]; const requestedNodeId = args[2]
        if (!pendingId) { ctx.reply('Usage: `/node approve <pending-id> [node-id]`'); return }
        try {
          const approved = await approvePendingPairing(pendingId, requestedNodeId)
          ctx.reply(`✅ Approved pending pairing \`${pendingId}\`\n\nNode id: \`${approved.nodeId}\`\nRequested name: \`${approved.pending.requestedName || '-'}\`\nDelivered live: \`${approved.deliveredLive ? 'yes' : 'no'}\`\n\nPer-node token (save securely):\n\`${approved.authToken}\``)
        } catch (e: any) { ctx.reply(`❌ Failed to approve pairing: ${e.message}`) }
        return
      }
      if (args[0] === 'reject') {
        const pendingId = args[1]
        if (!pendingId) { ctx.reply('Usage: `/node reject <pending-id>`'); return }
        try {
          await rejectPendingPairing(pendingId)
          ctx.reply(`✅ Rejected pending pairing \`${pendingId}\``)
        } catch (e: any) { ctx.reply(`❌ Failed to reject pairing: ${e.message}`) }
        return
      }
      if (args[0] === 'remove') {
        const nodeId = args[1]
        if (!nodeId) { ctx.reply('Usage: `/node remove <node-id>`'); return }
        try {
          const removed = await removeApprovedNode(nodeId)
          const disconnected = nodesManager.disconnectNode(removed.nodeId, 'Node credentials removed by /node remove')
          ctx.reply([
            `✅ Removed approved node \`${removed.nodeId}\`.`,
            `Runtime connection: \`${disconnected ? 'closed' : 'not online'}\`.`,
            'The old node credentials are no longer valid; the node must be paired again before it can reconnect.',
          ].join('\n'))
        } catch (e: any) { ctx.reply(`❌ Failed to remove node: ${e.message}`) }
        return
      }
      if (args[0] === 'move') {
        const oldNodeId = args[1]
        const newNodeId = args[2]
        if (!oldNodeId || !newNodeId) { ctx.reply('Usage: `/node move <old-id> <new-id>`'); return }
        try {
          const onlineConflict = nodesManager.getNode(newNodeId)
          if (isReservedNodeId(newNodeId)) {
            throw new Error(`Node id \`${newNodeId}\` is reserved`)
          }
          if (onlineConflict && newNodeId !== oldNodeId) {
            throw new Error(`Node id \`${newNodeId}\` is currently online/registered`)
          }
          const moved = await moveApprovedNode(oldNodeId, newNodeId)
          const disconnected = nodesManager.disconnectNode(moved.oldNodeId, 'Node id moved by /node move; reconnect with the new node id')
          ctx.reply([
            `✅ Moved approved node \`${moved.oldNodeId}\` → \`${moved.newNodeId}\`.`,
            'Auth token hash and metadata were preserved server-side.',
            `Runtime connection: \`${disconnected ? 'old connection closed' : 'old node not online'}\`.`,
            `Node-side credentials still store the old node id. Update the node credentials file to use nodeId \`${moved.newNodeId}\` with the existing authToken, then restart the node so it reconnects with the new id.`,
          ].join('\n'))
        } catch (e: any) { ctx.reply(`❌ Failed to move node: ${e.message}`) }
        return
      }
      // Switch node
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
        await sessionRuntime.updateSettings(sessionId, { currentNode: nodeId })
        ctx.reply(`✅ Switched to node \`${nodeId}\`\n\nAll file/exec/browser tools will now execute on this node.`)
      } catch (e: any) { ctx.reply(`❌ Failed to switch node: ${e.message}`) }
    }
  },
  '/search': {
    description: 'Search archived messages within your allowed memory scope',
    requiresSession: true,
    autocomplete: { children: SEARCH_AUTOCOMPLETE },
    handler: async (ctx, args, sessionId, session) => {
      if (!sessionId || !session) { ctx.reply('❌ No active session.'); return }
      let limit = 5; let targetSessionId: string | undefined; let targetAgentName: string | undefined
      const queryParts: string[] = []
      for (let i = 0; i < args.length; i += 1) {
        const arg = args[i]
        if (arg === '--limit' && i + 1 < args.length) { const p = parseInt(args[i+1], 10); if (!Number.isNaN(p) && p > 0) limit = p; i += 1; continue }
        if (arg === '--session' && i + 1 < args.length) { targetSessionId = args[i+1]; i += 1; continue }
        if (arg === '--agent' && i + 1 < args.length) { targetAgentName = args[i+1]; i += 1; continue }
        queryParts.push(arg)
      }
      const query = queryParts.join(' ').trim()
      if (!query) { ctx.reply('Usage: /search [--session <session-id>] [--agent <agent-name>] [--limit <n>] <query>'); return }
      try {
        const result = await tools.recall({ vector_query: query, limit, sessionId: targetSessionId, agentName: targetAgentName }, { sessionId })
        ctx.reply(result)
      } catch (e: any) { ctx.reply(`❌ Search failed: ${e.message}`) }
    }
  },
  '/messages': {
    description: 'Show message previews. `args: <num> | <start> <end>`',
    requiresSession: true,
    showInTelegram: false,
    autocomplete: { children: MESSAGES_AUTOCOMPLETE },
    handler: async (ctx, args, sessionId, session) => {
      if (!sessionId || !session) return
      const history = await sessionRuntime.getHistory(sessionId)
      const totalMessages = history?.messages.length ?? commandSessionMessageCount(session)
      const previewLength = 100
      let start: number | undefined; let end: number | undefined
      if (args.length === 0) { ctx.reply(messagesUsage); return }
      const n1 = parseInt(args[0], 10)
      if (isNaN(n1)) { ctx.reply(messagesUsage); return }
      if (args.length === 1) {
        if (n1 === 0) { ctx.reply(messagesUsage); return }
        if (n1 > 0) { start = 0; end = Math.min(n1, totalMessages) }
        else { const count = Math.min(Math.abs(n1), totalMessages); start = Math.max(0, totalMessages - count); end = totalMessages }
      } else {
        const n2 = parseInt(args[1], 10)
        if (isNaN(n2)) { ctx.reply(messagesUsage); return }
        start = n1 < 0 ? totalMessages + n1 : n1
        end = n2 < 0 ? totalMessages + n2 : n2
        start = Math.max(0, Math.min(start, totalMessages))
        end = Math.max(0, Math.min(end, totalMessages))
      }
      if (end === undefined || start === undefined || end < start) { ctx.reply('No messages found in the specified range.'); return }
      const messages = (history?.messages || []).slice(start, end)
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
      const { defaultKey, currentKey } = resolveModelConfig(session.model)
      const modelKeys = getDisplayModelKeys(session.model)
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
        await sessionRuntime.updateSettings(sessionId, { model: null })
        ctx.reply('✅ Model reset to default.')
        return
      }
      const resolved = resolveCommandModelSelection(target, session.model)
      if (resolved.error) { ctx.reply(resolved.error); return }
      await sessionRuntime.updateSettings(sessionId, { model: resolved.key })
      ctx.reply(`✅ Model switched to \`${resolved.key}\`.`)
    }
  },
  '/delete-messages': {
    description: 'Delete messages from current session. `args: <num>` (positive: oldest, negative: newest)',
    requiresSession: true,
    showInTelegram: false,
    autocomplete: { children: DELETE_MESSAGES_AUTOCOMPLETE },
    handler: async (ctx, args, sessionId) => {
      if (!sessionId) return
      if (args.length === 0) { ctx.reply(deleteMessagesUsage); return }
      const num = parseInt(args[0], 10)
      if (isNaN(num) || num === 0) { ctx.reply(deleteMessagesUsage); return }
      const result = await sessionRuntime.deleteMessages(sessionId, num)
      ctx.reply(`✅ Deleted ${result.deleted} messages. Remaining: ${result.remaining}.`)
    }
  },
  '/verbose': {
    description: 'Toggle verbose mode (show tool calls). `args: [on|off]`',
    requiresSession: true,
    autocomplete: { children: VERBOSE_AUTOCOMPLETE },
    handler: async (ctx, args, sessionId) => {
      if (!sessionId) return
      const session = await sessionRuntime.getSession(sessionId)
      if (!session) { ctx.reply('❌ No active session.'); return }
      if (args.length === 0) { ctx.reply(`Verbose mode is currently *${session.verbose ? 'on' : 'off'}*.`); return }
      const target = args[0].toLowerCase()
      if (target === 'on') { await sessionRuntime.updateSettings(sessionId, { verbose: true }); ctx.reply('✅ Verbose mode enabled. Tool calls will be shown.') }
      else if (target === 'off') { await sessionRuntime.updateSettings(sessionId, { verbose: false }); ctx.reply('✅ Verbose mode disabled. Tool calls will be hidden.') }
      else { ctx.reply('Usage: /verbose [on|off]') }
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
        ctx.reply([
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
        ].filter(Boolean).join('\n'))
        return
      }

      if (subcommand === 'login') {
        try {
          const result = await startWeixinQrLogin({ baseUrl, botType: loginBotType, routeTag })
          ctx.reply([
            '✅ Weixin QR login started.',
            `- sessionKey: \`${result.sessionKey}\``,
            result.qrcodeUrl ? `- qrcodeUrl: ${result.qrcodeUrl}` : '- qrcodeUrl: (none)',
            '', 'After scanning, run:', `\`/weixin wait ${result.sessionKey}\``,
          ].join('\n'))
        } catch (e: any) {
          const cause = e?.cause
          const causeText = cause?.message ? ` (${cause.message}${cause?.code ? `; code=${cause.code}` : ''})` : ''
          ctx.reply(`❌ Failed to start Weixin login: ${e.message}${causeText}`)
        }
        return
      }

      if (subcommand === 'wait') {
        const sessionKey = args[1]?.trim()
        if (!sessionKey) { ctx.reply('Usage: /weixin wait <sessionKey>'); return }
        try {
          const result = await waitForWeixinQrLogin({ sessionKey, baseUrl, routeTag, timeoutMs: 60_000 })
          if (!result.connected || !result.botToken) { ctx.reply(`⏳ ${result.message}`); return }
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
          ctx.reply([
            '✅ Weixin login completed and config file updated.',
            `- config: \`${APP_CONFIG_PATH}\``, `- channelId: \`${weixinChannelId}\``,
            `- baseUrl: \`${result.baseUrl || baseUrl}\``,
            result.userId ? `- ownerUserId: \`${result.userId}\`` : undefined,
            `- runtime: ${runtimeNote}`, '',
            `You can also inspect runtime state with \`/channel status ${weixinChannelId}\`.`,
          ].filter(Boolean).join('\n'))
        } catch (e: any) { ctx.reply(`❌ Failed while waiting for Weixin login: ${e.message}`) }
        return
      }

      ctx.reply('Usage: /weixin status\n       /weixin login\n       /weixin wait <sessionKey>')
    }
  },
  '/channel': {
    description: 'Manage channel settings and channel runtime. `args: info|auth|status|start|stop|restart|mode ...`',
    requiresSession: false,
    autocomplete: { children: CHANNEL_AUTOCOMPLETE },
    handler: handleChannelCommand,
  },
}
