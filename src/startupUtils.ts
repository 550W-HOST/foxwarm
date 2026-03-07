import { logger } from './common';

const sleep = (ms: number) => new Promise(resolve => setTimeout(resolve, ms));

export async function startWithRetry<T>(
  name: string,
  startFn: () => Promise<T>,
  options: { retries?: number; delayMs?: number } = {}
): Promise<T | null> {
  const retries = options.retries ?? 0;
  const delayMs = options.delayMs ?? 5000;

  for (let attempt = 1; attempt <= retries + 1; attempt++) {
    try {
      const result = await startFn();
      if (attempt > 1) {
        logger.info({ name, attempt }, 'Component startup succeeded after retry');
      }
      return result;
    } catch (e: any) {
      logger.error({ err: e, name, attempt, retries }, 'Component startup failed');
      if (attempt > retries) {
        logger.error({ name }, 'Component disabled after startup failure');
        return null;
      }
      await sleep(delayMs);
    }
  }

  return null;
}
