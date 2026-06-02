import { ChannelContext, getChannelId, getConversationId } from '../channel';
import { inspectChannelAuthorizationFromContext, formatAuthorizationInspection } from '../channelAuth';
import { getChannelRuntimeStatus, restartManagedChannel, startManagedChannel, stopManagedChannel } from '../channelRuntime';
import * as sessionManager from '../sessionManager';
import { formatChannelInfo, formatChannelRuntimeStatus, getManagedPlatformHelp } from './helpers';

export async function handleChannelCommand(ctx: ChannelContext, args: string[]) {
  if (args.length === 0) {
    ctx.reply([
      'Usage: /channel info',
      '       /channel auth',
      '       /channel status [channel-id-or-type]',
      '       /channel start <channel-id>',
      '       /channel stop <channel-id>',
      '       /channel restart <channel-id>',
      '       /channel mode <send-only|normal>',
      '       /channel dangerously-allow-all-users <yes|no>',
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

      await restartManagedChannel(channelId)
      ctx.reply(`✅ Channel \`${channelId}\` restarted.\n${formatChannelRuntimeStatus(channelId)}`)
    } catch (e: any) {
      ctx.reply(`❌ Failed to ${subcommand} channel: ${e.message}`)
    }
    return
  }
  
  if (subcommand === 'mode') {
    if (args.length < 2) {
      const config = sessionManager.getChannelConfig(getChannelId(ctx), getConversationId(ctx))
      const currentMode = config?.mode || 'normal'
      ctx.reply(`Current channel mode: *${currentMode}*\nUsage: /channel mode <send-only|normal>`)
      return
    }

    const mode = args[1].toLowerCase()
    if (mode !== 'send-only' && mode !== 'push-only' && mode !== 'normal') {
      ctx.reply('Invalid mode. Use: send-only or normal')
      return
    }

    try {
      const normalizedMode = mode === 'normal' ? undefined : 'send-only'
      sessionManager.setChannelMode(getChannelId(ctx), getConversationId(ctx), normalizedMode)
      ctx.reply(`✅ Channel mode set to *${normalizedMode || 'normal'}*`)
    } catch (e: any) {
      ctx.reply(`❌ Failed to set channel mode: ${e.message}`)
    }
  } else if (subcommand === 'dangerously-allow-all-users' || subcommand === 'dangerously-allow-all-group-members') {
    if (args.length < 2) {
      const currentValue = sessionManager.getChannelDangerouslyAllowAllUsers(getChannelId(ctx), getConversationId(ctx))
      ctx.reply(`Current dangerouslyAllowAllUsers: *${currentValue ? 'yes' : 'no'}*\nUsage: /channel dangerously-allow-all-users <yes|no>`)
      return
    }

    const value = args[1].toLowerCase()
    if (value !== 'yes' && value !== 'no') {
      ctx.reply('Invalid value. Use: yes or no')
      return
    }

    try {
      sessionManager.setChannelDangerouslyAllowAllUsers(getChannelId(ctx), getConversationId(ctx), value === 'yes')
      ctx.reply(`✅ dangerouslyAllowAllUsers set to *${value}*`)
    } catch (e: any) {
      ctx.reply(`❌ Failed to set dangerouslyAllowAllUsers: ${e.message}`)
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
      '/channel mode <send-only|normal>',
      '/channel dangerously-allow-all-users <yes|no>',
    ].join('\n'))
  }
}
