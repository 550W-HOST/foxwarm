const assert = require('assert');
const axios = require('axios');
const llm = require('../lib/llm.js');
const sessionManager = require('../lib/sessionManager.js');

async function run() {
  const sessionId = `zz_stop_abort_${Date.now()}`;
  const session = await sessionManager.getSession(sessionId);
  session.persistentMemorySnapshot = 'SYSTEM: stop abort smoke';
  session.agent = session.agent || 'main';

  const originalPost = axios.post;
  axios.post = async (_url, _data, config = {}) => {
    if (!config.signal) {
      throw new Error('missing abort signal');
    }

    return new Promise((_resolve, reject) => {
      const onAbort = () => {
        config.signal?.removeEventListener?.('abort', onAbort);
        reject(new axios.CanceledError('aborted by smoke test'));
      };

      if (config.signal.aborted) {
        onAbort();
        return;
      }

      config.signal.addEventListener('abort', onAbort, { once: true });
    });
  };

  try {
    const startedAt = Date.now();
    const chatPromise = llm.chat([{ text: 'hello stop abort smoke' }], session, 0);
    const chatSettled = chatPromise.then(
      value => ({ ok: true, value }),
      err => ({ ok: false, err })
    );

    await new Promise(resolve => setTimeout(resolve, 50));
    const stopResult = await sessionManager.requestSessionStop(sessionId);
    assert.strictEqual(stopResult.abortedInFlight, true, 'requestSessionStop should abort active request');

    const result = await chatSettled;
    assert.strictEqual(result.ok, false, 'chat promise should reject after abort');
    assert.ok(llm.isAbortError(result.err), `expected abort error, got: ${result.err?.name || result.err}`);
    assert.ok(Date.now() - startedAt < 3000, 'abort should stop request quickly');

    console.log('stopAbortSmoke: ok');
  } finally {
    axios.post = originalPost;
    session.stopping = false;
    await sessionManager.clearSession(sessionId).catch(() => {});
  }
}

run().catch(err => {
  console.error(err);
  process.exit(1);
});
