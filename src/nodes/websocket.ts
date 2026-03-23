import http from 'http';
import { RawData, WebSocket } from 'ws';
import { HttpServer } from '../httpServer';
import { nodesManager } from './manager';
import { logger } from '../common';
import {
  attachPendingPairingSocket,
  authenticateApprovedNode,
  createPendingPairing,
  detachPendingPairingSocket,
  touchApprovedNode,
} from './registry';

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
    let readyForMessages = false;
    const pendingMessages: string[] = [];

    const processNodeMessage = async (messageText: string) => {
      const data = JSON.parse(messageText);

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

        const pending = await createPendingPairing({
          nodeType,
          capabilities,
          requestedName,
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

          nodeId = nodesManager.registerNodeWithTools(
            ws,
            req,
            nodeType,
            capabilities,
            authenticatedNodeId || undefined
          );
          if (authenticatedNodeId) {
            await touchApprovedNode(authenticatedNodeId, {
              nodeType,
              capabilities,
              lastSeenAt: Date.now(),
            });
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
        case 'session_event':
          if (!data.sessionId || typeof data.message !== 'string') {
            ws.send(JSON.stringify({
              type: 'error',
              error: 'Invalid session_event message: missing sessionId or message'
            }));
            break;
          }
          await nodesManager.handleSessionEvent(
            nodeId || authenticatedNodeId || 'unknown-node',
            String(data.sessionId),
            data.message,
            data.eventType === 'trigger' || data.eventType === 'onboot' ? data.eventType : 'background'
          );
          break;
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
      if (pendingPairingId) {
        detachPendingPairingSocket(pendingPairingId);
      }
      if (nodeId) {
        logger.info({ nodeId }, 'Node disconnected');
        nodesManager.unregisterNode(nodeId, ws);
      }
    });

    ws.on('error', (err: Error) => {
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
