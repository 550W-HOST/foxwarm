import { readFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { collectOpenAIResponsesStream } from '../../src/llmProviders/openai';

type Case = { name: string; events: any[]; chunks: string[] };
const corpus = JSON.parse(readFileSync(new URL('./responses-stream-corpus.json', import.meta.url), 'utf8')) as Case[];

function clone<T>(value: T): T { return structuredClone(value); }
function normalizeError(error: any, item: Case) {
  if (error?.name === 'AbortError' || error?.code === 'ERR_CANCELED') return { category: 'cancellation' };
  if (String(error?.message || '').startsWith('OpenAI Responses stream ended before response.completed.')) return { category: 'eof-before-completed', message: error.message };
  if (error instanceof SyntaxError) return { category: 'malformed-json', message: 'Malformed OpenAI Responses SSE event JSON.' };
  const terminal = item.events.find(event => ['response.failed', 'response.incomplete', 'response.error', 'error'].includes(event.type));
  const source = terminal?.type === 'response.failed' || terminal?.type === 'response.incomplete' ? terminal.response : terminal?.type === 'response.error' ? terminal.error : terminal;
  const detail = source?.error && typeof source.error === 'object' ? source.error : source;
  const message = detail?.message || source?.message || detail?.label || (
    terminal?.type === 'response.failed' ? 'OpenAI Responses request failed.' :
    terminal?.type === 'response.incomplete' ? 'OpenAI Responses request was incomplete.' : 'OpenAI Responses stream error.');
  const status = detail?.status ?? source?.status;
  const code = detail?.code ?? source?.code;
  return { category: 'provider-terminal', kind: terminal?.type, message, ...(status === undefined ? {} : { status: String(status) }), ...(code === undefined ? {} : { code: String(code) }) };
}

async function main() {
const results = [];
for (const item of corpus) {
  const stream = new PassThrough();
  const progress: any[] = []; const safety: any[] = []; const blocks: string[] = []; let decodedRaw = ''; let meaningfulCount = 0;
  const promise = collectOpenAIResponsesStream(stream, new AbortController().signal, {
    onProgress: snapshot => progress.push(clone(snapshot)),
    onMeaningfulProgress: () => { meaningfulCount += 1; },
    onSafetyBuffering: metadata => safety.push(clone(metadata)),
    onRawChunk: text => { decodedRaw += text; },
    onRawSseBlock: block => blocks.push(block),
  });
  process.nextTick(() => { for (const chunk of item.chunks) stream.write(Buffer.from(chunk, 'utf8')); stream.end(); });
  let observation: any;
  try {
    const final = await promise;
    observation = { status: 'success', final: clone(final), progress, meaningfulCount, safety, decodedRaw, blocks };
  } catch (error) {
    observation = { status: 'error', error: normalizeError(error, item), progress, meaningfulCount, safety, decodedRaw, blocks };
  }
  results.push({ name: item.name, observation });
}
process.stdout.write(JSON.stringify(results));
}
main();
