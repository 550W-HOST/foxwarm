/**
 * WebUI Channel - HTTP API for web interface and external trigger
 */

import express from 'express';
import path from 'path';
import fs from 'fs-extra';
import { Channel, ChannelContext, ChannelMessage } from '../channel';
import { MessageRouter } from '../messageRouter';
import { logger } from '../common';
import * as sessionManager from '../sessionManager';
import { BASE_DIR } from '../config';
import { httpServer } from '../httpServer';
import { COMMANDS } from '../commands';

// Extend Express Request to include cookies
declare global {
  namespace Express {
    interface Request {
      cookies: { [key: string]: string };
    }
  }
}

export interface WebUIChannelOptions {
  router: MessageRouter;
  token: string;
  enableWebUI?: boolean;
  enableTrigger?: boolean;
}

export class WebUIChannel implements Channel {
  readonly name = 'webui';
  readonly platform = 'webui';
  private router: MessageRouter;
  private token: string;
  private enableWebUI: boolean;
  private enableTrigger: boolean;
  private sseClients: Map<string, express.Response[]> = new Map(); // sessionId -> clients
  private globalSseClients: express.Response[] = []; // Global clients for session list updates

  constructor(options: WebUIChannelOptions) {
    this.router = options.router;
    this.token = options.token;
    this.enableWebUI = options.enableWebUI !== false;
    this.enableTrigger = options.enableTrigger !== false;
    
    // Add routes to HTTP server
    this.setupRoutes();
  }

  // Middleware for static file protection
  private staticAuthMiddleware = (req: express.Request, res: express.Response, next: express.NextFunction) => {
    // Allow login.html, /api/auth, and /download without token check here (handled by route)
    if (req.path === '/login.html' || req.path === '/api/auth' || req.path === '/download') {
      return next();
    }
    
    // Check token
    if (!httpServer.checkToken(req)) {
      // Serve login.html directly instead of redirect
      const loginPath = path.join(BASE_DIR, 'packages', 'webui', 'public', 'login.html');
      return res.sendFile(loginPath);
    }
    
    next();
  };

