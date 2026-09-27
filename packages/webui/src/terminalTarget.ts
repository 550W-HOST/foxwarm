import { normalizeNodeId } from './nodeTargets'
import { normalizeCodePath } from './vscodeWeb'

export type TerminalTarget = { nodeId?: string; cwd?: string }

export function normalizeTerminalCwd(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) return '/'
  const trimmed = value.trim()
  return normalizeCodePath(trimmed) || (trimmed === '/' ? '/' : trimmed.replace(/\/+$/, '')) || '/'
}

export function normalizeTerminalTarget(target: TerminalTarget): { nodeId: string; cwd: string } {
  return {
    nodeId: normalizeNodeId(target.nodeId),
    cwd: normalizeTerminalCwd(target.cwd),
  }
}

export function terminalTargetsMatch(left: TerminalTarget, right: TerminalTarget): boolean {
  const normalizedLeft = normalizeTerminalTarget(left)
  const normalizedRight = normalizeTerminalTarget(right)
  return normalizedLeft.nodeId === normalizedRight.nodeId && normalizedLeft.cwd === normalizedRight.cwd
}

export function findTerminalForTarget<T extends TerminalTarget>(terminals: readonly T[], target: TerminalTarget): T | undefined {
  return terminals.find(terminal => terminalTargetsMatch(terminal, target))
}

export function buildTerminalCreateRequest(target: TerminalTarget, cols: number, rows: number) {
  return { ...normalizeTerminalTarget(target), cols, rows }
}