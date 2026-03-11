import http from 'http';
import { WebSocket } from 'ws';
import { HttpServer } from './httpServer';
import { nodesManager } from './nodesManager';
import { logger } from './common';

export function registerNodeWebSocket(httpServer: HttpServer, nodeToken: string): void {
  httpServer.addWebSocket('/node_ws', async (ws: WebSocket, req: http.IncomingMessage) => {
    const url = new URL(req.url || '', `http://${req.headers.host}`);
    const providedToken = url.searchParams.get('token');
    const customNodeId = url.searchParams.get('id');

    if (providedToken !== nodeToken) {
      logger.warn({ url: req.url }, 'Node connection rejected: invalid token');
      ws.close(1008, 'Invalid token');
      return;
    }

    let nodeId: string | null = null;
    let nodeRegistered = false;

    logger.info('Node connecting via WebSocket');

    ws.on('message', async (message: Buffer) => {
      try {
        const data = JSON.parse(message.toString());

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
              customNodeId || undefined
            );
            nodeRegistered = true;
            break;
          }
          case 'tool_call_response':
            nodesManager.handleToolResponse(data.callId, data.result);
            break;
          case 'tool_call_error':
            nodesManager.handleToolError(data.callId, data.error);
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
      } catch (e) {
        logger.error({ err: e, nodeId }, 'Error processing node message');
      }
    });

    ws.on('close', () => {
      if (nodeId) {
        logger.info({ nodeId }, 'Node disconnected');
        nodesManager.unregisterNode(nodeId);
      }
    });

    ws.on('error', (err: Error) => {
      if (nodeId) {
        logger.error({ err, nodeId }, 'Node WebSocket error');
        nodesManager.unregisterNode(nodeId);
      }
    });
  });
}
