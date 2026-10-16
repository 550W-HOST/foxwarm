import { randomUUID } from 'crypto';
import type { Session } from '../types';

function isValidStoredPromptCacheKey(value: unknown): value is string {
    return typeof value === 'string' && /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(value);
}

export function generatePromptCacheKey(): string {
    return randomUUID();
}

export function ensurePromptCacheKey(session: Session): string {
    if (isValidStoredPromptCacheKey(session.promptCacheKey)) {
        return session.promptCacheKey;
    }

    const promptCacheKey = generatePromptCacheKey();
    session.promptCacheKey = promptCacheKey;
    return promptCacheKey;
}

