import { promises as fs, type Stats } from 'node:fs';
import type { FileHandle } from 'node:fs/promises';
import type { HttpServer } from '../httpServer';

export const LOG_WINDOW_BYTES = 100 * 1024;
export const LOG_CATCHUP_BYTES = 2 * LOG_WINDOW_BYTES;
export const LOG_SOCKET_BUFFER_BYTES = 512 * 1024;
export type LogCursor = { fileId: string; offset: number };
export type LogSubscription = { id: string; cursor?: LogCursor };
export type LogWindow = {
  fileId: string | null; size: number; startOffset: number; endOffset: number;
  text: string; lineCount: number; startsMidLine: boolean; endsMidLine: boolean;
  pendingBytes: number; missing: boolean;
};
export class LogFileResetError extends Error {}

type Subscriber = {
  request: LogSubscription; cursor?: LogCursor; initial: boolean; stopped: boolean; lastSize?: number;
  gap: boolean; emit: (message: Record<string, unknown>) => void; canSend: () => boolean;
};

// Text is never interpreted as terminal commands or markup. Also strip OSC links.
export function cleanLogText(text: string): string {
  return text.replace(/\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/g, '');
}

function continuation(byte: number): boolean { return (byte & 0xc0) === 0x80; }
function utf8End(buffer: Buffer, end: number): number {
  if (!end) return end;
  let lead = end - 1;
  while (lead > 0 && continuation(buffer[lead]) && end - lead < 4) lead--;
  const byte = buffer[lead];
  const length = byte >= 0xf0 && byte <= 0xf4 ? 4 : byte >= 0xe0 && byte <= 0xef ? 3 : byte >= 0xc2 && byte <= 0xdf ? 2 : 1;
  return lead + length > end ? lead : end;
}

function timestamps(window: LogWindow): Array<{ time: number; offset: number }> {
  const records: Array<{ time: number; offset: number }> = [];
  let offset = window.startOffset;
  for (const [index, line] of window.text.split('\n').entries()) {
    if (!(index === 0 && window.startsMidLine)) {
      const readable = cleanLogText(line);
      const pretty = /^\[(\d{4}-\d{2}-\d{2}) (\d{2}:\d{2}:\d{2}\.\d{3}) ([+-]\d{4})\]/.exec(readable);
      let time = pretty ? Date.parse(`${pretty[1]}T${pretty[2]}${pretty[3]}`) : NaN;
      if (!pretty && readable.startsWith('{')) {
        try { const value = JSON.parse(readable); if (typeof value.time === 'number') time = value.time; } catch {}
      }
      if (Number.isFinite(time)) records.push({ time, offset });
    }
    offset += Buffer.byteLength(line) + 1;
  }
  return records;
}

/** Reads only the configured logger file. File identity and cursors are raw bytes. */
export class WebUiLogFile {
  private identity = '';
  private generation = 0;
  private observedSize = 0;
  private subscribers = new Set<Subscriber>();
  private timer?: NodeJS.Timeout;
  private running = false;
  private disposed = false;
  private readTail: Promise<unknown> = Promise.resolve();

  constructor(private readonly filePath: string, private readonly intervalMs = 250) {}

  private identify(stat: Stats): string {
    const identity = `${stat.dev}:${stat.ino}:${stat.birthtimeMs}`;
    if (identity !== this.identity || stat.size < this.observedSize) this.generation++;
    this.identity = identity;
    this.observedSize = stat.size;
    return `${identity}:${this.generation}`;
  }

