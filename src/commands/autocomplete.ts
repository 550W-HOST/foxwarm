import { CommandAutocompleteNode, literalNode, placeholderNode } from './types';

export const TIMER_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  literalNode('list', 'List timers for the current session'),
  literalNode('delete', 'Delete a timer by id', {
    usage: '/timer delete <id>',
    children: [placeholderNode('<id>', 'Timer identifier')],
  }),
  literalNode('after', 'Create a one-time timer after N seconds', {
    usage: '/timer after <seconds> [--new-session] [--prefix <prefix>] [--agent <agent>] [--] <message>',
    children: [placeholderNode('<seconds>', 'Delay in seconds')],
  }),
  literalNode('at', 'Create a one-time timer at an absolute time', {
    usage: '/timer at <ISO-time> [--new-session] [--prefix <prefix>] [--agent <agent>] [--] <message>',
    children: [placeholderNode('<ISO-time>', 'Absolute time like 2026-03-13T12:00:00Z')],
  }),
  literalNode('cron', 'Create a recurring cron timer', {
    usage: '/timer cron <expr> [--new-session] [--prefix <prefix>] [--agent <agent>] -- <message>',
    children: [placeholderNode('<expr>', 'Cron expression (5 or 6 fields)')],
  }),
]

export const BTW_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  placeholderNode('<message>', 'Side/background question to answer without executing tools'),
]

export const SESSION_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  literalNode('list', 'List all sessions', {
    usage: '/session list [page]',
    children: [placeholderNode('[page]', 'Optional page number')],
  }),
  literalNode('new', 'Create a new ad-hoc session'),
  literalNode('create', 'Create a session under an existing agent', {
    usage: '/session create <agent> <session> [--model <model>] [--system-prompt-file <path>]...',
    children: [
      placeholderNode('<agent>', 'Existing agent name', {
        children: [placeholderNode('<session>', 'New session name', {
          children: [
            literalNode('--model', 'Explicit model for the new session', {
              children: [placeholderNode('<model>', 'Model key or partial model name')],
            }),
            literalNode('--system-prompt-file', 'Add one file to the new session memory-source list', {
              children: [placeholderNode('<path>', 'Agent-relative, absolute, or ~/ file path')],
            }),
          ],
        })],
      }),
    ],
  }),
  literalNode('child-model', 'Get/set the current session child default model', {
    usage: '/session child-model [model|default|clear|unset]',
    children: [
      literalNode('default', 'Follow the current session model again'),
      literalNode('clear', 'Alias of default'),
      literalNode('unset', 'Alias of default'),
      placeholderNode('[model]', 'Model key or partial model name'),
    ],
  }),
  literalNode('fork', 'Fork the current session'),
  literalNode('delete', 'Delete a session', {
    usage: '/session delete <sessionId>',
    children: [placeholderNode('<sessionId>', 'Target session id')],
  }),
  literalNode('clear', 'Clear the current session history'),
  literalNode('rename', 'Set a session display name', {
    usage: '/session rename <name>',
    children: [placeholderNode('<name>', 'New display name')],
  }),
  literalNode('update-snapshot', 'Refresh a session prompt snapshot', {
    usage: '/session update-snapshot [session-id]',
    children: [placeholderNode('[session-id]', 'Defaults to the current session')],
  }),
  literalNode('compact-threshold', 'Get/set the auto-compact threshold override for the current session', {
    usage: '/session compact-threshold [tokens|Nk|clear|unset]',
    children: [
      placeholderNode('[tokens|Nk]', 'Examples: 8000, 8k'),
      literalNode('clear', 'Clear the session override and inherit the default threshold'),
      literalNode('unset', 'Alias of clear'),
    ],
  }),
  literalNode('index', 'Force archive indexing for the current session'),
  literalNode('move', 'Rename the current session or move it to an existing agent', {
    usage: '/session move <new-session-id>|<existing-agent>/<new-session-id> [--parent <parent-session-id>]',
    children: [placeholderNode('<new-session-id|agent/session>', 'Rename target or existing-agent/new-session-id', {
      children: [literalNode('--parent', 'Assign an existing parent after moving', {
        children: [placeholderNode('<parent-session-id>', 'Existing parent session ID')],
      })],
    })],
  }),
  literalNode('parent', 'Set a parent session', {
    usage: '/session parent <parent-session-id> [child-session-id]',
    children: [
      placeholderNode('<parent-session-id>', 'Parent session id', {
        children: [placeholderNode('[child-session-id]', 'Defaults to the current session')],
      }),
    ],
  }),
  literalNode('unparent', 'Remove a parent session', {
    usage: '/session unparent [child-session-id]',
    children: [placeholderNode('[child-session-id]', 'Defaults to the current session')],
  }),
  literalNode('archive', 'Archive a session', {
    usage: '/session archive [session-id]',
    children: [placeholderNode('[session-id]', 'Defaults to the current session')],
  }),
  literalNode('unarchive', 'Unarchive a session', {
    usage: '/session unarchive [session-id]',
    children: [placeholderNode('[session-id]', 'Defaults to the current session')],
  }),
]

