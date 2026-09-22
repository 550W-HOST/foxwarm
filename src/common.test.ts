import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

const CHILD_TIMEOUT_MS = 5_000;

async function runLoggerChild(dataRoot: string, marker: string): Promise<{ stdout: string; stderr: string }> {
    const commonPath = require.resolve('./common');
    const script = `
        const { logger } = require(${JSON.stringify(commonPath)});
        logger.info({ marker: ${JSON.stringify(marker)} }, ${JSON.stringify(marker)});
    `;
    const env: NodeJS.ProcessEnv = { ...process.env, FOXWARM_DATA_DIR: dataRoot };
    for (const key of [
        'FOXWARM_SYNC_FILE_LOG',
        'FOXWARM_NO_CONSOLE_LOG',
        'FOXWARM_LOG_STDERR',
        'FOXWARM_TEST_PROCESS_ROOT',
        'NODE_TEST_CONTEXT',
    ]) delete env[key];

    const child = spawn(process.execPath, ['-e', script], {
        cwd: path.dirname(__dirname),
        env,
        stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.setEncoding('utf8').on('data', chunk => { stdout += chunk; });
    child.stderr.setEncoding('utf8').on('data', chunk => { stderr += chunk; });

    return await new Promise((resolve, reject) => {
        let timedOut = false;
        const timer = setTimeout(() => {
            timedOut = true;
            child.kill('SIGKILL');
        }, CHILD_TIMEOUT_MS);
        child.once('error', error => {
            clearTimeout(timer);
            reject(error);
        });
        child.once('close', (code, signal) => {
            clearTimeout(timer);
            if (timedOut) {
                reject(new Error(`Logger child did not exit within ${CHILD_TIMEOUT_MS}ms.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
                return;
            }
            if (code !== 0 || signal) {
                reject(new Error(`Logger child exited with code ${code} and signal ${signal}.\nstdout:\n${stdout}\nstderr:\n${stderr}`));
                return;
            }
            resolve({ stdout, stderr });
        });
    });
}

test('async logger creates its file directory, preserves the final record, and exits naturally', async () => {
    const dataRoot = await fs.mkdtemp(path.join(os.tmpdir(), 'foxwarm-async-logger-'));
    const marker = `async-logger-final-${process.pid}`;
    try {
        const result = await runLoggerChild(dataRoot, marker);
        assert.match(result.stdout, new RegExp(marker));
        const fileLog = await fs.readFile(path.join(dataRoot, 'state', 'logs', 'foxwarm.log'), 'utf8');
        assert.match(fileLog, new RegExp(marker));
    } finally {
        await fs.rm(dataRoot, { recursive: true, force: true });
    }
});
