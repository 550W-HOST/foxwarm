import crypto from 'crypto';
import type { ChannelTurnProgress, ChannelTurnToolStatus } from '../types';

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

type WeWorkStreamTextBlock = {
  type: 'text';
  text: string;
  /** Marks the answer body that must render outside the folded process area. */
  final?: boolean;
};

type WeWorkStreamToolEntry = {
  id: string;
  name: string;
  status: ChannelTurnToolStatus;
};

type WeWorkStreamToolGroupBlock = {
  type: 'toolGroup';
  tools: WeWorkStreamToolEntry[];
  thinking: boolean;
};

type WeWorkStreamBlock = WeWorkStreamTextBlock | WeWorkStreamToolGroupBlock;

type WeWorkStreamState = WeWorkStreamSnapshot & {
  blocks: WeWorkStreamBlock[];
};

export type WeWorkStreamAggregatorOptions = {
  maxContentBytes?: number;
  ttlMs?: number;
  thinkFrame?: WeWorkThinkFrameStyle;
};

const DEFAULT_EMPTY_FINAL_CONTENT = '处理完成。';
const THINKING_LABEL = '🤔 thinking';
const TRUNCATION_SUFFIX = '\n\n…[内容过长，已截断]';

export const WEWORK_STREAM_THINK_OPEN = '<think>';
export const WEWORK_STREAM_THINK_CLOSE = '</think>';

/**
 * WeWork renders a passive stream card as a collapsible "thinking" area: the
 * content between an unclosed `<think>` and its closing tag stays folded, and
 * whatever follows the closing tag becomes the visible answer body.
 *
 * Documented label triggers: a first frame with `<think>` and no closing tag
 * shows the running state, a later update that introduces the closing tag shows
 * the finished state, and a frame that already contains the complete pair shows
 * the deep-thinking state instead. Text before `<think>` is dropped, and
 * content without a closing tag stays entirely folded.
 *
 * - `open` (default): streaming frames never close the pair and only the final
 *   frame emits the closing tag, which is what produces the running label first
 *   and the finished label on the answer frame.
 * - `closed`: every frame carries a complete pair (`<think></think>` while the
 *   run has no recognizable process output, `<think>…</think>` afterwards) and
 *   only the answer body follows the closing tag. A first frame that already
 *   carries the pair shows the deep-thinking label instead of the
 *   running-then-finished progression.
 */
export type WeWorkThinkFrameStyle = 'closed' | 'open';
export const DEFAULT_WEWORK_THINK_FRAME_STYLE: WeWorkThinkFrameStyle = 'open';
export const WEWORK_STREAM_CONTENT_BYTE_LIMIT = 20480;
// WeWork stream.content limit is documented as 20480 bytes. Keep a little room
// for the truncation marker so UTF-8 byte length remains below the platform cap.
export const DEFAULT_WEWORK_STREAM_MAX_CONTENT_BYTES = 20000;
export const DEFAULT_WEWORK_STREAM_TTL_MS = 15 * 60 * 1000;
// A finalized frame keeps at least this much room for the answer body so that
// process truncation can never push the closing think tag out of the frame.
const FINAL_BODY_RESERVE_BYTES = 1000;

function utf8ByteLength(value: string): number {
  return Buffer.byteLength(value, 'utf8');
}

/** Resolves the configured think-frame style; unknown values fall back to the default. */
export function normalizeWeWorkThinkFrameStyle(value: unknown): WeWorkThinkFrameStyle {
  return value === 'open' || value === 'closed' ? value : DEFAULT_WEWORK_THINK_FRAME_STYLE;
}

/**
 * Removes think tags before content leaves the streaming card. Proactive
 * WeWork deliveries (markdown webhook, WebSocket `aibot_send_msg`, terminal
 * `response_url`) render the tags literally, because the fold only exists for
 * the passive stream card.
 */
export function stripWeWorkThinkTags(value: string): string {
  return typeof value === 'string' ? value.replace(/<\/?think>/gi, '') : value;
}