  private async open(): Promise<{ handle: FileHandle; stat: Stats; fileId: string } | null> {
    let handle: FileHandle;
    try { handle = await fs.open(this.filePath, 'r'); }
    catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
      if (this.identity) { this.generation++; this.identity = ''; this.observedSize = 0; }
      return null;
    }
    try {
      const stat = await handle.stat();
      if (!stat.isFile()) throw new Error('The log destination is not a regular file.');
      return { handle, stat, fileId: this.identify(stat) };
    } catch (error) { await handle.close(); throw error; }
  }

  read(options: { direction?: 'latest' | 'before' | 'after'; offset?: number; fileId?: string } = {}): Promise<LogWindow> {
    const result = this.readTail.then(() => this.readNow(options));
    this.readTail = result.catch(() => {});
    return result;
  }

  private async readNow(options: { direction?: 'latest' | 'before' | 'after'; offset?: number; fileId?: string }): Promise<LogWindow> {
    const file = await this.open();
    if (!file) {
      if (options.fileId) throw new LogFileResetError('The log file is no longer available. Return to latest logs.');
      return { fileId: null, size: 0, startOffset: 0, endOffset: 0, text: '', lineCount: 0, startsMidLine: false, endsMidLine: false, pendingBytes: 0, missing: true };
    }
    try {
      if (options.fileId && file.fileId !== options.fileId) throw new LogFileResetError('The log file changed. Return to latest logs.');
      const direction = options.direction || 'latest';
      const offset = options.offset ?? file.stat.size;
      if (!Number.isSafeInteger(offset) || offset < 0 || offset > file.stat.size) throw new LogFileResetError('The log position is no longer available. Return to latest logs.');
      const start = direction === 'after' ? offset : Math.max(0, (direction === 'before' ? offset : file.stat.size) - LOG_WINDOW_BYTES);
      const end = direction === 'after' ? Math.min(file.stat.size, offset + LOG_WINDOW_BYTES) : direction === 'before' ? offset : file.stat.size;
      // A fixed edge allowance handles UTF-8 boundaries and partial-line flags.
      const readStart = Math.max(0, start - 1);
      const buffer = Buffer.alloc(end - readStart);
      let bytesRead = 0;
      while (bytesRead < buffer.length) {
        const next = await file.handle.read(buffer, bytesRead, buffer.length - bytesRead, readStart + bytesRead);
        if (!next.bytesRead) break;
        bytesRead += next.bytesRead;
      }
      const raw = buffer.subarray(0, bytesRead);
      let from = start - readStart;
      while (from < raw.length && continuation(raw[from])) from++;
      const to = Math.max(from, utf8End(raw, raw.length));
      const content = raw.subarray(from, to);
      let newlines = 0;
      for (let index = content.length - 1; index >= 0; index--) if (content[index] === 10) newlines++;
      const startOffset = readStart + from;
      const endOffset = readStart + to;
      const result: LogWindow = {
        fileId: file.fileId, size: file.stat.size, startOffset, endOffset,
        text: content.toString('utf8'), lineCount: newlines + (content.length && content[content.length - 1] !== 10 ? 1 : 0),
        startsMidLine: startOffset > 0 && raw[from - 1] !== 10,
        endsMidLine: content.length > 0 && content[content.length - 1] !== 10,
        pendingBytes: end === file.stat.size ? Math.max(0, bytesRead - to) : 0, missing: false,
      };
      const after = await file.handle.stat();
      if (after.size < file.stat.size || this.identify(after) !== file.fileId) throw new LogFileResetError('The log file changed during reading. Return to latest logs.');
      return result;
    } finally { await file.handle.close(); }
  }

  async seek(time: number, fileId: string): Promise<{ window: LogWindow; locatedTime: string; approximate: true }> {
    if (!Number.isFinite(time)) throw new Error('Choose a valid date and time.');
    const latest = await this.read({ fileId });
    let best: { time: number; offset: number } | undefined;
    let earliest = Infinity;
    let latestTime = -Infinity;
    let low = 0;
    let high = latest.size;
    const consider = (records: ReturnType<typeof timestamps>) => {
      for (const record of records) {
        earliest = Math.min(earliest, record.time); latestTime = Math.max(latestTime, record.time);
        if (!best || Math.abs(record.time - time) < Math.abs(best.time - time)) best = record;
      }
    };
    consider(timestamps(latest));
    if (latest.startOffset > 0) consider(timestamps(await this.read({ direction: 'after', offset: 0, fileId })));
    // No monotonicity guarantee: these are bounded probes for an approximate jump,
    // not a first-after query. Unknown/HH-only regions never imply an older date.
    for (let probe = 0; probe < 20 && high - low > LOG_WINDOW_BYTES; probe++) {
      const middle = Math.floor((low + high) / 2);
      const window = await this.read({ direction: 'after', offset: middle, fileId });
      const records = timestamps(window);
      consider(records);
      if (!records.length) {
        const neighbor = await this.read({ direction: 'before', offset: middle, fileId });
        const nearby = timestamps(neighbor);
        consider(nearby);
        if (!nearby.length) break;
        // A record gives a time comparison; absence of a record never does.
        if (nearby[nearby.length - 1].time < time) low = middle;
        else high = middle;
      } else if (records[0].time < time) low = middle;
      else high = middle;
    }
    if (!best) throw new Error('No full dates were found near that time. Older entries without dates can still be browsed.');
    if (time < earliest || time > latestTime) throw new Error('That time is outside the dated logs we could find. Try another time or browse older logs.');
    const candidate = await this.read({ direction: 'after', offset: Math.max(0, best.offset - Math.floor(LOG_WINDOW_BYTES / 2)), fileId });
    consider(timestamps(candidate));
    const window = await this.read({ direction: 'after', offset: best.offset, fileId });
    return { window, locatedTime: new Date(best.time).toISOString(), approximate: true };
  }

  subscribe(request: LogSubscription, emit: Subscriber['emit'], canSend: Subscriber['canSend']): () => void {
    const subscriber: Subscriber = { request, cursor: request.cursor, initial: true, stopped: false, gap: false, emit, canSend };
    if (this.disposed) return () => {};
    this.subscribers.add(subscriber);
    this.schedule(0);
    return () => { subscriber.stopped = true; this.subscribers.delete(subscriber); this.cancelIfIdle(); };
  }

  private schedule(delay = this.intervalMs): void {
    if (this.disposed || this.timer || this.running || !this.subscribers.size) return;
    this.timer = setTimeout(() => { this.timer = undefined; void this.tick(); }, delay);
    this.timer.unref?.();
  }

  private async tick(): Promise<void> {
    if (this.running || this.disposed) return;
    this.running = true;
    try {
      for (const subscriber of this.subscribers) {
        if (subscriber.stopped) continue;
        if (!subscriber.canSend()) { subscriber.gap = true; continue; }
        if (subscriber.gap) { this.emit(subscriber, { type: 'logs-gap', message: 'Some logs were not displayed. Return to latest logs.' }); subscriber.stopped = true; continue; }
        try {
          if (subscriber.initial && !subscriber.cursor) {
            const window = await this.read();
            this.emit(subscriber, { type: 'logs-snapshot', window });
            if (window.fileId) subscriber.cursor = { fileId: window.fileId, offset: window.endOffset };
            subscriber.lastSize = window.size;
            subscriber.initial = false;
            continue;
          }
          if (!subscriber.cursor) {
            const latest = await this.read();
            if (!latest.missing) { subscriber.initial = true; this.emit(subscriber, { type: 'logs-reset', message: 'The log file became available. Return to latest logs.' }); subscriber.stopped = true; }
            continue;
          }
          const window = await this.read({ direction: 'after', fileId: subscriber.cursor.fileId, offset: subscriber.cursor.offset });
          if (window.size - subscriber.cursor.offset > LOG_CATCHUP_BYTES) {
            this.emit(subscriber, { type: 'logs-gap', message: 'Some logs were not displayed. Return to latest logs.' });
            subscriber.stopped = true;
            continue;
          }
          if (window.endOffset > subscriber.cursor.offset || subscriber.initial || window.size !== subscriber.lastSize) {
            this.emit(subscriber, { type: 'logs-delta', window });
            subscriber.cursor = { fileId: window.fileId!, offset: window.endOffset };
          }
          subscriber.lastSize = window.size;
          subscriber.initial = false;
        } catch (error) {
          this.emit(subscriber, { type: error instanceof LogFileResetError ? 'logs-reset' : 'logs-error', message: error instanceof Error ? error.message : 'Unable to read logs.' });
          subscriber.stopped = true;
        }
      }
    } finally {
      this.running = false;
      for (const subscriber of this.subscribers) if (subscriber.stopped) this.subscribers.delete(subscriber);
      this.schedule();
    }
  }

  private emit(subscriber: Subscriber, message: Record<string, unknown>): void {
    if (!subscriber.stopped && this.subscribers.has(subscriber)) subscriber.emit({ ...message, logsId: subscriber.request.id });
  }
  private cancelIfIdle(): void { if (!this.subscribers.size && this.timer) { clearTimeout(this.timer); this.timer = undefined; } }
  getSubscriberCount(): number { return this.subscribers.size; }
  dispose(): void { this.disposed = true; for (const subscriber of this.subscribers) subscriber.stopped = true; this.subscribers.clear(); this.cancelIfIdle(); }
}

