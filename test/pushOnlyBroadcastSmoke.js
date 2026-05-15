const path = require('path');
const sessionManager = require(path.join(__dirname, '..', 'lib', 'sessionManager'));
const { registerChannel } = require(path.join(__dirname, '..', 'lib', 'channel'));

(async () => {
  const sessionId = `zz_send_only_${Date.now()}`;
  const platform = 'fakepush';
  const calls = [];

  registerChannel(platform, {
    name: platform,
    platform,
    async start() {},
    async stop() {},
    async sendMessage(channelUserId, text) {
      calls.push({ channelUserId, text });
    },
    async sendTyping() {},
    onMessage() {},
  });

  sessionManager.attachChannel(platform, 'normal-user', sessionId);
  sessionManager.attachChannel(platform, 'send-only-user', sessionId);
  sessionManager.setChannelMode(platform, 'send-only-user', 'send-only');

  try {
    const session = await sessionManager.getSession(sessionId);
    if (!session.broadcast) {
      throw new Error('session.broadcast missing');
    }

    session.broadcast('send-only smoke message');
    await new Promise(resolve => setTimeout(resolve, 50));

    const recipients = calls.map(call => call.channelUserId).sort();
    if (recipients.length !== 1 || recipients[0] !== 'normal-user') {
      throw new Error(`Unexpected recipients: ${JSON.stringify(recipients)}`);
    }

    console.log('sendOnlyBroadcastSmoke: ok');
  } finally {
    sessionManager.detachChannel(platform, 'normal-user');
    sessionManager.detachChannel(platform, 'send-only-user');
    await sessionManager.clearSession(sessionId).catch(() => {});
  }
})().catch(err => {
  console.error(err);
  process.exit(1);
});
