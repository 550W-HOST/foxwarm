import crypto from 'crypto';
import { ModelConfigEntry, VirtualModelRoutingConfig, isVirtualModelConfigEntry } from './config';

type TargetHealthState = {
  consecutiveFailures: number;
  cooldownUntil: number;
};

export type VirtualTargetSelection = {
  targetKey: string;
  targetIndex: number;
  isLastTarget: boolean;
};

export type VirtualFailureOutcome = {
  terminal: boolean;
  enteredCooldown: boolean;
  consecutiveFailures: number;
};

type Clock = () => number;

const routeHealth = new Map<string, Map<string, TargetHealthState>>();
const activeFailoverFingerprint = new Map<string, string>();
let clock: Clock = () => Date.now();

function routeScopeKey(virtualKey: string, routing: VirtualModelRoutingConfig): string {
  return `${virtualKey}\0${routing.fingerprint}`;
}

function getRouteHealth(virtualKey: string, routing: VirtualModelRoutingConfig): Map<string, TargetHealthState> {
  const scopeKey = routeScopeKey(virtualKey, routing);
  let health = routeHealth.get(scopeKey);
  if (!health) {
    health = new Map<string, TargetHealthState>();
    routeHealth.set(scopeKey, health);
  }
  return health;
}

function activateFailoverRoute(virtualKey: string, routing: VirtualModelRoutingConfig): void {
  const previousFingerprint = activeFailoverFingerprint.get(virtualKey);
  if (previousFingerprint === routing.fingerprint) return;
  if (previousFingerprint) {
    routeHealth.delete(`${virtualKey}\0${previousFingerprint}`);
  }
  activeFailoverFingerprint.set(virtualKey, routing.fingerprint);
}

function isActiveFailoverRoute(virtualKey: string, routing: VirtualModelRoutingConfig): boolean {
  return activeFailoverFingerprint.get(virtualKey) === routing.fingerprint;
}

export function clearVirtualRoutingState(virtualKey: string): void {
  const previousFingerprint = activeFailoverFingerprint.get(virtualKey);
  if (previousFingerprint) {
    routeHealth.delete(`${virtualKey}\0${previousFingerprint}`);
    activeFailoverFingerprint.delete(virtualKey);
  }
}

function compareDigest(left: Buffer, right: Buffer): number {
  return Buffer.compare(left, right);
}

export function selectSessionHashTarget(virtualKey: string, routingKey: string, targets: readonly string[]): VirtualTargetSelection {
  if (targets.length === 0) {
    throw new Error(`Virtual model \`${virtualKey}\` has no routing targets.`);
  }

  let selectedIndex = 0;
  let selectedScore: Buffer | undefined;
  for (let index = 0; index < targets.length; index += 1) {
    const score = crypto.createHash('sha256')
      .update(virtualKey, 'utf8')
      .update('\0')
      .update(routingKey, 'utf8')
      .update('\0')
      .update(targets[index], 'utf8')
      .digest();
    const comparison = selectedScore ? compareDigest(score, selectedScore) : 1;
    if (!selectedScore || comparison > 0 || (comparison === 0 && targets[index] < targets[selectedIndex])) {
      selectedScore = score;
      selectedIndex = index;
    }
  }

  return {
    targetKey: targets[selectedIndex],
    targetIndex: selectedIndex,
    isLastTarget: selectedIndex === targets.length - 1,
  };
}

export function selectVirtualTarget(
  virtualKey: string,
  entry: ModelConfigEntry,
  routingKey: string,
  now: number = clock(),
): VirtualTargetSelection {
  if (!isVirtualModelConfigEntry(entry)) {
    throw new Error(`Model \`${virtualKey}\` is not a virtual model.`);
  }

  const routing = entry.virtualRouting;
  if (routing.strategy === 'session-hash') {
    clearVirtualRoutingState(virtualKey);
    return selectSessionHashTarget(virtualKey, routingKey, routing.targets);
  }

  activateFailoverRoute(virtualKey, routing);
  const health = getRouteHealth(virtualKey, routing);
  for (let index = 0; index < routing.targets.length; index += 1) {
    const targetKey = routing.targets[index];
    const state = health.get(targetKey);
    if (state?.cooldownUntil && state.cooldownUntil > now) {
      continue;
    }
    if (state?.cooldownUntil && state.cooldownUntil <= now) {
      health.delete(targetKey);
    }
    return {
      targetKey,
      targetIndex: index,
      isLastTarget: index === routing.targets.length - 1,
    };
  }

  // The configured last target is never put into cooldown: its failure clears
  // the route and terminates the current request. This fallback is defensive
  // against externally injected/test state rather than a normal route state.
  const lastIndex = routing.targets.length - 1;
  return {
    targetKey: routing.targets[lastIndex],
    targetIndex: lastIndex,
    isLastTarget: true,
  };
}

export function recordVirtualTargetSuccess(virtualKey: string, entry: ModelConfigEntry, targetKey: string): void {
  if (!isVirtualModelConfigEntry(entry) || entry.virtualRouting.strategy !== 'failover') {
    return;
  }
  if (!isActiveFailoverRoute(virtualKey, entry.virtualRouting)) return;
  const health = getRouteHealth(virtualKey, entry.virtualRouting);
  health.delete(targetKey);
}

export function recordVirtualTargetFailure(
  virtualKey: string,
  entry: ModelConfigEntry,
  selection: VirtualTargetSelection,
  now: number = clock(),
): VirtualFailureOutcome {
  if (!isVirtualModelConfigEntry(entry) || entry.virtualRouting.strategy !== 'failover') {
    return { terminal: false, enteredCooldown: false, consecutiveFailures: 0 };
  }
  if (!isActiveFailoverRoute(virtualKey, entry.virtualRouting)) {
    return { terminal: false, enteredCooldown: false, consecutiveFailures: 0 };
  }

  const routing = entry.virtualRouting;
  const scopeKey = routeScopeKey(virtualKey, routing);
  if (selection.isLastTarget) {
    routeHealth.delete(scopeKey);
    return { terminal: true, enteredCooldown: false, consecutiveFailures: 1 };
  }

  const health = getRouteHealth(virtualKey, routing);
  const previous = health.get(selection.targetKey);
  const consecutiveFailures = (previous?.consecutiveFailures || 0) + 1;
  if (consecutiveFailures >= routing.failureThreshold) {
    health.set(selection.targetKey, {
      consecutiveFailures,
      cooldownUntil: now + routing.cooldownMs,
    });
    return { terminal: false, enteredCooldown: true, consecutiveFailures };
  }

  health.set(selection.targetKey, {
    consecutiveFailures,
    cooldownUntil: 0,
  });
  return { terminal: false, enteredCooldown: false, consecutiveFailures };
}

export function resetVirtualRoutingStateForTests(): void {
  routeHealth.clear();
  activeFailoverFingerprint.clear();
  clock = () => Date.now();
}

export function setVirtualRoutingClockForTests(nextClock?: Clock): void {
  clock = nextClock || (() => Date.now());
}

export function getVirtualRoutingStateForTests(virtualKey: string, entry: ModelConfigEntry): Record<string, TargetHealthState> {
  if (!isVirtualModelConfigEntry(entry)) return {};
  const health = routeHealth.get(routeScopeKey(virtualKey, entry.virtualRouting));
  return Object.fromEntries(Array.from(health?.entries() || []).map(([key, value]) => [key, { ...value }]));
}
