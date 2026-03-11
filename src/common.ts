import path from 'path';
import pino from 'pino';
import { BOT_NAME, ENABLE_TUI, LOGS_DIR } from './config';

const LOG_DIR = LOGS_DIR;

// Configure logger based on TUI mode
const targets: any[] = [];

// Only add console output if TUI is not enabled
if (!ENABLE_TUI) {
    targets.push({
        target: 'pino-pretty',
        options: {},
    });
}

// Always log to file
const logFileName = `${BOT_NAME}.log`;
targets.push({
    target: 'pino-pretty',
    options: { destination: path.join(LOG_DIR, logFileName) }
});

export const logger = pino({
    level: 'info',
    transport: {
        targets,
    },
});
