import test from 'node:test';
import assert from 'node:assert/strict';
import { buildArchiveSegments, createRowsFromSegment } from './vector';

type Role = 'user' | 'model' | 'tool';

function makeArchiveLine(seq: number, text: string, role: Role = 'user') {
    return {
        v: 1,
        kind: 'message' as const,
        sessionId: 'test/session',
        agent: 'test-agent',
        seq,
        timestamp: 1700000000000 + seq,
        role,
        message: {
            role,
            parts: [{ text }],
            __meta: {
                seq,
                timestamp: 1700000000000 + seq,
            },
        },
    };
}

test('buildArchiveSegments groups multiple short messages into one segment', () => {
    const lines = [
        makeArchiveLine(1, 'hello'),
        makeArchiveLine(2, 'world'),
        makeArchiveLine(3, 'again'),
    ];

    const segments = buildArchiveSegments(lines);
    assert.equal(segments.length, 1);
    assert.equal(segments[0].startSeq, 1);
    assert.equal(segments[0].endSeq, 3);
    assert.equal(segments[0].messageCount, 3);
});

test('buildArchiveSegments overlaps by token budget on the segment tail', () => {
    const mediumMessage = 'a'.repeat(1200);
    const lines = Array.from({ length: 10 }, (_, index) => makeArchiveLine(index + 1, mediumMessage));

    const segments = buildArchiveSegments(lines);
    assert.equal(segments.length, 5);
    assert.equal(segments[0].startSeq, 1);
    assert.equal(segments[0].endSeq, 3);
    assert.equal(segments[1].startSeq, 3);
    assert.equal(segments[1].endSeq, 5);
});

test('overlap does not cross a long message that would dominate overlap budget', () => {
    const mediumMessage = 'b'.repeat(1200);
    const longMessage = 'c'.repeat(2200);
    const lines = [
        makeArchiveLine(1, mediumMessage),
        makeArchiveLine(2, mediumMessage),
        makeArchiveLine(3, mediumMessage),
        makeArchiveLine(4, mediumMessage),
        makeArchiveLine(5, longMessage),
        makeArchiveLine(6, mediumMessage),
        makeArchiveLine(7, mediumMessage),
        makeArchiveLine(8, mediumMessage),
        makeArchiveLine(9, mediumMessage),
    ];

    const segments = buildArchiveSegments(lines);
    const longMessageSegmentIndex = segments.findIndex(segment => segment.endSeq === 5);
    assert.ok(longMessageSegmentIndex >= 0, 'expected a segment that ends with the long message');
    assert.equal(segments[longMessageSegmentIndex + 1]?.startSeq, 6);
    assert.notEqual(segments[longMessageSegmentIndex + 1]?.startSeq, 5);
});

test('single oversized message becomes a single segment with multiple embedding rows', () => {
    const oversizedMessage = 'z'.repeat(12000);
    const [segment] = buildArchiveSegments([makeArchiveLine(1, oversizedMessage)]);
    const rows = createRowsFromSegment(segment);

    assert.equal(segment.startSeq, 1);
    assert.equal(segment.endSeq, 1);
    assert.ok(rows.length > 1);
    assert.ok(rows.every(row => row.chunk_count === rows.length));
});