export const AGENT_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  literalNode('list', 'List all agents'),
  literalNode('create', 'Create a new agent', {
    usage: '/agent create <name> [--no-main] [--isolated <node-id>]',
    children: [
      placeholderNode('<name>', 'New agent name', {
        children: [
          literalNode('--no-main', 'Create the agent without a main session'),
          literalNode('--isolated', 'Create the agent in isolated mode bound to a node', {
            children: [placeholderNode('<node-id>', 'Bound non-master node id')],
          }),
        ],
      }),
    ],
  }),
  literalNode('isolated', 'Set or clear agent-level isolation', {
    usage: '/agent isolated <agent> <node-id|off>',
    children: [
      placeholderNode('<agent>', 'Agent name', {
        children: [placeholderNode('<node-id|off>', 'Bind to node id or disable isolation with off')],
      }),
    ],
  }),
  literalNode('inherit', 'Set or clear shared-memory inheritance', {
    usage: '/agent inherit <agent> <parent-agent|none>',
    children: [
      placeholderNode('<agent>', 'Agent to update', {
        children: [placeholderNode('<parent-agent|none>', 'Parent agent name or none')],
      }),
    ],
  }),
  literalNode('delete', 'Delete an agent and all its sessions', {
    usage: '/agent delete <name> [--confirm]',
    children: [
      placeholderNode('<name>', 'Agent to delete', {
        children: [literalNode('--confirm', 'Required confirmation flag')],
      }),
    ],
  }),
]

export const SKILL_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  literalNode('list', 'List available skills'),
  literalNode('show', 'Show skill documents', {
    usage: '/skill show <skill>',
    children: [placeholderNode('<skill>', 'Skill name')],
  }),
]

export const NODE_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  literalNode('list', 'List approved nodes, pending approvals, and current node status'),
  literalNode('approve', 'Approve a pending node pairing request', {
    usage: '/node approve <pending-id> [node-id]',
    children: [
      placeholderNode('<pending-id>', 'Pending pairing id', {
        children: [placeholderNode('[node-id]', 'Optional final node id')],
      }),
    ],
  }),
  literalNode('reject', 'Reject a pending node pairing request', {
    usage: '/node reject <pending-id>',
    children: [placeholderNode('<pending-id>', 'Pending pairing id')],
  }),
  literalNode('remove', 'Remove an approved node and invalidate its credentials', {
    usage: '/node remove <node-id>',
    children: [placeholderNode('<node-id>', 'Approved node id to remove')],
  }),
  literalNode('move', 'Rename an approved node id while preserving its auth hash and metadata', {
    usage: '/node move <old-id> <new-id>',
    children: [placeholderNode('<old-id>', 'Existing approved node id', {
      children: [placeholderNode('<new-id>', 'New sanitized node id')],
    })],
  }),
  literalNode('pair-help', 'Show node pairing/bootstrap help'),
  placeholderNode('<node-id>', 'Existing node id; omit it to list nodes'),
]

export const MESSAGES_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  placeholderNode('<num>', 'Positive = oldest messages, negative = newest', {
    children: [placeholderNode('[end]', 'Optional end index for a range')],
  }),
]

export const MODEL_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  literalNode('default', 'Reset to the default model'),
  placeholderNode('<name>', 'Model name or partial model name'),
]

export const DELETE_MESSAGES_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  placeholderNode('<num>', 'Positive = oldest, negative = newest'),
]

export const VERBOSE_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  literalNode('on', 'Show tool calls and verbose details'),
  literalNode('off', 'Hide tool calls and verbose details'),
]

export const CHANNEL_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  literalNode('info', 'Show current channel identifiers and attachment state'),
  literalNode('auth', 'Show current channel authorization diagnostics'),
  literalNode('status', 'Show runtime channel status', {
    children: [placeholderNode('[channel-id-or-type]', 'Optional channel id (preferred) or type, e.g. weixin')],
  }),
  literalNode('start', 'Start a managed channel without restarting foxwarm', {
    children: [placeholderNode('<channel-id>', 'Managed channel id, e.g. weixin or mainbot')],
  }),
  literalNode('stop', 'Stop a managed channel', {
    children: [placeholderNode('<channel-id>', 'Managed channel id, e.g. weixin or mainbot')],
  }),
  literalNode('restart', 'Restart a managed channel', {
    children: [placeholderNode('<channel-id>', 'Managed channel id, e.g. weixin or mainbot')],
  }),
  literalNode('mode', 'Set channel mode', {
    children: [
      literalNode('send-only', 'Only allow direct sending via explicit tools, not normal session reply broadcasts'),
      literalNode('normal', 'Normal interactive mode'),
    ],
  }),
  literalNode('dangerously-allow-all-users', 'Allow all users in this attached conversation to send normal messages', {
    children: [
      literalNode('yes', 'Enable allow-all mode'),
      literalNode('no', 'Disable allow-all mode'),
    ],
  }),
]

export const SEARCH_AUTOCOMPLETE: CommandAutocompleteNode[] = [
  literalNode('--session', 'Restrict search to one session in your allowed scope', {
    children: [placeholderNode('<session-id>', 'Session id within your allowed scope')],
  }),
  literalNode('--agent', 'Restrict search to your current agent', {
    children: [placeholderNode('<agent-name>', 'Current agent only')],
  }),
  literalNode('--limit', 'Maximum number of matches', {
    children: [placeholderNode('<n>', 'Result limit, default 5')],
  }),
  placeholderNode('<query>', 'Search query text'),
]
