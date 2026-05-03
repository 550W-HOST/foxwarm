export const CLI_NODE_CAPABILITIES = {
  tools: [
    {
      name: 'read',
      description: 'Read a file from agent-folder.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          startLine: { type: 'number' },
          endLine: { type: 'number' },
        },
        required: ['filePath'],
      },
    },
    {
      name: 'write',
      description: 'Write a file to agent-folder.',
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' },
          content: { type: 'string' },
          overwrite: { type: 'boolean' },
        },
        required: ['filePath', 'content'],
      },
    },
    {
      name: 'edit',
      description: 'Replace exact text in a file using oldText/newText.',
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
      description: 'Apply an OpenAI-style patch envelope to modify files.',
      parameters: {
        type: 'object',
        properties: { input: { type: 'string' } },
        required: ['input'],
      },
    },
    {
      name: 'exec',
      description: 'Execute a shell command. Defaults to the session cwd when set. Commands running over the timeout continue in the background and send a completion message later.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' },
          cwd: { type: 'string' },
          timeout: { type: 'number' },
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
