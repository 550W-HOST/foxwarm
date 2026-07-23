import crypto from 'crypto';
import { ModelConfigEntry, VirtualModelRoutingConfig, isVirtualModelConfigEntry } from './config';

type TargetHealthState = {
  consecutiveFailures: number;
  cooldownUntil: number;
};

type ActiveFailoverRoute = {
  fingerprint: string;
  generation: number;
  health: Map<string, TargetHealthState>;
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

export type VirtualRoutingRequest = {
  virtualKey: string;
  routing: VirtualModelRoutingConfig;
  generation: number;
  health: Map<string, TargetHealthState>;
};

type Clock = () => number;

const activeFailoverRoutes = new Map<string, ActiveFailoverRoute>();
let nextGeneration = 1;
let clock: Clock = () => Date.now();

function activateFailoverRoute(virtualKey: string, routing: VirtualModelRoutingConfig): ActiveFailoverRoute {
  const active = activeFailoverRoutes.get(virtualKey);
  if (active?.fingerprint === routing.fingerprint) return active;

  const replacement: ActiveFailoverRoute = {
    fingerprint: routing.fingerprint,
    generation: nextGeneration++,
    health: new Map<string, TargetHealthState>(),
  };
  activeFailoverRoutes.set(virtualKey, replacement);
  return replacement;
}

function isActiveRequest(request: VirtualRoutingRequest): boolean {
  const active = activeFailoverRoutes.get(request.virtualKey);
  return !!active
    && active.fingerprint === request.routing.fingerprint
    && active.generation === request.generation
    && active.health === request.health;
}

export function clearVirtualRoutingState(virtualKey: string): void {
  activeFailoverRoutes.delete(virtualKey);
}

export function beginVirtualRoutingRequest(virtualKey: string, entry: ModelConfigEntry): VirtualRoutingRequest {
  if (!isVirtualModelConfigEntry(entry)) {
    throw new Error(`Model \`${virtualKey}\` is not a virtual model.`);
  }

  const routing = entry.virtualRouting;
  if (routing.strategy === 'session-hash') {
    clearVirtualRoutingState(virtualKey);
    return {
      virtualKey,
      routing,
      generation: 0,
      health: new Map<string, TargetHealthState>(),
    };
  }

  const active = activateFailoverRoute(virtualKey, routing);
  return {
    virtualKey,
    routing,
    generation: active.generation,
    health: active.health,
  };
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
  request: VirtualRoutingRequest,
  routingKey: string,
  now: number = clock(),
): VirtualTargetSelection {
  const { routing } = request;
  if (routing.strategy === 'session-hash') {
    return selectSessionHashTarget(request.virtualKey, routingKey, routing.targets);
  }

  for (let index = 0; index < routing.targets.length; index += 1) {
    const targetKey = routing.targets[index];
    const state = request.health.get(targetKey);
    if (state?.cooldownUntil && state.cooldownUntil > now) {
      continue;
    }
    if (state?.cooldownUntil && state.cooldownUntil <= now) {
      request.health.delete(targetKey);
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

export function recordVirtualTargetSuccess(request: VirtualRoutingRequest, targetKey: string): void {
  if (request.routing.strategy !== 'failover') return;
  request.health.delete(targetKey);
}

export function recordVirtualTargetFailure(
  request: VirtualRoutingRequest,
  selection: VirtualTargetSelection,
  now: number = clock(),
): VirtualFailureOutcome {
  if (request.routing.strategy !== 'failover') {
    return { terminal: false, enteredCooldown: false, consecutiveFailures: 0 };
  }

  const routing = request.routing;
  if (selection.isLastTarget) {
    const active = isActiveRequest(request);
    request.health.clear();
    if (active) {
      // Advance the global generation so later completions from requests that
      // shared the exhausted generation publish only to their detached maps.
      activeFailoverRoutes.set(request.virtualKey, {
        fingerprint: routing.fingerprint,
        generation: nextGeneration++,
        health: new Map<string, TargetHealthState>(),
      });
    }
    return { terminal: true, enteredCooldown: false, consecutiveFailures: 1 };
  }

  const previous = request.health.get(selection.targetKey);
  const consecutiveFailures = (previous?.consecutiveFailures || 0) + 1;
  if (consecutiveFailures >= routing.failureThreshold) {
    request.health.set(selection.targetKey, {
      consecutiveFailures,
      cooldownUntil: now + routing.cooldownMs,
    });
    return { terminal: false, enteredCooldown: true, consecutiveFailures };
  }

  request.health.set(selection.targetKey, {
    consecutiveFailures,
    cooldownUntil: 0,
  });
  return { terminal: false, enteredCooldown: false, consecutiveFailures };
}

export function resetVirtualRoutingStateForTests(): void {
  activeFailoverRoutes.clear();
  nextGeneration = 1;
  clock = () => Date.now();
}

export function setVirtualRoutingClockForTests(nextClock?: Clock): void {
  clock = nextClock || (() => Date.now());
}

export function getVirtualRoutingStateForTests(virtualKey: string, entry: ModelConfigEntry): Record<string, TargetHealthState> {
  if (!isVirtualModelConfigEntry(entry) || entry.virtualRouting.strategy !== 'failover') return {};
  const active = activeFailoverRoutes.get(virtualKey);
  if (!active || active.fingerprint !== entry.virtualRouting.fingerprint) return {};
  return Object.fromEntries(Array.from(active.health.entries()).map(([key, value]) => [key, { ...value }]));
}
