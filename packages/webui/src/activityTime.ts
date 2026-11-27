/** Relative time of a past moment as the Sessions list shows it: Now, 5m ago, 3h ago, 2d ago, then the date. */
export function formatActivityTime(timestamp: number): string {
  if (!timestamp || !Number.isFinite(new Date(timestamp).getTime())) return ''
  const minutes = Math.max(0, Math.floor((Date.now() - timestamp) / 60000))
  if (minutes < 1) return 'Now'
  if (minutes < 60) return `${minutes}m ago`
  if (minutes < 1440) return `${Math.floor(minutes / 60)}h ago`
  if (minutes < 10080) return `${Math.floor(minutes / 1440)}d ago`
  return new Intl.DateTimeFormat(undefined, { month: 'short', day: 'numeric' }).format(timestamp)
}
