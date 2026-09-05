import test from 'node:test';
import assert from 'node:assert/strict';
import { fingerprintOpenAIWsRequest, OpenAIWsCompletedChainPool } from './openaiWsState';

function request(items: unknown[]) {
  return fingerprintOpenAIWsRequest({ model: 'm', instructions: 's', input: items, stream: true });
}

test('OpenAI WS pool selects longest exact prefix then newest equal prefix', () => {
  const closed: string[] = [];
  const pool = new OpenAIWsCompletedChainPool<string>(resource => closed.push(resource));
  const input = [{ n: 1 }, { n: 2 }, { n: 3 }];
  const fingerprint = request(input);
  const make = (id: string, count: number, lastUsedAt: number) => ({
    id, resource: id, connectionFingerprint: 'connection', invariantHash: fingerprint.invariantHash,
    expectedPrefixHash: fingerprint.prefixes[count - 1].hash, expectedPrefixItemCount: count,
    previousResponseId: `response-${id}`, createdAt: 0, lastUsedAt,
  });
  pool.release(make('short', 1, 30), 5);
  pool.release(make('long-old', 2, 10), 5);
  pool.release(make('long-new', 2, 20), 5);
  assert.equal(pool.takeLongest('connection', fingerprint)?.chain.id, 'long-new');
  assert.equal(pool.takeLongest('connection', fingerprint)?.chain.id, 'long-old');
  assert.deepEqual(closed, []);
});

test('OpenAI WS pool closes LRU entries above five and excludes leased entries from idle count', () => {
  const closed: string[] = [];
  const pool = new OpenAIWsCompletedChainPool<string>(resource => closed.push(resource));
  for (let index = 0; index < 6; index += 1) {
    const fingerprint = request([{ index }]);
    pool.release({
      id: `c${index}`, resource: `r${index}`, connectionFingerprint: `connection-${index}`,
      invariantHash: fingerprint.invariantHash, expectedPrefixHash: fingerprint.finalPrefix.hash,
      expectedPrefixItemCount: 1, previousResponseId: `response-${index}`, createdAt: index, lastUsedAt: index,
    }, 5);
  }
  assert.equal(pool.size, 5);
  assert.deepEqual(closed, ['r0']);
  const selected = request([{ index: 5 }]);
  assert.equal(pool.takeLongest('connection-5', selected)?.chain.id, 'c5');
  assert.equal(pool.size, 4);
});