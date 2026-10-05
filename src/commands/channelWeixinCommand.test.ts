import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'fs-extra';
import os from 'node:os';
import path from 'node:path';
import type { ChannelContext } from '../channel';

test('/channel weixin preserves authorized status and QR login/config/runtime behavior without a standalone alias', async t => {
  const root = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-channel-weixin-'));
  process.env.FOXWARM_DATA_DIR = root;
  const config = await import('../config');
  const runtime = await import('../channelRuntime');
  const api = await import('../weixin/api');
  const { COMMANDS } = await import('../commands');
  const { CommandHandler } = await import('../commandHandler');
  const originals = {
    read: config.readAppConfigFile, write: config.writeAppConfigFile,
    status: runtime.getChannelRuntimeStatus, restart: runtime.restartManagedChannel,
    login: api.startWeixinQrLogin, wait: api.waitForWeixinQrLogin,
  };
  const replies: string[] = [];
  const ctx = { platform: 'webui', channelId: 'webui', channelType: 'webui', channelUserId: 'synthetic-room',
    conversationId: 'synthetic-room', username: 'fixture', senderId: 'fixture',
    reply: async (text: string) => { replies.push(text); }, sendTyping: async () => {},
  } as ChannelContext;
  let current: any;
  const writes: any[] = [];
  const restarts: string[] = [];
  const loginCalls: any[] = [];
  const waitCalls: any[] = [];
  let loginFailure: Error | undefined;
  let waitFailure: Error | undefined;
  let restartFailure: Error | undefined;
  let restartRunning = true;
  let waitResult: any = { connected: false, message: 'Synthetic scan not finished.' };
  const initial = () => ({ url: 'https://example.invalid', channels: {
    unrelated: { type: 'telegram', enabled: false, token: 'synthetic-unrelated' },
    chatwechat: { type: 'weixin', baseUrl: ' https://weixin.example.invalid/ ', routeTag: ' fixture-route ', loginBotType: ' 7 ',
      token: 'synthetic-previous', allowedUsers: ['fixture-owner'], extraSetting: 'preserved' },
  } });
  const dispatch = async (args: string[]) => {
    replies.length = 0;
    await COMMANDS['/channel'].handler(ctx, args);
    return replies.join('\n');
  };
  try {
    current = initial();
    (config as any).readAppConfigFile = () => structuredClone(current);
    (config as any).writeAppConfigFile = (next: any) => { writes.push(next); current = next; };
    (runtime as any).getChannelRuntimeStatus = (id: string) => { assert.equal(id, 'chatwechat'); return { running: true }; };
    (runtime as any).restartManagedChannel = async (id: string) => { restarts.push(id); if (restartFailure) throw restartFailure; return { status: { running: restartRunning } }; };
    (api as any).startWeixinQrLogin = async (args: any) => { loginCalls.push(args); if (loginFailure) throw loginFailure; return { sessionKey: 'synthetic-login-session', qrcodeUrl: 'https://qr.example.invalid' }; };
    (api as any).waitForWeixinQrLogin = async (args: any) => { waitCalls.push(args); if (waitFailure) throw waitFailure; return waitResult; };

    await t.test('registry, help and nested autocomplete expose only the new namespace', async () => {
      assert.equal(COMMANDS['/weixin'], undefined);
      assert.equal(COMMANDS['/channel'].requiresSession, false);
      const node = COMMANDS['/channel'].autocomplete!.children!.find(node => node.value === 'weixin');
      assert.equal(node?.kind, 'literal');
      assert.deepEqual(node?.children?.map(node => node.value), ['status', 'login', 'wait']);
      const key = node?.children?.find(node => node.value === 'wait')?.children?.[0];
      assert.equal(key?.value, '<sessionKey>'); assert.equal(key?.kind, 'placeholder');
      replies.length = 0; await COMMANDS['/help'].handler(ctx, []);
      assert.match(replies.join('\n'), /`\/channel`/);
      assert.doesNotMatch(replies.join('\n'), /`\/weixin`/);
      assert.match(await dispatch([]), /\/channel weixin/);
      assert.match(await dispatch(['unknown']), /\/channel weixin/);
    });

    await t.test('bare nested command defaults to status through ordinary authorization without a Session', async () => {
      const handler = new CommandHandler({ isAuthorized: () => true, buildUnauthorizedMessage: () => 'Synthetic denied' } as any);
      replies.length = 0;
      assert.equal(await handler.handleCommand(ctx, '/channel', ['weixin']), true);
      const bare = replies.join('\n');
      assert.match(bare, /channelId: `chatwechat`/);
      assert.match(bare, /token: `configured`/);
      assert.match(bare, /runtime: `running`/);
      assert.match(bare, /\/channel weixin login/);
      assert.equal(await dispatch(['WEIXIN', 'STATUS']), bare);
      assert.equal(await handler.handleCommand(ctx, '/weixin', []), false);
      const denied = new CommandHandler({ isAuthorized: () => false, buildUnauthorizedMessage: () => 'Synthetic denied' } as any);
      replies.length = 0;
      await denied.handleCommand(ctx, '/channel', ['weixin', 'login']);
      assert.deepEqual(replies, ['Synthetic denied']);
      assert.equal(loginCalls.length, 0);
      assert.equal(writes.length, 0);
    });

    await t.test('login dispatch retains configured and default API arguments and reports failures', async () => {
      assert.match(await dispatch(['weixin', 'LOGIN']), /\/channel weixin wait synthetic-login-session/);
      assert.deepEqual(loginCalls[0], { baseUrl: 'https://weixin.example.invalid/', botType: '7', routeTag: 'fixture-route' });
      current = { channels: {} };
      assert.match(await dispatch(['weixin', 'login']), /QR login started/);
      assert.deepEqual(loginCalls[1], { baseUrl: api.DEFAULT_WEIXIN_BASE_URL, botType: api.DEFAULT_WEIXIN_LOGIN_BOT_TYPE, routeTag: undefined });
      loginFailure = Object.assign(new Error('Synthetic login failed'), { cause: Object.assign(new Error('Synthetic socket failed'), { code: 'FIXTURE_CODE' }) });
      assert.match(await dispatch(['weixin', 'login']), /Synthetic login failed.*Synthetic socket failed; code=FIXTURE_CODE/);
      loginFailure = undefined; current = initial();
      assert.equal(writes.length, 0); assert.equal(restarts.length, 0);
    });

    await t.test('missing/unknown/wait-not-finished/failure do not save config or restart runtime', async () => {
      assert.equal(await dispatch(['weixin', 'wait']), 'Usage: /channel weixin wait <sessionKey>');
      assert.equal(waitCalls.length, 0);
      assert.match(await dispatch(['weixin', 'unknown']), /\/channel weixin status/);
      assert.match(await dispatch(['weixin', 'wait', ' fixture-session ']), /Synthetic scan not finished/);
      assert.deepEqual(waitCalls[0], { sessionKey: 'fixture-session', baseUrl: 'https://weixin.example.invalid/', routeTag: 'fixture-route', timeoutMs: 60_000 });
      waitResult = { connected: true, message: 'No credential returned.' };
      assert.match(await dispatch(['weixin', 'wait', 'fixture-session']), /No credential returned/);
      waitFailure = new Error('Synthetic wait failed');
      assert.match(await dispatch(['weixin', 'wait', 'fixture-session']), /Failed while waiting.*Synthetic wait failed/);
      waitFailure = undefined;
      assert.equal(writes.length, 0); assert.equal(restarts.length, 0);
    });

    await t.test('successful wait updates only the selected channel and retains runtime outcome reporting', async () => {
      waitResult = { connected: true, botToken: 'synthetic-new-credential', baseUrl: 'https://confirmed.example.invalid', userId: 'fixture-owner', message: 'Connected' };
      assert.match(await dispatch(['weixin', 'wait', 'fixture-session']), /started immediately/);
      assert.deepEqual(writes[0], { ...initial(), channels: { ...initial().channels, chatwechat: {
        ...initial().channels.chatwechat, enabled: true, type: 'weixin', baseUrl: 'https://confirmed.example.invalid', token: 'synthetic-new-credential', routeTag: 'fixture-route',
      } } });
      assert.deepEqual(restarts, ['chatwechat']);
      assert.doesNotMatch(replies.join('\n'), /synthetic-new-credential/);
      restartRunning = false;
      assert.match(await dispatch(['weixin', 'wait', 'fixture-session']), /runtime status is still stopped/);
      restartFailure = new Error('Synthetic runtime unavailable');
      assert.match(await dispatch(['weixin', 'wait', 'fixture-session']), /config updated, but runtime start failed: Synthetic runtime unavailable/);
      assert.equal(writes.length, 3);
      assert.deepEqual(restarts, ['chatwechat', 'chatwechat', 'chatwechat']);
    });
  } finally {
    (config as any).readAppConfigFile = originals.read; (config as any).writeAppConfigFile = originals.write;
    (runtime as any).getChannelRuntimeStatus = originals.status; (runtime as any).restartManagedChannel = originals.restart;
    (api as any).startWeixinQrLogin = originals.login; (api as any).waitForWeixinQrLogin = originals.wait;
    assert.equal(await fs.pathExists(config.APP_CONFIG_PATH), false, 'the command never writes a real configuration file');
    await fs.remove(root);
  }
});