  private setupRoutes() {
    // Add routes to HTTP server
    const httpServerInstance = httpServer;
    
    // External trigger endpoint
    if (this.enableTrigger) {
      httpServerInstance.addRoute({
        path: '/trigger',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const { text, sessionId } = req.body;
            const finalSessionId = sessionId || 'main'; // Default to main session

            if (!text) throw new Error('Missing text');

            logger.info({ trigger: true, text, sessionId: finalSessionId }, 'External trigger received');

            await sessionManager.queueSessionEvent(finalSessionId, text, 'trigger');
            res.json({ success: true, message: 'Triggered' });
          } catch (e: any) {
            logger.error({ err: e }, 'Trigger error');
            res.status(400).json({ error: e.message });
          }
        },
      });
      logger.info('External trigger endpoint enabled');
    }

    // WebUI API endpoints
    if (this.enableWebUI) {
      // Auth endpoint
      httpServerInstance.addRoute({
        path: '/api/auth',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          const { token } = req.body;
          if (token === this.token) {
            res.json({ success: true });
          } else {
            res.status(401).json({ error: 'Invalid token' });
          }
        }
      });

      // Get available slash commands for WebUI autocomplete
      httpServerInstance.addRoute({
        path: '/api/commands',
        method: 'GET',
        handler: async (_req: express.Request, res: express.Response) => {
          try {
            const commands = Object.entries(COMMANDS)
              .map(([name, def]) => ({
                name,
                description: def.description,
                usage: def.usage || null,
                requiresSession: def.requiresSession !== false,
                showInTelegram: def.showInTelegram !== false,
              }))
              .sort((a, b) => a.name.localeCompare(b.name));

            res.json({ commands });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to get commands');
            res.status(500).json({ error: e.message });
          }
        },
      });

      // Get all sessions
      httpServerInstance.addRoute({
        path: '/api/sessions',
        method: 'GET',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const allSessions = sessionManager.getAllSessions();
            
            // Build parent-to-children map
            const childrenMap = new Map<string, string[]>();
            for (const [id, session] of allSessions.entries()) {
              if (session.parentSessionId) {
                if (!childrenMap.has(session.parentSessionId)) {
                  childrenMap.set(session.parentSessionId, []);
                }
                childrenMap.get(session.parentSessionId)!.push(id);
              }
            }
            
            const sessions = Array.from(allSessions.entries())
              .map(([id, session]) => ({
                id,
                messageCount: session.meta?.messageCount ?? session.history.length,
                lastMessageTime: session.meta?.lastMessageTime ?? (session.history.length > 0 
                  ? session.history[session.history.length - 1].__meta?.timestamp || 0
                  : 0),
                parentSessionId: session.parentSessionId || null,
                childSessions: childrenMap.get(id) || [],
                aliases: session.aliases || [],
                busy: session.busy || false,
                queueLength: session.queue?.length || 0,
                displayName: session.displayName || null,
                archived: session.archived || false
              }))
              .sort((a, b) => b.lastMessageTime - a.lastMessageTime); // Sort by lastMessageTime descending
            res.json({ sessions });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to get sessions');
            res.status(500).json({ error: e.message });
          }
        },
      });

      httpServerInstance.addRoute({
        path: '/api/sessions',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            if (typeof req.body?.sessionId === 'string' && req.body.sessionId.trim()) {
              return res.status(400).json({ error: 'Custom sessionId is not allowed.' });
            }

            const { session, created } = await sessionManager.createEmptySession();

            if (!created) {
              return res.status(409).json({ error: 'Session already exists', sessionId: session.id });
            }

            this.broadcastSessionListUpdate();

            res.json({
              success: true,
              sessionId: session.id,
            });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to create session');
            res.status(500).json({ error: e.message });
          }
        },
      });

      // Get agents tree (for multi-agent dashboard)
      httpServerInstance.addRoute({
        path: '/api/agents/tree',
        method: 'GET',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const allSessions = sessionManager.getAllSessions();

            const childrenMap = new Map<string, string[]>();
            for (const [id, session] of allSessions.entries()) {
              if (session.parentSessionId) {
                if (!childrenMap.has(session.parentSessionId)) {
                  childrenMap.set(session.parentSessionId, []);
                }
                childrenMap.get(session.parentSessionId)!.push(id);
              }
            }
            
            // Build tree structure
            const agents = Array.from(allSessions.entries()).map(([id, session]) => ({
              id,
              displayName: session.displayName || id,
              busy: session.busy || false,
              queueLength: session.queue?.length || 0,
              parentSessionId: session.parentSessionId || null,
              childSessions: childrenMap.get(id) || [],
              messageCount: session.meta?.messageCount ?? session.history.length,
              lastMessageTime: session.meta?.lastMessageTime ?? 0,
              archived: session.archived || false
            }));
            
            // Build root agents (no parent)
            const rootAgents = agents.filter(a => !a.parentSessionId);
            
            res.json({ agents, rootAgents: rootAgents.map(a => a.id) });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to get agents tree');
            res.status(500).json({ error: e.message });
          }
        },
      });

      // Get session history (must be before DELETE /:sessionId)
      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId/history',
        method: 'GET',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const sessionId = req.params.sessionId as string;
            const session = await sessionManager.getExistingSession(sessionId);
            if (!session) {
              return res.status(404).json({ error: 'Session not found' });
            }
            res.json({ messages: session.history });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to get history');
            res.status(500).json({ error: e.message });
          }
        },
      });

      // Update session display name
      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId/name',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const sessionId = req.params.sessionId as string;
            const { name } = req.body;
            const session = await sessionManager.getExistingSession(sessionId);

            if (!session) {
              return res.status(404).json({ error: 'Session not found' });
            }

            if (typeof name === 'string' && name.trim()) {
              session.displayName = name.trim();
            } else {
              session.displayName = undefined;
            }

            await sessionManager.saveSession(session.id);

            this.broadcastSessionListUpdate();

            res.json({
              success: true,
              sessionId: session.id,
              displayName: session.displayName || null,
            });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to update session display name');
            res.status(500).json({ error: e.message });
          }
        },
      });

      // Archive/unarchive session (must be before DELETE /:sessionId)
      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId/archive',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const sessionId = req.params.sessionId as string;
            const { archived } = req.body;
            
            const success = await sessionManager.archiveSession(sessionId, archived !== false);
            
            if (success) {
              // Broadcast session list update
              this.broadcastSessionListUpdate();
              res.json({ success: true, archived: archived !== false });
            } else {
              res.status(404).json({ error: 'Session not found' });
            }
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to archive session');
            res.status(500).json({ error: e.message });
          }
        },
      });

      // Fork session (must be before DELETE /:sessionId)
      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId/fork',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const sessionId = req.params.sessionId as string;
            const { suffix } = req.body;
            
            const newSessionId = await sessionManager.forkSession(sessionId, suffix, false);
            
            // Broadcast session list update
            this.broadcastSessionListUpdate();
            
            res.json({ success: true, newSessionId });
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to fork session');
            res.status(500).json({ error: e.message });
          }
        },
      });

      // Delete session (must be after specific routes like /archive, /fork, /history)
      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId',
        method: 'DELETE',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const sessionId = req.params.sessionId as string;
            
            const blockingChannels = sessionManager
              .getChannelsBySession(sessionId)
              .filter(channel => channel.platform !== 'webui');

            if (blockingChannels.length > 0) {
              return res.status(400).json({ error: 'Cannot delete active session. Detach channels first.' });
            }

            const prep = await sessionManager.prepareSessionForDestructiveAction(sessionId);
            if (prep.requiresRetry) {
              const queueNote = prep.droppedQueueItems > 0
                ? ` Cleared ${prep.droppedQueueItems} queued item(s).`
                : '';
              const stopNote = prep.abortedInFlight
                ? ' The in-flight LLM request was aborted.'
                : ' It will stop after the current tool call completes.';
              return res.status(409).json({
                error: `Session is busy. Stop signal sent.${stopNote}${queueNote} Retry delete after it becomes idle.`,
              });
            }
            
            const deleted = await sessionManager.deleteSession(sessionId);
            
            if (deleted) {
              // Broadcast session list update
              this.broadcastSessionListUpdate();
              res.json({ success: true });
            } else {
              res.status(404).json({ error: 'Session not found' });
            }
          } catch (e: any) {
            logger.error({ err: e }, 'Failed to delete session');
            res.status(500).json({ error: e.message });
          }
          
          res;
        },
      });

      // SSE endpoint for real-time updates
      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId/stream',
        method: 'GET',
        handler: async (req: express.Request, res: express.Response) => {
          const sessionId = req.params.sessionId as string;

          // Check token from cookie or query parameter
          if (!httpServer.checkToken(req)) {
            logger.warn('SSE token validation failed');
            res.status(401).json({ error: 'Unauthorized' });
            return;
          }
          
          // Set SSE headers
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
          res.flushHeaders(); // Flush headers immediately
          
          // Add client to list
          if (!this.sseClients.has(sessionId)) {
            this.sseClients.set(sessionId, []);
          }
          this.sseClients.get(sessionId)!.push(res);
          
          // logger.info({ sessionId, clientCount: this.sseClients.get(sessionId)!.length }, 'SSE client connected');
          
          // Send initial ping
          res.write('data: {"type":"connected"}\n\n');
          
          // Keep-alive ping every 30 seconds
          const keepAliveInterval = setInterval(() => {
            try {
              res.write(': keep-alive\n\n');
            } catch (e) {
              clearInterval(keepAliveInterval);
            }
          }, 30000);
          
          // Remove client on disconnect
          req.on('close', () => {
            clearInterval(keepAliveInterval);
            const clients = this.sseClients.get(sessionId);
            if (clients) {
              const index = clients.indexOf(res);
              if (index !== -1) {
                clients.splice(index, 1);
              }
              if (clients.length === 0) {
                this.sseClients.delete(sessionId);
              }
            }
            // logger.info({ sessionId }, 'SSE client disconnected');
          });
          
        }
      });

      // Global SSE endpoint for session list updates
      httpServerInstance.addRoute({
        path: '/api/sessions/stream',
        method: 'GET',
        handler: async (req: express.Request, res: express.Response) => {
          // Check token
          if (!httpServer.checkToken(req)) {
            logger.warn('Global SSE token validation failed');
            res.status(401).json({ error: 'Unauthorized' });
            return;
          }
          
          // Set SSE headers
          res.setHeader('Content-Type', 'text/event-stream');
          res.setHeader('Cache-Control', 'no-cache');
          res.setHeader('Connection', 'keep-alive');
          res.setHeader('X-Accel-Buffering', 'no');
          res.flushHeaders();
          
          // Add to global clients
          this.globalSseClients.push(res);
          
          // Send initial ping
          res.write('data: {"type":"connected"}\n\n');
          
          // Keep-alive ping
          const keepAliveInterval = setInterval(() => {
            try {
              res.write(': keep-alive\n\n');
            } catch (e) {
              clearInterval(keepAliveInterval);
            }
          }, 30000);
          
          // Remove on disconnect
          req.on('close', () => {
            clearInterval(keepAliveInterval);
            const index = this.globalSseClients.indexOf(res);
            if (index !== -1) {
              this.globalSseClients.splice(index, 1);
            }
          });
          
          res;
        },
      });

      // Upload file
      httpServerInstance.addRoute({
        path: '/api/upload',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const multer = require('multer');
            const os = require('os');
            const crypto = require('crypto');
            
            // Setup multer for file upload
            const upload = multer({
              dest: path.join(os.tmpdir(), 'foxwarm-uploads'),
              limits: { fileSize: 50 * 1024 * 1024 } // 50MB limit
            });
            
            // Ensure upload directory exists
            await fs.ensureDir(path.join(os.tmpdir(), 'foxwarm-uploads'));
            
            // Handle upload
            upload.single('file')(req, res, async (err: any) => {
              if (err) {
                res.status(400).json({ error: err.message });
                return;
              }
              
              if (!req.file) {
                res.status(400).json({ error: 'No file uploaded' });
                return;
              }
              
              // Generate unique filename
              const ext = path.extname(req.file.originalname);
              const filename = `${crypto.randomBytes(16).toString('hex')}${ext}`;
              const finalPath = path.join(os.tmpdir(), 'foxwarm-uploads', filename);
              
              // Move file to final path
              await fs.move(req.file.path, finalPath, { overwrite: true });
              
              logger.info({ filename, originalName: req.file.originalname, size: req.file.size }, 'File uploaded');
              
              res.json({ 
                path: finalPath,
                filename: req.file.originalname,
                size: req.file.size
              });
            });
          } catch (e: any) {
            logger.error({ err: e }, 'Upload error');
            res.status(500).json({ error: e.message });
          }
        },
      });

      // Send message
      httpServerInstance.addRoute({
        path: '/api/sessions/:sessionId/message',
        method: 'POST',
        handler: async (req: express.Request, res: express.Response) => {
          try {
            const sessionId = req.params.sessionId as string;
            const { text, parts, filePaths } = req.body;

            // Support both old format (text) and new format (parts)
            let finalParts = parts || (text ? [{ text }] : []);
            
            const ctx: ChannelContext = {
              channelUserId: sessionId, // Use sessionId as channelUserId (matches attachChannel)
              username: 'webui',
              platform: 'webui',
              reply: async (replyText: string) => {
                // Check if this is a command response by checking if message starts with /
                const messageText = (text || finalParts.map((p: any) => p.text || '').join('\n')).trim();
                const isCommand = messageText.startsWith('/');
                
                logger.info({ sessionId, isCommand, replyLength: replyText.length }, 'WebUI reply called');
                
                if (isCommand) {
                  // Broadcast temporary command response (not saved to history)
                  this.broadcastMessage(sessionId, {
                    role: 'assistant',
                    parts: [{ text: replyText }],
                    __meta: {
                      timestamp: Date.now(),
                      channelUserId: sessionId,
                      username: 'webui',
                      platform: 'webui',
                      temporary: true, // Mark as temporary
                      isCommandResponse: true // Mark as command response to skip timestamp check
                    }
                  });
                  logger.info({ sessionId }, 'Command response broadcasted');
                }
                
                // Don't call res.json() here - response already sent
              },
              sendTyping: async () => {}
            };

            const message: ChannelMessage = {
              parts: finalParts,
              channelUserId: sessionId, // Use sessionId as channelUserId
              username: 'webui'
            };
            
            // If filePaths provided, read and add image parts
            if (filePaths && Array.isArray(filePaths)) {
              for (const filePath of filePaths) {
                try {
                  // Check if file exists and is an image
                  const stats = await fs.stat(filePath);
                  if (stats.isFile()) {
                    const ext = path.extname(filePath).toLowerCase();
                    const imageExts = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
                    
                    if (imageExts.includes(ext)) {
                      // Read image and convert to base64
                      const imageBuffer = await fs.readFile(filePath);
                      const base64 = imageBuffer.toString('base64');
                      const mimeType = ext === '.png' ? 'image/png' : 
                                      ext === '.gif' ? 'image/gif' :
                                      ext === '.webp' ? 'image/webp' : 'image/jpeg';
                      
                      finalParts.push({
                        inlineData: {
                          data: base64,
                          mimeType
                        }
                      });
                    }
                  }
                } catch (err) {
                  logger.warn({ filePath, err }, 'Failed to read uploaded file');
                }
              }
            }
            
            if (finalParts.length === 0) throw new Error('Missing message content');

            const existingSession = await sessionManager.getExistingSession(sessionId);
            if (!existingSession) {
              return res.status(404).json({ error: 'Session not found' });
            }

            // Attach webui channel if not already attached
            // Use sessionId as channelUserId so each session has its own channel
            let existingSessionId = sessionManager.getSessionByChannel('webui', sessionId);
            if (!existingSessionId || existingSessionId !== sessionId) {
              sessionManager.attachChannel('webui', sessionId, sessionId);
            }

            // Return immediately - don't wait for processing
            res.json({ success: true, message: 'Message received' });

            // Let the router handle everything asynchronously (including commands)
            // Results will be sent via SSE
            this.router.handleMessage(ctx, message).catch(err => {
              logger.error({ err }, 'Error handling WebUI message');
            });
          } catch (e: any) {
            logger.error({ err: e }, 'WebUI message error');
            res.status(500).json({ error: e.message });
          }
        },
      });

      // Serve WebUI static files with authentication
      const webuiDistPath = path.join(BASE_DIR, 'packages', 'webui', 'dist');
      const loginPath = path.join(BASE_DIR, 'packages', 'webui', 'public', 'login.html');
      
      if (fs.existsSync(webuiDistPath)) {
        // Serve login.html without auth
        if (fs.existsSync(loginPath)) {
          httpServerInstance.addRoute({
            path: '/login.html',
            method: 'GET',
            noAuth: true,
            handler: async (req: express.Request, res: express.Response) => {
              res.sendFile(loginPath);
            }
          });
        }
        
        // Protect all other static files
        httpServerInstance.app.use(this.staticAuthMiddleware);
        httpServerInstance.app.use(express.static(webuiDistPath));
        
        // Note: No SPA fallback route needed, using hash routing
      } else {
        logger.warn('WebUI dist folder not found, skipping static file serving');
      }

      logger.info('WebUI endpoints enabled');
    }

    // File download endpoint
    httpServerInstance.addRoute({
      path: '/download',
      method: 'GET',
      handler: async (req: express.Request, res: express.Response) => {
        // Check token
        if (!httpServer.checkToken(req)) {
          logger.warn('Download token validation failed');
          res.status(401).json({ error: 'Unauthorized' });
          return;
        }

        const filePath = req.query.path as string;
        if (!filePath) {
          res.status(400).json({ error: 'Missing path parameter' });
          return;
        }

        // Security: Ensure absolute path
        if (!path.isAbsolute(filePath)) {
          res.status(400).json({ error: 'Path must be absolute' });
          return;
        }

        // Check if file exists
        if (!fs.existsSync(filePath)) {
          res.status(404).json({ error: 'File not found' });
          return;
        }

        // Check if it's a file (not directory)
        const stats = fs.statSync(filePath);
        if (!stats.isFile()) {
          res.status(400).json({ error: 'Path is not a file' });
          return;
        }

        // Send file
        const fileName = path.basename(filePath);
        res.download(filePath, fileName, (err) => {
          if (err) {
            logger.error({ err, filePath }, 'Failed to send file');
            if (!res.headersSent) {
              res.status(500).json({ error: 'Failed to send file' });
            }
          }
        });
      }
    });
  }

  // Broadcast new message to SSE clients
  broadcastMessage(sessionId: string, message: any) {
    const clients = this.sseClients.get(sessionId);
    logger.info({ sessionId, clientCount: clients?.length || 0, messageRole: message.role }, 'Broadcasting message to SSE clients');
    if (clients && clients.length > 0) {
      const data = JSON.stringify({ type: 'message', message });
      clients.forEach(client => {
        try {
          client.write(`data: ${data}\n\n`);
          logger.debug({ sessionId }, 'SSE message sent');
        } catch (e) {
          logger.error({ err: e }, 'Failed to send SSE message');
        }
      });
    }
  }

  // Broadcast session list update to all global SSE clients
  broadcastSessionListUpdate() {
    if (this.globalSseClients.length > 0) {
      const data = JSON.stringify({ type: 'sessions-updated' });
      this.globalSseClients.forEach(client => {
        try {
          client.write(`data: ${data}\n\n`);
        } catch (e) {
          logger.error({ err: e }, 'Failed to send session list update');
        }
      });
    }
  }

  // Channel interface implementation
  async sendMessage(channelUserId: string, text: string, options?: any): Promise<void> {
    // For WebUI, channelUserId is the sessionId
    // Use broadcastMessage for consistency (unified message system)
    logger.debug({ sessionId: channelUserId, textPreview: text.substring(0, 50) }, 'WebUI sendMessage called');
    this.broadcastMessage(channelUserId, {
      role: 'assistant',
      parts: [{ text }],
      __meta: {
        timestamp: Date.now(),
        channelUserId: channelUserId,
        username: 'system',
        platform: 'webui',
        temporary: true,
        isInstantNotification: true // Mark as instant notification (like compact messages)
      }
    });
  }

  async sendTyping(channelUserId: string): Promise<void> {
    // For WebUI, send typing indicator via SSE
    const clients = this.sseClients.get(channelUserId);
    if (clients && clients.length > 0) {
      const data = JSON.stringify({ type: 'typing' });
      clients.forEach(client => {
        try {
          client.write(`data: ${data}\n\n`);
        } catch (e) {
          logger.error({ err: e, sessionId: channelUserId }, 'Failed to send typing indicator');
        }
      });
    }
  }

  onMessage(handler: (ctx: ChannelContext, message: ChannelMessage) => Promise<void>): void {
    // WebUI handles messages internally via HTTP API
    // This is a no-op for WebUI
  }

  async start(): Promise<void> {
    // HTTP server is already started globally, no need to start here
    logger.info({ webui: this.enableWebUI, trigger: this.enableTrigger }, 'WebUI channel started');
    return Promise.resolve();
  }

  async stop(): Promise<void> {
    // HTTP server is managed globally, no need to stop here
    logger.info('WebUI channel stopped');
    return Promise.resolve();
  }
}
