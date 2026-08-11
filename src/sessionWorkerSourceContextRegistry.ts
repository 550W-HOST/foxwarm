import type { ChannelContext } from './channel';
import type { QueueSource } from './types';
import { stableSessionWorkerJson } from './sessionWorkerStableJson';

export class SessionWorkerSourceContextRegistry {
  private readonly contexts = new Map<string, Map<symbol, ChannelContext>>();

  register(sessionId: string, source: QueueSource, context: ChannelContext): () => void {
    const key = this.key(sessionId, source);
    const token = Symbol();
    let entries = this.contexts.get(key);
    if (!entries) { entries = new Map(); this.contexts.set(key, entries); }
    entries.set(token, context);
    let live = true;
    return () => {
      if (!live) return;
      live = false;
      const current = this.contexts.get(key);
      current?.delete(token);
      if (current?.size === 0) this.contexts.delete(key);
    };
  }

  resolve = (sessionId: string, source: QueueSource): ChannelContext | undefined => {
    const entries = this.contexts.get(this.key(sessionId, source));
    return entries?.size === 1 ? entries.values().next().value : undefined;
  };

  get size(): number { return [...this.contexts.values()].reduce((total, entries) => total + entries.size, 0); }

  private key(sessionId: string, source: QueueSource): string {
    return `${sessionId}\n${stableSessionWorkerJson(source)}`;
  }
}
