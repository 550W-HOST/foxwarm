import crypto from 'crypto';
import { canonicalJournalJson, hashJournalValue } from '../llmRequestJournal';
import type { Message } from '../types';

const PREFIX_DOMAIN = 'foxwarm-openai-responses-ws-prefix-v1';

export type OpenAIWsHistoryAppendOutcome =
    | { appended: true; message: Message }
    | { appended: false };

export type OpenAIWsHistoryAppendFinalizer = (outcome: OpenAIWsHistoryAppendOutcome) => void;

export type OpenAIWsPrefixHash = {
    hash: string;
    itemCount: number;
};

export type OpenAIWsRequestFingerprint = {
    invariantHash: string;
    prefixes: OpenAIWsPrefixHash[];
    finalPrefix: OpenAIWsPrefixHash;
};

export type OpenAIWsCompletedChain<Resource> = {
    id: string;
    resource: Resource;
    connectionFingerprint: string;
    invariantHash: string;
    expectedPrefixHash: string;
    expectedPrefixItemCount: number;
    previousResponseId: string;
    createdAt: number;
    lastUsedAt: number;
};

export type OpenAIWsChainMatch<Resource> = {
    chain: OpenAIWsCompletedChain<Resource>;
    appendFromItemIndex: number;
};

function sha256(value: string): string {
    return crypto.createHash('sha256').update(value).digest('hex');
}

function appendPrefix(previousHash: string, item: unknown, itemCount: number): OpenAIWsPrefixHash {
    const hash = sha256(`${PREFIX_DOMAIN}\0${previousHash}\0${itemCount}\0${canonicalJournalJson(item)}`);
    return { hash, itemCount };
}

/**
 * Fingerprint the complete provider-visible Responses request after history
 * repair, concrete-model filtering, image hydration/deduplication, extra
 * fields, effort mapping, and payload sanitation. Transport-owned fields are
 * excluded; every other request field is conservatively part of the chain
 * compatibility boundary.
 */
export function fingerprintOpenAIWsRequest(data: Record<string, any>): OpenAIWsRequestFingerprint {
    const { input: rawInput, previous_response_id: _previousResponseId, stream: _stream, ...invariants } = data;
    const input = Array.isArray(rawInput) ? rawInput : [];
    const invariantHash = hashJournalValue(invariants);
    const prefixes: OpenAIWsPrefixHash[] = [];
    let current: OpenAIWsPrefixHash = {
        hash: sha256(`${PREFIX_DOMAIN}\0${invariantHash}`),
        itemCount: 0,
    };

    for (const item of input) {
        current = appendPrefix(current.hash, item, current.itemCount + 1);
        prefixes.push(current);
    }

    return { invariantHash, prefixes, finalPrefix: current };
}

/** Extend a completed request prefix with the exact assistant Message replay projection. */
export function extendOpenAIWsPrefix(
    prefix: OpenAIWsPrefixHash,
    replayItems: readonly unknown[],
): OpenAIWsPrefixHash {
    let current = prefix;
    for (const item of replayItems) {
        current = appendPrefix(current.hash, item, current.itemCount + 1);
    }
    return current;
}

/**
 * Process-local idle-chain pool. A chain is removed while leased, so active
 * requests do not consume the completed-idle retention limit. The caller owns
 * connection health, ambiguous-send handling, and once-only finalization.
 */
export class OpenAIWsCompletedChainPool<Resource> {
    private readonly idle: OpenAIWsCompletedChain<Resource>[] = [];

    constructor(private readonly closeResource: (resource: Resource) => void) {}

    takeLongest(
        connectionFingerprint: string,
        request: OpenAIWsRequestFingerprint,
    ): OpenAIWsChainMatch<Resource> | undefined {
        const requestHashesByCount = new Map(request.prefixes.map(prefix => [prefix.itemCount, prefix.hash]));
        let selectedIndex = -1;

        for (let index = 0; index < this.idle.length; index += 1) {
            const candidate = this.idle[index];
            if (candidate.connectionFingerprint !== connectionFingerprint
                || candidate.invariantHash !== request.invariantHash
                || requestHashesByCount.get(candidate.expectedPrefixItemCount) !== candidate.expectedPrefixHash) {
                continue;
            }
            if (selectedIndex < 0) {
                selectedIndex = index;
                continue;
            }
            const selected = this.idle[selectedIndex];
            if (candidate.expectedPrefixItemCount > selected.expectedPrefixItemCount
                || (candidate.expectedPrefixItemCount === selected.expectedPrefixItemCount
                    && candidate.lastUsedAt > selected.lastUsedAt)) {
                selectedIndex = index;
            }
        }

        if (selectedIndex < 0) return undefined;
        const [chain] = this.idle.splice(selectedIndex, 1);
        return { chain, appendFromItemIndex: chain.expectedPrefixItemCount };
    }

    release(chain: OpenAIWsCompletedChain<Resource>, maxIdle: number): void {
        if (!Number.isSafeInteger(maxIdle) || maxIdle < 0) {
            throw new Error('OpenAI Responses WebSocket idle-chain limit must be a non-negative integer.');
        }
        const duplicateIndex = this.idle.findIndex(candidate => candidate.id === chain.id);
        if (duplicateIndex >= 0) {
            const [duplicate] = this.idle.splice(duplicateIndex, 1);
            if (duplicate.resource !== chain.resource) this.safeClose(duplicate.resource);
        }
        this.idle.push(chain);
        this.idle.sort((left, right) => right.lastUsedAt - left.lastUsedAt);
        while (this.idle.length > maxIdle) {
            const evicted = this.idle.pop();
            if (evicted) this.safeClose(evicted.resource);
        }
    }

    remove(id: string): OpenAIWsCompletedChain<Resource> | undefined {
        const index = this.idle.findIndex(candidate => candidate.id === id);
        if (index < 0) return undefined;
        return this.idle.splice(index, 1)[0];
    }

    clear(): void {
        for (const chain of this.idle.splice(0)) this.safeClose(chain.resource);
    }

    get size(): number {
        return this.idle.length;
    }

    private safeClose(resource: Resource): void {
        try {
            this.closeResource(resource);
        } catch {
            // Pool eviction is best-effort optimization cleanup. Transport
            // owners retain their own error diagnostics and close handling.
        }
    }
}