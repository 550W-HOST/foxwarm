import assert from 'node:assert/strict';
import { test } from 'node:test';
import { TOOL_NAMES, toolDefinitions, validateArgs } from '../../browser-node/background/contract.js';

const headless = { variant: 'headless', windowed: false, keys: true, fullPage: true };
const chrome = { variant: 'chrome', windowed: true, keys: true, fullPage: false };
const firefox = { variant: 'firefox', windowed: true, keys: false, fullPage: false };

test('every tool has a strict schema and no generic parameter bag', () => {
  for (const profile of [headless, chrome, firefox])
    for (const tool of toolDefinitions(profile)) {
      assert.match(tool.name, /^browser_[a-z]+$/);
      assert.equal(tool.parameters.additionalProperties, false);
      assert.ok(!('params' in tool.parameters.properties) && !('action' in tool.parameters.properties));
      for (const required of tool.parameters.required) assert.ok(required in tool.parameters.properties);
    }
});

test('capability differences are omitted tools or parameters, never different names', () => {
  const names = (profile) => toolDefinitions(profile).map((tool) => tool.name);
  assert.deepEqual(names(headless), TOOL_NAMES);
  assert.deepEqual(names(chrome), TOOL_NAMES);
  assert.deepEqual(names(firefox), TOOL_NAMES.filter((name) => !['browser_type', 'browser_press'].includes(name)));
  const open = (profile) => toolDefinitions(profile).find((tool) => tool.name === 'browser_open').parameters;
  assert.ok(!('windowId' in open(headless).properties));
  assert.deepEqual(open(chrome).required, ['url', 'windowId']);
});

test('arguments are validated against the schema and cross-field rules', () => {
  const v = (name, args, profile = headless) => validateArgs(name, args, profile);
  assert.throws(() => v('browser_read', { tabId: 1, extra: true }), /Unknown argument/);
  assert.throws(() => v('browser_read', {}), /tabId is required/);
  assert.throws(() => v('browser_read', { tabId: '1' }), /integer/);
  assert.throws(() => v('browser_read', { tabId: 1, format: 'pdf' }), /one of/);
  assert.throws(() => v('browser_click', { tabId: 1 }), /element or screenshot coordinates/);
  assert.throws(() => v('browser_click', { tabId: 1, ref: 'a', selector: 'b' }), /not both/);
  assert.throws(() => v('browser_click', { tabId: 1, x: 1, y: 1 }), /pageId/);
  assert.throws(() => v('browser_fill', { tabId: 1, text: 'x' }), /ref or selector/);
  assert.throws(() => v('browser_navigate', { tabId: 1 }), /url or history/);
  assert.throws(() => v('browser_navigate', { tabId: 1, url: 'https://a.test/', history: 'back' }), /url or history/);
  assert.throws(() => v('browser_navigate', { tabId: 1, url: 'ftp://a.test/' }), /Only HTTP/);
  assert.throws(() => v('browser_wait', { tabId: 1, condition: 'element' }), /selector/);
  assert.throws(() => v('browser_wait', { tabId: 1, condition: 'url', url: 'x', timeoutMs: 600000 }), /above/);
  assert.throws(() => v('browser_open', { url: 'https://a.test/' }, chrome), /windowId is required/);
  assert.throws(() => v('browser_type', { tabId: 1, text: 'x' }, firefox), /unsupported/);
  assert.equal(v('browser_open', { url: 'HTTPS://A.test' }).url, 'https://a.test/');
  assert.deepEqual(v('browser_read', { tabId: 1, format: null }), { tabId: 1 });
});
