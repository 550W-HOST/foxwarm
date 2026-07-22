import { ChannelContext, getChannelId, getConversationId } from '../channel';
import { Session } from '../types';
import * as sessionManager from '../sessionManager';
import { resolveModelConfig } from '../config';
import { parseSessionMoveTarget, parseCompactThresholdInput, resolveCommandModelSelection } from './helpers';

export function formatSessionListChannels(channelKeys: Iterable<string>): string {
  const visibleChannels = Array.from(channelKeys).filter(channelKey => !channelKey.startsWith('webui:'));
  return visibleChannels.length > 0
    ? `    - channels: \`${visibleChannels.join(', ')}\`\n`
    : '';
}

export async function handleSessionCommand(ctx: ChannelContext, args: string[], sessionId?: string, session?: Session) {
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
    resp += '`/session create <agent> <session> [--model <model>] [--system-prompt-file <path>]...` - Create session under an existing agent\n'
    resp += '`/session child-model [model|default|clear|unset]` - Get/set child default model for spawned sessions\n'
    resp += '`/session fork [suffix]` - Fork current session as a child session (default suffix: `fork`)\n'
    resp += '`/session delete <sessionId>` - Delete session\n'
    resp += '`/session clear` - Clear current session history\n'
    resp += '`/session rename <name>` - Rename session\n'
    resp += '`/session update-snapshot [session-id]` - Refresh session prompt snapshot\n'
    resp += '`/session compact-threshold [tokens|Nk|clear|unset]` - Get/set auto-compact threshold override for current session\n'
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
        resp += formatSessionListChannels(attachedChannels)
      }

      if (totalPages > 1) {
        resp += `\nUse \`/session list <page>\` to view other pages.`
      }

      ctx.reply(resp)
      break
    }

    case 'new': {
      const { session: newSession } = await sessionManager.createEmptySession()
      sessionManager.detachChannel(getChannelId(ctx), getConversationId(ctx))
      const newSessionId = sessionManager.attachChannel(getChannelId(ctx), getConversationId(ctx), newSession.id)
      ctx.reply(`✅ Created and attached to new session \`${newSessionId}\``)
      break
    }

    case 'create': {
      if (subArgs.length < 2) {
        ctx.reply('Usage: /session create <agent> <session> [--model <model>] [--system-prompt-file <path>]...')
        return
      }

      const agentName = subArgs[0]
      const newSessionName = subArgs[1]
      const modelFlagIndex = subArgs.indexOf('--model')
      let resolvedModel: string | undefined
      const systemPromptFiles: string[] = []

      if (modelFlagIndex >= 0) {
        const requestedModel = subArgs[modelFlagIndex + 1]
        if (!requestedModel) {
          ctx.reply('Usage: /session create <agent> <session> [--model <model>] [--system-prompt-file <path>]...')
          return
        }

        const selection = resolveCommandModelSelection(requestedModel, session?.model)
        if (selection.error) {
          ctx.reply(selection.error)
          return
        }

        resolvedModel = selection.key
      }

      for (let index = 2; index < subArgs.length; index += 1) {
        if (subArgs[index] !== '--system-prompt-file') continue
        const configuredFile = subArgs[index + 1]
        if (!configuredFile) {
          ctx.reply('Usage: /session create <agent> <session> [--model <model>] [--system-prompt-file <path>]...')
          return
        }

        systemPromptFiles.push(configuredFile)
        index += 1
      }

      try {
        const result = await sessionManager.createSessionInAgent({
          agentName,
          sessionName: newSessionName,
          currentNode: session?.currentNode,
          systemPromptFiles: systemPromptFiles.length > 0 ? systemPromptFiles : undefined,
          model: sessionManager.resolveSpawnedSessionModel(session, resolvedModel),
        })

        sessionManager.detachChannel(getChannelId(ctx), getConversationId(ctx))
        sessionManager.attachChannel(getChannelId(ctx), getConversationId(ctx), result.sessionId)
        const createdSession = await sessionManager.getSession(result.sessionId)
        const { currentKey } = resolveModelConfig(createdSession.model)
        ctx.reply(`✅ Created session \`${result.sessionId}\` under agent \`${agentName}\` and attached current channel.\nModel: \`${currentKey}\``)
      } catch (e: any) {
        ctx.reply(`❌ Session create failed: ${e.message}`)
      }
      break
    }

    case 'child-model': {
      if (!sessionId || !session) {
        ctx.reply('❌ No active session.')
        return
      }

      if (subArgs.length === 0) {
        const override = session.childModelDefault?.trim()
          ? `\`${session.childModelDefault.trim()}\``
          : 'follow current session model'
        const { currentKey: currentSessionModel } = resolveModelConfig(session.model)
        const { currentKey: effectiveSpawnModel } = resolveModelConfig(sessionManager.resolveSpawnedSessionModel(session))
        ctx.reply([
          '🧒 *Child default model*',
          '',
          `- override: ${override}`,
          `- current session model: \`${currentSessionModel}\``,
          `- effective spawned-session model: \`${effectiveSpawnModel}\``,
        ].join('\n'))
        return
      }

      const target = subArgs[0].toLowerCase()
      if (target === 'default' || target === 'clear' || target === 'unset') {
        await sessionManager.setSessionChildModelDefault(sessionId)
        delete session.childModelDefault
        const { currentKey } = resolveModelConfig(sessionManager.resolveSpawnedSessionModel(session))
        ctx.reply(`✅ Child default model cleared. New child sessions will follow the current session model path (effective: \`${currentKey}\`).`)
        return
      }

      const selection = resolveCommandModelSelection(subArgs[0], session.model)
      if (selection.error) {
        ctx.reply(selection.error)
        return
      }

      await sessionManager.setSessionChildModelDefault(sessionId, selection.key)
      session.childModelDefault = selection.key
      ctx.reply(`✅ Child default model set to \`${selection.key}\`.`)
      return
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

      targetSession.archived = false
      await sessionManager.saveSession(targetSessionId)

      ctx.reply(`✅ Session \`${targetSessionId}\` unarchived.`)
      break
    }

    default:
      ctx.reply(`❌ Unknown subcommand: ${subcommand}\nUse \`/session\` to see available commands.`)
  }
}
