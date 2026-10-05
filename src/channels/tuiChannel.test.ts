import assert from 'node:assert/strict';
import test from 'node:test';
import { TUIChannel } from './tuiChannel';
import * as sessionManager from '../sessionManager';
import * as sessionRuntime from '../sessionRuntime';

test('TUI reports missing default and keeps an available current selection', async () => {
  const originalGetAllSessions = sessionManager.getAllSessions;
  const originalGetSessionByChannel = sessionManager.getSessionByChannel;
  const originalGetSessionCatalog = sessionManager.getSessionCatalog;
  const originalGetSessionRuntimeStatus = sessionRuntime.getSessionRuntimeStatus;
  const items: string[][] = [];
  const selected: number[] = [];
  let chatContent = '';
  const fakeTui = Object.create(TUIChannel.prototype) as any;
  fakeTui.currentSessionId = null;
  fakeTui.currentTab = 'chat';
  fakeTui.inChatMode = false;
  fakeTui.sessionList = {
    setItems: (nextItems: string[]): void => { items.push(nextItems); },
    select: (index: number): void => { selected.push(index); },
  };
  fakeTui.chatLog = { setContent: (content: string) => { chatContent = content; } };
  fakeTui.screen = { render: () => {} };

  try {
    (sessionManager as any).getAllSessions = () => new Map();
    (sessionManager as any).getSessionByChannel = (): undefined => undefined;
    (sessionManager as any).getSessionCatalog = (): undefined => undefined;
    (sessionRuntime as any).getSessionRuntimeStatus = () => ({ ready: false });
    await (fakeTui as any).refreshSessionList();
    assert.equal(items.at(-1)?.length, 0);
    assert.match(chatContent, /No default session is available/);
    assert.deepEqual(selected, []);

    const currentSessionId = `tui_current_${Date.now()}`;
    const otherSessionId = `${currentSessionId}_other`;
    fakeTui.currentSessionId = currentSessionId;
    (sessionManager as any).getAllSessions = () => new Map([
      [otherSessionId, { id: otherSessionId, history: [], meta: {} }],
      [currentSessionId, { id: currentSessionId, history: [], meta: {} }],
    ]);
    await (fakeTui as any).refreshSessionList();
    assert.deepEqual(selected, [1]);
  } finally {
    (sessionManager as any).getAllSessions = originalGetAllSessions;
    (sessionManager as any).getSessionByChannel = originalGetSessionByChannel;
    (sessionManager as any).getSessionCatalog = originalGetSessionCatalog;
    (sessionRuntime as any).getSessionRuntimeStatus = originalGetSessionRuntimeStatus;
  }
});