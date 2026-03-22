import { ChannelContext, getChannelId, getChannelType, getConversationId } from './channel';
import { getChannelConfigById, readAppConfigFile } from './config';
import * as sessionManager from './sessionManager';

export type ChannelAuthorizationInspection = {
  channelId: string;
  channelType: string;
  conversationId: string;
  senderId?: string;
  username?: string;
  effectiveAuthId: string;
  authorized: boolean;
  directAuthorized: boolean;
  wildcardAuthorized: boolean;
  channelOverrideAuthorized: boolean;
  platformAlwaysAuthorized: boolean;
  allowedUsers: string[];
  allowAllUsers: boolean;
  allowlistSource: string;
  dangerouslyAllowAllGroupMembers: boolean;
};

function dedupe(values: Array<string | undefined>): string[] {
  return Array.from(new Set(values.map(value => value?.trim()).filter((value): value is string => Boolean(value))));
}

function getChannelAllowlist(channelId: string, channelType: string): { allowedUsers: string[]; allowAllUsers: boolean; source: string } {
  const appConfig = readAppConfigFile();
  const entry = getChannelConfigById(channelId, appConfig);
  const config = (entry?.config || {}) as Record<string, any>;

  switch (channelType) {
    case 'telegram':
      return {
        allowedUsers: dedupe([config.mainAttachUser, ...(config.allowedUsers || [])]),
        allowAllUsers: false,
        source: `channels.${channelId}.allowedUsers`,
      };
    case 'matrix':
      return {
        allowedUsers: dedupe([config.botUserId, ...(config.allowedUsers || [])]),
        allowAllUsers: false,
        source: `channels.${channelId}.allowedUsers`,
      };
    case 'wework':
      return {
        allowedUsers: dedupe(config.allowedUsers || []),
        allowAllUsers: false,
        source: `channels.${channelId}.allowedUsers`,
      };
    case 'weixin':
      return {
        allowedUsers: dedupe(config.allowedUsers || []),
        allowAllUsers: Boolean(config.allowAllUsers),
        source: `channels.${channelId}.allowedUsers`,
      };
    default:
      return {
        allowedUsers: dedupe(config.allowedUsers || []),
        allowAllUsers: Boolean(config.allowAllUsers),
        source: entry ? `channels.${channelId}.allowedUsers` : 'not-configurable',
      };
  }
}

export function inspectChannelAuthorization(params: {
  platform: string;
  channelId?: string;
  channelType?: string;
  channelUserId: string;
  conversationId?: string;
  senderId?: string;
  username?: string;
  startupAuthorizedUsers?: Iterable<string>;
}): ChannelAuthorizationInspection {
  const channelType = params.channelType || params.platform;
  const channelId = params.channelId || params.platform;
  const conversationId = params.conversationId || params.channelUserId;
  const { senderId, username, startupAuthorizedUsers } = params;
  const effectiveAuthId = (senderId || conversationId || '').trim();
  const startupSet = startupAuthorizedUsers ? new Set(startupAuthorizedUsers) : new Set<string>();
  const { allowedUsers, allowAllUsers, source } = getChannelAllowlist(channelId, channelType);
  const dangerouslyAllowAllGroupMembers = sessionManager.getChannelDangerouslyAllowAllGroupMembers(channelId, conversationId);
  const platformAlwaysAuthorized = channelType === 'internal' || channelType === 'webui' || channelType === 'tui';
  const wildcardAuthorized = startupSet.has(`${channelId}:*`) || startupSet.has(`${channelType}:*`) || allowAllUsers;
  const directAuthorized = startupSet.has(`${channelId}:${effectiveAuthId}`) || startupSet.has(`${channelType}:${effectiveAuthId}`) || allowedUsers.includes(effectiveAuthId);
  const channelOverrideAuthorized = dangerouslyAllowAllGroupMembers;
  const authorized = platformAlwaysAuthorized || wildcardAuthorized || directAuthorized || channelOverrideAuthorized;

  return {
    channelId,
    channelType,
    conversationId,
    senderId,
    username,
    effectiveAuthId,
    authorized,
    directAuthorized,
    wildcardAuthorized,
    channelOverrideAuthorized,
    platformAlwaysAuthorized,
    allowedUsers,
    allowAllUsers,
    allowlistSource: source,
    dangerouslyAllowAllGroupMembers,
  };
}

function toYamlSnippet(platform: string, authId: string): string {
  const escaped = authId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    'channels:',
    `  ${platform}:`,
    platform !== 'telegram' && platform !== 'matrix' && platform !== 'wework' && platform !== 'weixin' ? undefined : undefined,
    '    allowedUsers:',
    `      - "${escaped}"`,
  ].filter(Boolean).join('\n');
}

