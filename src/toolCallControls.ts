import type { FunctionCall, ToolDefinition } from './types';

export const CANCEL_TOOL_ARGUMENT = '__cancelTool';
export const CANCEL_ALL_TOOLS_ARGUMENT = '__cancelAllToolsThisTurn';
export const COMPACT_PLAN_TOOL_NAME = 'submit_compact_plan';

export const INTER_AGENT_HANDOFF_RECALL_PREFIX = 'Before composing this inter-agent handoff, have I recalled the applicable communication rules, the user\'s actual request, and the scope this recipient needs?';
export const INTER_AGENT_HANDOFF_RECALL_PLACEHOLDER = '<write the actual applicable rules, request, and recipient scope recalled for this handoff>';
export const INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX = 'Before sending this inter-agent handoff, have I honestly checked that it is necessary, actionable, and not merely acknowledgement, duplication, or inherited-rule repetition; if I found that it should not be sent, did I omit or cancel it instead?';
export const INTER_AGENT_HANDOFF_CONFIRMATION_PLACEHOLDER = '<write the specific honest review for this handoff>';
export const INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX = 'I have completed the check, found no issue, and confirm this inter-agent handoff should proceed.';

const CANCEL_PROPERTY_SCHEMA = {
  type: 'boolean',
  enum: [true],
};

const HANDOFF_TOOL_NAMES = new Set(['send_to_session', 'create_child_session']);

function hasArgument(args: Record<string, any>, key: string): boolean {
  return Object.prototype.hasOwnProperty.call(args || {}, key);
}

export function requiresInterAgentHandoffConfirmation(
  toolName: string,
  args: Record<string, any>,
): boolean {
  if (toolName === 'send_to_session') return true;
  if (toolName === 'create_child_session') {
    return hasArgument(args, 'message') || hasArgument(args, 'taskId');
  }
  return true;
}

export function addHandoffConfirmationSchema(definition: ToolDefinition, enabled: boolean): ToolDefinition {
  if (!HANDOFF_TOOL_NAMES.has(definition.name)) return definition;
  const parameters = definition.parameters;
  const originalProperties = { ...(parameters.properties || {}) };
  delete originalProperties.confirmation;
  delete originalProperties.handoffRecall;
  delete originalProperties.handoffConfirmation;
  const properties: Record<string, any> = {};
  for (const [key, value] of Object.entries(originalProperties)) {
    if (key === 'message') {
      if (enabled) {
        properties.handoffRecall = {
          type: 'string',
          description: `Put handoffRecall before message. Start with the exact opening sentence below, then write the actual applicable communication rules, the user\'s actual request, and the scope this recipient needs. Replace the placeholder with this handoff\'s own recalled context. This field is checked locally and is not delivered to the recipient.\n\n${INTER_AGENT_HANDOFF_RECALL_PREFIX}\n${INTER_AGENT_HANDOFF_RECALL_PLACEHOLDER}`,
        };
      }
    }
    properties[key] = value;
  }
  const required = (parameters.required || []).filter(key => key !== 'confirmation' && key !== 'handoffRecall' && key !== 'handoffConfirmation');
  if (enabled) {
    properties.handoffConfirmation = {
      type: 'string',
      description: `Put handoffConfirmation last in the arguments. Write an honest review of the proposed handoff using the exact opening and closing sentences below. Replace the placeholder with your own specific review. This field is checked locally and is not delivered to the recipient.${definition.name === 'create_child_session' ? ' When taskId is supplied, review the handoff action without copying the task description; the task assignment delivers that description separately.' : ''} If the handoff should not proceed, omit it or cancel with __cancelTool=true instead of approving it to satisfy the check.\n\nFor a handoff that should proceed, use: ${INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX}\n${INTER_AGENT_HANDOFF_CONFIRMATION_PLACEHOLDER}\n${INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX}`,
    };
    if (definition.name === 'send_to_session') {
      required.push('handoffRecall', 'handoffConfirmation');
    }
  }
  return {
    ...definition,
    description: enabled
      ? `${definition.description}${definition.name === 'create_child_session'
        ? ' A confirmation review is required when message or taskId is supplied; creating a child without either does not require review fields.'
        : ' A confirmation review is required.'}`
      : definition.description,
    parameters: {
      ...parameters,
      properties,
      ...(required.length ? { required } : { required: undefined }),
    },
  };
}

