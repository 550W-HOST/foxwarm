import path from 'path';
import pino from 'pino';
import { LOGS_DIR } from './config';

const LOG_DIR = LOGS_DIR;

// Check if TUI mode is enabled
const ENABLE_TUI = process.env.ENABLE_TUI === 'true' || process.argv.includes('--tui');

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
const logFileName = process.env.BOT_NAME ? `${process.env.BOT_NAME}.log` : 'foxwarm.log';
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
