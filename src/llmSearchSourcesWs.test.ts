import './testEnvironment';
import test from 'node:test';
import assert from 'node:assert/strict';
import { EventEmitter } from 'node:events';
import WebSocket from 'ws';
import * as config from './config';
import { chat } from './llm';
import { clearOpenAIWsCompletedChains, getOpenAIWsCompletedChainCountForTests, setOpenAIWsTransportTestHooks } from './llmProviders/openaiWsTransport';
import type { Message, Session } from './types';

class TestSocket extends EventEmitter {
    readyState: number = WebSocket.CONNECTING;
    sent: any[] = [];
    _socket = { ref() {}, unref() {} };
    constructor(private readonly respond: (socket: TestSocket) => void) {
        super();
        process.nextTick(() => { this.readyState = WebSocket.OPEN; this.emit('open'); });
    }
    send(raw: string) { this.sent.push(JSON.parse(raw)); process.nextTick(() => this.respond(this)); }
    frame(event: unknown) { this.emit('message', Buffer.from(JSON.stringify(event))); }
    close() { this.readyState = WebSocket.CLOSED; this.emit('close', 1000, Buffer.alloc(0)); }
    terminate() { this.close(); }
}

test('WS search handoff sends evidence on a fresh request rather than pretending it was cached output', async () => {
    const modelId = 'search-fixture/model';
    const modelEntry: any = { providerKey: 'search-fixture', providerType: 'openai-ws', baseUrl: 'https://fixture.example/v1',
        model: 'model', webSearch: { enabled: true }, extraFields: {}, extraHeaders: {} };
    const modelsConfig: any = { default: modelId, models: { [modelId]: modelEntry } };
    const originalResolve = config.resolveModelConfig;
    (config as any).resolveModelConfig = () => ({ modelsConfig, defaultKey: modelId, currentKey: modelId, modelEntry, contextLimit: 128000 });
    const session = { id: 'search-evidence-ws', model: modelId, history: [],
        persistentMemorySnapshot: `<foxwarm-current-model model-id="${modelId}" />\n\nFixture system prompt`,
        stats: { totalCachedTokens: 0, totalInputTokens: 0, totalOutputTokens: 0, lastUsage: null },
        busy: false, queue: [], meta: { lastMessageTime: Date.now() },
    } as Session;
    const sockets: TestSocket[] = [];
    let calls = 0;
    setOpenAIWsTransportTestHooks({ socketFactory: () => {
        const socket = new TestSocket(current => {
            calls++;
            const output = calls === 1 ? [
                { type: 'web_search_call', id: 'ws_actual', status: 'completed', action: { type: 'search', sources: [{ type: 'url', url: 'https://example.com/actual' }] } },
                { type: 'function_call', id: 'fc_actual', call_id: 'local_actual', name: 'read', arguments: '{}' },
            ] : [{ type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Answer.' }] }];
            for (const [index, item] of output.entries()) current.frame({ type: 'response.output_item.done', output_index: index, item });
            current.frame({ type: 'response.completed', response: { id: `response_${calls}`, output, usage: { input_tokens: 4, output_tokens: 5 } } });
        });
        sockets.push(socket);
        return socket as any;
    } });
    const options = { toolDefinitions: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } }],
        registerAbortController: false, notifySessionEvents: false, maxRetries: 1,
        appendMessage: async (message: Message) => { session.history.push(message); },
    };
    try {
        await chat([{ text: 'Search then check locally.' }], session, 0, options);
        assert.equal(getOpenAIWsCompletedChainCountForTests(), 0);
        assert.equal(sockets[0].readyState, WebSocket.CLOSED);
        session.history.push({ role: 'tool', parts: [{ functionResponse: { name: 'read', tool_use_id: 'local_actual', response: { output: 'Checked.' } } }] });
        await chat(null, session, 1, options);
        assert.equal(sockets.length, 2);
        const handoff = sockets[1].sent[0];
        assert.equal(handoff.previous_response_id, undefined);
        assert.match(JSON.stringify(handoff.input), /Historical hosted web-search source data/);
        assert.match(JSON.stringify(handoff.input), /https:\/\/example.com\/actual/);
        assert.equal(handoff.input.filter((item: any) => item.type === 'function_call_output').length, 1);
        assert.equal(JSON.stringify(session.history).includes('Historical hosted web-search source data'), false);
        assert.equal(getOpenAIWsCompletedChainCountForTests(), 1);
        await chat([{ text: 'Continue.' }], session, 2, options);
        assert.equal(sockets.length, 2, 'ordinary exact-prefix reuse resumes after evidence has actually been sent');
        assert.equal(sockets[1].sent[1].previous_response_id, 'response_2');
        assert.equal(sockets[1].sent[1].input.length, 1);
    } finally {
        (config as any).resolveModelConfig = originalResolve;
        setOpenAIWsTransportTestHooks();
        clearOpenAIWsCompletedChains();
    }
});
