import './testEnvironment';
import test from 'node:test';
import assert from 'node:assert/strict';
import axios from 'axios';
import { PassThrough } from 'node:stream';
import { requestLlmOnce } from './llm';
import { HOSTED_SEARCH_SOURCES_INCLUDE } from './llmSearchSources';
import type { Message } from './types';

const source = { type: 'url', url: 'https://example.com/actual-source', title: 'Source title' };
const searchItem = { type: 'web_search_call', id: 'ws_real', status: 'completed', action: { type: 'search', sources: [source] } };
const textItem = { type: 'message', role: 'assistant', phase: 'final_answer', content: [{ type: 'output_text', text: 'Answer.' }] };
const localItem = { type: 'function_call', id: 'fc_real', call_id: 'local_real', name: 'read', arguments: '{}' };
function eventsStream(events: any[]): PassThrough {
    const stream = new PassThrough();
    process.nextTick(() => { for (const event of events) stream.write(`data: ${JSON.stringify(event)}\n\n`); stream.end(); });
    return stream;
}
function responseStream(output = [textItem] as any[]) {
    return eventsStream([{ type: 'response.completed', response: { id: 'resp_fixture', output, usage: { input_tokens: 3, output_tokens: 4 } } }]);
}
function entry(overrides: Record<string, any> = {}): any {
    return { providerKey: 'fixture', providerType: 'openai-responses', baseUrl: 'https://fixture.example/v1', model: 'source',
        effort: { allowed: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], default: 'high' },
        webSearch: { enabled: true }, extraFields: {}, extraHeaders: {}, ...overrides };
}
function request(overrides: Record<string, any> = {}) {
    return requestLlmOnce({ contents: [{ role: 'user', parts: [{ text: 'Search then check a local file.' }] }], systemPrompt: '',
        modelEntryOverride: entry(), toolDefinitions: [{ name: 'read', description: 'Read', parameters: { type: 'object', properties: {} } }],
        notifySessionEvents: false, registerAbortController: false, maxRetries: 1, ...overrides });
}
function capture(factory: (body: any, index: number) => any = () => responseStream()) {
    const original = axios.post;
    const bodies: any[] = [];
    (axios as any).post = async (_url: string, body: any) => {
        bodies.push(body);
        return { status: 200, statusText: 'OK', headers: {}, data: factory(body, bodies.length - 1) };
    };
    return { bodies, restore: () => { (axios as any).post = original; } };
}

for (const effort of ['none', 'high']) {
    test(`sources include is merged after extraFields and ${effort} effort without losing custom includes`, async () => {
        const cap = capture();
        try {
            for (const extraFields of [{}, { include: ['message.output_text.logprobs', 'reasoning.encrypted_content'] }, { include: [HOSTED_SEARCH_SOURCES_INCLUDE] }]) {
                await request({ effort, modelEntryOverride: entry({ extraFields }) });
            }
            for (const body of cap.bodies) {
                assert.equal(body.include.filter((value: string) => value === HOSTED_SEARCH_SOURCES_INCLUDE).length, 1);
                assert.equal(body.include.includes('reasoning.encrypted_content'), effort !== 'none');
            }
            assert.ok(cap.bodies[1].include.includes('message.output_text.logprobs'));
        } finally { cap.restore(); }
    });
}

test('sources include follows the actual hosted tool declaration and is absent for disabled/compact requests', async () => {
    const cap = capture();
    try {
        await request({ modelEntryOverride: entry({ webSearch: { enabled: false } }) });
        await request({ purpose: 'compact-plan' });
        await request({ modelEntryOverride: entry({ extraFields: { tools: [] } }) });
        await request({ modelEntryOverride: entry({ webSearch: { enabled: false }, extraFields: { tools: [{ type: 'web_search_preview' }] } }) });
        assert.ok(cap.bodies.slice(0, 3).every(body => !body.include?.includes(HOSTED_SEARCH_SOURCES_INCLUDE)));
        assert.ok(cap.bodies[3].include.includes(HOSTED_SEARCH_SOURCES_INCLUDE));
    } finally { cap.restore(); }
});

test('search → local tool → reply retains sources and hands off safe evidence for same and switched models', async () => {
    const cap = capture((_body, index) => index === 0 ? eventsStream([
        { type: 'response.output_item.done', output_index: 0, item: searchItem },
        { type: 'response.output_item.done', output_index: 1, item: localItem },
        { type: 'response.completed', response: { output: [{ ...searchItem, action: { type: 'search', sources: [] } }, localItem] } },
    ]) : responseStream());
    try {
        const searched = await request();
        assert.equal(searched.toolCalls.length, 1);
        const metadata = searched.allParts.find(part => part.providerMeta?.openaiResponses?.outputItem?.type === 'web_search_call');
        assert.deepEqual(metadata.providerMeta.openaiResponses.outputItem.action.sources, [source]);
        const messages: Message[] = [
            { role: 'user', parts: [{ text: 'Search then check a local file.' }] },
            { role: 'model', __meta: { modelId: searched.modelId, llmRequestId: searched.llmRequestId }, parts: searched.allParts },
            { role: 'tool', parts: [{ functionResponse: { name: 'read', tool_use_id: 'local_real', response: { output: 'Checked.' } } }] },
        ];
        const before = structuredClone(messages);
        await request({ contents: messages });
        await request({ contents: messages, modelEntryOverride: entry({ model: 'other' }) });
        await request({ contents: messages });
        assert.deepEqual(messages, before);
        for (const body of cap.bodies.slice(1)) {
            const text = body.input.flatMap((item: any) => item.content || []).map((part: any) => part.text || '').join('\n');
            assert.match(text, /https:\/\/example.com\/actual-source/);
            assert.match(text, /Source title/);
            assert.equal((text.match(/Historical hosted web-search source data/g) || []).length, 1);
            assert.doesNotMatch(text, /turn\d+search\d+/);
            assert.ok(body.input.some((item: any) => item.type === 'function_call_output' && item.call_id === 'local_real'));
        }
        assert.equal(cap.bodies[1].input.filter((item: any) => item.type === 'web_search_call').length, 1);
        assert.equal(cap.bodies[2].input.filter((item: any) => item.type === 'web_search_call').length, 0);
        assert.deepEqual(cap.bodies[1].input, cap.bodies[3].input);
    } finally { cap.restore(); }
});

test('early commentary cannot freeze a search item before final-only sources arrive', async () => {
    const commentary = { ...textItem, phase: 'commentary' };
    const cap = capture(() => eventsStream([
        { type: 'response.output_item.done', output_index: 0, item: { ...searchItem, action: { type: 'search' } } },
        { type: 'response.output_item.done', output_index: 1, item: commentary },
        { type: 'response.output_item.done', output_index: 2, item: localItem },
        { type: 'response.completed', response: { output: [searchItem, commentary, localItem] } },
    ]));
    const committed: Message[] = [];
    try {
        const result = await request({ purpose: 'normal-turn',
            getCommittedHistoryForRetry: () => committed,
            onPartialAssistantCommit: async (segment: any) => {
                const message: Message = { role: 'model', parts: segment.parts };
                committed.push(message);
                return message;
            },
        });
        assert.deepEqual(committed, []);
        const search = result.allParts.find(part => part.providerMeta?.openaiResponses?.outputItem?.type === 'web_search_call');
        assert.deepEqual(search.providerMeta.openaiResponses.outputItem.action.sources, [source]);
        assert.equal(result.toolCalls.length, 1);
    } finally { cap.restore(); }
});