function toChannelYamlSnippet(channelId: string, channelType: string, authId: string): string {
  const escapedChannelId = channelId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedType = channelType.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  const escapedAuth = authId.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
  return [
    'channels:',
    `  ${escapedChannelId}:`,
    channelId !== channelType ? `    type: ${escapedType}` : undefined,
    '    allowedUsers:',
    `      - "${escapedAuth}"`,
  ].filter(Boolean).join('\n');
}

export function formatAuthorizationInspection(
  inspection: ChannelAuthorizationInspection,
  options: { title?: string; unauthorized?: boolean } = {}
): string {
  const title = options.title || (options.unauthorized ? '❌ Unauthorized.' : 'Channel authorization diagnostics');
  const allowlistPreview = inspection.allowAllUsers
    ? 'all users'
    : (inspection.allowedUsers.length > 0 ? inspection.allowedUsers.map(value => `\`${value}\``).join(', ') : 'none');

  if (options.unauthorized) {
    const userLabel = inspection.senderId && inspection.senderId !== inspection.conversationId
      ? `senderId: \`${inspection.senderId}\`\n- userId: \`${inspection.effectiveAuthId}\``
      : `userId: \`${inspection.effectiveAuthId || inspection.conversationId || '(empty)'}\``;

    const lines = [
      title,
      '',
      `- channelId: \`${inspection.channelId}\``,
      `- channelType: \`${inspection.channelType}\``,
      `- ${userLabel}`,
    ];

    if (inspection.platformAlwaysAuthorized) {
      lines.push('', 'This platform is normally trusted internally, so if you still saw this message please check the current request path/session state.');
      return lines.join('\n');
    }

    if (inspection.effectiveAuthId) {
      lines.push(
        '',
        'Authorize this user by adding it to config.yaml:',
        '```yaml',
        toChannelYamlSnippet(inspection.channelId, inspection.channelType, inspection.effectiveAuthId),
        '```'
      );
    } else {
      lines.push('', 'Authorize this sender by adding the current user id to the platform allowlist in config.yaml.');
    }

    if (inspection.senderId && inspection.senderId !== inspection.conversationId) {
      lines.push('', 'Tip: for this platform, use the sender/user id above for allowlist matching, not the channel id.');
    }

    return lines.join('\n');
  }

  const lines = [
    title,
    '',
    `- channelId: \`${inspection.channelId}\``,
    `- channelType: \`${inspection.channelType}\``,
    `- conversationId: \`${inspection.conversationId || '(empty)'}\``,
    `- senderId: \`${inspection.senderId || '(none)'}\``,
    `- effectiveAuthId: \`${inspection.effectiveAuthId || '(empty)'}\``,
  ];

  if (inspection.username) {
    lines.push(`- username: \`${inspection.username}\``);
  }

  lines.push(
    `- authorized: \`${inspection.authorized ? 'yes' : 'no'}\``,
    `- directAllowlistMatch: \`${inspection.directAuthorized ? 'yes' : 'no'}\``,
    `- allowAllUsers: \`${inspection.allowAllUsers ? 'yes' : 'no'}\``,
    `- dangerouslyAllowAllGroupMembers: \`${inspection.dangerouslyAllowAllGroupMembers ? 'yes' : 'no'}\``,
    `- allowlistSource: \`${inspection.allowlistSource}\``,
    `- configuredAllowlist: ${allowlistPreview}`,
  );

  if (inspection.platformAlwaysAuthorized) {
    lines.push('- authorizationReason: built-in trusted platform access');
  } else if (inspection.wildcardAuthorized) {
    lines.push('- authorizationReason: allow-all / wildcard platform authorization');
  } else if (inspection.channelOverrideAuthorized) {
    lines.push('- authorizationReason: channel-level dangerouslyAllowAllGroupMembers override');
  } else if (inspection.directAuthorized) {
    lines.push('- authorizationReason: direct allowlist match');
  }

  if (!inspection.platformAlwaysAuthorized && inspection.effectiveAuthId) {
    lines.push('', 'Add this sender to config.yaml:', '```yaml', toChannelYamlSnippet(inspection.channelId, inspection.channelType, inspection.effectiveAuthId), '```');
  }

  if (inspection.senderId && inspection.senderId !== inspection.conversationId) {
    lines.push('', 'Note: this message is authorized by `senderId` first; `conversationId` is only used when `senderId` is absent.');
  }

  return lines.join('\n');
}

export function inspectChannelAuthorizationFromContext(
  ctx: ChannelContext,
  startupAuthorizedUsers?: Iterable<string>
): ChannelAuthorizationInspection {
  return inspectChannelAuthorization({
    platform: getChannelType(ctx),
    channelId: getChannelId(ctx),
    channelType: getChannelType(ctx),
    channelUserId: getConversationId(ctx),
    conversationId: getConversationId(ctx),
    senderId: ctx.senderId,
    username: ctx.username,
    startupAuthorizedUsers,
  });
}
