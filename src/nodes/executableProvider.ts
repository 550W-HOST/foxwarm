import crypto from 'node:crypto';
import { spawn, type ChildProcessWithoutNullStreams } from 'node:child_process';
import type { NormalizedExecutableNodeProviderConfig } from '../config';
import {
  NodeProviderError,
  type NodeAvailability,
  type NodeCapabilityDescriptor,
  type NodeDescriptor,
  type NodeLifecycleNodeRequest,
  type NodeLifecycleProviderRequest,
  type NodeLifecycleResult,
  type NodeProvider,
  type NodeProviderCallOptions,
  type NodeToolRequest,
} from './providerRegistry';

export const EXECUTABLE_NODE_PROVIDER_PROTOCOL = 'foxwarm-node-provider@1';
export const EXECUTABLE_NODE_PROVIDER_MAX_LIST_BYTES = 256 * 1024;
export const EXECUTABLE_NODE_PROVIDER_MAX_RESULT_BYTES = 8 * 1024 * 1024;
export const EXECUTABLE_NODE_PROVIDER_MAX_LIFECYCLE_BYTES = 512 * 1024;
export const EXECUTABLE_NODE_PROVIDER_MAX_LIFECYCLE_DETAILS_BYTES = 64 * 1024;
export const EXECUTABLE_NODE_PROVIDER_MAX_REQUEST_BYTES = 4 * 1024 * 1024;
export const EXECUTABLE_NODE_PROVIDER_MAX_STDERR_BYTES = 64 * 1024;
export const EXECUTABLE_NODE_PROVIDER_MAX_NODES = 100;
export const EXECUTABLE_NODE_PROVIDER_MAX_TOOLS = 200;
export const EXECUTABLE_NODE_PROVIDER_MAX_SCHEMA_BYTES = 16 * 1024;
export const EXECUTABLE_NODE_PROVIDER_MAX_CONCURRENT = 8;
const TERMINATE_GRACE_MS = 250;
const KILL_CONFIRM_MS = 2_000;

const SAFE_ENV_KEYS = [
  'PATH', 'HOME', 'USERPROFILE', 'TMPDIR', 'TMP', 'TEMP',
  'LANG', 'LC_ALL', 'LC_CTYPE', 'SystemRoot', 'COMSPEC', 'PATHEXT',
] as const;

function providerEnvironment(): NodeJS.ProcessEnv {
  const env: NodeJS.ProcessEnv = {};
  for (const key of SAFE_ENV_KEYS) {
    if (process.env[key] !== undefined) env[key] = process.env[key];
  }
  return env;
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const prototype = Object.getPrototypeOf(value);
  return prototype === Object.prototype || prototype === null;
}

function assertOnlyKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const allowedSet = new Set(allowed);
  const unexpected = Object.keys(value).find(key => !allowedSet.has(key));
  if (unexpected) {
    throw new NodeProviderError('NODE_PROVIDER_PROTOCOL_INVALID_RESPONSE', `${label} contains unsupported field \`${unexpected}\`.`);
  }
}

function exactString(value: unknown, label: string, maxLength: number, pattern?: RegExp): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || value.trim() !== value) {
    throw new NodeProviderError('NODE_PROVIDER_INVALID_DESCRIPTOR', `${label} must be a non-empty exact string of at most ${maxLength} characters.`);
  }
  if (pattern && !pattern.test(value)) {
    throw new NodeProviderError('NODE_PROVIDER_INVALID_DESCRIPTOR', `${label} contains unsupported characters.`);
  }
  return value;
}

function boundedString(value: unknown, label: string, maxLength: number): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > maxLength || /[\u0000-\u001f\u007f]/.test(value)) {
    throw new NodeProviderError('NODE_PROVIDER_INVALID_DESCRIPTOR', `${label} must be a non-empty string of at most ${maxLength} characters.`);
  }
  return value;
}

