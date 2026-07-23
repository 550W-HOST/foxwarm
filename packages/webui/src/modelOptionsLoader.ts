export type LatestRequestGate = ReturnType<typeof createLatestRequestGate>

export type ModelOptionsLoadState<T> = {
  options?: T[]
  error?: string | null
  loading?: boolean
}

export function createLatestRequestGate() {
  let sequence = 0
  return {
    begin(): number {
      sequence += 1
      return sequence
    },
    isCurrent(requestSequence: number): boolean {
      return requestSequence === sequence
    },
    invalidate(): void {
      sequence += 1
    },
  }
}

export async function runLatestModelOptionsRequest<T>(
  gate: LatestRequestGate,
  request: () => Promise<T[]>,
  update: (state: ModelOptionsLoadState<T>) => void,
): Promise<void> {
  const requestSequence = gate.begin()
  update({ loading: true })
  try {
    const options = await request()
    if (!gate.isCurrent(requestSequence)) return
    update({ options, error: null })
  } catch (error) {
    if (!gate.isCurrent(requestSequence)) return
    update({
      options: [],
      error: error instanceof Error ? error.message : 'Failed to load models',
    })
  } finally {
    if (gate.isCurrent(requestSequence)) update({ loading: false })
  }
}
