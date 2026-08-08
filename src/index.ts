import { logger } from './common';
import { TelegramChannel } from './channels/telegramChannel';
import { MatrixChannel } from './channels/matrixChannel';
import { WebUIChannel } from './channels/webuiChannel';
import { TUIChannel } from './channels/tuiChannel';
import { isWeWorkChannelConfigReady, WeWorkWebhookChannel } from './channels/weworkChannel';
import { initializeChannelRuntime, startManagedChannel } from './channelRuntime';
import { MessageRouter } from './messageRouter';
import { CommandHandler } from './commandHandler';
import * as sessionManager from './sessionManager';
import * as sessionRuntime from './sessionRuntime';
import { resumeSessionWorkerPendingIntents, SessionWorkerIngressCoordinator } from './sessionWorkerIngress';
import { SessionWorkerSourceContextRegistry } from './sessionWorkerSourceContextRegistry';
import { SessionWorkerStore } from './sessionWorkerStore';
import { SessionWorkerSupervisor } from './sessionWorkerSupervisor';
import * as mainManagementTools from './mainManagementTools';
import * as nodeExecution from './nodeExecution';
import * as mcpExternal from './mcpExternalService';
import * as vector from './vector';
import { registerChannel } from './channel';
import fs from 'fs-extra';
import crypto from 'crypto';
import path from 'path';
import {
    AGENTS_DIR,
    AGENTS_SYSTEM_PROMPT_PATH,
    AGENTS_SYSTEM_PROMPT_TEMPLATE_PATH,
    BOT_NAME,
    BASE_DIR,
    DATA_ROOT_DIR,
    DB_WORKERS_ENABLED,
    ENABLE_TUI,
    ENABLE_TRIGGER,
    ENABLE_WEBUI,
    HTTP_PORT,
    getDefaultChannelConfigByType,
    getNormalizedChannelConfigs,
    MAIN_AGENT_MEMORY_DIR,
    NODE_TOKEN_FILE,
    ONBOOT_FILE,
    SESSION_WORKERS_CONFIG,
    SESSION_WORKERS_ENABLED,
    TELEGRAM_CONFIG,
    TOKEN_FILE,
} from './config';
import type { TelegramConfig } from './config';
import { HttpServer, setHttpServer } from './httpServer';
import { registerNodeWebSocket } from './nodes/websocket';
import { registerNodeHttpRoutes } from './nodes/httpRoutes';
import { initializeNodeRegistry } from './nodes/registry';
import { scheduleLogRotation } from './logRotation';
import { startWithRetry } from './startupUtils';
import { initializeTimers } from './timers';
import { initializeExecManager } from './execManager';

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
    logger.info(`Starting ${BOT_NAME}...`);
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
            // Generate new node pairing token
            const newToken = crypto.randomBytes(32).toString('hex');
            await fs.ensureDir(path.dirname(NODE_TOKEN_FILE));
            await fs.writeFile(NODE_TOKEN_FILE, newToken);
            logger.info('Generated new node pairing token file');
            return newToken;
        }
        throw err;
    }
}

let sessionWorkerStore: SessionWorkerStore | undefined;
let sessionWorkerSupervisor: SessionWorkerSupervisor | undefined;
let sessionWorkerIngress: SessionWorkerIngressCoordinator | undefined;
let shutdownSessionWorkers: (() => Promise<void>) | undefined;