export function addToolCancellationSchema(definition: ToolDefinition): ToolDefinition {
  if (definition.name === COMPACT_PLAN_TOOL_NAME) return definition;
  const parameters = definition.parameters;
  return {
    ...definition,
    parameters: {
      ...parameters,
      properties: {
        ...(parameters.properties || {}),
        [CANCEL_TOOL_ARGUMENT]: {
          ...CANCEL_PROPERTY_SCHEMA,
          description: 'Set true to cancel this tool call before it runs.',
        },
        [CANCEL_ALL_TOOLS_ARGUMENT]: {
          ...CANCEL_PROPERTY_SCHEMA,
          description: 'Set true to cancel every tool call in this model response before any of them runs.',
        },
      },
    },
  };
}

export function stripToolCancellationArguments(args: Record<string, any> | undefined): Record<string, any> {
  const next = { ...(args || {}) };
  delete next[CANCEL_TOOL_ARGUMENT];
  delete next[CANCEL_ALL_TOOLS_ARGUMENT];
  return next;
}

export function getToolCancellationArgumentError(call: FunctionCall): string | undefined {
  if (call.argsParseError) return undefined;
  for (const key of [CANCEL_TOOL_ARGUMENT, CANCEL_ALL_TOOLS_ARGUMENT]) {
    if (Object.prototype.hasOwnProperty.call(call.args || {}, key) && call.args[key] !== true) {
      return `${key} accepts only the boolean value true when provided.`;
    }
  }
  return undefined;
}

export function isWholeBatchCancellationRequested(calls: FunctionCall[]): boolean {
  return calls.some(call => !call.argsParseError && call.args?.[CANCEL_ALL_TOOLS_ARGUMENT] === true);
}

export function isSingleToolCancellationRequested(call: FunctionCall): boolean {
  return !call.argsParseError && call.args?.[CANCEL_TOOL_ARGUMENT] === true;
}

export function validateInterAgentHandoffConfirmation(args: Record<string, any>): void {
  const recall = args?.handoffRecall;
  if (typeof recall !== 'string' || !recall.startsWith(INTER_AGENT_HANDOFF_RECALL_PREFIX)) {
    throw new Error('Inter-agent handoff recall must start with the exact required opening sentence and include the applicable recalled context.');
  }
  const recalledContext = recall.slice(INTER_AGENT_HANDOFF_RECALL_PREFIX.length).trim();
  if (!recalledContext || recalledContext === INTER_AGENT_HANDOFF_RECALL_PLACEHOLDER) {
    throw new Error('Inter-agent handoff recall must include the caller\'s actual recalled context instead of the documented placeholder.');
  }
  const confirmation = args?.handoffConfirmation;
  const prefix = INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX;
  const suffix = INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX;
  if (typeof confirmation !== 'string' || !confirmation.startsWith(prefix) || !confirmation.endsWith(suffix)) {
    throw new Error('Inter-agent handoff confirmation must contain the exact required prefix and suffix separated by a non-empty review.');
  }
  const review = confirmation.slice(prefix.length, confirmation.length - suffix.length).trim();
  if (!review) {
    throw new Error('Inter-agent handoff confirmation review must be non-empty.');
  }
  if (review === INTER_AGENT_HANDOFF_CONFIRMATION_PLACEHOLDER) {
    throw new Error('Inter-agent handoff confirmation review must replace the documented placeholder with the caller\'s own review.');
  }
  const keys = Object.keys(args);
  if (keys.at(-1) !== 'handoffConfirmation') {
    throw new Error('Inter-agent handoff confirmation must be the final argument property.');
  }
  const messageIndex = keys.indexOf('message');
  const recallIndex = keys.indexOf('handoffRecall');
  if (messageIndex >= 0 && (recallIndex < 0 || recallIndex > messageIndex)) {
    throw new Error('Inter-agent handoff recall must be before the message argument.');
  }
}

export function validateInterAgentHandoffConfirmationForMode(
  args: Record<string, any>,
  enabled: boolean,
  toolName?: string,
): void {
  if (enabled && (!toolName || requiresInterAgentHandoffConfirmation(toolName, args))) {
    validateInterAgentHandoffConfirmation(args);
  }
}
