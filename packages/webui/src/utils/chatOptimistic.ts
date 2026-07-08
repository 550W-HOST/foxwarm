export function shouldAppendOptimisticMessage(sessionBusy: boolean, sessionQueueLength: number): boolean {
  return !sessionBusy && sessionQueueLength <= 0
}