export function registerWebUiLogRoutes(server: Pick<HttpServer, 'addRoute'>, logs: WebUiLogFile): void {
  server.addRoute({ path: '/api/webui/logs', method: 'GET', handler: async (req, res) => {
    try {
      const allowed = new Set(['direction', 'offset', 'fileId', 'time']);
      if (Object.keys(req.query).some(key => !allowed.has(key)) || Object.values(req.query).some(value => typeof value !== 'string')) throw new Error('Invalid log query.');
      const { direction, offset, fileId, time } = req.query as Record<string, string>;
      if (time) {
        if (!fileId || direction || offset) throw new Error('Time lookup requires only a file identity and date/time.');
        res.json(await logs.seek(Date.parse(time), fileId));
      } else {
        if (direction && !['latest', 'before', 'after'].includes(direction)) throw new Error('Invalid log direction.');
        if ((direction === 'before' || direction === 'after') && (offset === undefined || !fileId)) throw new Error('Log paging requires a file identity and byte position.');
        if (offset !== undefined && (!/^\d+$/.test(offset) || !Number.isSafeInteger(Number(offset)))) throw new Error('Invalid log byte position.');
        res.json({ window: await logs.read({ direction: direction as 'latest' | 'before' | 'after', offset: offset === undefined ? undefined : Number(offset), fileId }) });
      }
    } catch (error) {
      res.status(error instanceof LogFileResetError ? 409 : 400).json({ error: error instanceof Error ? error.message : 'Unable to read logs.', reset: error instanceof LogFileResetError });
    }
  } });
}
