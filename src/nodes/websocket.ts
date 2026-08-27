import http from 'http';
import { RawData, WebSocket } from 'ws';
import { HttpServer } from '../httpServer';
import { nodesManager } from './manager';
import { logger } from '../common';
import {
  attachPendingPairingSocket,
  authenticateApprovedNode,
  claimApprovedPairing,
  createPendingPairing,
  detachPendingPairingSocket,
  listPendingPairings,
  touchApprovedNode,
} from './registry';
import {
  CURRENT_NODE_PROTOCOL_RANGE,
  describeNodeProtocolCompatibility,
  negotiateNodeProtocol,
  resolveAdvertisedNodeProtocol,
} from '../../packages/shared/dist/nodeProtocol';

function rawDataToString(message: RawData): string {
  if (typeof message === 'string') {
    return message;
  }
  if (message instanceof ArrayBuffer) {
    return Buffer.from(message).toString();
  }
  if (Array.isArray(message)) {
    return Buffer.concat(message.map(chunk => {
      if (typeof chunk === 'string') return Buffer.from(chunk);
      if (chunk instanceof ArrayBuffer) return Buffer.from(chunk);
      return Buffer.from(chunk);
    })).toString();
  }
  return Buffer.from(message).toString();
}

const NODE_HEARTBEAT_INTERVAL_MS = 30_000;
const NODE_HEARTBEAT_TIMEOUT_MS = 10_000;


function setupNodeHeartbeat(ws: WebSocket, params: {
  getRegisteredNodeId: () => string | null;
  getAuthenticatedNodeId: () => string | null;
  getPendingPairingId: () => string | null;
}): () => void {
  let awaitingPong = false;
  let lastPingAt = 0;

  const markAlive = () => {
    awaitingPong = false;
    const registeredNodeId = params.getRegisteredNodeId();
    if (registeredNodeId) {
      nodesManager.updateNodeActivity(registeredNodeId);
    }
    const authenticatedNodeId = params.getAuthenticatedNodeId();
    if (authenticatedNodeId) {
      void touchApprovedNode(authenticatedNodeId, { lastSeenAt: Date.now() }).catch((err) => {
        logger.warn({ err, nodeId: authenticatedNodeId }, 'Failed to record node heartbeat activity');
      });
    }
  };

  ws.on('pong', markAlive);

  const timer = setInterval(() => {
    if (ws.readyState !== WebSocket.OPEN) {
      return;
    }
    if (awaitingPong && Date.now() - lastPingAt >= NODE_HEARTBEAT_TIMEOUT_MS) {
      logger.warn({
        nodeId: params.getRegisteredNodeId() || params.getAuthenticatedNodeId(),
        pendingPairingId: params.getPendingPairingId(),
      }, 'Node heartbeat timed out; terminating stale WebSocket');
      ws.terminate();
      return;
    }
    awaitingPong = true;
    lastPingAt = Date.now();
    try {
      ws.ping();
    } catch (err) {
      logger.warn({ err, nodeId: params.getRegisteredNodeId() || params.getAuthenticatedNodeId() }, 'Failed to send node heartbeat ping');
    }
  }, NODE_HEARTBEAT_INTERVAL_MS);
  timer.unref?.();

  return () => clearInterval(timer);
}

