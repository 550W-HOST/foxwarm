export const CLI_NODE_CAPABILITIES = {
  services: {
    'vscode-fs': 1,
    'vscode-git': 1,
  },
  tools: [
    {
      name: 'read',
      description: 'Read a file or list a directory. Directory reads are non-recursive, default to 50 items, and use startLine/endLine as item numbers; passing 0 for startLine/endLine is treated as omitted. Relative paths resolve from the session cwd when one is supplied for this node, otherwise from this node\'s agent folder. Absolute paths and ~/... are accepted when allowed.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          startLine: { type: 'number', description: 'Starting line number/item number (1-indexed, optional). 0 is treated as omitted.' },
          endLine: { type: 'number', description: 'Ending line number/item number (1-indexed, inclusive, optional). 0 is treated as omitted.' },
        },
        required: ['filePath'],
      },
    },
    {
      name: 'write',
      description: 'Write a file. By default, parent directories must already exist; pass createDirs=true to create missing parent directories. Relative paths resolve from the session cwd when one is supplied for this node, otherwise from this node\'s agent folder. Absolute paths and ~/... are accepted when allowed.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          content: { type: 'string' },
          overwrite: { type: 'boolean' },
          createDirs: { type: 'boolean', description: 'Create missing parent directories before writing. Default: false' },
        },
        required: ['filePath', 'content'],
      },
    },
    {
      name: 'edit',
      description: 'Replace exact text in a file using oldText/newText. Relative paths resolve from the session cwd when one is supplied for this node, otherwise from this node\'s agent folder.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          oldText: { type: 'string' },
          newText: { type: 'string' },
        },
        required: ['filePath', 'oldText', 'newText'],
      },
    },
    {
      name: 'apply_patch',
      description: 'Apply an OpenAI-style patch envelope to modify files. Paths in patch file headers resolve from the session cwd when one is supplied for this node, otherwise from this node\'s agent folder.',
      parameters: {
        type: 'object',
        properties: { input: { type: 'string' } },
        required: ['input'],
      },
    },
    {
      name: 'exec',
      description: 'Execute a shell command. Uses explicit cwd when provided, otherwise the session cwd when supplied for this node, otherwise the node process cwd. Relative cwd values resolve from the session cwd when set, otherwise from the node process cwd. Commands running over the timeout continue in the background and send a completion message later. Timeout values above the 60s maximum are clamped to 60s with a warning.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
          timeout: { type: 'number', minimum: 1, description: 'Optional timeout in seconds. Default: 15. Values above the 60s maximum are clamped to 60s with a warning.' },
        },
        required: ['command'],
      },
    },
    {
      name: 'get_default_cwd',
      description: 'Return the node process working directory used as the default cwd for exec when no session cwd or explicit cwd is set.',
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'browse_open',
      description: 'Open a new browser tab and navigate to URL. Returns tab ID for future operations.',
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' } },
        required: ['url'],
      },
    },
    { name: 'browse_list', description: 'List all open browser tabs with their IDs, titles, and URLs.', parameters: { type: 'object', properties: {} } },
    {
      name: 'browse_get',
      description: 'Get content or screenshot from a browser tab.',
      parameters: {
        type: 'object',
        properties: { tabId: { type: 'string' }, screenshot: { type: ['boolean', 'string'], default: false } },
        required: ['tabId'],
      },
    },
    { name: 'browse_close', description: 'Close a browser tab.', parameters: { type: 'object', properties: { tabId: { type: 'string' } }, required: ['tabId'] } },
    {
      name: 'browse_interact',
      description: 'Interact with a browser tab. Supports: click, type, fill, press, scroll, wait, evaluate, goto, back, forward, reload.',
      parameters: {
        type: 'object',
        properties: {
          tabId: { type: 'string' },
          action: { type: 'string', enum: ['click', 'type', 'fill', 'press', 'scroll', 'wait', 'evaluate', 'goto', 'back', 'forward', 'reload'] },
          params: {
            type: 'object',
            properties: {
              selector: { type: 'string' }, text: { type: 'string' }, key: { type: 'string' }, y: { type: 'number' }, url: { type: 'string' }, code: { type: 'string' }, timeout: { type: 'number' },
            },
          },
        },
        required: ['tabId', 'action'],
      },
    },
  ],
} as const;
