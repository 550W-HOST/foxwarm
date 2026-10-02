import { APP_CONFIG_PATH, getDefaultChannelIdByType, readAppConfigFile, writeAppConfigFile, WEIXIN_CONFIG } from '../config';
import { DEFAULT_WEIXIN_BASE_URL, DEFAULT_WEIXIN_LOGIN_BOT_TYPE, startWeixinQrLogin, waitForWeixinQrLogin } from '../weixin/api';
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
      '       /channel weixin [status|login|wait <sessionKey>]',
      '       /channel dangerously-allow-all-users <yes|no>',
    ].join('\n'))
    return
  }

  const subcommand = args[0].toLowerCase()

  if (subcommand === 'weixin') {
    await handleWeixinChannelCommand(ctx, args.slice(1))
    return
  }

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
      '/channel weixin [status|login|wait <sessionKey>]',
      '/channel dangerously-allow-all-users <yes|no>',
    ].join('\n'))
  }
}

async function handleWeixinChannelCommand(ctx: ChannelContext, args: string[]) {
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
      '- `/channel weixin login`',
      '- `/channel weixin wait <sessionKey>`',
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
        '', 'After scanning, run:', `\`/channel weixin wait ${result.sessionKey}\``,
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
    if (!sessionKey) { ctx.reply('Usage: /channel weixin wait <sessionKey>'); return }
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

  ctx.reply('Usage: /channel weixin status\n       /channel weixin login\n       /channel weixin wait <sessionKey>')
}