export function truncateUtf8(value: string, maxBytes: number): string {
  if (!Number.isFinite(maxBytes) || maxBytes <= 0 || utf8ByteLength(value) <= maxBytes) {
    return value;
  }

  const suffix = TRUNCATION_SUFFIX;
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

function formatTextBlock(text: string, label?: string): string {
  const trimmed = String(text || '').trim();
  if (!trimmed) {
    return '';
  }
  const normalizedLabel = typeof label === 'string' ? label.trim() : '';
  return normalizedLabel ? `**${normalizedLabel}**\n${trimmed}` : trimmed;
}

function formatToolStatusIcon(status: ChannelTurnToolStatus): string {
  if (status === 'success') return '☑️';
  if (status === 'error') return '❌';
  return '⌛️';
}

function formatToolGroup(block: WeWorkStreamToolGroupBlock): string {
  if (block.tools.length === 0) {
    // An empty group is only the "thinking" placeholder. The card's fold title
    // already announces that state, so it must not occupy folded content.
    return '';
  }
  const grouped = new Map<string, { name: string; status: ChannelTurnToolStatus; count: number }>();
  for (const tool of block.tools) {
    const name = tool.name || 'tool';
    const key = `${tool.status}\u0000${name}`;
    const existing = grouped.get(key);
    if (existing) {
      existing.count++;
    } else {
      grouped.set(key, { name, status: tool.status, count: 1 });
    }
  }
  const items = Array.from(grouped.values(), item => {
    const count = item.count > 1 ? ` ×${item.count}` : '';
    return `${formatToolStatusIcon(item.status)} ${item.name}${count}`;
  });
  if (block.thinking) {
    items.push(THINKING_LABEL);
  }
  return items.length > 0 ? `> ${items.join(' | ')}` : '';
}

export class WeWorkStreamAggregator {
  private readonly maxContentBytes: number;
  private readonly ttlMs: number;
  private readonly thinkFrame: WeWorkThinkFrameStyle;
  private readonly byConversation = new Map<string, WeWorkStreamState>();
  private readonly byStreamId = new Map<string, WeWorkStreamState>();

  constructor(options: WeWorkStreamAggregatorOptions = {}) {
    const requestedMaxBytes = options.maxContentBytes || DEFAULT_WEWORK_STREAM_MAX_CONTENT_BYTES;
    this.maxContentBytes = Math.min(Math.max(1, requestedMaxBytes), WEWORK_STREAM_CONTENT_BYTE_LIMIT);
    this.ttlMs = Math.max(1, options.ttlMs || DEFAULT_WEWORK_STREAM_TTL_MS);
    this.thinkFrame = normalizeWeWorkThinkFrameStyle(options.thinkFrame);
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
      content: '',
      finish: false,
      delivery,
      updatedAt: now,
      blocks: [{ type: 'toolGroup', tools: [], thinking: true }],
    };
    state.content = this.renderContent(state);
    this.byConversation.set(normalizedConversationId, state);
    this.byStreamId.set(streamId, state);
    return this.toSnapshot(state);
  }

  supersedeActive(conversationId: string): WeWorkStreamSnapshot | undefined {
    this.cleanupExpired();
    const state = this.byConversation.get(String(conversationId || '').trim());
    if (!state || state.finish) {
      return undefined;
    }

    // A superseded card closes immediately: its substantive model text becomes
    // the visible body (no fold), and transient tool status is dropped.
    const text = state.blocks
      .filter((block): block is WeWorkStreamTextBlock => block.type === 'text')
      .map(block => block.text)
      .filter(Boolean)
      .join('\n\n');
    state.blocks = text ? [{ type: 'text', text, final: true }] : [];
    state.finish = true;
    state.content = this.renderContent(state);
    state.updatedAt = Date.now();
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

  applyProgressByStreamId(streamId: string, progress: ChannelTurnProgress): WeWorkStreamSnapshot | undefined {
    this.cleanupExpired();
    const state = this.byStreamId.get(String(streamId || '').trim());
    if (!state || state.finish) {
      return undefined;
    }

    this.applyProgressToState(state, progress);
    state.content = this.renderContent(state);
    state.updatedAt = Date.now();
    return this.toSnapshot(state);
  }

  private appendToState(state: WeWorkStreamState | undefined, text: string, options: WeWorkStreamAppendOptions = {}): WeWorkStreamSnapshot | undefined {
    if (!state) {
      return undefined;
    }
    if (state.finish) {
      return undefined;
    }

    const section = formatTextBlock(text, options.label);
    let appendedBlock: WeWorkStreamTextBlock | undefined;
    if (section) {
      this.clearThinking(state);
      if (options.replaceLast) {
        const lastTextBlock = [...state.blocks].reverse().find(block => block.type === 'text') as WeWorkStreamTextBlock | undefined;
        if (lastTextBlock) {
          lastTextBlock.text = section;
          appendedBlock = lastTextBlock;
        } else {
          appendedBlock = { type: 'text', text: section };
          state.blocks.push(appendedBlock);
        }
      } else {
        appendedBlock = { type: 'text', text: section };
        state.blocks.push(appendedBlock);
      }
    }

    if (options.finish) {
      this.clearThinking(state);
      // The closing append carries the answer body: it renders after the
      // folded process area instead of inside it.
      if (appendedBlock) appendedBlock.final = true;
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
    this.clearThinking(state);
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

  /**
   * Keeps an unfinished card alive while its client polls for updates. Without
   * this, a card parked on a suspended turn would expire by TTL even though the
   * platform is still asking for its content.
   */
  touchByStreamId(streamId: string, now: number = Date.now()): WeWorkStreamSnapshot | undefined {
    this.cleanupExpired();
    const state = this.byStreamId.get(String(streamId || '').trim());
    if (!state) {
      return undefined;
    }
    if (!state.finish) {
      state.updatedAt = now;
    }
    return this.toSnapshot(state);
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

  private getCurrentToolGroup(state: WeWorkStreamState, create: boolean): WeWorkStreamToolGroupBlock | undefined {
    const lastBlock = state.blocks[state.blocks.length - 1];
    if (lastBlock?.type === 'toolGroup') {
      return lastBlock;
    }
    if (!create) {
      return undefined;
    }
    const block: WeWorkStreamToolGroupBlock = { type: 'toolGroup', tools: [], thinking: false };
    state.blocks.push(block);
    return block;
  }

  private clearThinking(state: WeWorkStreamState): void {
    state.blocks = state.blocks.filter(block => {
      if (block.type !== 'toolGroup') {
        return true;
      }
      block.thinking = false;
      return block.tools.length > 0;
    });
  }

  private findTool(state: WeWorkStreamState, id: string): WeWorkStreamToolEntry | undefined {
    for (const block of state.blocks) {
      if (block.type !== 'toolGroup') continue;
      const tool = block.tools.find(entry => entry.id === id);
      if (tool) return tool;
    }
    return undefined;
  }

  private applyProgressToState(state: WeWorkStreamState, progress: ChannelTurnProgress): void {
    if (progress.type === 'llm-start') {
      const group = this.getCurrentToolGroup(state, true);
      if (group) {
        group.thinking = true;
      }
      return;
    }

    if (progress.type === 'tool-calls-start') {
      this.clearThinking(state);
      const text = typeof progress.text === 'string' ? formatTextBlock(progress.text) : '';
      if (text) {
        state.blocks.push({ type: 'text', text });
      }
      const group = this.getCurrentToolGroup(state, true);
      if (!group) return;
      for (const call of progress.calls || []) {
        if (!call.id) continue;
        const existing = this.findTool(state, call.id);
        if (existing) {
          existing.name = call.name || existing.name;
          existing.status = 'running';
          continue;
        }
        group.tools.push({ id: call.id, name: call.name || 'tool', status: 'running' });
      }
      return;
    }

    if (progress.type === 'tool-calls-finish') {
      const group = this.getCurrentToolGroup(state, true);
      for (const result of progress.results || []) {
        if (!result.id) continue;
        const existing = this.findTool(state, result.id);
        if (existing) {
          existing.name = result.name || existing.name;
          existing.status = result.status;
          continue;
        }
        group?.tools.push({ id: result.id, name: result.name || 'tool', status: result.status });
      }
    }
  }

  private renderContent(state: WeWorkStreamState): string {
    const process = state.blocks
      .filter(block => !(block.type === 'text' && block.final))
      .map(block => block.type === 'text' ? block.text : formatToolGroup(block))
      .filter(Boolean)
      .join('\n\n');
    if (!state.finish) {
      return this.renderStreamingFrame(process);
    }
    const finalText = state.blocks.find(
      (block): block is WeWorkStreamTextBlock => block.type === 'text' && block.final === true,
    )?.text || '';
    return this.renderFinalFrame(process, finalText || DEFAULT_EMPTY_FINAL_CONTENT);
  }

  /** Bytes consumed by the think pair and its newlines in either frame shape. */
  private frameOverheadBytes(): number {
    return utf8ByteLength(WEWORK_STREAM_THINK_OPEN) + utf8ByteLength(WEWORK_STREAM_THINK_CLOSE) + 4;
  }

  private fitProcess(process: string, budget: number): string {
    if (!process || budget <= utf8ByteLength(TRUNCATION_SUFFIX)) {
      return '';
    }
    return truncateUtf8(process, budget);
  }

  private renderStreamingFrame(process: string): string {
    const body = this.fitProcess(process, this.maxContentBytes - this.frameOverheadBytes());
    if (this.thinkFrame === 'open') {
      return body ? `${WEWORK_STREAM_THINK_OPEN}\n${body}` : WEWORK_STREAM_THINK_OPEN;
    }
    return body
      ? `${WEWORK_STREAM_THINK_OPEN}\n${body}\n${WEWORK_STREAM_THINK_CLOSE}`
      : `${WEWORK_STREAM_THINK_OPEN}${WEWORK_STREAM_THINK_CLOSE}`;
  }

  private renderFinalFrame(process: string, finalText: string): string {
    const fitted = this.fitProcess(
      process,
      this.maxContentBytes - this.frameOverheadBytes() - Math.min(utf8ByteLength(finalText), FINAL_BODY_RESERVE_BYTES),
    );
    if (!fitted) {
      // Nothing to fold: a card that only carries the answer must not show an
      // empty folded area above it.
      return truncateUtf8(finalText, this.maxContentBytes);
    }
    const framed = `${WEWORK_STREAM_THINK_OPEN}\n${fitted}\n${WEWORK_STREAM_THINK_CLOSE}\n${finalText}`;
    // Any remaining overflow can only cut the answer tail: the closed pair is
    // inside the prefix reserved above, so the fold can never be left open.
    return utf8ByteLength(framed) > this.maxContentBytes ? truncateUtf8(framed, this.maxContentBytes) : framed;
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