async function start() {
    const templatesDir = path.join(BASE_DIR, 'templates', 'main', 'memory');
    const legacyMainSystemPromptPath = path.join(MAIN_AGENT_MEMORY_DIR, '00_SYSTEM.md');

    if (DATA_ROOT_DIR !== BASE_DIR) {
        logger.info(`Using experimental external data root: ${DATA_ROOT_DIR}`);
    }

    // Ensure agents directory exists
    await fs.ensureDir(AGENTS_DIR);

    // Initialize the framework-level system prompt for fresh installs. Existing
    // legacy installs may still carry agents/main/memory/00_SYSTEM.md; keep that
    // as the runtime fallback instead of silently creating a competing root file.
    if (!await fs.pathExists(AGENTS_SYSTEM_PROMPT_PATH)) {
        if (await fs.pathExists(legacyMainSystemPromptPath)) {
            logger.info('Legacy main agent 00_SYSTEM.md found; using it as framework prompt fallback until migrated to agents/00_SYSTEM.md');
        } else if (await fs.pathExists(AGENTS_SYSTEM_PROMPT_TEMPLATE_PATH)) {
            logger.info('Framework system prompt not found, copying from template...');
            await fs.copy(AGENTS_SYSTEM_PROMPT_TEMPLATE_PATH, AGENTS_SYSTEM_PROMPT_PATH, { overwrite: false });
            logger.info('Framework system prompt initialized from template');
        }
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

    // Complete authoritative SQLite/data migrations before a vector child is
    // allowed to open archive checkpoints or LanceDB.
    await sessionManager.loadSessions();

    // Session-worker placement: assemble the durable ownership/mailbox store,
    // supervisor, and closed ingress coordinator before any consumer starts.
    if (SESSION_WORKERS_ENABLED) {
        sessionWorkerStore = new SessionWorkerStore();
        sessionWorkerStore.open();
        const sourceContexts = new SessionWorkerSourceContextRegistry();
        sessionWorkerSupervisor = new SessionWorkerSupervisor({
            store: sessionWorkerStore,
            idleMs: SESSION_WORKERS_CONFIG.idleSeconds * 1000,
            shouldRestart: () => true,
            resolveExactFinalSourceContext: sourceContexts.resolve,
        });
        await sessionWorkerSupervisor.reconcileStartupOwnerships();
        sessionWorkerIngress = new SessionWorkerIngressCoordinator(
            sessionWorkerStore,
            sessionWorkerSupervisor,
            sourceContexts,
            (sessionId) => sessionManager.resolveLoadedSessionId(sessionId),
        );
        sessionManager.setSessionWorkerEnqueueSink(
            (sessionId, item) => sessionWorkerIngress!.submitEnsuringWorker(sessionId, item).then(() => {}),
        );
        shutdownSessionWorkers = async () => {
            sessionManager.setSessionWorkerEnqueueSink(undefined);
            await sessionWorkerSupervisor!.shutdown();
            sessionWorkerStore!.close();
        };
    }

    // Session consumers use the placement-neutral DTO service regardless of
    // whether sessions execute locally or in supervised child workers.
    await sessionRuntime.initializeSessionRuntime(
        sessionWorkerStore && sessionWorkerSupervisor && sessionWorkerIngress
            ? { worker: { store: sessionWorkerStore, registry: sessionWorkerSupervisor.projectionRegistry, ingress: sessionWorkerIngress } }
            : undefined,
    );
    await mainManagementTools.initializeMainManagementTools();
    await nodeExecution.initializeNodeExecution();
    await mcpExternal.initializeMcpExternalService();

    // Initialize the vector owner locally or in its configured child process.
    // Startup readiness means the table is open; archive backfill continues in
    // the background in either placement.
    await vector.init({ useWorker: DB_WORKERS_ENABLED });

    await initializeExecManager();

    // Ensure "main" session exists
    await sessionManager.getSession('main');
    logger.info('Main session initialized');

    await sessionRuntime.startEvents();

    // Create message router with authorized users
    const authorizedUsers: Array<{ platform: string; userId: string }> = [];
    
    for (const entry of getNormalizedChannelConfigs()) {
        const config: any = entry.config || {};
        const allowedUsers: string[] = Array.isArray(config.allowedUsers) ? config.allowedUsers : [];
        const allowAllUsers = config.allowAllUsers === true;

        if (entry.type === 'telegram' && config.mainAttachUser) {
            authorizedUsers.push({ platform: entry.id, userId: config.mainAttachUser });
        }

        if (entry.type === 'matrix' && config.botUserId) {
            authorizedUsers.push({ platform: entry.id, userId: config.botUserId });
        }

        if (allowAllUsers) {
            authorizedUsers.push({ platform: entry.id, userId: '*' });
            logger.info({ channelId: entry.id, type: entry.type }, 'Channel configured to allow all users');
        }

        for (const user of allowedUsers) {
            authorizedUsers.push({ platform: entry.id, userId: user });
            logger.info({ channelId: entry.id, type: entry.type, user }, 'Added channel user to whitelist');
        }
    }
    
    // Always allow WebUI and TUI
    authorizedUsers.push({ platform: 'webui', userId: 'webui' });
    authorizedUsers.push({ platform: 'tui', userId: 'tui' });
    
    const router = new MessageRouter(
        authorizedUsers,
        SESSION_WORKERS_ENABLED
            ? (sessionId, item, ctx) => sessionRuntime.submitAndRun(sessionId, item, ctx)
            : undefined,
    );
    const commandHandler = new CommandHandler(router);
    initializeChannelRuntime(
        (ctx, message) => router.handleMessage(ctx, message),
        (ctx, command, args, rawArgs) => commandHandler.handleCommand(ctx, command, args, rawArgs),
    );
    
    // Set command handler in router and give commandHandler access to router
    router.setCommandHandler((ctx, command, args, rawArgs) => commandHandler.handleCommand(ctx, command, args, rawArgs));

    // Set up TUI channel handlers
    if (tuiChannel) {
        tuiChannel.onMessage((ctx, message) => router.handleMessage(ctx, message));
        tuiChannel.onCommand((ctx, command, args, rawArgs) => commandHandler.handleCommand(ctx, command, args, rawArgs));
    }

    // Set up session event callbacks (for background processes, child sessions, etc.)
    sessionManager.setSessionTriggerCallback(
        (sessionId) => router.processSessionQueue(sessionId)
    );
    sessionManager.setSessionRetryCallback(
        (sessionId) => router.processSessionRetry(sessionId)
    );

    await initializeTimers();

    // Start unified HTTP server (WebUI + Trigger + Nodes)
    let webuiChannel: WebUIChannel | null = null;
    if (ENABLE_WEBUI || ENABLE_TRIGGER) {
        const token = await ensureToken();
        const nodeToken = await ensureNodeToken();
        await initializeNodeRegistry();
        
        // Create HTTP server instance
        const httpServerInstance = new HttpServer(HTTP_PORT, token);
        setHttpServer(httpServerInstance);
        
        // Add nodes WebSocket handler to HTTP server
        registerNodeWebSocket(httpServerInstance, nodeToken);
        registerNodeHttpRoutes(httpServerInstance);
        
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
        
        // Bridge transport-neutral SessionRuntime events into WebUI SSE.
        sessionRuntime.subscribe((eventName, payload: any) => {
            if (eventName === 'history') {
                webuiChannel!.broadcastMessage(payload.sessionId, payload.message);
            } else if (eventName === 'stream') {
                webuiChannel!.broadcastSessionEvent(payload.sessionId, payload.event);
            } else if (eventName === 'listChanged') {
                webuiChannel!.broadcastSessionListUpdate();
            } else if (eventName === 'stateChanged') {
                webuiChannel!.broadcastSessionStateUpdate(payload.sessionId, payload.session);
            }
        });
    } else {
        logger.info('HTTP server disabled (both WebUI and Trigger are disabled)');
    }

    const defaultTelegramEntry = getDefaultChannelConfigByType<TelegramConfig>('telegram');
    const telegramChannelPromise: Promise<TelegramChannel | null> = (defaultTelegramEntry?.config?.enabled !== false && defaultTelegramEntry?.config?.botToken)
        ? startWithRetry(`telegram:${defaultTelegramEntry.id}`, async () => {
            const channel = new TelegramChannel(defaultTelegramEntry.config, defaultTelegramEntry.id);
            channel.onMessage((ctx, message) => router.handleMessage(ctx, message));
            channel.onCommand((ctx, command, args, rawArgs) => commandHandler.handleCommand(ctx, command, args, rawArgs));
            await channel.start();
            registerChannel(defaultTelegramEntry.id, channel);
            logger.info({ channelId: defaultTelegramEntry.id }, 'Telegram channel initialized');

            if (defaultTelegramEntry.config.mainAttachUser) {
                sessionManager.attachChannel(defaultTelegramEntry.id, defaultTelegramEntry.config.mainAttachUser, 'main');
            }

            return channel;
        }, { retries: 3, delayMs: 5000 })
        : Promise.resolve(null);

    for (const entry of getNormalizedChannelConfigs()) {
        const config: any = entry.config || {};
        if (entry.type === 'telegram') {
            if (defaultTelegramEntry?.id === entry.id) continue;
            if (config.enabled === false || !config.botToken) continue;
            void startWithRetry(`telegram:${entry.id}`, async () => {
                const channel = new TelegramChannel(config, entry.id);
                channel.onMessage((ctx, message) => router.handleMessage(ctx, message));
                channel.onCommand((ctx, command, args, rawArgs) => commandHandler.handleCommand(ctx, command, args, rawArgs));
                await channel.start();
                registerChannel(entry.id, channel);
                logger.info({ channelId: entry.id }, 'Telegram channel initialized');
                if (config.mainAttachUser) {
                    sessionManager.attachChannel(entry.id, config.mainAttachUser, 'main');
                }
                return channel;
            }, { retries: 3, delayMs: 5000 });
            continue;
        }

        if (entry.type === 'matrix') {
            if (config.enabled === false || !config.homeserver || !config.accessToken || !config.botUserId) continue;
            void startWithRetry(`matrix:${entry.id}`, async () => {
                const matrixChannel = new MatrixChannel(config, entry.id);
                matrixChannel.onMessage((ctx, message) => router.handleMessage(ctx, message));
                await matrixChannel.start();
                registerChannel(entry.id, matrixChannel);
                logger.info({ channelId: entry.id }, 'Matrix channel initialized');
                sessionManager.attachChannel(entry.id, config.botUserId, 'main');
                return matrixChannel;
            }, { retries: 1, delayMs: 3000 });
            continue;
        }

        if (entry.type === 'wework') {
            if (config.enabled === false || !isWeWorkChannelConfigReady(config)) continue;
            void startWithRetry(`wework:${entry.id}`, async () => {
                const weworkChannel = new WeWorkWebhookChannel(config, entry.id);
                weworkChannel.onMessage((ctx, message) => router.handleMessage(ctx, message));
                await weworkChannel.start();
                registerChannel(entry.id, weworkChannel);
                logger.info({ channelId: entry.id }, 'WeWork Webhook channel initialized');
                return weworkChannel;
            }, { retries: 1, delayMs: 3000 });
            continue;
        }

        if (entry.type === 'weixin') {
            if (config.enabled === false) continue;
            if (config.token?.trim()) {
                void startWithRetry(`weixin:${entry.id}`, async () => {
                    const result = await startManagedChannel(entry.id);
                    logger.info({ channelId: entry.id }, 'Weixin channel initialized');
                    return result.status;
                }, { retries: 1, delayMs: 3000 });
            } else if (config.baseUrl || config.enabled) {
                logger.info({ channelId: entry.id }, 'Weixin channel configured without token; use /weixin login and foxwarm will start it dynamically once config is ready');
            }
            continue;
        }

        if (entry.type === 'qqbot') {
            if (config.enabled === false) continue;
            if (config.appId?.trim() && config.clientSecret?.trim()) {
                void startWithRetry(`qqbot:${entry.id}`, async () => {
                    const result = await startManagedChannel(entry.id);
                    logger.info({ channelId: entry.id }, 'QQ Bot channel initialized');
                    return result.status;
                }, { retries: 1, delayMs: 3000 });
            } else if (config.appId || config.enabled) {
                logger.info({ channelId: entry.id }, 'QQ Bot channel configured without appId/clientSecret; use /channel status after adding official QQ Bot credentials');
            }
        }
    }

    logger.info('Foxwarm started successfully');

    // Resume busy sessions after restart (must be after callback is set)
    await sessionManager.resumeBusySessions();

    // Durable Worker mailbox intents survive restarts; ensure their owners and
    // run the pending prefix. Per-session failures keep the work retryable.
    if (sessionWorkerStore && sessionWorkerSupervisor) {
        void resumeSessionWorkerPendingIntents(sessionWorkerStore, sessionWorkerSupervisor);
    }

    // Schedule log rotation (start immediately and every 10 hours)
    scheduleLogRotation();

    // Handle ONBOOT.md
    await handleOnboot(telegramChannelPromise);
    
    // In TUI mode, keep the process running
    if (ENABLE_TUI) {
        // Process will stay alive due to blessed screen event loop
        await new Promise(() => {}); // Never resolves
    }
}

async function handleOnboot(telegramChannelPromise: Promise<TelegramChannel | null>) {
    try {
        if (await fs.pathExists(ONBOOT_FILE)) {
            const onbootContent = await fs.readFile(ONBOOT_FILE, 'utf8');
            if (onbootContent && onbootContent.trim().length > 0) {
                logger.info('ONBOOT.md found, triggering auto-run after 3 seconds...');
                await new Promise(r => setTimeout(r, 3000));

                // Send notification via Telegram if available.
                // The telegram channel may still be starting in the background.
                if (TELEGRAM_CONFIG.mainAttachUser) {
                    void telegramChannelPromise.then((telegramChannel) => {
                        if (!telegramChannel) {
                            return;
                        }

                        return telegramChannel.sendMessage(TELEGRAM_CONFIG.mainAttachUser!, '📋 ONBOOT: ' + onbootContent);
                    }).catch((err: Error) => {
                        logger.error({ err }, 'Failed to send ONBOOT notification via Telegram');
                    });
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

let shutdownStarted = false;
for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => {
        if (shutdownStarted) return;
        shutdownStarted = true;
        void Promise.resolve()
            .then(() => shutdownSessionWorkers?.())
            .catch((err: Error) => logger.error({ err, signal }, 'Failed to shut down session workers cleanly'))
            .then(() => nodeExecution.shutdownNodeExecution())
            .catch((err: Error) => logger.error({ err, signal }, 'Failed to shut down node execution cleanly'))
            .then(() => mcpExternal.shutdownMcpExternalService())
            .catch((err: Error) => logger.error({ err, signal }, 'Failed to shut down MCP external service cleanly'))
            .then(() => mainManagementTools.shutdownMainManagementTools())
            .catch((err: Error) => logger.error({ err, signal }, 'Failed to shut down main management tools cleanly'))
            .then(() => sessionRuntime.shutdownSessionRuntime())
            .catch((err: Error) => logger.error({ err, signal }, 'Failed to shut down session runtime cleanly'))
            .then(() => vector.shutdown())
            .catch((err: Error) => logger.error({ err, signal }, 'Failed to shut down vector service cleanly'))
            .finally(() => process.exit(0));
    });
}

start().catch((err: Error) => {
    logger.error({ err }, 'Failed to start:');
    process.exit(1);
});