function validatePlainJson(value: unknown, label: string, maxBytes = EXECUTABLE_NODE_PROVIDER_MAX_SCHEMA_BYTES): unknown {
  let seen = 0;
  const visit = (candidate: unknown, depth: number): void => {
    if (depth > 32 || ++seen > 10_000) {
      throw new NodeProviderError('NODE_PROVIDER_INVALID_DESCRIPTOR', `${label} is too deeply nested or complex.`);
    }
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) {
        throw new NodeProviderError('NODE_PROVIDER_INVALID_DESCRIPTOR', `${label} must contain only finite JSON numbers.`);
      }
      return;
    }
    if (Array.isArray(candidate)) {
      for (const item of candidate) visit(item, depth + 1);
      return;
    }
    if (!isPlainRecord(candidate)) {
      throw new NodeProviderError('NODE_PROVIDER_INVALID_DESCRIPTOR', `${label} must be plain JSON.`);
    }
    for (const nested of Object.values(candidate)) visit(nested, depth + 1);
  };
  visit(value, 0);
  const encoded = JSON.stringify(value);
  if (Buffer.byteLength(encoded, 'utf8') > maxBytes) {
    throw new NodeProviderError('NODE_PROVIDER_INVALID_DESCRIPTOR', `${label} exceeds ${maxBytes} bytes.`);
  }
  return value;
}

function cloneProtocolJson(value: unknown, label: string): unknown {
  const seen = new WeakSet<object>();
  let count = 0;
  const clone = (candidate: unknown, depth: number): unknown => {
    if (depth > 32 || ++count > 100_000) {
      throw new NodeProviderError('NODE_PROVIDER_INVALID_REQUEST', `${label} is too deeply nested or complex.`);
    }
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return candidate;
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate)) throw new NodeProviderError('NODE_PROVIDER_INVALID_REQUEST', `${label} contains a non-finite number.`);
      return candidate;
    }
    if (!candidate || typeof candidate !== 'object') {
      throw new NodeProviderError('NODE_PROVIDER_INVALID_REQUEST', `${label} must contain only JSON values.`);
    }
    if (seen.has(candidate)) throw new NodeProviderError('NODE_PROVIDER_INVALID_REQUEST', `${label} must not contain cycles.`);
    seen.add(candidate);
    if (Array.isArray(candidate)) {
      const descriptors = Object.getOwnPropertyDescriptors(candidate);
      if (Object.getOwnPropertySymbols(candidate).some(symbol => Object.getOwnPropertyDescriptor(candidate, symbol)?.enumerable)) {
        throw new NodeProviderError('NODE_PROVIDER_INVALID_REQUEST', `${label} must not contain enumerable symbol keys.`);
      }
      if (Object.keys(descriptors).some(key => key !== 'length' && !/^(0|[1-9]\d*)$/.test(key))) {
        throw new NodeProviderError('NODE_PROVIDER_INVALID_REQUEST', `${label} arrays must not contain named properties.`);
      }
      const result = Array.from({ length: candidate.length }, (_item, index) => {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !('value' in descriptor)) {
          throw new NodeProviderError('NODE_PROVIDER_INVALID_REQUEST', `${label} arrays must not contain holes or accessors.`);
        }
        return clone(descriptor.value, depth + 1);
      });
      seen.delete(candidate);
      return result;
    }
    if (!isPlainRecord(candidate)) throw new NodeProviderError('NODE_PROVIDER_INVALID_REQUEST', `${label} must be plain JSON.`);
    if (Object.getOwnPropertySymbols(candidate).some(symbol => Object.getOwnPropertyDescriptor(candidate, symbol)?.enumerable)) {
      throw new NodeProviderError('NODE_PROVIDER_INVALID_REQUEST', `${label} must not contain enumerable symbol keys.`);
    }
    const result: Record<string, unknown> = Object.create(null);
    for (const [key, descriptor] of Object.entries(Object.getOwnPropertyDescriptors(candidate))) {
      if (!descriptor.enumerable) continue;
      if (key.length > 256) throw new NodeProviderError('NODE_PROVIDER_INVALID_REQUEST', `${label} contains an overlong key.`);
      if (!('value' in descriptor)) throw new NodeProviderError('NODE_PROVIDER_INVALID_REQUEST', `${label} must not contain accessors.`);
      Object.defineProperty(result, key, {
        value: clone(descriptor.value, depth + 1),
        enumerable: true,
        writable: true,
        configurable: true,
      });
    }
    seen.delete(candidate);
    return result;
  };
  return clone(value, 0);
}

