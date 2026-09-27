import { requireVerifiedMcpInboundExternalId, type VerifiedMcpInboundPrincipal } from './mcpInboundConfig';
import type { ExternalExecutionContext } from './mcpInboundHttp';
import { definitions } from './tools/definitions';
import * as nodeTools from './tools/nodeTools';
import {
  buildExternalToolAuthorizationRequest, evaluateToolAuthorization, evaluateToolAuthorizationSync,
  isToolAuthorizationPotentiallyVisibleSync,
} from './toolAuthorization';

const supportedNames = ['node_pair_list', 'node_pair_approve'] as const;
export type ExternalPairingToolName = typeof supportedNames[number];
export class ExternalPairingBeforeEffectError extends Error {}
export function isExternalPairingToolName(name: string): name is ExternalPairingToolName {
  return name === 'node_pair_list' || name === 'node_pair_approve';
}

function assertActive(principal: VerifiedMcpInboundPrincipal, context: ExternalExecutionContext): void {
  if (context.externalId !== requireVerifiedMcpInboundExternalId(principal) || context.disposed) {
    throw new ExternalPairingBeforeEffectError('External pairing context is unavailable.');
  }
}
function permission(principal: VerifiedMcpInboundPrincipal, context: ExternalExecutionContext,
  name: ExternalPairingToolName, args: Record<string, unknown> = {}) {
  return buildExternalToolAuthorizationRequest({ principal, sessionId: context.id,
    tool: { source: 'builtin', name }, args });
}

/** Only the two pre-existing Main-owned pairing tools are discoverable, with their original copy/schema. */
export function listExternalPairingDefinitions(principal: VerifiedMcpInboundPrincipal, context: ExternalExecutionContext) {
  assertActive(principal, context);
  const visible = supportedNames.filter(name =>
    isToolAuthorizationPotentiallyVisibleSync(permission(principal, context, name)));
  assertActive(principal, context);
  return visible.map(name => {
    const definition = definitions.find(item => item.name === name);
    if (!definition) throw new Error(`Missing builtin pairing definition: ${name}`);
    return definition;
  });
}

/** Use the ordinary Main pairing handlers without creating a ToolContext or claiming an internal Session. */
export async function callExternalPairingTool(principal: VerifiedMcpInboundPrincipal, context: ExternalExecutionContext,
  name: ExternalPairingToolName, args: Record<string, unknown>): Promise<string> {
  assertActive(principal, context);
  if (!supportedNames.includes(name) || Object.keys(args).some(key => name === 'node_pair_list'
    || (key !== 'pendingId' && key !== 'nodeId'))
    || (name === 'node_pair_approve' && (typeof args.pendingId !== 'string' || !args.pendingId.trim()
      || Buffer.byteLength(args.pendingId, 'utf8') > 256
      || (args.nodeId !== undefined && (typeof args.nodeId !== 'string' || !args.nodeId.trim()
        || Buffer.byteLength(args.nodeId, 'utf8') > 128))))) {
    throw new ExternalPairingBeforeEffectError('Invalid pairing arguments.');
  }
  if ((await evaluateToolAuthorization(permission(principal, context, name, args))).action !== 'allow') {
    throw new ExternalPairingBeforeEffectError('Pairing operation is not permitted.');
  }
  assertActive(principal, context);
  if (name === 'node_pair_list') return nodeTools.tool_node_pair_list();
  return nodeTools.tool_node_pair_approve(args, undefined, () => {
    assertActive(principal, context);
    if (evaluateToolAuthorizationSync(permission(principal, context, name, args)).action !== 'allow') {
      throw new ExternalPairingBeforeEffectError('Pairing operation is not permitted.');
    }
  });
}
