export type ToolPlacementOwner =
  | 'node-environment'
  | 'session-owner'
  | 'main-management'
  | 'external-service'
  | 'dispatcher/container';

export interface ToolPlacementMetadata {
  owner: ToolPlacementOwner;
  defaultAction?: string;
  actionOwners?: Readonly<Record<string, ToolPlacementOwner>>;
}

export interface ResolvedBuiltinToolPlacement {
  name: string;
  owner: ToolPlacementOwner;
  executionNode: string;
}

/** Ownership metadata is deliberately separate from permission policy and model schemas. */
export const BUILTIN_TOOL_PLACEMENTS = {
  read: { owner: 'node-environment' },
  write: { owner: 'node-environment' },
  edit: { owner: 'node-environment' },
  apply_patch: { owner: 'node-environment' },
  read_memory: { owner: 'session-owner' },
  write_memory: { owner: 'session-owner' },
  edit_memory: { owner: 'session-owner' },
  delete_memory: { owner: 'session-owner' },
  apply_patch_memory: { owner: 'session-owner' },
  copy_between_nodes: { owner: 'main-management' },
  image_crop: { owner: 'session-owner' },
  image_write_to_file: { owner: 'dispatcher/container' },
  exec: { owner: 'node-environment' },
  create_child_session: { owner: 'dispatcher/container' },
  send_to_session: { owner: 'main-management' },
  wait: { owner: 'dispatcher/container' },
  send_to_channel: { owner: 'main-management' },
  send_file: { owner: 'dispatcher/container' },
  session: {
    owner: 'dispatcher/container',
    defaultAction: 'status',
    actionOwners: {
      status: 'session-owner',
      list: 'main-management',
      'update-display-name': 'main-management',
    },
  },
  list_agents: { owner: 'main-management' },
  skill: { owner: 'session-owner' },
  get_session_messages: { owner: 'dispatcher/container' },
  get_archived_messages: { owner: 'external-service' },
  get_archived_blocks: { owner: 'external-service' },
  recall: { owner: 'dispatcher/container' },
  delete_session: { owner: 'main-management' },
  set_goal: { owner: 'session-owner' },
  set_session_child_model: { owner: 'session-owner' },
  set_session_compact_threshold: { owner: 'session-owner' },
  update_session_snapshot: { owner: 'session-owner' },
  stop_session: { owner: 'dispatcher/container' },
  submit_compact_plan: { owner: 'session-owner' },
  compact_session: { owner: 'dispatcher/container' },
  create_timer: { owner: 'main-management' },
  list_timers: { owner: 'main-management' },
  update_timer: { owner: 'main-management' },
  delete_timer: { owner: 'main-management' },
  browse_open: { owner: 'node-environment' },
  browse_list: { owner: 'node-environment' },
  browse_get: { owner: 'node-environment' },
  browse_close: { owner: 'node-environment' },
  browse_interact: { owner: 'node-environment' },
  search_tools: { owner: 'dispatcher/container' },
  call_tool: { owner: 'dispatcher/container' },
  run_script: { owner: 'dispatcher/container' },
  start_toolscript_run: { owner: 'dispatcher/container' },
  continue_script: { owner: 'dispatcher/container' },
  list_toolscript_runs: { owner: 'dispatcher/container' },
  get_toolscript_run: { owner: 'dispatcher/container' },
  cancel_toolscript_run: { owner: 'dispatcher/container' },
  remote_node: { owner: 'dispatcher/container' },
  mcp_config: { owner: 'external-service' },
  call_mcp: { owner: 'external-service' },
  search_mcp_tools: { owner: 'external-service' },
  list_mcp_servers: { owner: 'external-service' },
  node: {
    owner: 'dispatcher/container',
    actionOwners: {
      list: 'main-management',
      select: 'dispatcher/container',
    },
  },
  node_bootstrap_info: { owner: 'main-management' },
  node_pair_approve: { owner: 'main-management' },
  node_pair_list: { owner: 'main-management' },
  create_agent: { owner: 'main-management' },
  create_session: { owner: 'main-management' },
  set_agent_inherit: { owner: 'main-management' },
  set_agent_isolated: { owner: 'main-management' },
  move_session: { owner: 'main-management' },
} as const satisfies Readonly<Record<string, ToolPlacementMetadata>>;

export type RegisteredBuiltinToolName = keyof typeof BUILTIN_TOOL_PLACEMENTS;

export const NODE_ENVIRONMENT_BUILTIN_NAMES = Object.freeze(
  Object.entries(BUILTIN_TOOL_PLACEMENTS)
    .filter(([, metadata]) => metadata.owner === 'node-environment')
    .map(([name]) => name as RegisteredBuiltinToolName),
);

export function resolveBuiltinToolPlacement(
  name: string,
  args: Record<string, unknown> | undefined,
  currentNode: string,
): ResolvedBuiltinToolPlacement {
  const metadata = BUILTIN_TOOL_PLACEMENTS[name as RegisteredBuiltinToolName] as ToolPlacementMetadata | undefined;
  if (!metadata) {
    // Preserve the existing direct-provider unknown-tool response path. Unknown
    // names are not registered metadata and never inherit currentNode routing.
    return { name, owner: 'dispatcher/container', executionNode: 'master' };
  }

  const requestedAction = typeof args?.action === 'string' && args.action.trim()
    ? args.action.trim().toLowerCase()
    : metadata.defaultAction;
  const owner = requestedAction && metadata.actionOwners?.[requestedAction]
    ? metadata.actionOwners[requestedAction]
    : metadata.owner;

  return {
    name,
    owner,
    executionNode: owner === 'node-environment' ? currentNode : 'master',
  };
}