function normalizeTool(value: unknown, nodeId: string, index: number): NodeCapabilityDescriptor {
  if (!isPlainRecord(value)) {
    throw new NodeProviderError('NODE_PROVIDER_INVALID_DESCRIPTOR', `Node \`${nodeId}\` tool ${index} must be an object.`);
  }
  assertOnlyKeys(value, ['name', 'description', 'parameters'], `Node \`${nodeId}\` tool ${index}`);
  const name = exactString(value.name, `Node \`${nodeId}\` tool name`, 128, /^[A-Za-z0-9][A-Za-z0-9_.:-]*$/);
  const descriptor: NodeCapabilityDescriptor = { name };
  if (value.description !== undefined) {
    if (typeof value.description !== 'string'
      || value.description.length > 2_000
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.description)) {
      throw new NodeProviderError('NODE_PROVIDER_INVALID_DESCRIPTOR', `Node \`${nodeId}\` tool \`${name}\` description is invalid.`);
    }
    descriptor.description = value.description;
  }
  if (value.parameters !== undefined) {
    descriptor.parameters = validatePlainJson(value.parameters, `Node \`${nodeId}\` tool \`${name}\` schema`);
  }
  return descriptor;
}

function normalizeNode(value: unknown, providerId: string, index: number): NodeDescriptor {
  if (!isPlainRecord(value)) {
    throw new NodeProviderError('NODE_PROVIDER_INVALID_DESCRIPTOR', `Provider \`${providerId}\` node ${index} must be an object.`);
  }
  assertOnlyKeys(value, ['id', 'kind', 'type', 'availability', 'tools', 'defaultCwd'], `Provider \`${providerId}\` node ${index}`);
  const id = exactString(value.id, `Provider \`${providerId}\` node id`, 128, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
  if (id.toLowerCase() === 'master') {
    throw new NodeProviderError('NODE_PROVIDER_INVALID_DESCRIPTOR', 'Executable providers cannot advertise the reserved `master` Node ID.');
  }
  if (value.kind !== 'sandbox') {
    throw new NodeProviderError('NODE_PROVIDER_INVALID_DESCRIPTOR', `Executable provider node \`${id}\` kind must be \`sandbox\`.`);
  }
  const type = exactString(value.type, `Node \`${id}\` type`, 64, /^[A-Za-z0-9][A-Za-z0-9._-]*$/);
  const availabilityValues: NodeAvailability[] = ['ready', 'unavailable', 'offline', 'error'];
  if (!availabilityValues.includes(value.availability as NodeAvailability)) {
    throw new NodeProviderError('NODE_PROVIDER_INVALID_DESCRIPTOR', `Node \`${id}\` availability is invalid.`);
  }
  if (!Array.isArray(value.tools) || value.tools.length > EXECUTABLE_NODE_PROVIDER_MAX_TOOLS) {
    throw new NodeProviderError('NODE_PROVIDER_INVALID_DESCRIPTOR', `Node \`${id}\` tools must contain at most ${EXECUTABLE_NODE_PROVIDER_MAX_TOOLS} entries.`);
  }
  const tools = value.tools.map((tool, toolIndex) => normalizeTool(tool, id, toolIndex));
  if (new Set(tools.map(tool => tool.name)).size !== tools.length) {
    throw new NodeProviderError('NODE_PROVIDER_INVALID_DESCRIPTOR', `Node \`${id}\` advertises duplicate tool names.`);
  }
  return {
    id,
    kind: 'sandbox',
    provider: providerId,
    type,
    availability: value.availability as NodeAvailability,
    tools,
    ...(value.defaultCwd === undefined ? {} : { defaultCwd: boundedString(value.defaultCwd, `Node \`${id}\` defaultCwd`, 4_096) }),
  };
}

function normalizeListResult(value: unknown, providerId: string): NodeDescriptor[] {
  if (!isPlainRecord(value)) {
    throw new NodeProviderError('NODE_PROVIDER_PROTOCOL_INVALID_RESPONSE', 'Executable provider list result must be an object.');
  }
  assertOnlyKeys(value, ['nodes'], 'Executable provider list result');
  if (!Array.isArray(value.nodes) || value.nodes.length > EXECUTABLE_NODE_PROVIDER_MAX_NODES) {
    throw new NodeProviderError('NODE_PROVIDER_INVALID_DESCRIPTOR', `Executable provider list may contain at most ${EXECUTABLE_NODE_PROVIDER_MAX_NODES} nodes.`);
  }
  const nodes = value.nodes.map((node, index) => normalizeNode(node, providerId, index));
  if (new Set(nodes.map(node => node.id)).size !== nodes.length) {
    throw new NodeProviderError('NODE_PROVIDER_DUPLICATE_NODE', `Executable provider \`${providerId}\` advertises duplicate Node IDs.`);
  }
  return nodes;
}

function normalizeLifecycleResult(
  value: unknown,
  providerId: string,
  operation: 'create' | 'ensure' | 'inspect' | 'destroy',
): NodeLifecycleResult {
  if (!isPlainRecord(value)) {
    throw new NodeProviderError('NODE_LIFECYCLE_INVALID_RESULT', `Executable provider ${operation} result must be an object.`);
  }
  assertOnlyKeys(value, ['node', 'nodeId', 'effect', 'dataRetention', 'details'], `Executable provider ${operation} result`);
  const result: NodeLifecycleResult = {};
  if (operation === 'create' || operation === 'ensure' || operation === 'inspect') {
    result.node = normalizeNode(value.node, providerId, 0);
  } else {
    result.nodeId = exactString(value.nodeId, 'Executable provider destroy result nodeId', 128, /^[A-Za-z0-9][A-Za-z0-9._:-]*$/);
  }
  if (value.effect !== undefined) {
    result.effect = boundedString(value.effect, `Executable provider ${operation} effect`, 4_096);
  }
  if (value.dataRetention !== undefined) {
    result.dataRetention = boundedString(value.dataRetention, `Executable provider ${operation} dataRetention`, 4_096);
  }
  if (value.details !== undefined) {
    result.details = validatePlainJson(
      value.details,
      `Executable provider ${operation} details`,
      EXECUTABLE_NODE_PROVIDER_MAX_LIFECYCLE_DETAILS_BYTES,
    );
  }
  return result;
}

export type ExecutableNodeProviderOperation = 'list' | 'invoke' | 'create' | 'ensure' | 'inspect' | 'destroy';

export type ExecutableNodeProviderRequest = {
  protocol: typeof EXECUTABLE_NODE_PROVIDER_PROTOCOL;
  providerId: string;
  requestId: string;
  operation: ExecutableNodeProviderOperation;
  request?: unknown;
};

export type ExecutableNodeProviderResponse = {
  protocol: typeof EXECUTABLE_NODE_PROVIDER_PROTOCOL;
  providerId: string;
  requestId: string;
  operation: ExecutableNodeProviderOperation;
  ok: boolean;
  result?: unknown;
  error?: { code: string; message: string; retryable?: boolean };
};

export class ExecutableNodeProvider implements NodeProvider {
  readonly id: string;
  readonly deferredLookup = true;
  private activeRequests = 0;

  constructor(private readonly config: NormalizedExecutableNodeProviderConfig) {
    this.id = config.id;
  }

  async listNodes(options?: NodeProviderCallOptions): Promise<NodeDescriptor[]> {
    const result = await this.run('list', undefined, EXECUTABLE_NODE_PROVIDER_MAX_LIST_BYTES, options);
    return normalizeListResult(result, this.id);
  }

  async getNode(nodeId: string, options?: NodeProviderCallOptions): Promise<NodeDescriptor | undefined> {
    return (await this.listNodes(options)).find(node => node.id === nodeId);
  }

  async invokeTool(request: NodeToolRequest, options?: NodeProviderCallOptions): Promise<unknown> {
    return this.run('invoke', {
      sourceSessionId: request.sourceSessionId,
      nodeId: request.nodeId,
      toolName: request.toolName,
      args: request.args,
      context: request.context,
    }, EXECUTABLE_NODE_PROVIDER_MAX_RESULT_BYTES, options);
  }

  async createNode(request: NodeLifecycleProviderRequest, options?: NodeProviderCallOptions): Promise<NodeLifecycleResult> {
    const result = await this.run('create', request, EXECUTABLE_NODE_PROVIDER_MAX_LIFECYCLE_BYTES, options);
    return normalizeLifecycleResult(result, this.id, 'create');
  }

  async ensureNode(request: NodeLifecycleProviderRequest, options?: NodeProviderCallOptions): Promise<NodeLifecycleResult> {
    const result = await this.run('ensure', request, EXECUTABLE_NODE_PROVIDER_MAX_LIFECYCLE_BYTES, options);
    return normalizeLifecycleResult(result, this.id, 'ensure');
  }

  async inspectNode(request: NodeLifecycleNodeRequest, options?: NodeProviderCallOptions): Promise<NodeLifecycleResult> {
    const result = await this.run('inspect', request, EXECUTABLE_NODE_PROVIDER_MAX_LIFECYCLE_BYTES, options);
    return normalizeLifecycleResult(result, this.id, 'inspect');
  }

  async destroyNode(request: NodeLifecycleNodeRequest, options?: NodeProviderCallOptions): Promise<NodeLifecycleResult> {
    const result = await this.run('destroy', request, EXECUTABLE_NODE_PROVIDER_MAX_LIFECYCLE_BYTES, options);
    return normalizeLifecycleResult(result, this.id, 'destroy');
  }

  private async run(
    operation: ExecutableNodeProviderOperation,
    request: unknown,
    maxStdoutBytes: number,
    options?: NodeProviderCallOptions,
  ): Promise<unknown> {
    if (this.activeRequests >= EXECUTABLE_NODE_PROVIDER_MAX_CONCURRENT) {
      throw new NodeProviderError('NODE_PROVIDER_BACKPRESSURE', `Executable Node provider \`${this.id}\` has too many active requests.`, true);
    }
    if (options?.signal?.aborted) {
      throw new NodeProviderError('NODE_PROVIDER_CANCELLED', `Executable Node provider \`${this.id}\` request was cancelled.`, true);
    }
    const requestId = crypto.randomUUID();
    const envelope: ExecutableNodeProviderRequest = {
      protocol: EXECUTABLE_NODE_PROVIDER_PROTOCOL,
      providerId: this.id,
      requestId,
      operation,
      ...(request === undefined ? {} : { request: cloneProtocolJson(request, 'Executable Node provider request') }),
    };
    let encoded: string;
    try {
      encoded = JSON.stringify(envelope);
    } catch {
      throw new NodeProviderError('NODE_PROVIDER_INVALID_REQUEST', 'Executable Node provider request must be finite JSON.');
    }
    if (Buffer.byteLength(encoded, 'utf8') > EXECUTABLE_NODE_PROVIDER_MAX_REQUEST_BYTES) {
      throw new NodeProviderError('NODE_PROVIDER_REQUEST_LIMIT', `Executable Node provider request exceeds ${EXECUTABLE_NODE_PROVIDER_MAX_REQUEST_BYTES} bytes.`);
    }

    this.activeRequests += 1;
    try {
      const raw = await this.runChild(encoded, maxStdoutBytes, options?.signal);
      return this.parseResponse(raw, requestId, operation);
    } finally {
      this.activeRequests -= 1;
    }
  }

  private runChild(encoded: string, maxStdoutBytes: number, signal?: AbortSignal): Promise<string> {
    return new Promise((resolve, reject) => {
      let child: ChildProcessWithoutNullStreams;
      try {
        child = spawn(this.config.command, this.config.args, {
          shell: false,
          windowsHide: true,
          stdio: ['pipe', 'pipe', 'pipe'],
          env: providerEnvironment(),
        });
      } catch {
        reject(new NodeProviderError('NODE_PROVIDER_PROCESS_START', `Executable Node provider \`${this.id}\` failed to start.`, true));
        return;
      }

      const stdout: Buffer[] = [];
      let stdoutBytes = 0;
      let stderrBytes = 0;
      let settled = false;
      let exited = false;
      let exitCode: number | null = null;
      let exitSignal: NodeJS.Signals | null = null;
      let terminalError: NodeProviderError | undefined;
      let timeoutTimer: NodeJS.Timeout | undefined;
      let killTimer: NodeJS.Timeout | undefined;
      let confirmTimer: NodeJS.Timeout | undefined;
      let closeTimer: NodeJS.Timeout | undefined;
      const deadlineAt = Date.now() + this.config.timeoutMs;

      const cleanup = () => {
        if (timeoutTimer) clearTimeout(timeoutTimer);
        if (killTimer) clearTimeout(killTimer);
        if (confirmTimer) clearTimeout(confirmTimer);
        if (closeTimer) clearTimeout(closeTimer);
        signal?.removeEventListener('abort', onAbort);
      };
      const destroyOwnedStdio = () => {
        child.stdin.destroy();
        child.stdout.destroy();
        child.stderr.destroy();
      };
      const settleReject = (error: NodeProviderError, destroyStdio = false) => {
        if (settled) return;
        settled = true;
        cleanup();
        if (destroyStdio) destroyOwnedStdio();
        reject(error);
      };
      const settleResolve = (value: string) => {
        if (settled) return;
        settled = true;
        cleanup();
        resolve(value);
      };
      const scheduleCloseConfirmation = () => {
        if (settled || closeTimer) return;
        if (timeoutTimer) {
          clearTimeout(timeoutTimer);
          timeoutTimer = undefined;
        }
        closeTimer = setTimeout(() => {
          const error = terminalError || new NodeProviderError(
            'NODE_PROVIDER_PROCESS_CLOSE_TIMEOUT',
            `Executable Node provider \`${this.id}\` exited without closing its owned stdio.`,
            true,
          );
          settleReject(error, true);
        }, terminalError ? TERMINATE_GRACE_MS : Math.max(1, deadlineAt - Date.now()));
      };
      const terminate = (error: NodeProviderError) => {
        if (!terminalError) terminalError = error;
        if (settled) return;
        if (exited || child.exitCode !== null || child.signalCode !== null) {
          exited = true;
          settleReject(terminalError, true);
          return;
        }
        try { child.kill('SIGTERM'); } catch {}
        if (!killTimer) {
          killTimer = setTimeout(() => {
            if (settled) return;
            if (exited || child.exitCode !== null || child.signalCode !== null) {
              exited = true;
              settleReject(terminalError!, true);
              return;
            }
            try { child.kill('SIGKILL'); } catch {}
            confirmTimer = setTimeout(() => {
              if (settled) return;
              settleReject(
                new NodeProviderError('NODE_PROVIDER_PROCESS_EXIT_UNCONFIRMED', `Executable Node provider \`${this.id}\` did not confirm child exit.`),
                true,
              );
            }, KILL_CONFIRM_MS);
          }, TERMINATE_GRACE_MS);
        }
      };
      const onAbort = () => terminate(new NodeProviderError('NODE_PROVIDER_CANCELLED', `Executable Node provider \`${this.id}\` request was cancelled.`, true));
      timeoutTimer = setTimeout(() => {
        terminate(new NodeProviderError('NODE_PROVIDER_TIMEOUT', `Executable Node provider \`${this.id}\` exceeded its ${this.config.timeoutMs}ms request timeout.`, true));
      }, this.config.timeoutMs);

      signal?.addEventListener('abort', onAbort, { once: true });
      if (signal?.aborted) onAbort();
      child.stdout.on('data', (chunk: Buffer) => {
        if (settled) return;
        stdoutBytes += chunk.length;
        if (stdoutBytes > maxStdoutBytes) {
          terminate(new NodeProviderError('NODE_PROVIDER_OUTPUT_LIMIT', `Executable Node provider \`${this.id}\` stdout exceeded ${maxStdoutBytes} bytes.`));
          return;
        }
        stdout.push(chunk);
      });
      child.stderr.on('data', (chunk: Buffer) => {
        if (settled) return;
        stderrBytes += chunk.length;
        if (stderrBytes > EXECUTABLE_NODE_PROVIDER_MAX_STDERR_BYTES) {
          terminate(new NodeProviderError('NODE_PROVIDER_STDERR_LIMIT', `Executable Node provider \`${this.id}\` stderr exceeded ${EXECUTABLE_NODE_PROVIDER_MAX_STDERR_BYTES} bytes.`));
        }
      });
      child.once('error', () => {
        settleReject(new NodeProviderError('NODE_PROVIDER_PROCESS_START', `Executable Node provider \`${this.id}\` failed to start.`, true), true);
      });
      child.once('exit', (code, childSignal) => {
        if (settled) return;
        exited = true;
        exitCode = code;
        exitSignal = childSignal;
        scheduleCloseConfirmation();
      });
      child.once('close', (code, childSignal) => {
        if (settled) return;
        exited = true;
        exitCode = code;
        exitSignal = childSignal;
        if (terminalError) {
          settleReject(terminalError);
          return;
        }
        if (exitSignal || exitCode !== 0) {
          settleReject(new NodeProviderError(
            'NODE_PROVIDER_PROCESS_EXIT',
            `Executable Node provider \`${this.id}\` exited abnormally (${exitSignal ? `signal ${exitSignal}` : `code ${code ?? 'unknown'}`}).`,
            true,
          ));
          return;
        }
        settleResolve(Buffer.concat(stdout).toString('utf8'));
      });
      child.stdin.on('error', () => {});
      child.stdin.end(encoded);
    });
  }

  private parseResponse(raw: string, requestId: string, operation: ExecutableNodeProviderOperation): unknown {
    const trimmed = raw.trim();
    if (!trimmed) {
      throw new NodeProviderError('NODE_PROVIDER_PROTOCOL_INVALID_RESPONSE', `Executable Node provider \`${this.id}\` returned empty stdout.`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(trimmed);
    } catch {
      throw new NodeProviderError('NODE_PROVIDER_PROTOCOL_INVALID_RESPONSE', `Executable Node provider \`${this.id}\` stdout must contain exactly one JSON response.`);
    }
    if (!isPlainRecord(parsed)) {
      throw new NodeProviderError('NODE_PROVIDER_PROTOCOL_INVALID_RESPONSE', 'Executable Node provider response must be an object.');
    }
    assertOnlyKeys(parsed, ['protocol', 'providerId', 'requestId', 'operation', 'ok', 'result', 'error'], 'Executable Node provider response');
    if (parsed.protocol !== EXECUTABLE_NODE_PROVIDER_PROTOCOL) {
      throw new NodeProviderError('NODE_PROVIDER_PROTOCOL_MISMATCH', `Executable Node provider \`${this.id}\` returned the wrong protocol.`);
    }
    if (parsed.providerId !== this.id) {
      throw new NodeProviderError('NODE_PROVIDER_ID_MISMATCH', `Executable Node provider \`${this.id}\` returned the wrong provider identity.`);
    }
    if (parsed.requestId !== requestId) {
      throw new NodeProviderError('NODE_PROVIDER_REQUEST_MISMATCH', `Executable Node provider \`${this.id}\` returned the wrong request identity.`);
    }
    if (parsed.operation !== operation) {
      throw new NodeProviderError('NODE_PROVIDER_OPERATION_MISMATCH', `Executable Node provider \`${this.id}\` returned the wrong operation identity.`);
    }
    if (parsed.ok === true) {
      if (!Object.prototype.hasOwnProperty.call(parsed, 'result') || Object.prototype.hasOwnProperty.call(parsed, 'error')) {
        throw new NodeProviderError('NODE_PROVIDER_PROTOCOL_INVALID_RESPONSE', 'Successful executable provider response must contain only a result envelope.');
      }
      return parsed.result;
    }
    if (parsed.ok !== false || Object.prototype.hasOwnProperty.call(parsed, 'result') || !isPlainRecord(parsed.error)) {
      throw new NodeProviderError('NODE_PROVIDER_PROTOCOL_INVALID_RESPONSE', 'Failed executable provider response must contain only an error envelope.');
    }
    assertOnlyKeys(parsed.error, ['code', 'message', 'retryable'], 'Executable Node provider error');
    if (typeof parsed.error.code !== 'string'
      || parsed.error.code.length === 0
      || parsed.error.code.length > 128
      || !/^[A-Za-z0-9][A-Za-z0-9_.:-]*$/.test(parsed.error.code)) {
      throw new NodeProviderError('NODE_PROVIDER_PROTOCOL_INVALID_RESPONSE', 'Executable Node provider error code is invalid.');
    }
    if (typeof parsed.error.message !== 'string'
      || parsed.error.message.length === 0
      || parsed.error.message.length > 16_384
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(parsed.error.message)) {
      throw new NodeProviderError('NODE_PROVIDER_PROTOCOL_INVALID_RESPONSE', 'Executable Node provider error message is invalid.');
    }
    if (parsed.error.retryable !== undefined && typeof parsed.error.retryable !== 'boolean') {
      throw new NodeProviderError('NODE_PROVIDER_PROTOCOL_INVALID_RESPONSE', 'Executable Node provider error retryable must be a boolean.');
    }
    if (['create', 'ensure', 'inspect', 'destroy'].includes(operation) && parsed.error.code === 'UnsupportedOperation') {
      throw new NodeProviderError(
        'NODE_LIFECYCLE_OPERATION_UNSUPPORTED',
        `Executable Node provider \`${this.id}\` does not support \`${operation}\`: ${parsed.error.message}`,
        false,
      );
    }
    throw new NodeProviderError(
      'NODE_PROVIDER_REPORTED_ERROR',
      `Executable Node provider \`${this.id}\` reported ${parsed.error.code}: ${parsed.error.message}`,
      parsed.error.retryable === true,
    );
  }
}
