import path from 'path';
import pino from 'pino';
import { BOT_NAME, ENABLE_TUI, LOGS_DIR } from './config';

const LOG_DIR = LOGS_DIR;

// Configure logger based on TUI mode
const targets: any[] = [];
const prettyBaseOptions = {
    singleLine: true,
};

// Skip console output when TUI is enabled or when running as interactive node client
const suppressConsole = ENABLE_TUI || !!process.env.FOXWARM_NO_CONSOLE_LOG;
if (!suppressConsole) {
    targets.push({
        target: 'pino-pretty',
        options: {
            ...prettyBaseOptions,
            // Use stderr (fd 2) when FOXWARM_LOG_STDERR is set (e.g. interactive node client)
            ...(process.env.FOXWARM_LOG_STDERR ? { destination: 2 } : {}),
        },
    });
}

// Always log to file
const logFileName = `${BOT_NAME}.log`;
targets.push({
    target: 'pino-pretty',
    options: {
        ...prettyBaseOptions,
        destination: path.join(LOG_DIR, logFileName),
    }
});

export const logger = pino({
    level: 'info',
    transport: {
        targets,
    },
});
