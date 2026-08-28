/**
 * WebSocket connection manager — handles pairing, auth, reconnect, heartbeat
 */

import * as storage from './storage.js';
import { TOOL_DEFINITIONS, TOOL_HANDLERS } from './tools.js';

const HEARTBEAT_INTERVAL_MS = 25000;
const HEARTBEAT_TIMEOUT_MS = 10000;
const RECONNECT_DELAY_MS = 5000;
const NODE_TYPE = 'browser-extension';
const NODE_PROTOCOL = Object.freeze({ min: 2, max: 2 });

let ws = null;
let heartbeatTimer = null;
let heartbeatAwaitingPong = false;
let heartbeatLastPingAt = 0;
let reconnectTimer = null;
let forceImmediateReconnect = false;
let connectionState = 'disconnected'; // disconnected, connecting, connected, pairing, registered
let pairingRejected = false;
let protocolIncompatible = false;
let currentNodeId = null;
let manualDisconnect = false;
let stateChangeCallback = null;

export function onStateChange(cb) {
  stateChangeCallback = cb;
}

function setState(state, detail = {}) {
  connectionState = state;
  // Notify callback
  if (stateChangeCallback) {
    try { stateChangeCallback(state, detail); } catch {}
  }
  // Broadcast to popup
  chrome.runtime.sendMessage({
    type: 'connection_state',
    state,
    detail,
  }).catch(() => { /* popup not open */ });
}

export function getState() {
  return { state: connectionState, nodeId: currentNodeId };
}

function stopHeartbeat() {
  if (heartbeatTimer) {
    clearInterval(heartbeatTimer);
    heartbeatTimer = null;
  }
  heartbeatAwaitingPong = false;
}

function startHeartbeat() {
  stopHeartbeat();
  heartbeatTimer = setInterval(() => {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;

    if (heartbeatAwaitingPong && Date.now() - heartbeatLastPingAt >= HEARTBEAT_TIMEOUT_MS) {
      console.warn('[foxwarm-node] Heartbeat timeout, closing connection');
      ws.close();
      return;
    }

    // WebSocket API in service workers doesn't have ping/pong frames.
    // We send a JSON ping message instead and expect a pong from the server.
    // Actually, the server uses WS-level ping/pong which the browser handles automatically.
    // The browser's WebSocket will respond to server pings automatically.
    // For client-side keepalive, we just send a small message.
    heartbeatAwaitingPong = true;
    heartbeatLastPingAt = Date.now();
    try {
      // Send a lightweight keepalive. The server's heartbeat (ping frames) is the primary mechanism.
      // We just need to detect if the connection is dead from our side.
      ws.send(JSON.stringify({ type: 'ping' }));
    } catch (e) {
      console.warn('[foxwarm-node] Failed to send heartbeat:', e);
    }
  }, HEARTBEAT_INTERVAL_MS);
}

function scheduleReconnect() {
  if (reconnectTimer || manualDisconnect) return;

  const delay = forceImmediateReconnect ? 250 : RECONNECT_DELAY_MS;
  forceImmediateReconnect = false;

  console.log(`[foxwarm-node] Reconnecting in ${delay}ms...`);
  setState('reconnecting', { delay });

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    connect().catch(err => {
      console.error('[foxwarm-node] Reconnect failed:', err);
      scheduleReconnect();
    });
  }, delay);
}

async function handleMessage(data) {
  // Any message from server means connection is alive
  heartbeatAwaitingPong = false;

  switch (data.type) {
    case 'registered':
      if (!data.nodeProtocol?.master
        || !Number.isInteger(data.nodeProtocol.master.min)
        || !Number.isInteger(data.nodeProtocol.master.max)
        || data.nodeProtocol.master.min > NODE_PROTOCOL.max
        || data.nodeProtocol.master.max < NODE_PROTOCOL.min
        || !Number.isInteger(data.nodeProtocol.negotiated)
        || data.nodeProtocol.negotiated < NODE_PROTOCOL.min
        || data.nodeProtocol.negotiated > NODE_PROTOCOL.max) {
        protocolIncompatible = true;
        console.error('[foxwarm-node] Master Node protocol is incompatible; update Master or this extension');
        setState('protocol_incompatible', { nodeId: data.nodeId, nodeProtocol: data.nodeProtocol });
        ws?.close(1008, 'Master Node protocol incompatible');
        break;
      }
      protocolIncompatible = false;
      console.log(`[foxwarm-node] Registered as ${data.nodeId}`);
      currentNodeId = data.nodeId;
      setState('registered', { nodeId: data.nodeId });
      break;

    case 'node_incompatible':
      protocolIncompatible = true;
      console.error('[foxwarm-node] Node protocol is incompatible:', data.message);
      setState('protocol_incompatible', data);
      break;

    case 'pair_pending':
      console.log(`[foxwarm-node] Pairing pending: ${data.pairCode}`);
      setState('pair_pending', { pendingId: data.pendingId, pairCode: data.pairCode });
      break;

    case 'pair_approved':
      console.log(`[foxwarm-node] Pairing approved: ${data.nodeId}`);
      await storage.saveCredentials(String(data.nodeId), String(data.authToken));
      currentNodeId = String(data.nodeId);
      setState('pair_approved', { nodeId: data.nodeId });
      forceImmediateReconnect = true;
      ws?.close(1000, 'Reconnect with credentials');
      break;

    case 'pair_rejected':
      console.warn(`[foxwarm-node] Pairing rejected:`, data.reason);
      pairingRejected = true;
      setState('pair_rejected', { reason: data.reason });
      break;

    case 'tool_call':
      await handleToolCall(data);
      break;

    case 'pong':
      // Server responded to our ping
      heartbeatAwaitingPong = false;
      break;

    case 'error':
      console.error(`[foxwarm-node] Server error:`, data.error);
      break;

    default:
      console.warn(`[foxwarm-node] Unknown message type:`, data.type);
  }
}

