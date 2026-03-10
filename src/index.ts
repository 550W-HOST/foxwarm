import 'dotenv/config';
import { logger } from './common';
import { TelegramChannel } from './channels/telegramChannel';
import { MatrixChannel } from './channels/matrixChannel';
import { WebUIChannel } from './channels/webuiChannel';
import { TUIChannel } from './channels/tuiChannel';
import { WeWorkWebhookChannel } from './channels/weworkChannel';
import { MessageRouter } from './messageRouter';
import { CommandHandler } from './commandHandler';
import * as sessionManager from './sessionManager';
import * as vector from './vector';
import { registerChannel } from './channel';
import fs from 'fs-extra';
import crypto from 'crypto';
import path from 'path';
import {
    AGENTS_DIR,
    BASE_DIR,
    ENABLE_TRIGGER,
    ENABLE_WEBUI,
    HTTP_PORT,
    LOGS_DIR,
    MAIN_AGENT_MEMORY_DIR,
    NODE_TOKEN_FILE,
    ONBOOT_FILE,
    PERSISTENT_MEMORY_DIR,
    TOKEN_FILE,
} from './config';
import { HttpServer, setHttpServer } from './httpServer';
import { registerNodeWebSocket } from './nodeWebSocket';
import { cleanupLegacyTopLevelLogDirs, scheduleLogRotation } from './logRotation';
import { startWithRetry } from './startupUtils';
import { initializeTimers } from './timers';

// Check if TUI mode is enabled
const ENABLE_TUI = process.env.ENABLE_TUI === 'true' || process.argv.includes('--tui');

// Global error handlers
process.on('unhandledRejection', (reason: any, promise) => {
    const errorInfo: any = {
        message: reason?.message || String(reason),
        stack: reason?.stack,
        promise: String(promise)
    };
    
    // Include full error object if available
    if (reason && typeof reason === 'object') {
        errorInfo.error = reason;
    }
    
    logger.error(errorInfo, 'Unhandled Rejection');
    
    // Also log to console in case logger fails
    console.error('Unhandled Rejection:', reason);
    if (reason?.stack) {
        console.error('Stack:', reason.stack);
    }
});

process.on('uncaughtException', (error) => {
    logger.error({ 
        message: error.message,
        stack: error.stack,
        error 
    }, 'Uncaught Exception');
    
    // Also log to console
    console.error('Uncaught Exception:', error);
    console.error('Stack:', error.stack);
    process.exit(1);
});

if (!ENABLE_TUI) {
    logger.info(`Starting ${process.env.BOT_NAME || 'foxwarm'}...`);
}

async function ensureToken(): Promise<string> {
    try {
        // Try to read existing token
        const token = await fs.readFile(TOKEN_FILE, 'utf8');
        return token.trim();
    } catch (err: any) {
        if (err.code === 'ENOENT') {
            // Generate new token
            const newToken = crypto.randomBytes(32).toString('hex');
            await fs.ensureDir(path.dirname(TOKEN_FILE));
            await fs.writeFile(TOKEN_FILE, newToken);
            logger.info('Generated new token file');
            return newToken;
        }
        throw err;
    }
}

async function ensureNodeToken(): Promise<string> {
    try {
        // Try to read existing node token
        const token = await fs.readFile(NODE_TOKEN_FILE, 'utf8');
        return token.trim();
    } catch (err: any) {
        if (err.code === 'ENOENT') {
            // Generate new node token
            const newToken = crypto.randomBytes(32).toString('hex');
            await fs.ensureDir(path.dirname(NODE_TOKEN_FILE));
            await fs.writeFile(NODE_TOKEN_FILE, newToken);
            logger.info('Generated new node token file');
            return newToken;
        }
        throw err;
    }
}

