import fs from 'fs-extra'
import path from 'path'
import { ChannelContext } from './channel'
import { nodesManager } from './nodesManager'
import { Session } from './types'
import * as sessionManager from './sessionManager'
import * as skills from './skills'
import * as tools from './tools'
import { estimateSessionTokens } from './tokenCount'
import { CONTEXT_LIMIT, COMPACT_PERCENT, resolveModelConfig } from './config'
import { formatSessionMessagesPreview } from './utils/messagePreview'
import * as timers from './timers'

export type CommandDef = {
  description: string
  usage?: string
  requiresSession?: boolean
  showInTelegram?: boolean
  handler: (ctx: ChannelContext, args: string[], sessionId?: string, session?: Session) => Promise<void>
}

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

async function handleCompactCommand(ctx: ChannelContext, args: string[], sessionId?: string, session?: Session) {
  if (!sessionId || !session) return
  if (session.history.length === 0) {
    ctx.reply('History is empty.')
    return
  }

  let keepPercent = COMPACT_PERCENT
  if (args.length >= 1) {
    const pct = parseFloat(args[0])
    if (!isNaN(pct) && pct > 0 && pct <= 100) {
      keepPercent = pct / 100
    }
  }

  const result = await sessionManager.requestSessionCompaction(sessionId, { keepPercent })

  if (result.alreadyQueued) {
    ctx.reply('ℹ️ Compaction is already queued for this session.')
    return
  }

  if (result.startedImmediately) {
    ctx.reply('🔄 Compaction started...')
    return
  }

  ctx.reply(`⏳ Compaction queued. Pending queue length: ${result.queueLength}`)
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
    description: 'Compact history. `args: [keep%]`',
    requiresSession: true,
    handler: handleCompactCommand,
  },
  '/compress': {
    description: 'Alias of /compact. `args: [keep%]`',
    requiresSession: true,
    handler: handleCompactCommand,
    showInTelegram: false,
  },
  '/timer': {
    description: 'Manage session timers: help, list, create, delete',
    requiresSession: true,
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
      resp += `\n*Channel:* ${ctx.platform}:${ctx.channelUserId}`
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
    handler: async (ctx, args, sessionId, session) => {
      // Manually get session for subcommands that need it
      if (!sessionId) {
        sessionId = sessionManager.getSessionByChannel(ctx.platform, ctx.channelUserId);
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
        resp += '`/session fork` - Fork current session\n'
        resp += '`/session delete <sessionId>` - Delete session\n'
        resp += '`/session clear` - Clear current session history\n'
        resp += '`/session rename <name>` - Rename session\n'
        resp += '`/session isolated [on|off] [node]` - Toggle isolated mode\n'
        resp += '`/session index` - Index messages to vector database\n'
        resp += '`/session move [agent/]<new-session-id>` - Move/rename session\n'
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
            const isolated = sess.isolated ? ' isolated' : ''
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
          sessionManager.detachChannel(ctx.platform, ctx.channelUserId)
          const newSessionId = sessionManager.attachChannel(ctx.platform, ctx.channelUserId)
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

            sessionManager.detachChannel(ctx.platform, ctx.channelUserId)
            sessionManager.attachChannel(ctx.platform, ctx.channelUserId, result.sessionId)
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
          const forkedSessionId = await sessionManager.forkSession(sessionId)
          sessionManager.detachChannel(ctx.platform, ctx.channelUserId)
          sessionManager.attachChannel(ctx.platform, ctx.channelUserId, forkedSessionId)
          ctx.reply(`✅ Forked session \`${sessionId}\` → \`${forkedSessionId}\`\nMessages: ${session.history.length}`)
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
          await sessionManager.clearSession(sessionId)
          sessionManager.detachChannel(ctx.platform, ctx.channelUserId)
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

        case 'isolated': {
          if (!sessionId || !session) {
            ctx.reply('❌ No active session.')
            return
          }

          if (subArgs.length === 0) {
            const node = session.currentNode || 'master'
            const state = session.isolated ? 'on' : 'off'
            ctx.reply(`🔒 Isolated: \`${state}\` (node: \`${node}\`)`)
            return
          }

          const mode = subArgs[0]
          if (mode !== 'on' && mode !== 'off') {
            ctx.reply('Usage: /session isolated [on|off] [node]')
            return
          }

          if (mode === 'on') {
            const nodeId = subArgs[1]
            if (nodeId) {
              if (nodeId !== 'master' && !nodesManager.getNode(nodeId)) {
                ctx.reply(`❌ Node \`${nodeId}\` not found.`)
                return
              }
              session.currentNode = nodeId
            }
            session.isolated = true
            await sessionManager.saveSession(sessionId)
            ctx.reply(`✅ Isolated mode enabled (node: \`${session.currentNode || 'master'}\`)`)
            return
          }

          session.isolated = false
          await sessionManager.saveSession(sessionId)
          ctx.reply('✅ Isolated mode disabled.')
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
            ctx.reply('Usage: /session move [agent/]<new-session-id>\nExample: /session move my-project\nExample: /session move my-agent/main')
            return
          }

          const targetId = subArgs[0]
          
          try {
            await tools.move_session({ 
              sessionId: sessionId,
              newSessionId: targetId 
            }, { 
              session,
              sessionId: sessionId,
              broadcast: async (msg: string) => ctx.reply(msg)
            })
            // move_session already sends reply via broadcast
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
    handler: async (ctx, args) => {
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

      sessionManager.detachChannel(ctx.platform, ctx.channelUserId)
      sessionManager.attachChannel(ctx.platform, ctx.channelUserId, targetSessionId)

      ctx.reply(`✅ Attached to session \`${targetSessionId}\``)
    }
  },
  '/agent': {
    description: 'Manage agents',
    requiresSession: false,
    handler: async (ctx, args) => {
      const subcommand = args[0]
      const subArgs = args.slice(1)

      if (!subcommand) {
        let resp = '🤖 *Agent Commands*\n\n'
        resp += '`/agent list` - List all agents\n'
        resp += '`/agent create <name> [--no-main]` - Create new agent (optionally without creating main session)\n'
        resp += '`/agent inherit <agent> <parent-agent|none>` - Set or clear shared memory inheritance\n'
        resp += '`/agent delete <name> [--confirm]` - Delete agent (requires confirmation)\n'
        ctx.reply(resp)
        return
      }

      switch (subcommand) {
        case 'list': {
          const agentsDir = path.join(process.cwd(), 'agents')
          
          if (!await fs.pathExists(agentsDir)) {
            ctx.reply('No agents found.')
            return
          }
          
          const entries = await fs.readdir(agentsDir, { withFileTypes: true })
          const agents: Array<{name: string, sessionCount: number, inherit?: string, skills?: string[]}> = []
          
          for (const entry of entries) {
            if (entry.isDirectory()) {
              const agentName = entry.name
              const sessions = Array.from(sessionManager.getAllSessions().values())
                .filter(sess => (sess.agent || 'main') === agentName)
              
              agents.push({
                name: agentName,
                sessionCount: sessions.length,
                inherit: sessionManager.getAgentMetadata(agentName).inherit,
                skills: sessionManager.getAgentSkills(agentName)
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
            ctx.reply('Usage: /agent create <name> [--no-main]\nExample: /agent create my-assistant\nExample: /agent create my-agent --no-main')
            return
          }

          const agentName = subArgs[0]
          const createMainSession = !subArgs.includes('--no-main')
          
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
              createMainSession
            })

            let resp = `✅ Agent "${agentName}" created successfully!\n\nAgent folder: \`agents/${agentName}\``
            resp += createMainSession
              ? `\nMain session: \`${result.mainSessionId}\``
              : '\nMain session: not created (`--no-main`)'
            ctx.reply(resp)
          } catch (e: any) {
            ctx.reply(`❌ Failed to create agent: ${e.message}`)
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

          const agentDir = path.join(process.cwd(), 'agents', agentName)
          
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
    handler: async (ctx, args) => {
      const subcommand = args[0]
      const subArgs = args.slice(1)

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
          const skillList = await skills.listSkills()
          if (skillList.length === 0) {
            ctx.reply('No skills found.')
            return
          }

          let resp = `🧩 *Skills* (${skillList.length})\n\n`
          for (const skill of skillList) {
            resp += `\`${skill.name}\``
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
            const { info, documents } = await skills.loadSkillDocuments(skillName)
            let resp = `🧩 *Skill:* \`${info.name}\``
            if (info.description) {
              resp += `\n${info.description}`
            }
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
    handler: async (ctx, args, sessionId, session) => {
      if (!sessionId || !session) return
      
      // No args: list nodes
      if (args.length === 0) {
        const nodes = nodesManager.listNodes()
        const currentNode = session.currentNode || 'master'

        if (nodes.length === 0) {
          ctx.reply('📋 No remote nodes registered.\n\n✅ Master node (local) is always available.')
          return
        }

        let reply = `📋 **Available Nodes** (${nodes.length + 1} total):\n\n`

        reply += currentNode === 'master' ? '✅ ' : '  '
        reply += '`master` (local)\n'

        for (const node of nodes) {
          if (node.id === 'master') continue
          reply += currentNode === node.id ? '✅ ' : '  '
          reply += `\`${node.id}\` - Last activity: ${new Date(node.lastActivity).toLocaleString()}\n`
        }

        reply += `\n💡 Current node: \`${currentNode}\``

        ctx.reply(reply)
        return
      }

      // With args: switch node
      const nodeId = args[0]

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
  '/messages': {
    description: 'Show message previews. `args: <num> | <start> <end>`',
    requiresSession: true,
    showInTelegram: false,
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
  '/channel': {
    description: 'Manage channel settings. `args: mode <push-only|normal>`',
    requiresSession: false,
    handler: async (ctx, args) => {
      if (args.length === 0) {
        ctx.reply('Usage: /channel mode <push-only|normal>')
        return
      }

      const subcommand = args[0].toLowerCase()
      
      if (subcommand === 'mode') {
        if (args.length < 2) {
          // Show current mode
          const config = sessionManager.getChannelConfig(ctx.platform, ctx.channelUserId)
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
          sessionManager.setChannelMode(ctx.platform, ctx.channelUserId, mode === 'push-only' ? 'push-only' : undefined)
          ctx.reply(`✅ Channel mode set to *${mode}*`)
        } catch (e: any) {
          ctx.reply(`❌ Failed to set channel mode: ${e.message}`)
        }
      } else {
        ctx.reply('Unknown subcommand. Usage: /channel mode <push-only|normal>')
      }
    }
  }
}
