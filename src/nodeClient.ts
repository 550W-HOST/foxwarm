/**
 * Node Client - Connect to foxwarm master and execute tools
 * Usage: npm run node -- --host http://master:3001/ --id my-node --token <token>
 */

import WebSocket from 'ws';
import { logger } from './common';
import * as tools from './tools';
import * as sessionManager from './sessionManager';

interface NodeClientOptions {
  host: string;
  nodeId?: string;
  token: string;
}

class NodeClient {
  private ws: WebSocket | null = null;
  private host: string;
  private nodeId: string;
  private token: string;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectDelay = 5000; // 5 seconds

  constructor(options: NodeClientOptions) {
    this.host = options.host;
    this.nodeId = options.nodeId || `node_${Date.now()}`;
    this.token = options.token;
  }

  async connect(): Promise<void> {
    const wsUrl = this.host.replace(/^http/, 'ws') + `/node_ws?token=${encodeURIComponent(this.token)}&id=${encodeURIComponent(this.nodeId)}`;
    
    logger.info({ host: this.host, nodeId: this.nodeId }, 'Connecting to foxwarm master...');
    
    this.ws = new WebSocket(wsUrl);
    
    this.ws.on('open', () => {
      logger.info({ nodeId: this.nodeId }, 'Connected to foxwarm master');
      
      // Clear reconnect timer
      if (this.reconnectTimer) {
        clearTimeout(this.reconnectTimer);
        this.reconnectTimer = null;
      }
    });
    
    this.ws.on('message', async (data: Buffer) => {
      try {
        const message = JSON.parse(data.toString());
        await this.handleMessage(message);
      } catch (e) {
        logger.error({ err: e }, 'Error handling message from master');
      }
    });
    
    this.ws.on('close', (code: number, reason: string) => {
      logger.warn({ code, reason }, 'Disconnected from master');
      this.scheduleReconnect();
    });
    
    this.ws.on('error', (err: Error) => {
      logger.error({ err }, 'WebSocket error');
    });
  }

  private scheduleReconnect(): void {
    if (this.reconnectTimer) {
      return; // Already scheduled
    }
    
    logger.info({ delay: this.reconnectDelay }, 'Scheduling reconnect...');
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect().catch(err => {
        logger.error({ err }, 'Reconnect failed');
        this.scheduleReconnect();
      });
    }, this.reconnectDelay);
  }

  private async handleMessage(message: any): Promise<void> {
    switch (message.type) {
      case 'registered':
        logger.info({ nodeId: message.nodeId }, 'Node registered');
        this.nodeId = message.nodeId;
        break;
        
      case 'tool_call':
        await this.handleToolCall(message);
        break;
        
      default:
        logger.warn({ type: message.type }, 'Unknown message type from master');
    }
  }

  private async handleToolCall(message: any): Promise<void> {
    const { callId, tool, args } = message;
    
    logger.info({ callId, tool }, 'Executing tool');
    
    try {
      // Get tool function
      const toolFn = (tools as any)[tool];
      if (!toolFn) {
        throw new Error(`Tool \`${tool}\` not found`);
      }
      
      // Create minimal context
      const ctx = {
        sessionId: args.sessionId || 'node',
        session: await sessionManager.getSession(args.sessionId || 'node'),
        broadcast: async (text: string) => {
          // Send broadcast back to master
          this.send({
            type: 'broadcast',
            callId,
            text
          });
        }
      };
      
      // Execute tool
      const output = await toolFn(args, ctx);
      
      // Return raw output (master will handle __IMAGE__ and __SCREENSHOT__ markers)
      const result = { output };
      
      // Send response
      this.send({
        type: 'tool_call_response',
        callId,
        result
      });
      
      logger.info({ callId, tool }, 'Tool executed successfully');
    } catch (e: any) {
      logger.error({ err: e, callId, tool }, 'Tool execution failed');
      
      // Send error
      this.send({
        type: 'tool_call_error',
        callId,
        error: e.message || String(e)
      });
    }
  }

  private send(data: any): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) {
      this.ws.send(JSON.stringify(data));
    } else {
      logger.warn('Cannot send message: WebSocket not connected');
    }
  }

  async disconnect(): Promise<void> {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = null;
    }
    
    if (this.ws) {
      this.ws.close();
      this.ws = null;
    }
  }
}

// Parse command line arguments
function parseArgs(): NodeClientOptions {
  const args = process.argv.slice(2);
  const options: any = {};
  
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    
    if (arg === '--host' && i + 1 < args.length) {
      options.host = args[++i];
    } else if (arg === '--id' && i + 1 < args.length) {
      options.nodeId = args[++i];
    } else if (arg === '--token' && i + 1 < args.length) {
      options.token = args[++i];
    }
  }
  
  if (!options.host) {
    console.error('Error: --host is required');
    console.error('Usage: npm run node -- --host http://master:3001/ --id my-node --token <token>');
    process.exit(1);
  }
  
  if (!options.token) {
    console.error('Error: --token is required');
    console.error('Usage: npm run node -- --host http://master:3001/ --id my-node --token <token>');
    process.exit(1);
  }
  
  return options as NodeClientOptions;
}

// Main
async function main() {
  const options = parseArgs();
  const client = new NodeClient(options);
  
  await client.connect();
  
  // Handle graceful shutdown
  process.on('SIGINT', async () => {
    logger.info('Shutting down...');
    await client.disconnect();
    process.exit(0);
  });
  
  process.on('SIGTERM', async () => {
    logger.info('Shutting down...');
    await client.disconnect();
    process.exit(0);
  });
}

main().catch(err => {
  logger.error({ err }, 'Node client failed');
  process.exit(1);
});
