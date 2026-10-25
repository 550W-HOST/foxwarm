import * as storage from './storage.js';
import { executeTool, TOOL_DEFINITIONS } from './tools.js';
import { cancelConfirmations, resolvePermission } from './permissions.js';
import * as cdp from './cdp.js';
import { NODE_PROTOCOL, resolveMasterNodeProtocol } from './nodeProtocol.js';

let ws,
  heartbeat,
  reconnect,
  generation = 0;
let state = { state: 'disconnected', nodeId: null, pendingId: null };
const activeCalls = new Map();
function publish(next, detail = {}) {
  state = { state: next, nodeId: detail.nodeId || null, pendingId: detail.pendingId || null };
  chrome.runtime.sendMessage({ type: 'connection_state', state: next, detail }).catch(() => {});
}
export function getState() {
  return state;
}
function cancelWork() {
  for (const { controller } of activeCalls.values())
    controller.abort(new Error('Browser connection stopped.'));
  activeCalls.clear();
  cancelConfirmations();
}
export function cancelCalls(predicate) {
  for (const entry of activeCalls.values())
    if (predicate(entry)) entry.controller.abort(new Error('Page or sharing changed.'));
}
export function isNavigating(tabId) {
  return [...activeCalls.values()].some(
    (entry) =>
      entry.tabId === tabId && entry.effect === 'navigation' && !entry.controller.signal.aborted,
  );
}
export async function disconnect() {
  generation++;
  clearTimeout(reconnect);
  clearInterval(heartbeat);
  reconnect = heartbeat = null;
  const previous = ws;
  ws = null;
  previous?.close(1000, 'User stopped');
  cancelWork();
  publish('disconnected');
  await Promise.all([storage.setEnabled(false), cdp.detachAll()]);
}
export async function resetAndDisconnect() {
  await disconnect();
  await storage.forget();
}
cdp.setDetachHandler(() => {
  void disconnect();
});

async function toolCall(socket, message) {
  if (state.state !== 'registered' || socket !== ws) return;
  if (activeCalls.size >= 32) {
    socket.send(
      JSON.stringify({
        type: 'tool_call_error',
        callId: message.callId,
        error: 'Too many pending browser calls.',
      }),
    );
    return;
  }
  const controller = new AbortController();
  const timeout = Math.min(62000, Math.max(1, Number(message.timeoutMs) || 62000));
  const deadline = Date.now() + timeout;
  const invocation = {
    controller,
    tool: message.tool,
    tabId: message.args?.tabId,
    windowId: message.args?.windowId,
  };
  activeCalls.set(message.callId, invocation);
  const timer = setTimeout(
    () => controller.abort(new Error('Browser call deadline expired.')),
    timeout,
  );
  try {
    if (!TOOL_DEFINITIONS.some((tool) => tool.name === message.tool))
      throw new Error('Unknown browser tool.');
    const result = await executeTool(message.tool, message.args || {}, {
      signal: controller.signal,
      deadline,
      sessionId: message.sessionId,
      agentName: message.agentName,
      beginEffect: (effect) => {
        controller.signal.throwIfAborted();
        invocation.effect = effect;
      },
    });
    controller.signal.throwIfAborted();
    if (ws === socket && socket.readyState === WebSocket.OPEN)
      socket.send(JSON.stringify({ type: 'tool_call_response', callId: message.callId, result }));
  } catch (error) {
    // Errors do not contain argument previews or entered values.
    const detail = error.message || 'Browser call canceled.';
    if (ws === socket && socket.readyState === WebSocket.OPEN)
      socket.send(
        JSON.stringify({
          type: 'tool_call_error',
          callId: message.callId,
          error: invocation.effect
            ? detail + ' The requested page effect may have occurred; it was not retried.'
            : detail,
        }),
      );
  } finally {
    clearTimeout(timer);
    activeCalls.delete(message.callId);
    if (invocation.effect === 'navigation') {
      try {
        if ((await resolvePermission(invocation.tabId)) === 'off')
          await cdp.detach(invocation.tabId);
      } catch {
        /* Tab may have closed. */
      }
    }
  }
}
export async function connect() {
  const attempt = ++generation;
  clearTimeout(reconnect);
  clearInterval(heartbeat);
  const conn = await storage.getConnection();
  if (attempt !== generation || !conn.enabled) return;
  if (!conn.host || !((conn.nodeId && conn.authToken) || conn.pairingToken))
    throw new Error('Enter the Main address and pairing token.');
  const previous = ws;
  ws = null;
  previous?.close();
  cancelWork();
  const authenticated = !!(conn.nodeId && conn.authToken);
  const query = authenticated
    ? `id=${encodeURIComponent(conn.nodeId)}&auth=${encodeURIComponent(conn.authToken)}`
    : `token=${encodeURIComponent(conn.pairingToken)}`;
  const socket = new WebSocket(conn.host.replace(/^http/, 'ws') + '/node_ws?' + query);
  ws = socket;
  publish('connecting');
  let awaitingPong = false;
  socket.onopen = () => {
    if (ws !== socket) return;
    publish('connected');
    socket.send(
      JSON.stringify({
        type: authenticated ? 'node_register' : 'pair_request',
        requestedName: conn.nodeName || 'browser',
        nodeType: 'browser-extension',
        nodeProtocol: NODE_PROTOCOL,
        capabilities: { tools: TOOL_DEFINITIONS, features: { toolCallCancellation: true } },
      }),
    );
    heartbeat = setInterval(() => {
      if (ws !== socket) return;
      if (awaitingPong) {
        socket.close();
        return;
      }
      awaitingPong = true;
      socket.send(JSON.stringify({ type: 'ping' }));
    }, 25000);
  };
  socket.onmessage = async (event) => {
    if (ws !== socket || attempt !== generation) return;
    let data;
    try {
      data = JSON.parse(event.data);
      awaitingPong = false;
      switch (data.type) {
        case 'registered':
          resolveMasterNodeProtocol(data.nodeProtocol);
          publish('registered', { nodeId: data.nodeId });
          break;
        case 'pair_pending':
          publish('pair_pending', { pendingId: data.pendingId });
          break;
        case 'pair_approved':
          await storage.saveCredentials(conn.host, String(data.nodeId), String(data.authToken));
          if (socket === ws && attempt === generation) {
            publish('pair_approved', { nodeId: data.nodeId });
            socket.close(1000, 'Use approved credentials');
          }
          break;
        case 'pair_rejected':
        case 'node_incompatible':
          await disconnect();
          publish(data.type === 'pair_rejected' ? 'pair_rejected' : 'protocol_incompatible');
          break;
        case 'tool_call':
          void toolCall(socket, data);
          break;
        case 'tool_call_cancel':
          activeCalls
            .get(data.callId)
            ?.controller.abort(new Error('Session canceled this browser call.'));
          break;
      }
    } catch {
      // A malformed registration or stale pairing cannot enable work or keep reconnecting.
      await disconnect();
      publish('disconnected');
    }
  };
  socket.onclose = async (event) => {
    if (ws !== socket || attempt !== generation) return;
    ws = null;
    clearInterval(heartbeat);
    cancelWork();
    await cdp.detachAll();
    if (attempt !== generation) return;
    if (event.code === 1008) {
      await storage.setEnabled(false);
      publish('disconnected');
      return;
    }
    publish('reconnecting');
    reconnect = setTimeout(() => {
      void connect().catch(() => publish('disconnected'));
    }, 1000);
  };
  socket.onerror = () => {}; // close owns bounded reconnect.
}
