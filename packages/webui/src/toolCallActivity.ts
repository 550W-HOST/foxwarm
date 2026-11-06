/** Transient exact-owner invocation state; canonical responses remain the durable authority. */
export interface ToolCallActivity {
  activityId: string
  sequence: number
  runningCallIds: ReadonlySet<string>
}

export type ToolCallActivityEvent = {
  type: 'tool-call-snapshot'
  activityId: string
  sequence: number
  runningCallIds: string[]
} | {
  type: 'tool-call-state'
  activityId: string
  sequence: number
  callId: string
  status: 'running' | 'finished'
}

export function applyToolCallActivity(previous: ToolCallActivity | undefined, event: ToolCallActivityEvent): ToolCallActivity {
  if (previous?.activityId === event.activityId && event.sequence <= previous.sequence) return previous
  if (event.type === 'tool-call-snapshot') return { activityId: event.activityId, sequence: event.sequence, runningCallIds: new Set(event.runningCallIds) }
  const runningCallIds = new Set(previous?.activityId === event.activityId ? previous.runningCallIds : [])
  if (event.status === 'running') runningCallIds.add(event.callId)
  else runningCallIds.delete(event.callId)
  return { activityId: event.activityId, sequence: event.sequence, runningCallIds }
}
