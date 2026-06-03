import crypto from 'crypto';

export type WeWorkStreamDelivery = {
  mode: 'webhook' | 'websocket';
  responseUrl?: string;
  reqId?: string;
};

export type WeWorkStreamAppendOptions = {
  finish?: boolean;
  replaceLast?: boolean;
  label?: string;
};

export type WeWorkStreamSnapshot = {
  conversationId: string;
  streamId: string;
  content: string;
  finish: boolean;
  delivery: WeWorkStreamDelivery;
  updatedAt: number;
};

type WeWorkStreamState = WeWorkStreamSnapshot & {
  sections: string[];
  initialContent: string;
};

export type WeWorkStreamAggregatorOptions = {
  initialContent?: string;
  maxContentBytes?: number;
  ttlMs?: number;
};

const DEFAULT_INITIAL_CONTENT = '正在处理，请稍候…';
export const WEWORK_STREAM_CONTENT_BYTE_LIMIT = 20480;
// WeWork stream.content limit is documented as 20480 bytes. Keep a little room
// for the truncation marker so UTF-8 byte length remains below the platform cap.
export const DEFAULT_WEWORK_STREAM_MAX_CONTENT_BYTES = 20000;
export const DEFAULT_WEWORK_STREAM_TTL_MS = 15 * 60 * 1000;

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || utf8ByteLength(value) <= maxBytes) {
    return value;
  }

  const suffix = '\n\n…[内容过长，已截断]';
  const suffixBytes = utf8ByteLength(suffix);
  const budget = Math.max(0, maxBytes - suffixBytes);
  let used = 0;
  let output = '';

  for (const char of value) {
    const bytes = utf8ByteLength(char);
    if (used + bytes > budget) {
      break;
    }
    output += char;
    used += bytes;
  }

  return output + suffix;
}

function makeStreamId(): string {
  if (typeof crypto.randomUUID === 'function') {
    return `fw_${crypto.randomUUID().replace(/-/g, '').slice(0, 24)}`;
  }
  return `fw_${Date.now().toString(36)}_${Math.random().toString(36).slice(2, 10)}`;
}

function formatSection(text: string, label?: string): string {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return '';
  }
  const normalizedLabel = typeof label === 'string' ? label.trim() : '';
  return normalizedLabel ? `**${normalizedLabel}**\n${trimmed}` : trimmed;
}

export class WeWorkStreamAggregator {
  private readonly initialContent: string;
  private readonly maxContentBytes: number;
  private readonly ttlMs: number;
  private readonly byConversation = new Map<string, WeWorkStreamState>();
  private readonly byStreamId = new Map<string, WeWorkStreamState>();

  constructor(options: WeWorkStreamAggregatorOptions = {}) {
    this.initialContent = options.initialContent || DEFAULT_INITIAL_CONTENT;
    const requestedMaxBytes = options.maxContentBytes || DEFAULT_WEWORK_STREAM_MAX_CONTENT_BYTES;
    this.maxContentBytes = Math.min(Math.max(1, requestedMaxBytes), WEWORK_STREAM_CONTENT_BYTE_LIMIT);
    this.ttlMs = Math.max(1, options.ttlMs || DEFAULT_WEWORK_STREAM_TTL_MS);
  }

  begin(conversationId: string, delivery: WeWorkStreamDelivery, streamId: string = makeStreamId()): WeWorkStreamSnapshot {
    this.cleanupExpired();
    const normalizedConversationId = String(conversationId || '').trim();
    if (!normalizedConversationId) {
      throw new Error('conversationId is required to begin a WeWork stream');
    }

    const now = Date.now();
    const state: WeWorkStreamState = {
      conversationId: normalizedConversationId,
      streamId,
      content: this.initialContent,
      finish: false,
      delivery,
      updatedAt: now,
      sections: [],
      initialContent: this.initialContent,
    };
    this.byConversation.set(normalizedConversationId, state);
    this.byStreamId.set(streamId, state);
    return this.toSnapshot(state);
  }