async function start() {
    // Migrate legacy pre-agent storage into agents/main if needed
    const templatesDir = path.join(BASE_DIR, 'templates', 'main', 'memory');
    const oldWorkspacePath = path.join(BASE_DIR, 'workspace');

    // Ensure agents directory exists
    await fs.ensureDir(AGENTS_DIR);

    await cleanupLegacyTopLevelLogDirs(LOGS_DIR);

    // Check if migration is needed (old format)
    const oldMemoryExists = await fs.pathExists(PERSISTENT_MEMORY_DIR);
    const oldWorkspaceExists = await fs.pathExists(oldWorkspacePath);
    const newMemoryExists = await fs.pathExists(MAIN_AGENT_MEMORY_DIR);

    if ((oldMemoryExists || oldWorkspaceExists) && !newMemoryExists) {
        logger.info('Migrating old format to agents/main/...');
        const mainAgentDir = path.dirname(MAIN_AGENT_MEMORY_DIR);
        await fs.ensureDir(mainAgentDir);

        // Migrate legacy memory directory into agents/main/memory
        if (oldMemoryExists) {
            logger.info('Migrating legacy memory directory to agents/main/memory...');
            await fs.move(PERSISTENT_MEMORY_DIR, MAIN_AGENT_MEMORY_DIR);
        }

        // Migrate legacy root workspace files into agents/main/
        if (oldWorkspaceExists) {
            const workspaceFiles = await fs.readdir(oldWorkspacePath);
            logger.info('Migrating legacy root workspace files to agents/main/...');
            for (const file of workspaceFiles) {
                const src = path.join(oldWorkspacePath, file);
                const dest = path.join(mainAgentDir, file);
                await fs.move(src, dest);
            }
            await fs.remove(oldWorkspacePath);
        }

        logger.info('Migration completed');
    }
    
    // Initialize main agent memory from templates if needed
    if (!await fs.pathExists(MAIN_AGENT_MEMORY_DIR) || 
        (await fs.readdir(MAIN_AGENT_MEMORY_DIR)).length === 0) {
        logger.info('Main agent memory not found or empty, copying from templates...');
        await fs.ensureDir(MAIN_AGENT_MEMORY_DIR);
        await fs.copy(templatesDir, MAIN_AGENT_MEMORY_DIR);
        logger.info('Main agent memory initialized from templates');
    }

    // Initialize TUI if enabled
    let tuiChannel: TUIChannel | null = null;
    if (ENABLE_TUI) {
        tuiChannel = new TUIChannel();
        await tuiChannel.start();
        registerChannel('tui', tuiChannel);
        
        // Redirect logger to TUI
        const originalLog = logger.info.bind(logger);
        const originalError = logger.error.bind(logger);
        const originalWarn = logger.warn.bind(logger);
        
        logger.info = ((...args: any[]) => {
            const msg = typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0]);
            tuiChannel!.logToTUI('INFO', msg);
            return originalLog(...args);
        }) as any;
        
        logger.error = ((...args: any[]) => {
            const msg = typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0]);
            tuiChannel!.logToTUI('ERROR', msg);
            return originalError(...args);
        }) as any;
        
        logger.warn = ((...args: any[]) => {
            const msg = typeof args[0] === 'string' ? args[0] : JSON.stringify(args[0]);
            tuiChannel!.logToTUI('WARN', msg);
            return originalWarn(...args);
        }) as any;
    }

    // Initialize vector database
    await vector.init();

    // Load sessions
    await sessionManager.loadSessions();

    // Ensure "main" session exists
    await sessionManager.getSession('main');
    logger.info('Main session initialized');

    // Create message router with authorized users
    const authorizedUsers: Array<{ platform: string; userId: string }> = [];
    
    if (process.env.ALLOWED_USER_ID) {
        authorizedUsers.push({ platform: 'telegram', userId: process.env.ALLOWED_USER_ID });
    }
    
    if (process.env.MATRIX_USER_ID) {
        authorizedUsers.push({ platform: 'matrix', userId: process.env.MATRIX_USER_ID });
    }
    
    // Always allow WebUI and TUI
    authorizedUsers.push({ platform: 'webui', userId: 'webui' });
    authorizedUsers.push({ platform: 'tui', userId: 'tui' });
    
    // Add additional Matrix users from env
    if (process.env.MATRIX_ALLOWED_USERS) {
        const users = process.env.MATRIX_ALLOWED_USERS.split(',').map(u => u.trim()).filter(u => u);
        for (const user of users) {
            authorizedUsers.push({ platform: 'matrix', userId: user });
            logger.info({ user }, 'Added Matrix user to whitelist');
        }
    }
    
    // Add WeWork users from env
    if (process.env.WEWORK_ALLOWED_USERS) {
        const users = process.env.WEWORK_ALLOWED_USERS.split(',').map(u => u.trim()).filter(u => u);
        for (const user of users) {
            authorizedUsers.push({ platform: 'wework', userId: user });
            logger.info({ user }, 'Added WeWork user to whitelist');
        }
    }
    
    const router = new MessageRouter(authorizedUsers);
    const commandHandler = new CommandHandler(router);
    
    // Set command handler in router and give commandHandler access to router
    router.setCommandHandler((ctx, command, args) => commandHandler.handleCommand(ctx, command, args));

    // Set up TUI channel handlers
    if (tuiChannel) {
        tuiChannel.onMessage((ctx, message) => router.handleMessage(ctx, message));
        tuiChannel.onCommand((ctx, command, args) => commandHandler.handleCommand(ctx, command, args));
    }

    // Start Telegram channel (if configured)
    let telegramChannel: TelegramChannel | null = null;
    if (process.env.TELEGRAM_BOT_TOKEN) {
        telegramChannel = await startWithRetry('telegram', async () => {
            const channel = new TelegramChannel(process.env.TELEGRAM_BOT_TOKEN!);
            channel.onMessage((ctx, message) => router.handleMessage(ctx, message));
            channel.onCommand((ctx, command, args) => commandHandler.handleCommand(ctx, command, args));
            await channel.start();
            registerChannel('telegram', channel);
            logger.info('Telegram channel initialized');

            if (process.env.ALLOWED_USER_ID) {
                sessionManager.attachChannel('telegram', process.env.ALLOWED_USER_ID, 'main');
            }

            return channel;
        }, { retries: 3, delayMs: 5000 });
    }

    // Set up session event callbacks (for background processes, child sessions, etc.)
    sessionManager.setSessionTriggerCallback(
        (sessionId) => {
            router.processSessionQueue(sessionId);
        }
    );

    await initializeTimers();

    // Start Matrix channel (if configured)
    if (process.env.MATRIX_HOMESERVER && process.env.MATRIX_ACCESS_TOKEN && process.env.MATRIX_USER_ID) {
        await startWithRetry('matrix', async () => {
            const matrixChannel = new MatrixChannel(
                process.env.MATRIX_HOMESERVER!,
                process.env.MATRIX_ACCESS_TOKEN!,
                process.env.MATRIX_USER_ID!
            );
            matrixChannel.onMessage((ctx, message) => router.handleMessage(ctx, message));
            await matrixChannel.start();
            registerChannel('matrix', matrixChannel);
            logger.info('Matrix channel initialized');

            sessionManager.attachChannel('matrix', process.env.MATRIX_USER_ID!, 'main');
            return matrixChannel;
        }, { retries: 1, delayMs: 3000 });
    }

    // Start WeWork Webhook channel (if configured)
    if (process.env.WEWORK_WEBHOOK_URL) {
        await startWithRetry('wework', async () => {
            const weworkChannel = new WeWorkWebhookChannel({
                webhookUrl: process.env.WEWORK_WEBHOOK_URL!,
                token: process.env.WEWORK_TOKEN,
                encodingAESKey: process.env.WEWORK_ENCODING_AES_KEY,
                listenPort: process.env.WEWORK_LISTEN_PORT ? parseInt(process.env.WEWORK_LISTEN_PORT) : undefined,
                listenPath: process.env.WEWORK_LISTEN_PATH
            });
            weworkChannel.onMessage((ctx, message) => router.handleMessage(ctx, message));
            await weworkChannel.start();
            registerChannel('wework', weworkChannel);
            logger.info('WeWork Webhook channel initialized');
            return weworkChannel;
        }, { retries: 1, delayMs: 3000 });
    }

    // Start unified HTTP server (WebUI + Trigger + Nodes)
    let webuiChannel: WebUIChannel | null = null;
    if (ENABLE_WEBUI || ENABLE_TRIGGER) {
        const token = await ensureToken();
        const nodeToken = await ensureNodeToken();
        
        // Create HTTP server instance
        const httpServerInstance = new HttpServer(HTTP_PORT, token);
        setHttpServer(httpServerInstance);
        
        // Add nodes WebSocket handler to HTTP server
        registerNodeWebSocket(httpServerInstance, nodeToken);
        
        // Start HTTP server
        await httpServerInstance.start();
        
        webuiChannel = new WebUIChannel({
            router,
            token,
            enableWebUI: ENABLE_WEBUI,
            enableTrigger: ENABLE_TRIGGER
        });
        
        await webuiChannel.start();
        registerChannel('webui', webuiChannel);
        
        // Set up history update callback for SSE
        sessionManager.setOnHistoryUpdated((sessionId, message) => {
            webuiChannel!.broadcastMessage(sessionId, message);
        });
        
        // Set up session list update callback for SSE
        sessionManager.setOnSessionListUpdated(() => {
            webuiChannel!.broadcastSessionListUpdate();
        });
    } else {
        logger.info('HTTP server disabled (both WebUI and Trigger are disabled)');
    }

    logger.info('Foxwarm started successfully');

    // Resume busy sessions after restart (must be after callback is set)
    await sessionManager.resumeBusySessions();

    // Schedule log rotation (start immediately and every 10 hours)
    scheduleLogRotation();

    // Handle ONBOOT.md
    await handleOnboot(telegramChannel);
    
    // In TUI mode, keep the process running
    if (ENABLE_TUI) {
        // Process will stay alive due to blessed screen event loop
        await new Promise(() => {}); // Never resolves
    }
}

async function handleOnboot(telegramChannel: TelegramChannel | null) {
    try {
        if (await fs.pathExists(ONBOOT_FILE)) {
            const onbootContent = await fs.readFile(ONBOOT_FILE, 'utf8');
            if (onbootContent && onbootContent.trim().length > 0) {
                logger.info('ONBOOT.md found, triggering auto-run after 3 seconds...');
                await new Promise(r => setTimeout(r, 3000));

                // Send notification via Telegram if available
                if (telegramChannel && process.env.ALLOWED_USER_ID) {
                    // Don't await, let it run in background
                    telegramChannel.sendMessage(process.env.ALLOWED_USER_ID, '📋 ONBOOT: ' + onbootContent);
                }

                // Queue ONBOOT as a session event (don't await processing to avoid blocking startup)
                sessionManager.queueSessionEvent('main', `ONBOOT: ${onbootContent}`, 'onboot').catch((err: Error) => {
                    logger.error({ err }, 'Failed to queue ONBOOT event');
                });
            }
        }
    } catch (e) {
        logger.error(e, 'Error processing ONBOOT.md');
    }
}

start().catch((err: Error) => {
    logger.error({ err }, 'Failed to start:');
    process.exit(1);
});
