export type LatestSessionListRequestGate = {
  latestRequestId: number
}

export function createLatestSessionListRequestGate(): LatestSessionListRequestGate {
  return { latestRequestId: 0 }
}

export async function applyLatestSessionListRequest<T>(
  gate: LatestSessionListRequestGate,
  request: () => Promise<T>,
  apply: (value: T) => void,
): Promise<T> {
  const requestId = ++gate.latestRequestId
  const value = await request()
  if (requestId === gate.latestRequestId) {
    apply(value)
  }
  return value
}