import type { FunctionCall, ToolDefinition } from './types';

export const CANCEL_TOOL_ARGUMENT = '__cancelTool';
export const CANCEL_ALL_TOOLS_ARGUMENT = '__cancelAllToolsThisTurn';
export const COMPACT_PLAN_TOOL_NAME = 'submit_compact_plan';

export const INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX = 'Before performing this inter-agent handoff, have I checked that it is necessary, accurate, self-contained, appropriately scoped, and compliant with the communication rules?';
export const INTER_AGENT_HANDOFF_REVIEW_PLACEHOLDER = '<replace this with your own non-empty review; do not copy this placeholder verbatim>';
export const INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX = 'I have completed the check, found no issue, and confirm this inter-agent handoff should proceed.';

const CANCEL_PROPERTY_SCHEMA = {
  type: 'boolean',
  enum: [true],
};

const HANDOFF_TOOL_NAMES = new Set(['send_to_session', 'create_child_session']);

export function addHandoffConfirmationSchema(definition: ToolDefinition, enabled: boolean): ToolDefinition {
  if (!HANDOFF_TOOL_NAMES.has(definition.name)) return definition;
  const parameters = definition.parameters;
  const properties = { ...(parameters.properties || {}) };
  delete properties.confirmation;
  const required = (parameters.required || []).filter(key => key !== 'confirmation');
  if (enabled) {
    properties.confirmation = {
      type: 'string',
      description: `Required final argument property. Use exactly: ${INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX}\n${INTER_AGENT_HANDOFF_REVIEW_PLACEHOLDER}\n${INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX}`,
    };
    required.push('confirmation');
  }
  return {
    ...definition,
    description: enabled
      ? `${definition.description} Every call${definition.name === 'create_child_session' ? ', including creation without an initial message,' : ''} requires the structured inter-agent handoff confirmation.`
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
          description: 'Cancel this call before execution; only true is accepted.',
        },
        [CANCEL_ALL_TOOLS_ARGUMENT]: {
          ...CANCEL_PROPERTY_SCHEMA,
          description: 'Cancel all tool calls in this model response before execution; only true is accepted.',
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
  const confirmation = args?.confirmation;
  const prefix = `${INTER_AGENT_HANDOFF_CONFIRMATION_PREFIX}\n`;
  const suffix = `\n${INTER_AGENT_HANDOFF_CONFIRMATION_SUFFIX}`;
  if (typeof confirmation !== 'string' || !confirmation.startsWith(prefix) || !confirmation.endsWith(suffix)) {
    throw new Error('Inter-agent handoff confirmation must contain the exact required prefix and suffix separated by a non-empty review.');
  }
  const review = confirmation.slice(prefix.length, confirmation.length - suffix.length);
  if (!review.trim()) {
    throw new Error('Inter-agent handoff confirmation review must be non-empty.');
  }
  if (review.trim() === INTER_AGENT_HANDOFF_REVIEW_PLACEHOLDER) {
    throw new Error('Inter-agent handoff confirmation review must replace the documented placeholder with the caller\'s own review.');
  }
  if (Object.keys(args).at(-1) !== 'confirmation') {
    throw new Error('Inter-agent handoff confirmation must be the final argument property.');
  }
}

export function validateInterAgentHandoffConfirmationForMode(args: Record<string, any>, enabled: boolean): void {
  if (enabled) validateInterAgentHandoffConfirmation(args);
}