async function handleToolCall(message) {
  const { callId, tool, args } = message;
  console.log(`[foxwarm-node] Tool call: ${tool} (${callId})`);

  try {
    const handler = TOOL_HANDLERS[tool];
    if (!handler) {
      throw new Error(`Unknown tool: ${tool}`);
    }

    const result = await handler(args || {});
    send({
      type: 'tool_call_response',
      callId,
      result: normalizeResult(result),
    });
    console.log(`[foxwarm-node] Tool ${tool} completed (${callId})`);
  } catch (e) {
    console.error(`[foxwarm-node] Tool ${tool} failed:`, e);
    send({
      type: 'tool_call_error',
      callId,
      error: e.message || String(e),
    });
  }
}

function normalizeResult(raw) {
  if (raw === undefined) return { output: '(No output)' };
  if (raw === null) return { output: null };
  if (typeof raw === 'string' || typeof raw === 'number' || typeof raw === 'boolean') {
    return { output: raw };
  }
  if (typeof raw === 'object') return raw;
  return { output: String(raw) };
}

function send(data) {
  if (ws && ws.readyState === WebSocket.OPEN) {
    ws.send(JSON.stringify(data));
  } else {
    console.warn('[foxwarm-node] Cannot send: WebSocket not connected');
  }
}

export async function connect() {
  const conn = await storage.getConnection();

  if (!conn.host) {
    throw new Error('No host configured');
  }

  const hasCredentials = conn.nodeId && conn.authToken;
  const hasPairingToken = !!conn.pairingToken;

  if (!hasCredentials && !hasPairingToken) {
    throw new Error('No credentials or pairing token');
  }

  // Close existing connection
  if (ws) {
    ws.close();
    ws = null;
  }

  manualDisconnect = false;
  pairingRejected = false;

  const isAuthMode = hasCredentials;
  const wsHost = conn.host.replace(/\/$/, '').replace(/^http/, 'ws');
  const wsUrl = isAuthMode
    ? `${wsHost}/node_ws?id=${encodeURIComponent(conn.nodeId)}&auth=${encodeURIComponent(conn.authToken)}`
    : `${wsHost}/node_ws?token=${encodeURIComponent(conn.pairingToken)}`;

  console.log(`[foxwarm-node] Connecting (${isAuthMode ? 'auth' : 'pairing'})...`);
  setState('connecting', { mode: isAuthMode ? 'authenticated' : 'pairing' });

  const capabilities = { tools: TOOL_DEFINITIONS };

  ws = new WebSocket(wsUrl);

  ws.onopen = () => {
    console.log('[foxwarm-node] Connected');
    setState('connected', { mode: isAuthMode ? 'authenticated' : 'pairing' });

    if (reconnectTimer) {
      clearTimeout(reconnectTimer);
      reconnectTimer = null;
    }

    startHeartbeat();

    if (isAuthMode) {
      send({
        type: 'node_register',
        nodeType: NODE_TYPE,
        capabilities,
        nodeProtocol: NODE_PROTOCOL,
      });
    } else {
      send({
        type: 'pair_request',
        requestedName: conn.nodeName || 'browser-ext',
        nodeType: NODE_TYPE,
        capabilities,
        nodeProtocol: NODE_PROTOCOL,
      });
    }
  };

  ws.onmessage = async (event) => {
    try {
      const data = JSON.parse(event.data);
      await handleMessage(data);
    } catch (e) {
      console.error('[foxwarm-node] Error handling message:', e);
    }
  };

  ws.onclose = async (event) => {
    stopHeartbeat();
    console.warn(`[foxwarm-node] Disconnected: code=${event.code} reason=${event.reason}`);
    setState('disconnected', { code: event.code, reason: event.reason });

    if (pairingRejected) {
      console.warn('[foxwarm-node] Pairing rejected, not reconnecting');
      return;
    }
    if (protocolIncompatible) {
      console.error('[foxwarm-node] Protocol incompatible, not reconnecting until the extension is updated/reloaded');
      return;
    }

    // If auth failed and we have a pairing token, clear credentials and retry
    if (event.code === 1008 && event.reason?.includes('Invalid node credentials') && hasPairingToken) {
      console.warn('[foxwarm-node] Auth failed, clearing credentials for re-pairing');
      await storage.clearCredentials();
    }

    if (!manualDisconnect) {
      scheduleReconnect();
    }
  };

  ws.onerror = (event) => {
    console.error('[foxwarm-node] WebSocket error:', event);
  };
}

export function disconnect() {
  manualDisconnect = true;
  stopHeartbeat();

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  if (ws) {
    ws.close(1000, 'User disconnect');
    ws = null;
  }

  currentNodeId = null;
  setState('disconnected', { manual: true });
}

export async function resetAndDisconnect() {
  disconnect();
  await storage.clearCredentials();
  currentNodeId = null;
}
