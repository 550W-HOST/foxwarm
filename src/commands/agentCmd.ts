import fs from 'fs-extra';
import { ChannelContext, getChannelId, getConversationId } from '../channel';
import { Session } from '../types';
import * as sessionManager from '../sessionManager';
import { AGENTS_DIR, getAgentDir } from '../config';

export async function handleAgentCommand(ctx: ChannelContext, args: string[]) {
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
      const agents: Array<{name: string, sessionCount: number, inherit?: string, isolated?: boolean, isolatedNode?: string}> = []
      
      for (const entry of entries) {
        if (entry.isDirectory()) {
          const agentName = entry.name
          const sessions = Array.from(sessionManager.getAllSessions().values())
            .filter(sess => (sess.agent || 'main') === agentName)
          
          agents.push({
            name: agentName,
            sessionCount: sessions.length,
            inherit: sessionManager.getAgentMetadata(agentName).inherit,
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
