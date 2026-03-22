import { ChannelContext } from './channel';
import { readAppConfigFile } from './config';
import * as sessionManager from './sessionManager';

export type ChannelAuthorizationInspection = {
  platform: string;
  channelUserId: string;
  senderId?: string;
  username?: string;
  channelId: string;
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

function getPlatformAllowlist(platform: string): { allowedUsers: string[]; allowAllUsers: boolean; source: string } {
  const appConfig = readAppConfigFile();
  switch (platform) {
    case 'telegram': {
      const config = appConfig.channels?.telegram;
      return {
        allowedUsers: dedupe([config?.mainAttachUser, ...(config?.allowedUsers || [])]),
        allowAllUsers: false,
        source: 'channels.telegram.allowedUsers',
      };
    }
    case 'matrix': {
      const config = appConfig.channels?.matrix;
      return {
        allowedUsers: dedupe([config?.botUserId, ...(config?.allowedUsers || [])]),
        allowAllUsers: false,
        source: 'channels.matrix.allowedUsers',
      };
    }
    case 'wework': {
      const config = appConfig.channels?.wework;
      return {
        allowedUsers: dedupe(config?.allowedUsers || []),
        allowAllUsers: false,
        source: 'channels.wework.allowedUsers',
      };
    }
    case 'weixin': {
      const config = appConfig.channels?.weixin;
      return {
        allowedUsers: dedupe(config?.allowedUsers || []),
        allowAllUsers: Boolean(config?.allowAllUsers),
        source: 'channels.weixin.allowedUsers',
      };
    }
    default:
      return {
        allowedUsers: [],
        allowAllUsers: false,
        source: 'not-configurable',
      };
  }
}

export function inspectChannelAuthorization(params: {
  platform: string;
  channelUserId: string;
  senderId?: string;
  username?: string;
  startupAuthorizedUsers?: Iterable<string>;
}): ChannelAuthorizationInspection {
  const { platform, channelUserId, senderId, username, startupAuthorizedUsers } = params;
  const channelId = `${platform}:${channelUserId}`;
  const effectiveAuthId = (senderId || channelUserId || '').trim();
  const startupSet = startupAuthorizedUsers ? new Set(startupAuthorizedUsers) : new Set<string>();
  const { allowedUsers, allowAllUsers, source } = getPlatformAllowlist(platform);
  const dangerouslyAllowAllGroupMembers = sessionManager.getChannelDangerouslyAllowAllGroupMembers(platform, channelUserId);
  const platformAlwaysAuthorized = platform === 'internal' || platform === 'webui' || platform === 'tui';
  const wildcardAuthorized = startupSet.has(`${platform}:*`) || allowAllUsers;
  const directAuthorized = startupSet.has(`${platform}:${effectiveAuthId}`) || allowedUsers.includes(effectiveAuthId);
  const channelOverrideAuthorized = dangerouslyAllowAllGroupMembers;
  const authorized = platformAlwaysAuthorized || wildcardAuthorized || directAuthorized || channelOverrideAuthorized;

  return {
    platform,
    channelUserId,
    senderId,
    username,
    channelId,
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
    '    allowedUsers:',
    `      - "${escaped}"`,
  ].join('\n');
}

export function formatAuthorizationInspection(
  inspection: ChannelAuthorizationInspection,
  options: { title?: string; unauthorized?: boolean } = {}
): string {
  const title = options.title || (options.unauthorized ? '❌ Unauthorized.' : 'Channel authorization diagnostics');
  const allowlistPreview = inspection.allowAllUsers
    ? 'all users'
    : (inspection.allowedUsers.length > 0 ? inspection.allowedUsers.map(value => `\`${value}\``).join(', ') : 'none');

  const lines = [
    title,
    '',
    `- platform: \`${inspection.platform}\``,
    `- channelId: \`${inspection.channelId}\``,
    `- channelUserId: \`${inspection.channelUserId || '(empty)'}\``,
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
    lines.push('', 'Add this sender to config.yaml:', '```yaml', toYamlSnippet(inspection.platform, inspection.effectiveAuthId), '```');
  }

  if (inspection.senderId && inspection.senderId !== inspection.channelUserId) {
    lines.push('', 'Note: this message is authorized by `senderId` first; `channelUserId` is only used when `senderId` is absent.');
  }

  return lines.join('\n');
}

export function inspectChannelAuthorizationFromContext(
  ctx: ChannelContext,
  startupAuthorizedUsers?: Iterable<string>
): ChannelAuthorizationInspection {
  return inspectChannelAuthorization({
    platform: ctx.platform,
    channelUserId: ctx.channelUserId,
    senderId: ctx.senderId,
    username: ctx.username,
    startupAuthorizedUsers,
  });
}