  append(conversationId: string, text: string, options: WeWorkStreamAppendOptions = {}): WeWorkStreamSnapshot | undefined {
    this.cleanupExpired();
    const state = this.byConversation.get(String(conversationId || '').trim());
    return this.appendToState(state, text, options);
  }

  appendByStreamId(streamId: string, text: string, options: WeWorkStreamAppendOptions = {}): WeWorkStreamSnapshot | undefined {
    this.cleanupExpired();
    const state = this.byStreamId.get(String(streamId || '').trim());
    return this.appendToState(state, text, options);
  }

  private appendToState(state: WeWorkStreamState | undefined, text: string, options: WeWorkStreamAppendOptions = {}): WeWorkStreamSnapshot | undefined {
    if (!state) {
      return undefined;
    }
    if (state.finish) {
      return undefined;
    }

    const section = formatSection(text, options.label);
    if (section) {
      if (options.replaceLast && state.sections.length > 0) {
        state.sections[state.sections.length - 1] = section;
      } else {
        state.sections.push(section);
      }
    }

    if (options.finish) {
      state.finish = true;
    }

    state.content = this.renderContent(state);
    state.updatedAt = Date.now();
    return this.toSnapshot(state);
  }

  finish(conversationId: string): WeWorkStreamSnapshot | undefined {
    this.cleanupExpired();
    const state = this.byConversation.get(String(conversationId || '').trim());
    return this.finishState(state);
  }

  finishByStreamId(streamId: string): WeWorkStreamSnapshot | undefined {
    this.cleanupExpired();
    const state = this.byStreamId.get(String(streamId || '').trim());
    return this.finishState(state);
  }

  private finishState(state: WeWorkStreamState | undefined): WeWorkStreamSnapshot | undefined {
    if (!state) {
      return undefined;
    }
    state.finish = true;
    state.content = this.renderContent(state);
    state.updatedAt = Date.now();
    return this.toSnapshot(state);
  }

  getByConversation(conversationId: string): WeWorkStreamSnapshot | undefined {
    this.cleanupExpired();
    const state = this.byConversation.get(String(conversationId || '').trim());
    return state ? this.toSnapshot(state) : undefined;
  }

  getByStreamId(streamId: string): WeWorkStreamSnapshot | undefined {
    this.cleanupExpired();
    const state = this.byStreamId.get(String(streamId || '').trim());
    return state ? this.toSnapshot(state) : undefined;
  }

  hasActive(conversationId: string): boolean {
    this.cleanupExpired();
    const state = this.byConversation.get(String(conversationId || '').trim());
    return !!state && !state.finish;
  }

  cleanupExpired(now: number = Date.now()): number {
    let removed = 0;
    for (const [streamId, state] of Array.from(this.byStreamId.entries())) {
      if (now - state.updatedAt <= this.ttlMs) {
        continue;
      }
      this.byStreamId.delete(streamId);
      if (this.byConversation.get(state.conversationId) === state) {
        this.byConversation.delete(state.conversationId);
      }
      removed++;
    }
    return removed;
  }

  private renderContent(state: WeWorkStreamState): string {
    const raw = state.sections.length > 0 ? state.sections.join('\n\n') : state.initialContent;
    return truncateUtf8(raw, this.maxContentBytes);
  }

  private toSnapshot(state: WeWorkStreamState): WeWorkStreamSnapshot {
    return {
      conversationId: state.conversationId,
      streamId: state.streamId,
      content: state.content,
      finish: state.finish,
      delivery: { ...state.delivery },
      updatedAt: state.updatedAt,
    };
  }
}

export function buildWeWorkStreamResponse(snapshot: WeWorkStreamSnapshot): any {
  return {
    msgtype: 'stream',
    stream: {
      id: snapshot.streamId,
      finish: snapshot.finish,
      content: snapshot.content,
    },
  };
}
