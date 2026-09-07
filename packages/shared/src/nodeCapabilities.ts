import { VSCODE_GIT_COMMIT_SERVICE_VERSION } from './gitCommitDetails';

export const CLI_NODE_CAPABILITIES = {
  services: {
    'vscode-fs': 1,
    'vscode-git': VSCODE_GIT_COMMIT_SERVICE_VERSION,
  },
  tools: [
    {
      name: 'read',
      description: "Read a file, view an image, or list a directory. Large text files are shown as bounded excerpts with their file size; use a line range to inspect a specific section. Directory listings are non-recursive and show up to 50 entries by default.",
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' , description: "File or directory path on this Node. Relative paths use the session working directory supplied for this Node, or its agent directory if unset. Absolute paths and ~/ paths are accepted subject to permissions."},
          startLine: { type: 'number', description: "First line to read, counting from 1. For directories, the first entry to list. Omit or use 0 to start at the beginning." },
          endLine: { type: 'number', description: "Last line or directory entry to include, counting from 1. Omit or use 0 for the default range." },
        },
        required: ['filePath'],
      },
    },
    {
      name: 'write',
      description: "Write text to a file on this Node. Existing files are protected unless overwrite is true; missing parent directories are created only when createDirs is true.",
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' , description: "Destination path on this Node. Relative paths use the session working directory supplied for this Node, or its agent directory if unset. Absolute paths and ~/ paths are accepted subject to permissions."},
          content: { type: 'string' , description: "Complete file contents."},
          overwrite: { type: 'boolean' , description: "Allow replacement of an existing file. Defaults to false."},
          createDirs: { type: 'boolean', description: "Create missing parent directories. Defaults to false." },
        },
        required: ['filePath', 'content'],
      },
    },
    {
      name: 'edit',
      description: "Replace one exact occurrence of text in a file. Use apply_patch when a line-based patch is more suitable.",
      parameters: {
        type: 'object',
        properties: {
          filePath: { type: 'string' , description: "File to edit on this Node. Relative paths use the session working directory supplied for this Node, or its agent directory if unset. Absolute paths and ~/ paths are accepted subject to permissions."},
          oldText: { type: 'string' , description: "Exact text to replace; it must identify a single occurrence."},
          newText: { type: 'string' , description: "Replacement text."},
        },
        required: ['filePath', 'oldText', 'newText'],
      },
    },
    {
      name: 'apply_patch',
      description: "Add, modify, or delete files on this Node using the apply_patch format with *** Begin Patch and *** End Patch. Relative paths in patch headers use the session working directory supplied for this Node, or its agent directory if unset.",
      parameters: {
        type: 'object',
        properties: { input: { type: 'string' , description: "Complete patch text with Add File, Update File, or Delete File operations."} },
        required: ['input'],
      },
    },
    {
      name: 'exec',
      description: "Run a shell command on the current Node. Output is saved in a command log and shown as a bounded preview. If the command outlasts timeout, it continues in the background and returns an execId; a later event reports completion. The timeout does not kill the command. Avoid adding head or tail just to shorten the preview: that changes the captured output. If you need both a complete log and a filtered view, save the complete output separately or use tee with a filter that consumes the whole stream.",
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string' , description: "Shell command or pipeline to execute."},
          cwd: { type: 'string' , description: "Working directory for this command. Relative paths use the session working directory supplied for this Node, or the Node process working directory if unset. With no cwd, execution uses that same default chain."},
          timeout: { type: 'number', minimum: 1, description: "Seconds to wait before returning a still-running command as a background execution. Defaults to 15; values above 60 are reduced to 60 with a warning." },
        },
        required: ['command'],
      },
    },
    {
      name: 'get_default_cwd',
      description: "Get this Node's process working directory, used by exec when neither a command nor the session specifies one.",
      parameters: {
        type: 'object',
        properties: {},
        required: [],
      },
    },
    {
      name: 'browse_open',
      description: "Open a browser tab at a URL and return its tab ID for later browser calls.",
      parameters: {
        type: 'object',
        properties: { url: { type: 'string' , description: "URL to open."} },
        required: ['url'],
      },
    },
    { name: 'browse_list', description: "List open browser tabs with their IDs, titles, and URLs.", parameters: { type: 'object', properties: {} } },
    {
      name: 'browse_get',
      description: "Read a browser tab's HTML or return a screenshot.",
      parameters: {
        type: 'object',
        properties: { tabId: { type: 'string' , description: "Tab ID returned by browse_open or browse_list."}, screenshot: { type: ['boolean', 'string'], default: false , description: "Omit or set false for page HTML. Set true for a viewport screenshot, or use full for a full-page screenshot. Screenshots are returned as images, not saved to a supplied path."} },
        required: ['tabId'],
      },
    },
    { name: 'browse_close', description: "Close a browser tab.", parameters: { type: 'object', properties: { tabId: { type: 'string' , description: "Tab to close."} }, required: ['tabId'] } },
    {
      name: 'browse_interact',
      description: "Interact with a browser tab: click, type, fill, press a key, scroll, wait, evaluate JavaScript, or navigate.",
      parameters: {
        type: 'object',
        properties: {
          tabId: { type: 'string' , description: "Tab to control."},
          action: { type: 'string', enum: ['click', 'type', 'fill', 'press', 'scroll', 'wait', 'evaluate', 'goto', 'back', 'forward', 'reload'] , description: "Browser action to perform."},
          params: {
            type: 'object',
            properties: {
              selector: { type: 'string' , description: "CSS selector for the target element."}, text: { type: 'string' , description: "Text to type or fill."}, key: { type: 'string' , description: "Key to press, such as Enter, Tab, or Escape."}, y: { type: 'number' , description: "Vertical scroll distance in pixels."}, url: { type: 'string' , description: "Destination URL for goto."}, code: { type: 'string' , description: "JavaScript to evaluate in the tab."}, timeout: { type: 'number' , description: "Action timeout in milliseconds. Defaults to 5,000."},
            },
           description: "Arguments for the action, such as {selector: '#id'} for click, {selector: 'input', text: 'hello'} for fill, {key: 'Enter'} for press, {y: 500} for scroll, {url: 'https://example.com'} for goto, or {code: 'document.title'} for evaluate."},
        },
        required: ['tabId', 'action'],
      },
    },
  ],
} as const;
