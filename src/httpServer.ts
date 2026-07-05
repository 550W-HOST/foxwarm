/**
 * HTTP Server - Unified HTTP server for all channels
 * Extracted from webuiChannel to be shared across modules
 */

import express from 'express';
import compression from 'compression';
import http from 'http';
import { WebSocketServer, WebSocket } from 'ws';
import { logger } from './common';

export interface HttpServerOptions {
  port?: number;
  enableWebUI?: boolean;
  enableTrigger?: boolean;
}

export interface RouteHandler {
  path: string;
  method: 'GET' | 'POST' | 'PUT' | 'DELETE';
  handler: (req: express.Request, res: express.Response) => Promise<any>;
  noAuth?: boolean;
}

export interface WebSocketHandler {
  path: string;
  handler: (ws: WebSocket, req: http.IncomingMessage) => Promise<void>;
}

export class HttpServer {
  public app: express.Application;
  private httpServer: http.Server;
  private wsServer: WebSocketServer;
  private port: number;
  private token: string;
  private routes: RouteHandler[] = [];
  private webSocketHandlers: WebSocketHandler[] = [];

  constructor(port: number, token: string) {
    this.port = port;
    this.token = token;
    this.app = express();
    
    // Setup middleware
    this.setupMiddleware();
    
    // Create HTTP server
    this.httpServer = http.createServer(this.app);
    
    // Create WebSocket server
    this.wsServer = new WebSocketServer({ noServer: true });
    
    // Setup WebSocket handlers
    this.setupWebSocketHandlers();
  }

  private setupMiddleware() {
    // Gzip compression
    this.app.use(compression({
      level: 6,
      threshold: 1024,
      filter: (req, res) => {
        if (req.path.includes('/stream')) {
          return false;
        }
        return compression.filter(req, res);
      }
    }));
    
    this.app.use(express.json());
    
    // Cookie parser
    this.app.use((req, _res, next) => {
      req.cookies = {};
      const cookieHeader = req.headers.cookie;
      if (cookieHeader) {
        cookieHeader.split(';').forEach(cookie => {
          const [name, ...rest] = cookie.split('=');
          req.cookies[name.trim()] = decodeURIComponent(rest.join('='));
        });
      }
      next();
    });
  }

  checkToken(req: express.Request): boolean {
    return this.checkTokenFromHeaders(req.headers.cookie, req.headers.authorization);
  }

  checkIncomingToken(req: http.IncomingMessage): boolean {
    return this.checkTokenFromHeaders(req.headers.cookie, req.headers.authorization);
  }

  private checkTokenFromHeaders(cookieHeader: string | undefined, authHeader: string | string[] | undefined): boolean {
    // Check cookie first
    const cookieToken = this.parseCookieToken(cookieHeader);
    if (cookieToken === this.token) {
      return true;
    }
    
    // Check Authorization header
    const authValue = Array.isArray(authHeader) ? authHeader[0] : authHeader;
    if (authValue && authValue.startsWith('Bearer ')) {
      const auth = authValue.substring(7);
      return auth === this.token;
    }
    
    return false;
  }

  private parseCookieToken(cookieHeader: string | undefined): string | undefined {
    if (!cookieHeader) return undefined;

    const cookies: Record<string, string> = {};
    cookieHeader.split(';').forEach(cookie => {
      const [name, ...rest] = cookie.split('=');
      cookies[name.trim()] = decodeURIComponent(rest.join('='));
    });

    return cookies.foxwarm_token || cookies.alphabot_token;
  }

  addRoute(route: RouteHandler): void {
    this.routes.push(route);
    
    const handler = async (req: express.Request, res: express.Response) => {
      try {
        await route.handler(req, res);
      } catch (e) {
        logger.error({ err: e, path: route.path }, 'Route handler error');
        res.status(500).json({ error: 'Internal server error' });
      }
    };

    const middlewares = route.noAuth ? [] : [this.authMiddleware];
    
    this.app[route.method.toLowerCase() as 'get'](route.path, ...middlewares, handler);
    
    logger.debug({ method: route.method, path: route.path }, 'Route added');
  }

  private authMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    if (this.checkToken(req)) {
      return next();
    }
    res.status(401).json({ error: 'Unauthorized' });
  };

  addWebSocket(path: string, handler: (ws: WebSocket, req: http.IncomingMessage) => Promise<void>): void {
    this.webSocketHandlers.push({ path, handler });
    logger.debug({ path }, 'WebSocket handler added');
  }

  private setupWebSocketHandlers() {
    this.httpServer.on('upgrade', (req: http.IncomingMessage, socket, head) => {
      const url = req.url || '/';
      const path = url.split('?')[0];
      const handler = this.webSocketHandlers.find(h => h.path === path);

      if (!handler) {
        logger.warn({ path }, 'No WebSocket handler found');
        socket.destroy();
        return;
      }

      this.wsServer.handleUpgrade(req, socket, head, (ws) => {
        handler.handler(ws, req).catch(err => {
          logger.error({ err, path }, 'WebSocket handler error');
          ws.close();
        });
      });
    });
  }

  async start(): Promise<void> {
    return new Promise((resolve) => {
      this.httpServer.listen(this.port, '0.0.0.0', () => {
        logger.info({ port: this.port }, 'HTTP server started');
        resolve();
      });
    });
  }

  async stop(): Promise<void> {
    if (this.httpServer) {
      return new Promise((resolve) => {
        this.httpServer.close(() => {
          logger.info('HTTP server stopped');
          resolve();
        });
      });
    }
  }
}

// Create singleton instance (will be initialized in index.ts)
export let httpServer: HttpServer | null = null;

export function setHttpServer(instance: HttpServer | null): void {
  httpServer = instance;
}