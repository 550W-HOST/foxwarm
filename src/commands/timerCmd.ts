import { ChannelContext } from '../channel';
import type { CommandSession } from './types';
import * as timers from '../timers';
import { checkTimerPermission } from '../isolatedCheck';
import { formatTimerDate, parseTimerFlags, parseTimerMessage } from './helpers';

export async function handleTimerCommand(ctx: ChannelContext, args: string[], sessionId?: string, session?: CommandSession) {
  if (!sessionId || !session) return

  const subcommand = args[0]
  const subArgs = args.slice(1)

  if (!subcommand) {
    let resp = '⏰ *Timer Commands*\n\n'
    resp += '`/timer list` - List timers for current session\n'
    resp += '`/timer delete <id>` - Delete a timer\n'
    resp += '`/timer after <seconds> [--new-session] [--prefix <prefix>] [--agent <agent>] [--] <message>` - Create a one-time timer after N seconds\n'
    resp += '`/timer at <ISO-time> [--new-session] [--prefix <prefix>] [--agent <agent>] [--] <message>` - Create a one-time timer at an absolute time\n'
    resp += '`/timer cron <expr> [--new-session] [--prefix <prefix>] [--agent <agent>] -- <message>` - Create a recurring cron timer\n'
    ctx.reply(resp)
    return
  }

  if (subcommand === 'list') {
    const timerList = timers.listTimers(sessionId)
    if (timerList.length === 0) {
      ctx.reply('No timers found for this session.')
      return
    }

    let resp = `⏰ *Timers for session \`${sessionId}\`*\n\n`
    for (const timer of timerList) {
      const mode = timer.mode === 'cron'
        ? `cron: \`${timer.cron}\``
        : `at: ${formatTimerDate(timer.at)}`
      const target = timer.newSession
        ? `new session (${timer.agentName || 'main'} / ${timer.sessionPrefix || 'timer'})`
        : `this session`
      resp += `- \`${timer.id}\` - ${mode} - next: ${formatTimerDate(timer.nextRunAt)} - ${target}\n`
      resp += `  ${timer.message}\n`
    }
    ctx.reply(resp)
    return
  }

  if (subcommand === 'delete') {
    const timerId = subArgs[0]
    if (!timerId) {
      ctx.reply('Usage: /timer delete <id>')
      return
    }

    const deleted = await timers.deleteTimer(timerId, sessionId)
    if (deleted) {
      ctx.reply(`✅ Timer \`${timerId}\` deleted.`)
    } else {
      ctx.reply(`❌ Timer \`${timerId}\` not found.`)
    }
    return
  }

  if (subcommand === 'after' || subcommand === 'at' || subcommand === 'cron') {
    try {
      let afterSeconds: number | undefined
      let at: string | undefined
      let cron: string | undefined
      let messageTokens: string[]

      if (subcommand === 'after') {
        const seconds = parseInt(subArgs[0], 10)
        if (isNaN(seconds) || seconds <= 0) {
          ctx.reply('Usage: /timer after <seconds> [--new-session] [--prefix <prefix>] [--agent <agent>] [--] <message>')
          return
        }
        afterSeconds = seconds
        const flags = parseTimerFlags(subArgs.slice(1))
        messageTokens = subArgs.slice(1 + flags.index)
        const message = parseTimerMessage(messageTokens)
        if (!message) {
          ctx.reply('Usage: /timer after <seconds> [--new-session] [--prefix <prefix>] [--agent <agent>] [--] <message>')
          return
        }

        await checkTimerPermission({ sessionId }, {
          targetSessionId: sessionId,
          newSession: flags.newSession,
          agentName: flags.agentName,
          sessionPrefix: flags.sessionPrefix,
        })

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
        ctx.reply(`✅ Timer created: \`${timer.id}\`\nFires at: ${formatTimerDate(timer.nextRunAt)}`)
      } else if (subcommand === 'at') {
        at = subArgs[0]
        if (!at) {
          ctx.reply('Usage: /timer at <ISO-time> [--new-session] [--prefix <prefix>] [--agent <agent>] [--] <message>')
          return
        }
        const flags = parseTimerFlags(subArgs.slice(1))
        messageTokens = subArgs.slice(1 + flags.index)
        const message = parseTimerMessage(messageTokens)
        if (!message) {
          ctx.reply('Usage: /timer at <ISO-time> [--new-session] [--prefix <prefix>] [--agent <agent>] [--] <message>')
          return
        }

        await checkTimerPermission({ sessionId }, {
          targetSessionId: sessionId,
          newSession: flags.newSession,
          agentName: flags.agentName,
          sessionPrefix: flags.sessionPrefix,
        })

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
        ctx.reply(`✅ Timer created: \`${timer.id}\`\nFires at: ${formatTimerDate(timer.nextRunAt)}`)
      } else {
        cron = subArgs[0]
        if (!cron) {
          ctx.reply('Usage: /timer cron <expr> [--new-session] [--prefix <prefix>] [--agent <agent>] -- <message>')
          return
        }
        const flags = parseTimerFlags(subArgs.slice(1))
        messageTokens = subArgs.slice(1 + flags.index)
        const message = parseTimerMessage(messageTokens)
        if (!message) {
          ctx.reply('Usage: /timer cron <expr> [--new-session] [--prefix <prefix>] [--agent <agent>] -- <message>')
          return
        }

        await checkTimerPermission({ sessionId }, {
          targetSessionId: sessionId,
          newSession: flags.newSession,
          agentName: flags.agentName,
          sessionPrefix: flags.sessionPrefix,
        })

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
        ctx.reply(`✅ Timer created: \`${timer.id}\`\nNext run: ${formatTimerDate(timer.nextRunAt)}`)
      }
    } catch (e: any) {
      ctx.reply(`❌ Timer creation failed: ${e.message}`)
    }
    return
  }

  ctx.reply('Unknown timer subcommand. Use `/timer` for help.')
}
