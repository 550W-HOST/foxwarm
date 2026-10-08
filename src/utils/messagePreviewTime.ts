import { formatLocalTimestamp } from './localTime';

export function normalizeMessagePreviewTimestamp(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) && Number.isFinite(new Date(value).getTime())
    ? value : undefined;
}

/** Tracks only messages actually displayed in one preview, never the stored page. */
export class MessagePreviewTimeState {
  private previousDay?: string;

  format(value: unknown): string | undefined {
    const timestamp = normalizeMessagePreviewTimestamp(value);
    if (timestamp === undefined) {
      this.previousDay = undefined;
      return undefined;
    }
    const full = formatLocalTimestamp(timestamp);
    const day = full.slice(0, full.indexOf(' '));
    const text = day === this.previousDay ? full.slice(day.length + 1) : full;
    this.previousDay = day;
    return text;
  }
}
