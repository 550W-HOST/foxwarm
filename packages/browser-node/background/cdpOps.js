// Page operations expressed over a CDP `send(method, params)` function. The extension feeds it
// `chrome.debugger`, and the managed headless host feeds it a Puppeteer CDP session, so trusted
// key input and bounded evaluation have one implementation.
import { MAX_TEXT, PRESS_KEYS } from './contract.js';

const KEY_CODES = {
  Enter: 13,
  Tab: 9,
  Escape: 27,
  Backspace: 8,
  Delete: 46,
  ArrowLeft: 37,
  ArrowUp: 38,
  ArrowRight: 39,
  ArrowDown: 40,
  Home: 36,
  End: 35,
};

export async function pressKey(send, name) {
  if (!PRESS_KEYS.includes(name)) throw new Error('Unsupported key.');
  const base = { key: name, code: name, windowsVirtualKeyCode: KEY_CODES[name] };
  await send('Input.dispatchKeyEvent', {
    type: 'keyDown',
    ...base,
    ...(name === 'Enter' ? { text: '\r' } : {}),
  });
  await send('Input.dispatchKeyEvent', { type: 'keyUp', ...base });
}

// Printable ASCII goes through key events so pages see keydown/keypress/input; anything else is
// inserted as text because it has no single physical key.
export async function typeText(send, text) {
  for (const char of text) {
    if (char === '\n' || char === '\r') await pressKey(send, 'Enter');
    else if (char === '\t') await pressKey(send, 'Tab');
    else if (char >= ' ' && char <= '~') {
      await send('Input.dispatchKeyEvent', { type: 'keyDown', key: char, text: char });
      await send('Input.dispatchKeyEvent', { type: 'keyUp', key: char });
    } else await send('Input.insertText', { text: char });
  }
}

// Evaluates in the page, awaits a Promise result and returns a size-bounded value. `context`
// selects the execution context (for example `{ uniqueContextId }`).
export async function evaluateBounded(send, expression, context = {}) {
  const response = await send('Runtime.evaluate', {
    expression,
    ...context,
    awaitPromise: true,
    returnByValue: false,
    allowUnsafeEvalBlockedByCSP: true,
  });
  if (response.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description?.split('\n')[0];
    throw new Error('JavaScript evaluation failed' + (detail ? ': ' + detail.slice(0, 300) : '.'));
  }
  const value = response.result;
  if (!value.objectId) {
    const primitive = value.value ?? value.unserializableValue ?? null;
    return {
      result: typeof primitive === 'string' ? primitive.slice(0, MAX_TEXT) : primitive,
      truncated: typeof primitive === 'string' && primitive.length > MAX_TEXT,
    };
  }
  try {
    const bounded = await send('Runtime.callFunctionOn', {
      objectId: value.objectId,
      functionDeclaration: `function() { try { const text = JSON.stringify(this); return { text: String(text).slice(0, ${MAX_TEXT}), truncated: String(text).length > ${MAX_TEXT} }; } catch { return { text: "[Unserializable result]", truncated: false }; } }`,
      returnByValue: true,
    });
    const result = bounded.result.value;
    if (result.truncated) return { result: result.text, truncated: true };
    try {
      return { result: JSON.parse(result.text), truncated: false };
    } catch {
      return { result: result.text, truncated: false };
    }
  } finally {
    Promise.resolve(send('Runtime.releaseObject', { objectId: value.objectId })).catch(() => {});
  }
}
