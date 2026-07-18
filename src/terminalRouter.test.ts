import assert from 'assert';
import test from 'node:test';
import type { WebSocket } from 'ws';
import { nodesManager } from './nodes/manager';
import { attachTerminalClient, closeTerminal, createTerminal, detachTerminalClient, resizeTerminal, resolveTerminalControlRequest, writeTerminalInput } from './terminalRouter';

test('terminal router proxies lifecycle and stream events to a capable remote node', async () => {
  const nodeId = `pty-router-${Date.now()}`;
  const terminalId = `term_remote_${Date.now()}`;
  const commands: any[] = [];
  let terminal: any = null;
  const socket = {
    send(raw: string) {
      const message = JSON.parse(raw);
      if (message.type === 'node_service_command') {
        commands.push(message);
        return;
      }
      if (message.type !== 'node_service_request') return;
      let result: any;
      if (message.operation === 'create') {
        terminal = { id: terminalId, nodeId: '', shell: '/bin/bash', cwd: message.args.cwd, cols: 100, rows: 30, createdAt: Date.now(), pid: 123 };
        result = { terminal };
      } else if (message.operation === 'list') result = { terminals: terminal ? [terminal] : [] };
      else if (message.operation === 'attach') result = { terminal, backlog: 'remote backlog' };
      else if (message.operation === 'close') { terminal = null; result = { success: true }; }
      else result = { terminal };
      queueMicrotask(() => nodesManager.handleNodeServiceResponse(nodeId, message.requestId, result));
    },
    close() {},
  } as unknown as WebSocket;
  nodesManager.registerNodeWithTools(socket, {} as any, 'cli-node', { tools: [], services: { 'vscode-pty': 1 } }, nodeId);

  const sent: any[] = [];
  const client = {
    readyState: 1,
    send(raw: string) { sent.push(JSON.parse(raw)); },
    close() {},
  } as unknown as WebSocket;

  try {
    const created = await createTerminal({ nodeId, cwd: '/workspace' });
    assert.equal(created.nodeId, nodeId);
    assert.equal(created.cwd, '/workspace');

    const attached = await attachTerminalClient(created.id, client, { codeControl: true });
    assert.equal(attached.backlog, 'remote backlog');
    nodesManager.handleNodeServiceEvent(nodeId, 'vscode-pty', { type: 'output', terminalId, data: 'live output' });
    assert.deepEqual(sent, [{ type: 'output', data: 'live output' }]);

    writeTerminalInput(created.id, 'pwd\r');
    resizeTerminal(created.id, 132, 44);
    assert.deepEqual(commands.map((command) => command.operation), ['input', 'resize']);
    assert.equal(commands[0].args.data, 'pwd\r');

    nodesManager.handleNodeServiceEvent(nodeId, 'vscode-pty', {
      type: 'code-request',
      terminalId,
      requestId: 'code-request-1',
      request: { kind: 'openFile', path: '/workspace/index.ts' },
    });
    assert.deepEqual(sent.at(-1), {
      type: 'control',
      requestId: 'code-request-1',
      command: 'open',
      request: { kind: 'openFile', path: '/workspace/index.ts', nodeId },
    });
    resolveTerminalControlRequest(created.id, client, {
      type: 'control-result',
      requestId: 'code-request-1',
      ok: true,
      message: 'Opened index.ts',
    });
    assert.equal(commands.at(-1).operation, 'code-result');
    assert.equal(commands.at(-1).args.message, 'Opened index.ts');

    detachTerminalClient(created.id, client);
    assert.equal(commands.at(-1).operation, 'detach');
    await closeTerminal(created.id, 'test');
  } finally {
    nodesManager.unregisterNode(nodeId, socket);
  }
});

test('terminal router rejects a connected node that does not advertise vscode-pty', async () => {
  const nodeId = `pty-unsupported-${Date.now()}`;
  const socket = { send() {}, close() {} } as unknown as WebSocket;
  nodesManager.registerNodeWithTools(socket, {} as any, 'cli-node', { tools: [], services: { 'vscode-fs': 1 } }, nodeId);
  try {
    await assert.rejects(
      createTerminal({ nodeId, cwd: '/workspace' }),
      /does not advertise service `vscode-pty`/,
    );
  } finally {
    nodesManager.unregisterNode(nodeId, socket);
  }
});