export function registerNodeWebSocket(httpServer: HttpServer, nodeToken: string): void {
  httpServer.addWebSocket('/node_ws', async (ws: WebSocket, req: http.IncomingMessage) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const providedPairToken = url.searchParams.get('token');
    const providedNodeId = url.searchParams.get('id');
    const providedAuthToken = url.searchParams.get('auth');

    const pairingMode = !!providedPairToken && !providedAuthToken && !providedNodeId;
    const approvedMode = !!providedNodeId && !!providedAuthToken;

    if (!pairingMode && !approvedMode) {
      logger.warn({ url: req.url }, 'Node connection rejected: expected pairing token or approved node credentials');
      ws.close(1008, 'Expected pairing token or approved node credentials');
      return;
    }

    if (pairingMode && providedPairToken !== nodeToken) {
      logger.warn({ url: req.url }, 'Node connection rejected: invalid pairing token');
      ws.close(1008, 'Invalid pairing token');
      return;
    }

    let nodeId: string | null = null;
    let pendingPairingId: string | null = null;
    let nodeRegistered = false;
    let authenticatedNodeId: string | null = null;
    let protocolState: 'pending' | 'compatible' | 'upgrade-required' = 'pending';
    let readyForMessages = false;
    const pendingMessages: string[] = [];
    const stopHeartbeat = setupNodeHeartbeat(ws, {
      getRegisteredNodeId: () => nodeId,
      getAuthenticatedNodeId: () => authenticatedNodeId,
      getPendingPairingId: () => pendingPairingId,
    });

    const processNodeMessage = async (messageText: string) => {
      const data = JSON.parse(messageText);

      if (protocolState === 'upgrade-required') {
        const error = 'Node protocol is incompatible; update and restart this Node before sending application messages.';
        ws.send(JSON.stringify({ type: 'error', code: 'NODE_PROTOCOL_INCOMPATIBLE', ...(data?.requestId ? { requestId: data.requestId } : {}), error }));
        return;
      }

      if (pairingMode) {
        if (data.type !== 'pair_request') {
          ws.send(JSON.stringify({
            type: 'error',
            error: 'Pairing connection only accepts pair_request'
          }));
          return;
        }

        if (pendingPairingId) {
          ws.send(JSON.stringify({
            type: 'error',
            error: 'Pair request already sent for this connection'
          }));
          return;
        }

        const { nodeType, capabilities, requestedName } = data;
        if (!nodeType || !capabilities || !Array.isArray(capabilities.tools)) {
          ws.send(JSON.stringify({
            type: 'error',
            error: 'Invalid pair_request message: missing nodeType or capabilities.tools'
          }));
          return;
        }

        // Check if there's an existing approved-but-undelivered pending for this client
        const existingPendings = await listPendingPairings();
        const approvedPending = existingPendings.find(p =>
          p.approvedNodeId && p.approvedAuthToken &&
          p.nodeType === nodeType && p.requestedName === requestedName
        );

        if (approvedPending) {
          const claimed = await claimApprovedPairing(approvedPending.id);
          if (claimed) {
            logger.info({ nodeId: claimed.nodeId, pendingId: approvedPending.id }, 'Delivering previously approved pairing');
            ws.send(JSON.stringify({
              type: 'pair_approved',
              pendingId: approvedPending.id,
              nodeId: claimed.nodeId,
              authToken: claimed.authToken,
            }));
            try {
              ws.close(1000, 'Pairing approved; reconnect with node credentials');
            } catch {}
            return;
          }
        }

        let advertisedProtocol;
        try { advertisedProtocol = resolveAdvertisedNodeProtocol(data.nodeProtocol); }
        catch (error: any) {
          ws.send(JSON.stringify({ type: 'error', code: 'NODE_PROTOCOL_INVALID', error: error?.message || String(error) }));
          return;
        }
        const pending = await createPendingPairing({
          nodeType,
          capabilities,
          requestedName,
          nodeProtocol: advertisedProtocol.range,
          legacyProtocol: advertisedProtocol.legacy,
        });
        pendingPairingId = pending.id;
        attachPendingPairingSocket(pending.id, ws);

        ws.send(JSON.stringify({
          type: 'pair_pending',
          pendingId: pending.id,
          pairCode: pending.pairCode,
          requestedName: pending.requestedName,
          nodeType: pending.nodeType,
        }));
        return;
      }

      if (!nodeRegistered && data.type !== 'node_register') {
        ws.send(JSON.stringify({
          type: 'error',
          code: 'NODE_PROTOCOL_NEGOTIATION_REQUIRED',
          ...(data?.requestId ? { requestId: data.requestId } : {}),
          error: 'Authenticated Node must complete core protocol registration before application messages.',
        }));
        return;
      }

      switch (data.type) {
        case 'node_register': {
          if (nodeRegistered) {
            logger.warn({ nodeId }, 'Node already registered, ignoring duplicate registration');
            break;
          }

          const { nodeType, capabilities } = data;
          if (!nodeType || !capabilities || !capabilities.tools) {
            ws.send(JSON.stringify({
              type: 'error',
              error: 'Invalid node_register message: missing nodeType or capabilities.tools'
            }));
            break;
          }

          let advertisedProtocol;
          try { advertisedProtocol = resolveAdvertisedNodeProtocol(data.nodeProtocol); }
          catch (error: any) {
            const message = error?.message || String(error);
            ws.send(JSON.stringify({ type: 'error', code: 'NODE_PROTOCOL_INVALID', error: message }));
            logger.warn({ nodeId: authenticatedNodeId, err: error }, 'Rejected malformed Node protocol offer');
            break;
          }
          const protocolCompatibility = negotiateNodeProtocol(
            advertisedProtocol.range,
            CURRENT_NODE_PROTOCOL_RANGE,
            advertisedProtocol.legacy,
          );
          if (authenticatedNodeId) {
            await touchApprovedNode(authenticatedNodeId, {
              nodeType,
              capabilities,
              lastSeenAt: Date.now(),
              nodeProtocol: protocolCompatibility.client,
              protocolCompatibility,
            });
          }
          if (protocolCompatibility.status === 'compatible') {
            nodeId = nodesManager.registerNodeWithTools(
              ws,
              req,
              nodeType,
              capabilities,
              authenticatedNodeId || undefined,
              protocolCompatibility,
            );
            protocolState = 'compatible';
          } else {
            nodeId = nodesManager.registerIncompatibleNodeWithTools(
              ws,
              req,
              nodeType,
              capabilities,
              protocolCompatibility,
              authenticatedNodeId || undefined,
            );
            protocolState = 'upgrade-required';
            logger.warn({ nodeId, protocolCompatibility }, describeNodeProtocolCompatibility(protocolCompatibility));
          }
          nodeRegistered = true;
          break;
        }
        case 'tool_call_response':
          nodesManager.handleToolResponse(data.callId, data.result);
          break;
        case 'tool_call_error':
          nodesManager.handleToolError(data.callId, data.error);
          break;
        case 'file_read_response':
          nodesManager.handleFileReadResponse(data.transferId, data.file);
          break;
        case 'file_write_response':
          nodesManager.handleFileWriteResponse(data.transferId, data.result);
          break;
        case 'file_transfer_error':
          nodesManager.handleFileTransferError(data.transferId, data.error);
          break;
        case 'node_service_response':
          nodesManager.handleNodeServiceResponse(nodeId || authenticatedNodeId || 'unknown-node', String(data.requestId || ''), data.result);
          break;
        case 'node_service_error':
          nodesManager.handleNodeServiceError(nodeId || authenticatedNodeId || 'unknown-node', String(data.requestId || ''), data.error || 'Node service failed.');
          break;
        case 'node_service_event':
          nodesManager.handleNodeServiceEvent(nodeId || authenticatedNodeId || 'unknown-node', String(data.service || ''), data.event);
          break;
        case 'session_event':
          if (!data.sessionId || typeof data.message !== 'string') {
            ws.send(JSON.stringify({
              type: 'error',
              requestId: data.requestId,
              error: 'Invalid session_event message: missing sessionId or message'
            }));
            break;
          }
          try {
            await nodesManager.handleSessionEvent(
              nodeId || authenticatedNodeId || 'unknown-node',
              String(data.sessionId),
              data.message,
              data.eventType === 'trigger' || data.eventType === 'onboot' ? data.eventType : 'background',
              {
                eventId: typeof data.eventId === 'string' ? data.eventId : undefined,
                execId: typeof data.execId === 'string' ? data.execId : undefined,
                completionCapability: typeof data.completionCapability === 'string' ? data.completionCapability : undefined,
                eventTimestamp: typeof data.eventTimestamp === 'number' ? data.eventTimestamp : undefined,
              },
            );
            if (data.requestId) {
              ws.send(JSON.stringify({ type: 'session_event_accepted', requestId: data.requestId }));
            }
          } catch (error: any) {
            if (!data.requestId) throw error;
            ws.send(JSON.stringify({
              type: 'error',
              requestId: data.requestId,
              error: error?.message || String(error),
            }));
          }
          break;
        case 'session_list_request': {
          const requestId = String(data.requestId || '');
          try {
            const sessions = await nodesManager.listSessionsForNode(nodeId || authenticatedNodeId || 'unknown-node');
            ws.send(JSON.stringify({ type: 'cli_response', requestId, ok: true, result: { sessions } }));
          } catch (err: any) {
            ws.send(JSON.stringify({ type: 'cli_response', requestId, ok: false, error: err?.message || String(err) }));
          }
          break;
        }
        case 'session_history_request': {
          const requestId = String(data.requestId || '');
          try {
            const result = await nodesManager.getSessionHistoryForNode(
              nodeId || authenticatedNodeId || 'unknown-node',
              String(data.sessionId || ''),
              typeof data.count === 'number' ? data.count : 30
            );
            ws.send(JSON.stringify({ type: 'cli_response', requestId, ok: true, result }));
          } catch (err: any) {
            ws.send(JSON.stringify({ type: 'cli_response', requestId, ok: false, error: err?.message || String(err) }));
          }
          break;
        }
        case 'session_send_message': {
          const requestId = String(data.requestId || '');
          if (!data.sessionId || typeof data.message !== 'string') {
            ws.send(JSON.stringify({ type: 'cli_response', requestId, ok: false, error: 'Invalid session_send_message: missing sessionId or message' }));
            break;
          }
          try {
            await nodesManager.handleSessionUserMessage(
              nodeId || authenticatedNodeId || 'unknown-node',
              String(data.sessionId),
              data.message,
              data.eventType === 'background' || data.eventType === 'onboot' ? data.eventType : 'trigger'
            );
            ws.send(JSON.stringify({ type: 'cli_response', requestId, ok: true, result: { accepted: true } }));
          } catch (err: any) {
            ws.send(JSON.stringify({ type: 'cli_response', requestId, ok: false, error: err?.message || String(err) }));
          }
          break;
        }
        case 'list_nodes': {
          const nodes = nodesManager.listNodes();
          ws.send(JSON.stringify({ type: 'nodes_list', nodes }));
          break;
        }
        case 'tool_definition': {
          const definition = nodesManager.getToolDefinition(data.tool);
          ws.send(JSON.stringify({ type: 'tool_definition', tool: data.tool, definition }));
          break;
        }
        default:
          logger.warn({ type: data.type }, 'Unknown message type from node');
      }

      if (nodeId) {
        nodesManager.updateNodeActivity(nodeId);
      }
    };

    ws.on('message', async (message: RawData) => {
      const messageText = rawDataToString(message);
      const activeNodeId = nodeId || authenticatedNodeId;
      if (activeNodeId) {
        nodesManager.updateNodeActivity(activeNodeId);
      }
      if (authenticatedNodeId) {
        void touchApprovedNode(authenticatedNodeId, { lastSeenAt: Date.now() }).catch((err) => {
          logger.warn({ err, nodeId: authenticatedNodeId }, 'Failed to update node activity from message');
        });
      }
      if (!readyForMessages) {
        pendingMessages.push(messageText);
        return;
      }

      try {
        await processNodeMessage(messageText);
      } catch (e) {
        logger.error({ err: e, nodeId, pendingPairingId }, 'Error processing node message');
      }
    });

    logger.info({ mode: pairingMode ? 'pairing' : 'approved', nodeId: authenticatedNodeId }, 'Node connecting via WebSocket');

    if (approvedMode) {
      const approved = await authenticateApprovedNode(String(providedNodeId), String(providedAuthToken));
      if (!approved) {
        logger.warn({ url: req.url, nodeId: providedNodeId }, 'Node connection rejected: invalid node credentials');
        ws.close(1008, 'Invalid node credentials');
        return;
      }
      authenticatedNodeId = approved.nodeId;
    }

    readyForMessages = true;
    for (const queuedMessage of pendingMessages.splice(0)) {
      try {
        await processNodeMessage(queuedMessage);
      } catch (e) {
        logger.error({ err: e, nodeId, pendingPairingId }, 'Error processing queued node message');
      }
    }

    ws.on('close', () => {
      stopHeartbeat();
      if (pendingPairingId) {
        detachPendingPairingSocket(pendingPairingId);
      }
      if (nodeId) {
        logger.info({ nodeId }, 'Node disconnected');
        nodesManager.unregisterNode(nodeId, ws);
      }
    });

    ws.on('error', (err: Error) => {
      stopHeartbeat();
      if (pendingPairingId) {
        detachPendingPairingSocket(pendingPairingId);
      }
      if (nodeId) {
        logger.error({ err, nodeId }, 'Node WebSocket error');
        nodesManager.unregisterNode(nodeId, ws);
      }
    });
  });
}
