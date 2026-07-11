import { DEFAULT_EXEC_TIMEOUT_SECONDS, MAX_EXEC_TIMEOUT_SECONDS, MIN_EXEC_TIMEOUT_SECONDS } from '../../packages/shared/dist/persistentExec';
import { COMPACT_PLAN_TOOL_DEFINITION } from '../session/compactPlan';


export const definitions = [
        {
            name: 'read',
            defaultInject: true,
            description: 'Read a file or list a directory. Directory reads are non-recursive, default to 50 items, and use startLine/endLine as item numbers; passing 0 for startLine/endLine is treated as omitted. Relative paths resolve from the current session cwd when set, otherwise from the current agent folder. Absolute paths and ~/... are also accepted when allowed.',
            parameters: {
                type: 'object',
                properties: { 
                    filePath: { type: 'string' },
                    startLine: { type: 'number', description: 'Starting line number/item number (1-indexed, optional). 0 is treated as omitted.' },
                    endLine: { type: 'number', description: 'Ending line number/item number (1-indexed, inclusive, optional). 0 is treated as omitted.' }
                },
                required: ['filePath']
            }
        },
        {
            name: 'write',
            defaultInject: true,
            description: 'Write a file. By default, parent directories must already exist; pass createDirs=true to create missing parent directories. Relative paths resolve from the current session cwd when set, otherwise from the current agent folder. Absolute paths and ~/... are also accepted when allowed. Provide either content, or contentRef from a previous write failure with overwrite=true to reuse the cached attempted content for the same path.',
            parameters: {
                type: 'object',
                properties: { 
                    content: { type: 'string' },
                    contentRef: { type: 'string', description: 'Short-lived reference returned by a previous write attempt that failed because the file already exists or a parent directory was missing. Use with overwrite=true and the same filePath to write the cached content without resending it.' },
                    filePath: { type: 'string' },
                    overwrite: { type: 'boolean', description: 'Overwrite existing file. Default: false' },
                    createDirs: { type: 'boolean', description: 'Create missing parent directories before writing. Default: false' }
                },
                required: ['filePath']
            }
        },
        {
            name: 'edit',
            defaultInject: true,
            description: 'Replace exact text in a file (legacy surgical edit). Relative file paths resolve from the current session cwd when set, otherwise from the current agent folder. Use oldText/newText for direct single-match replacement. Prefer apply_patch for patch-style changes.',
            parameters: {
                type: 'object',
                properties: { 
                    filePath: { type: 'string' },
                    oldText: { type: 'string', description: 'The exact text to find' },
                    newText: { type: 'string', description: 'The text to replace it with' },
                },
                required: ['filePath', 'oldText', 'newText']
            }
        },
        {
            name: 'apply_patch',
            defaultInject: true,
            description: `This is a custom utility that makes it more convenient to add, remove, or edit code files. Paths in patch file headers resolve like other file tools: relative paths resolve from the current session cwd when set, otherwise from the current agent folder; absolute paths and ~/... are also accepted when allowed. Pass the patch command text as \`input\`.

The patch must be enclosed in \`*** Begin Patch\` / \`*** End Patch\`. Each file operation starts with a header line:
- \`*** Update File: <path>\` — modify an existing file
- \`*** Add File: <path>\` — create a new file (all body lines must start with \`+\`)
- \`*** Delete File: <path>\` — delete a file (no body lines)

For Update File, the body uses line-based diff syntax:
- Lines starting with a single space \` \` are context (must match the existing file content)
- Lines starting with \`-\` are deletions (must match existing content)
- Lines starting with \`+\` are insertions (new content)
- \`@@\` or \`@@ <anchor text>\` starts a new section (anchor text helps locate the position in the file)
- \`*** End of File\` marks that the following context is at the end of the file

Example:
\`\`\`
*** Begin Patch
*** Update File: src/app.ts
@@ function main()
 import { foo } from './foo';
-const old = 'removed';
+const newVar = 'added';
 console.log(newVar);
*** Add File: src/newfile.ts
+export const hello = 'world';
*** End Patch
\`\`\``,
            parameters: {
                type: 'object',
                properties: {
                    input: { type: 'string', description: 'The apply_patch command text that you wish to execute.' }
                },
                required: ['input']
            }
        },
        {
            name: 'read_memory',
            defaultInject: true,
            description: 'Read a file from the current agent\'s memory/ directory. Pass a path relative to memory/ (for example `MEMORY.md` or `notes/foo.md`). This always targets your own memory files on master; do not prefix with `memory/` or pass node=master.',
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Relative file path inside the current agent memory/ directory.' },
                    startLine: { type: 'number', description: 'Starting line number (1-indexed, optional). 0 is treated as omitted.' },
                    endLine: { type: 'number', description: 'Ending line number (1-indexed, inclusive, optional). 0 is treated as omitted.' }
                },
                required: ['filePath']
            }
        },
        {
            name: 'write_memory',
            defaultInject: true,
            description: 'Create a new file under the current agent\'s memory/ directory. Pass a path relative to memory/. This tool never overwrites existing files; use edit_memory to modify an existing memory file.',
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Relative file path inside the current agent memory/ directory.' },
                    content: { type: 'string', description: 'File contents to create.' }
                },
                required: ['filePath', 'content']
            }
        },
        {
            name: 'edit_memory',
            defaultInject: true,
            description: 'Edit an existing file under the current agent\'s memory/ directory using an exact oldText/newText replacement. Pass a path relative to memory/.',
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Relative file path inside the current agent memory/ directory.' },
                    oldText: { type: 'string', description: 'The exact text to find' },
                    newText: { type: 'string', description: 'The text to replace it with' }
                },
                required: ['filePath', 'oldText', 'newText']
            }
        },
        {
            name: 'delete_memory',
            defaultInject: true,
            description: 'Delete a single file inside the current agent\'s memory/ directory. Pass a path relative to memory/.',
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Relative file path inside the current agent memory/ directory.' }
                },
                required: ['filePath']
            }
        },
        {
            name: 'apply_patch_memory',
            defaultInject: true,
            description: 'Apply an apply_patch-style patch only within the current agent\'s memory/ directory. Pass memory-relative paths in the patch file headers; `memory/` prefixes are accepted but optional. Supports the same patch envelope and bare-patch compatibility as apply_patch.',
            parameters: {
                type: 'object',
                properties: {
                    input: { type: 'string', description: 'The apply_patch command text to execute against files under the current agent memory/ directory.' }
                },
                required: ['input']
            }
        },
        {
            name: 'delete_file',
            defaultInject: true,
            description: 'Delete a single file or symlink. Relative paths resolve from the current session cwd when set, otherwise from the current agent folder. Refuses to delete directories.',
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'File path. Relative paths resolve from the current session cwd when set, otherwise from the current agent folder.' }
                },
                required: ['filePath']
            }
        },
        {
            name: 'copy_between_nodes',
            defaultInject: true,
            description: 'Copy a file between master/remote nodes. Absolute paths and ~/... are accepted when allowed. Relative paths resolve under the current agent folder on each endpoint. Non-isolated sessions have no Foxwarm path restriction; isolated sessions are restricted only when accessing master (to their own agent folder).',
            parameters: {
                type: 'object',
                properties: {
                    sourceNode: { type: 'string', description: 'Source node id. Use `master` for local files.' },
                    sourcePath: { type: 'string', description: 'Source file path on the source node. Absolute paths and ~/... are accepted when allowed; relative paths resolve under the current agent folder on that node.' },
                    targetNode: { type: 'string', description: 'Target node id. Use `master` for local files.' },
                    targetPath: { type: 'string', description: 'Target file path on the target node. Absolute paths and ~/... are accepted when allowed; relative paths resolve under the current agent folder on that node.' },
                    overwrite: { type: 'boolean', description: 'Overwrite the target file if it already exists. Default: false' },
                },
                required: ['sourceNode', 'sourcePath', 'targetNode', 'targetPath']
            }
        },
        {
            name: 'image_crop',
            defaultInject: true,
            description: 'Crop an image that was previously returned in this session by image id. Returns another inline image that can be cropped again or written to a file.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Image id from a prior tool-returned image label, such as `[IMAGE: id=...]`.' },
                    x: { type: 'number', description: 'Left coordinate in pixels.' },
                    y: { type: 'number', description: 'Top coordinate in pixels.' },
                    width: { type: 'number', description: 'Crop width in pixels.' },
                    height: { type: 'number', description: 'Crop height in pixels.' },
                },
                required: ['id', 'x', 'y', 'width', 'height']
            }
        },
        {
            name: 'image_write_to_file',
            defaultInject: true,
            description: 'Write a previously returned session image to a file so it can be reused or sent with send_file. On master, relative paths resolve from the current session cwd when set, otherwise from the current agent folder; on remote nodes, relative paths resolve under that node\'s agent folder. Absolute paths and ~/... are also accepted when allowed.',
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: 'Image id from a prior tool-returned image label.' },
                    filePath: { type: 'string', description: 'Output file path. On master, relative paths resolve from the current session cwd when set, otherwise from the current agent folder; on remote nodes, relative paths resolve under that node\'s agent folder.' },
                    overwrite: { type: 'boolean', description: 'Overwrite the target file if it already exists. Default: false.' },
                    node: { type: 'string', description: 'Optional. Node where the file should be written. Defaults to the current node.' },
                },
                required: ['id', 'filePath']
            }
        },
        {
            name: 'exec',
            defaultInject: true,
            description: 'Execute a shell command. The working directory is the explicit cwd when provided (relative cwd resolves from the session cwd when set, otherwise from the current node default), otherwise the session cwd when set, otherwise the current node default (master default is the agent folder). Output over 10000 tokens is automatically truncated (keeps first/last 5000 tokens), full output is saved under the agent folder .temp/exec area. Commands running longer than the configured timeout (default 15s, maximum 60s; larger values are clamped with a warning) continue in the background and send a completion system message later.',
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string' },
                    cwd: { type: 'string', description: 'Optional working directory override. Relative paths resolve from session.cwd when set, otherwise from the current node default.' },
                    timeout: { type: 'number', minimum: MIN_EXEC_TIMEOUT_SECONDS, description: `Optional timeout in seconds before the command is moved to background. Default: ${DEFAULT_EXEC_TIMEOUT_SECONDS}. Values above the ${MAX_EXEC_TIMEOUT_SECONDS}s maximum are clamped to ${MAX_EXEC_TIMEOUT_SECONDS}s with a warning.` }
                },
                required: ['command']
            }
        },
        {
            name: 'get_memory_context',
            description: 'Retrieve messages around a specific point in time to see conversation flow.',
            parameters: {
                type: 'object',
                properties: { 
                    timestamp: { type: 'number', description: 'The center timestamp to search around' },
                    limit: { type: 'number', description: 'Total messages to fetch' }
                },
                required: ['timestamp']
            }
        },
        {
            name: 'create_child_session',
            defaultInject: true,
            description: 'Create a child session. Can either fork (inherit context) or create new (empty). Child sessions should explicitly call send_to_session to report back. If handing off to the child is your final step for this turn, call wait afterward in the same response. When the current session is an agent main session such as `agent/main` (or bare `main`), the child id replaces the `main` leaf with the suffix (for example `agent/main` + `task1` => `agent/task1`); other sessions append the suffix as before.',
            parameters: {
                type: 'object',
                properties: {
                    suffix: { type: 'string', description: 'Suffix/session leaf for identification (e.g., "task1", "research"). For main sessions it replaces the `main` leaf; otherwise it is appended to the session ID.' },
                    fork: { type: 'boolean', description: 'Whether to fork (inherit parent context) or create new session. Default: false', default: false },
                    message: { type: 'string', description: 'Optional initial message to send to the child session immediately after creation' },
                    node: { type: 'string', description: 'Optional node to bind this session (sets currentNode)' }
                },
                required: ['suffix']
            }
        },
        {
            name: 'send_to_session',
            defaultInject: true,
            description: 'Send a message to a specific agent/session. Literal sessionId `<main>` resolves to the current agent\'s main session; `<parent>` resolves to the current session\'s parent session and errors clearly if there is no parent. Isolated sessions can only communicate with parent/child sessions. If this handoff is your final step, call wait in parallel in the same response.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Target session ID, or `<main>` for this agent\'s main session, or `<parent>` for this session\'s parent session.' },
                    message: { type: 'string', description: 'Message to send' }
                },
                required: ['sessionId', 'message']
            }
        },
        {
            name: 'wait',
            defaultInject: true,
            description: 'Pause this session until a new message or event arrives. Use this only when you have no useful user-facing reply or tool work to do right now. Omit timeoutSeconds or pass 0 for no timeout. If a positive timeoutSeconds is provided, the session will be woken by a system message after that many seconds only if no other message/event woke it first.',
            parameters: {
                type: 'object',
                properties: {
                    reason: { type: 'string', description: 'Optional short note for logs/debugging.' },
                    timeoutSeconds: { type: 'number', description: 'Optional timeout in seconds. If a positive value is provided and no newer message/event wakes the session first, a system message wakes it after this many seconds.' },
                    waitAllSessions: {
                        type: 'array',
                        description: 'Optional list of session IDs. Omit or pass [] for ordinary wait. When provided, wait until every listed session has sent at least one new message to this session after the wait starts; unrelated messages/events and timeout still wake normally with a pending reminder.',
                        items: { type: 'string', description: 'Session ID that must report before this wait-all condition is satisfied.' }
                    },
                    waitExecIds: {
                        type: 'array',
                        description: 'Optional list of background exec IDs this session is waiting for. This is advisory/runtime-state metadata for UI/status; omit for ordinary wait. Generic wait({}) remains valid and means waiting for any new message or event.',
                        items: { type: 'string', description: 'Background exec ID to label as an expected wake source.' }
                    }
                }
            }
        },
        {
            name: 'send_to_channel',
            defaultInject: true,
            description: 'Send a message directly to users via a specific channel target (<channel-instance-id>:<conversation-id>). Usually you should not need this, because normal assistant text replies are already broadcast to all non-send-only channels attached to the current session. Use this only when the user explicitly wants a reply sent to a specific conversation / room / group.',
            parameters: {
                type: 'object',
                properties: {
                    channelTargetId: { type: 'string', description: 'Target channel in format <channel-instance-id>:<conversation-id>' },
                    message: { type: 'string', description: 'Message to send' }
                },
                required: ['channelTargetId', 'message']
            }
        },
        {
            name: 'send_file',
            defaultInject: true,
            description: 'Send a local file or image to users. channelTargetId and sessionId are both optional, but not at the same time: if channelTargetId is specified, send only there; otherwise sessionId defaults to the current session, and the file is sent to all channels attached to that session.',
            parameters: {
                type: 'object',
                properties: {
                    channelTargetId: { type: 'string', description: 'Optional target channel in format <channel-instance-id>:<conversation-id>. Cannot be combined with sessionId.' },
                    sessionId: { type: 'string', description: 'Optional target session ID whose attached channels should receive the file. Defaults to the current session when omitted.' },
                    filePath: { type: 'string', description: 'File path on the selected node. On master, relative paths resolve from the current session cwd when set, otherwise from the current agent folder; on remote nodes, relative paths resolve under that node\'s agent folder. Absolute paths and ~/... are also accepted when allowed.' },
                    node: { type: 'string', description: 'Optional. Node where the file lives. Defaults to the current node; send_file still delivers through master-side channel/session routing.' },
                    caption: { type: 'string', description: 'Optional caption/text sent with the file where supported' },
                    text: { type: 'string', description: 'Alias of caption for convenience' }
                },
                required: ['filePath']
            }
        },
        {
            name: 'session',
            defaultInject: true,
            description: 'Get current session status or list sessions. With no args or action="status", returns current session agent id/name, agent dir, session id, parent session id, token estimate, last usage, auto-compact threshold, current node, current cwd, and recent child sessions. With action="list", returns the old list_sessions-style session list and accepts the same pagination args.',
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['status', 'list'], description: 'Optional action. Omit or use "status" for current session status; use "list" to list sessions.' },
                    start: { type: 'number', description: 'Start index in the session list sorted by last activity desc. Default: 0' },
                    count: { type: 'number', description: 'Number of sessions to return. Default: 20' }
                },
                required: [] as string[]
            }
        },
        {
            name: 'list_agents',
            defaultInject: true,
            description: 'List all agents with their session counts',
            parameters: {
                type: 'object',
                properties: {},
                required: [] as string[]
            }
        },
        {
            name: 'list_skills',
            defaultInject: true,
            description: 'List available skills for the current session agent (or an optionally specified agent), including agent-local, inherited-agent, and global skills.',
            parameters: {
                type: 'object',
                properties: {
                    agentName: { type: 'string', description: 'Optional agent name whose visible skills should be listed. Defaults to the current session agent.' }
                },
                required: [] as string[]
            }
        },
        {
            name: 'load_skill',
            defaultInject: true,
            description: 'Load a skill entry document and supporting resource list using the current session agent skill resolution (or an optionally specified agent). Supporting resources are listed but not eagerly read; this does not dynamically add tools.',
            parameters: {
                type: 'object',
                properties: {
                    skillName: { type: 'string', description: 'Skill name to load' },
                    agentName: { type: 'string', description: 'Optional agent name whose skill search path should be used. Defaults to the current session agent.' }
                },
                required: ['skillName']
            }
        },
        {
            name: 'get_session_messages',
            defaultInject: true,
            description: 'Get messages from a session with optional pagination. Defaults to last 10 messages. Output uses a total previewLength budget (auto-clamped to 1000-20000), folds tool calls/results by default, and can filter with query/includeRegex/excludeRegex.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Session ID' },
                    start: { type: 'number', description: 'Start index (0-based, optional). Negative values count from end (e.g., -10 for last 10 messages)' },
                    count: { type: 'number', description: 'Number of messages to retrieve (optional)' },
                    previewLength: { type: 'number', description: 'Total output preview budget, not per-message length. Values below 1000 or above 20000 are automatically clamped with a warning. Omit or pass 0 for the default.' },
                    query: { type: 'string', description: 'Optional literal case-insensitive text filter. Matching messages are previewed around the match when possible.' },
                    includeRegex: { type: 'string', description: 'Optional case-insensitive regex; messages must match this pattern in their full text/tool content.' },
                    excludeRegex: { type: 'string', description: 'Optional case-insensitive regex; matching messages are excluded.' },
                    toolDetail: { type: 'string', enum: ['names', 'snippets', 'full'], description: 'How much tool call/result content to show. Default names folds tools to name/id/status only; snippets shows short tool snippets; full expands tool args/results within the total preview budget.' }
                },
                required: ['sessionId']
            }
        },
        {
            name: 'get_archived_messages',
            description: 'Read archived session messages from the JSONL archive by seq range. This queries archived history, not just the current working history.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Session ID (optional, defaults to the current session)' },
                    startSeq: { type: 'number', description: 'Optional inclusive starting seq number' },
                    endSeq: { type: 'number', description: 'Optional inclusive ending seq number' },
                    previewLength: { type: 'number', description: 'Maximum preview length per message (default: 1000)' }
                }
            }
        },
        {
            name: 'get_archived_blocks',
            description: 'Read archived layered-context block summaries by block id range for a session.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Session ID (optional, defaults to the current session)' },
                    startId: { type: 'number', description: 'Optional inclusive starting block id' },
                    endId: { type: 'number', description: 'Optional inclusive ending block id' },
                    previewLength: { type: 'number', description: 'Maximum preview length per block summary (default: 1000)' }
                }
            }
        },
        {
            name: 'recall',
            defaultInject: true,
            description: 'Recall earlier session context by expanding CTX-BLOCK ids (for example `B#126`), reading message ranges, or doing semantic vector retrieval with vector_query. Use this when the working context contains a `[CTX-BLOCK ...]` reference and you need to drill down. Output uses a total previewLength budget (auto-clamped to 1000-20000), folds tool calls/results by default, and can filter with query/includeRegex/excludeRegex.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Session ID (optional, defaults to the current session)' },
                    target: { type: 'string', description: 'Target selector. Omit or use `overview` for help/ranges. Supported examples: `blocks`, `B#126`, `block#126`, `msg:B#126`, `msg#10637-10680`, `msg#10637`.' },
                    vector_query: { type: 'string', description: 'Optional semantic search query. When provided, recall searches vector-indexed history, loads the original archived message/block ranges from hit metadata, then renders them with the same preview/filter behavior.' },
                    limit: { type: 'number', description: 'Optional vector_query result limit. Default 5, max 20.' },
                    scope: { type: 'string', enum: ['all', 'current-session', 'current-agent'], description: 'For vector_query: requested scope. Non-isolated sessions are limited to the current agent; isolated sessions are limited to the current session.' },
                    agentName: { type: 'string', description: 'For vector_query: optional agent name, limited to your current agent.' },
                    previewLength: { type: 'number', description: 'Total output preview budget, not per-item length. Values below 1000 or above 20000 are automatically clamped with a warning. Omit or pass 0 for the default.' },
                    query: { type: 'string', description: 'Optional literal case-insensitive text filter applied to full message/block/tool content; previews center around matches when possible.' },
                    includeRegex: { type: 'string', description: 'Optional case-insensitive regex; returned items must match this pattern in their full text/tool content.' },
                    excludeRegex: { type: 'string', description: 'Optional case-insensitive regex; matching items are excluded.' },
                    preferBlocks: { type: 'boolean', description: 'For vector_query: if true, give block summary hits a modest ranking boost.' },
                    toolDetail: { type: 'string', enum: ['names', 'snippets', 'full'], description: 'How much tool call/result content to show. Default names folds tools to name/id/status only; snippets shows short tool snippets; full expands tool args/results within the total preview budget.' }
                }
            }
        },
        {
            name: 'delete_session',
            description: 'Delete a session permanently. Cannot delete current session.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Session ID to delete' }
                },
                required: ['sessionId']
            }
        },
        {
            name: 'update_session_name',
            defaultInject: true,
            description: 'Update the display name of a session. The display name is shown in the session list.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Session ID (optional, default: current session)' },
                    name: { type: 'string', description: 'New display name for the session. Use empty string to clear the name.' }
                },
                required: ['name']
            }
        },
        {
            name: 'set_goal',
            defaultInject: true,
            description: 'Set or clear the long-term goal reminder for the current session. The goal is preserved across session compaction so the session can retain its long-horizon objective even when older context is summarized.',
            parameters: {
                type: 'object',
                properties: {
                    goal: { type: 'string', description: 'Goal text. Use empty string to clear.' },
                    remindEvery: { type: 'number', description: 'Optional. Remind after this many later non-reminder session messages. If omitted, reuse the current goal setting or default to 10.' },
                    remindOnTurnEnd: { type: 'boolean', description: 'Optional. Whether to inject goal reminders at the end of a turn when newer work happened. If omitted, reuse the current setting or default to true.' },
                    clear: { type: 'boolean', description: 'If true, clear the current session goal reminder.' }
                }
            }
        },
        {
            name: 'set_session_child_model',
            description: 'Set, clear, or inspect the per-session default model used when this session creates child or related new sessions. When unset, spawned sessions follow the current session model behavior.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Session ID (optional, defaults to the current session)' },
                    model: { type: 'string', description: 'Model key to use by default for child/new sessions spawned from this session.' },
                    clear: { type: 'boolean', description: 'If true, clear the override and fall back to following the current session model.' }
                }
            }
        },
        {
            name: 'set_session_compact_threshold',
            description: 'Set, clear, or inspect the per-session auto-compact threshold override in tokens. When unset, the session inherits the default threshold derived from the active model context window.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Session ID (optional, defaults to the current session)' },
                    thresholdTokens: { type: 'number', description: 'Positive token threshold override for auto-compaction. Omit to inspect current status.' },
                    clear: { type: 'boolean', description: 'If true, clear the session override and inherit the default threshold again.' }
                }
            }
        },
        {
            name: 'update_session_snapshot',
            description: 'Refresh a session prompt snapshot from the latest session-configured memory sources, inheritance, and visible skills catalog. Defaults to the current session.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Session ID (optional, default: current session)' }
                }
            }
        },
        {
            name: 'stop_session',
            description: 'Stop a running session. Sets a flag that will stop tool call recursion after the current tool completes.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Session ID to stop' }
                },
                required: ['sessionId']
            }
        },
        COMPACT_PLAN_TOOL_DEFINITION,
        {
            name: 'compact_session',
            description: 'Request a compaction flow for the current session or another idle session. This does not return compact candidates directly. Instead, the target session enters a dedicated compaction planning flow where the model must call submit_compact_plan. Use summary only as optional extra guidance for the compaction prompt, not as the final compacted summary.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Target session ID (optional, default: current session)' },
                    summary: { type: 'string', description: 'Optional extra guidance for the compaction prompt. The model must still submit the actual keep/drop plan and final summary via submit_compact_plan.' },
                    keepPercent: { type: 'number', description: 'How much recent history to keep. Use 0-1 fraction or 1-100 percentage. Optional.' }
                }
            }
        },
        {
            name: 'create_timer',
            description: 'Create a one-shot or recurring timer for a session. Timers persist across restarts and deliver structured system events when they fire.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Owner session ID (optional, default: current session)' },
                    at: { type: ['string', 'number'], description: 'Absolute trigger time as ISO string or epoch milliseconds (one-shot)' },
                    afterSeconds: { type: 'number', description: 'Trigger after N seconds (one-shot)' },
                    cron: { type: 'string', description: 'Cron expression for recurring timers' },
                    message: { type: 'string', description: 'Message delivered when the timer fires' },
                    newSession: { type: 'boolean', description: 'If true, each trigger creates a new session instead of using the owner session' },
                    sessionPrefix: { type: 'string', description: 'Prefix for newly created timer sessions (default: timer)' },
                    agentName: { type: 'string', description: 'Target agent for new timer-created sessions (default: owner session agent)' }
                },
                required: ['message']
            }
        },
        {
            name: 'list_timers',
            description: 'List timers for a session. Defaults to the current session.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Owner session ID (optional, default: current session)' }
                }
            }
        },
        {
            name: 'update_timer',
            description: 'Update an existing timer without deleting and recreating it. Defaults to the current session scope. To change the schedule, pass exactly one of at, afterSeconds, or cron; omitted fields keep their current values.',
            parameters: {
                type: 'object',
                properties: {
                    timerId: { type: 'string', description: 'Timer ID to update' },
                    sessionId: { type: 'string', description: 'Owner session ID (optional, default: current session)' },
                    at: { type: ['string', 'number'], description: 'New absolute trigger time as ISO string or epoch milliseconds (one-shot)' },
                    afterSeconds: { type: 'number', description: 'Reschedule one-shot timer to trigger after N seconds from now' },
                    cron: { type: 'string', description: 'New cron expression for recurring timers' },
                    message: { type: 'string', description: 'New message delivered when the timer fires' },
                    newSession: { type: 'boolean', description: 'If true, each trigger creates a new session instead of using the owner session; if false, clears new-session target fields' },
                    sessionPrefix: { type: 'string', description: 'Prefix for newly created timer sessions (only with newSession=true)' },
                    agentName: { type: 'string', description: 'Target agent for new timer-created sessions (only with newSession=true; default: owner session agent)' }
                },
                required: ['timerId']
            }
        },
        {
            name: 'delete_timer',
            description: 'Delete a timer by ID. Defaults to the current session scope.',
            parameters: {
                type: 'object',
                properties: {
                    timerId: { type: 'string', description: 'Timer ID to delete' },
                    sessionId: { type: 'string', description: 'Owner session ID (optional, default: current session)' }
                },
                required: ['timerId']
            }
        },
        {
            name: 'browse_open',
            description: 'Open a new browser tab and navigate to URL. Returns tab ID for future operations.',
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: 'URL to visit' }
                },
                required: ['url']
            }
        },
        {
            name: 'browse_list',
            description: 'List all open browser tabs with their IDs, titles, and URLs.',
            parameters: {
                type: 'object',
                properties: {}
            }
        },
        {
            name: 'browse_get',
            description: 'Get content or screenshot from a browser tab.',
            parameters: {
                type: 'object',
                properties: {
                    tabId: { type: 'string', description: 'Tab ID (e.g., "tab1")' },
                    screenshot: { 
                        type: ['boolean', 'string'], 
                        description: 'If true, return screenshot to LLM for viewing. If a file path (string), save screenshot to that file. If false/omitted, return text content.',
                        default: false 
                    }
                },
                required: ['tabId']
            }
        },
        {
            name: 'browse_close',
            description: 'Close a browser tab.',
            parameters: {
                type: 'object',
                properties: {
                    tabId: { type: 'string', description: 'Tab ID to close' }
                },
                required: ['tabId']
            }
        },
        {
            name: 'browse_interact',
            description: 'Interact with a browser tab. Supports: click, type, fill, press (keyboard), scroll, wait, evaluate (JS), goto, back, forward, reload.',
            parameters: {
                type: 'object',
                properties: {
                    tabId: { type: 'string', description: 'Tab ID' },
                    action: { 
                        type: 'string', 
                        description: 'Action to perform: click, type, fill, press, scroll, wait, evaluate, goto, back, forward, reload',
                        enum: ['click', 'type', 'fill', 'press', 'scroll', 'wait', 'evaluate', 'goto', 'back', 'forward', 'reload']
                    },
                    params: { 
                        type: 'object', 
                        description: 'Action parameters. Examples: {selector: "#id"}, {selector: "input", text: "hello"}, {key: "Enter"}, {y: 500}, {url: "https://..."}, {code: "document.title"}',
                        properties: {
                            selector: { type: 'string', description: 'CSS selector' },
                            text: { type: 'string', description: 'Text to type/fill' },
                            key: { type: 'string', description: 'Key to press (e.g., Enter, Tab, Escape)' },
                            y: { type: 'number', description: 'Scroll distance in pixels' },
                            url: { type: 'string', description: 'URL to navigate to' },
                            code: { type: 'string', description: 'JavaScript code to evaluate' },
                            timeout: { type: 'number', description: 'Timeout in milliseconds (default: 5000)' }
                        }
                    }
                },
                required: ['tabId', 'action']
            }
        },
        {
            name: 'search_tools',
            defaultInject: true,
            description: 'Search or list callable tools across builtin, MCP, and remote-node sources. Builtin results include file/edit tools, exec, session/channel tools, vector/archive tools, timers, and wrapper tools such as MCP/node discovery helpers. Prefer this unified catalog before calling long-tail tools via call_tool; for timer tools, load the timer-automation skill first. Query text supports multi-word matching and ranks tools that match more of the words higher. For source=`node`, omitting nodeId searches only the current node (falls back to `master` when no current node is available, instead of listing every node). Example search_tools calls: `{query:"read file", sources:["builtin"]}` or `{query:"screenshot android", sources:["node"]}`.',
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: 'Optional search query matched against tool names/descriptions. Multi-word queries are split on spaces and ranked by how many words match.' },
                    sources: {
                        type: 'array',
                        description: 'Optional source filter. Defaults to builtin + mcp + node.',
                        items: { type: 'string', enum: ['builtin', 'mcp', 'node'] }
                    },
                    server: { type: 'string', description: 'Optional MCP server filter; if omitted while searching MCP tools, all enabled MCP servers are searched.' },
                    nodeId: { type: 'string', description: 'Optional remote node id filter. For source=`node`, omitted means use the current node instead of listing tools from every node.' },
                    limit: { type: 'number', description: 'Maximum number of results to return (default: 20, max: 200).' },
                    includeSchema: { type: 'boolean', description: 'If true (default), include each tool\'s input schema in results.' }
                }
            }
        },
        {
            name: 'call_tool',
            defaultInject: true,
            description: 'Unified tool caller for builtin, MCP, and remote-node tools. Prefer toolId returned by search_tools; explicit source/name/server/nodeId fields are also accepted. Put the target tool arguments inside `args` when visible, or use `argsJson` as a JSON object string fallback when the provider hides free-form object fields. Example using toolId: `{toolId:"builtin:read", args:{filePath:"README.md"}}` or `{toolId:"builtin:read", argsJson:"{\\"filePath\\":\\"README.md\\"}"}`. Example using explicit MCP fields: `{source:"mcp", server:"github", name:"search_repos", args:{query:"foxwarm"}}`. Example using explicit node fields: `{source:"node", nodeId:"android-node", name:"android_screenshot", args:{inline:true}}`.',
            parameters: {
                type: 'object',
                properties: {
                    toolId: { type: 'string', description: 'Preferred unified tool identifier returned by search_tools (for example builtin:read, mcp:server/tool, node:node-id/tool).' },
                    source: { type: 'string', enum: ['builtin', 'mcp', 'node'], description: 'Explicit source when not using toolId.' },
                    name: { type: 'string', description: 'Tool name when not using toolId.' },
                    server: { type: 'string', description: 'MCP server name; required when source=\"mcp\" and toolId is not provided.' },
                    nodeId: { type: 'string', description: 'Remote node id for source=node.' },
                    args: { type: 'object', description: 'Wrapper object containing the target tool arguments. Example: for builtin read, use `args: { filePath: "README.md" }`. Prefer this when visible.', additionalProperties: true },
                    argsJson: { type: 'string', description: 'JSON object string fallback for target tool arguments, for providers that do not expose free-form object fields. Example: `{"filePath":"README.md"}`. Used when `args` is not available.' }
                }
            }
        },
        {
            name: 'run_script',
            defaultInject: true,
            description: 'Start a ToolScript run from the current agent workspace. Every script execution becomes a persisted ToolScript run with a runId, mode, status, waiting metadata, stdout, and executed tool summary. Supports foreground (default) and background modes. Also supports a per-slice timeout budget (default 30s); when that timeout is hit at a safe checkpoint, the run pauses in a continue-able timeout state instead of failing immediately.',
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Path to the ToolScript file. Relative paths resolve from the current session cwd when set, otherwise from the current agent folder.' },
                    code: { type: 'string', description: 'Inline ToolScript code to execute directly. Must define `def main(args):`. When provided, filePath is not required.' },
                    args: { type: 'object', description: 'Optional object exposed to the script as the `args` input variable. Prefer this when visible.', additionalProperties: true },
                    argsJson: { type: 'string', description: 'JSON object string fallback exposed to the script as the `args` input variable, for providers that do not expose free-form object fields. Example: `{"key":"value"}`. Used when `args` is not available.' },
                    mode: { type: 'string', enum: ['foreground', 'background'], description: 'Run mode. foreground is the default. background runs are intended for persistent controller-style scripts.' },
                    timeoutSecs: { type: 'number', description: 'Optional ToolScript execution timeout budget for this run slice in seconds. Default 30. When exceeded at a safe checkpoint, the run pauses with waitingReason="timeout" and can be resumed with continue_script.' }
                },
                required: []
            }
        },
        {
            name: 'start_toolscript_run',
            defaultInject: true,
            description: 'Explicit background-oriented ToolScript run starter. Equivalent to run_script(..., mode="background") but with a clearer controller-run intent.',
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: 'Path to the ToolScript file. Relative paths resolve from the current session cwd when set, otherwise from the current agent folder.' },
                    code: { type: 'string', description: 'Inline ToolScript code to execute directly. Must define `def main(args):`. When provided, filePath is not required.' },
                    args: { type: 'object', description: 'Optional object exposed to the script as the `args` input variable. Prefer this when visible.', additionalProperties: true },
                    argsJson: { type: 'string', description: 'JSON object string fallback exposed to the script as the `args` input variable, for providers that do not expose free-form object fields. Example: `{"key":"value"}`. Used when `args` is not available.' },
                    mode: { type: 'string', enum: ['foreground', 'background'], description: 'Optional explicit mode override. Defaults to background for this tool.' },
                    timeoutSecs: { type: 'number', description: 'Optional ToolScript execution timeout budget for this run slice in seconds. Default 30. When exceeded at a safe checkpoint, the run pauses with waitingReason="timeout" and can be resumed with continue_script.' }
                },
                required: []
            }
        },
        {
            name: 'continue_script',
            defaultInject: true,
            description: 'Resume a waiting ToolScript run created by run_script/start_toolscript_run. Used both for ask_agent continuations and for timeout-paused runs that explicitly report they can continue. The returned stdout field is only the stdout/print output produced by this continuation slice; fetch the run to see the persisted full stdout.',
            parameters: {
                type: 'object',
                properties: {
                    runId: { type: 'string', description: 'ToolScript run identifier returned by run_script.' },
                    continuationId: { type: 'string', description: 'Continuation identifier returned when the script paused at ask_agent or timeout.' },
                    input: { type: 'string', description: 'String value returned to the paused ask_agent(...) call inside the script. For structured values, pass a JSON string and let the script parse it. Ignored for timeout-paused runs.' },
                    timeoutSecs: { type: 'number', description: 'Optional timeout budget for the resumed run slice in seconds. Default is to reuse the prior run timeout value.' }
                },
                required: ['runId', 'continuationId']
            }
        },
        {
            name: 'list_toolscript_runs',
            description: 'List ToolScript runs owned by the current session. Returns structured run summaries including status, mode, waiting metadata, managed-session refs, timestamps, and tool/stdout summaries.',
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: 'Maximum number of runs to return. Default 20, max 200.' },
                    status: { type: 'string', enum: ['running', 'waiting', 'completed', 'failed', 'cancelled'], description: 'Optional status filter.' }
                }
            }
        },
        {
            name: 'get_toolscript_run',
            description: 'Get a single ToolScript run with structured metadata including waiting reason, managed-session relations, timestamps, stdout, and tool summary.',
            parameters: {
                type: 'object',
                properties: {
                    runId: { type: 'string', description: 'ToolScript run identifier.' }
                },
                required: ['runId']
            }
        },
        {
            name: 'cancel_toolscript_run',
            description: 'Cancel an active/waiting ToolScript run owned by the current session. Best-effort releases managed-session leases tracked by the run before marking it cancelled.',
            parameters: {
                type: 'object',
                properties: {
                    runId: { type: 'string', description: 'ToolScript run identifier.' }
                },
                required: ['runId']
            }
        },
        {
            name: 'remote_node',
            description: 'Query and execute tools from dynamically registered remote nodes (browser-extension, android, etc). This is for remote hardware/browser nodes, NOT for MCP servers. Use this to discover what tools are available from connected remote nodes, then call them. Example: First call with action="list" to see available nodes and their tools, then call with action="call" to execute a specific tool on a remote node.',
            parameters: {
                type: 'object',
                properties: {
                    action: {
                        type: 'string',
                        enum: ['list', 'call'],
                        description: 'Action: "list" to see all connected remote nodes and their tools, "call" to execute a specific tool on a remote node'
                    },
                    nodeId: {
                        type: 'string',
                        description: 'Node ID (get from list action, required for call action)'
                    },
                    tool: {
                        type: 'string',
                        description: 'Tool name to call (required when action=call)'
                    },
                    args: {
                        type: 'object',
                        description: 'Tool arguments as key-value pairs (required when action=call)'
                    }
                },
                required: ['action']
            }
        },
        {
            name: 'mcp_config',
            defaultInject: true,
            description: 'Configure an MCP server (store in state/mcp.json). Use enable=false to disable an existing server.',
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: 'Server name' },
                    url: { type: 'string', description: 'Standard MCP server endpoint URL. Use the /mcp endpoint for streamable-http or auto, or the SSE endpoint for sse.' },
                    command: { type: 'string', description: 'Executable to run when transport=stdio.' },
                    args: { type: 'array', items: { type: 'string' }, description: 'Command line arguments for stdio transport.' },
                    env: { type: 'object', description: 'Extra environment variables for stdio transport. Prefer this when visible.', additionalProperties: { type: 'string' } },
                    envJson: { type: 'string', description: 'JSON object string fallback for extra environment variables, for providers that do not expose string-map object fields. Values must be strings. Example: `{"API_KEY":"..."}`. Used when `env` is not available.' },
                    cwd: { type: 'string', description: 'Working directory for stdio transport.' },
                    stderr: { type: 'string', description: 'How to handle stdio server stderr: inherit, pipe, or ignore.' },
                    token: { type: 'string', description: 'Optional bearer token (sets Authorization: Bearer <token>)' },
                    headers: { type: 'object', description: 'Custom HTTP headers as key-value pairs. Overrides token header if both specified. Prefer this when visible.', additionalProperties: { type: 'string' } },
                    headersJson: { type: 'string', description: 'JSON object string fallback for custom HTTP headers, for providers that do not expose string-map object fields. Values must be strings. Example: `{"X-API-Key":"..."}`. Used when `headers` is not available.' },
                    transport: { type: 'string', description: 'Transport type: streamable-http, sse, stdio, or auto. Defaults to auto.' },
                    type: { type: 'string', description: 'Alias for transport (same supported values: streamable-http, sse, stdio, auto).' },
                    description: { type: 'string', description: 'Optional description' },
                    enable: { type: 'boolean', description: 'Enable/disable this server' }
                },
                required: ['name']
            }
        },
        {
            name: 'call_mcp',
            description: 'Call a tool from a configured MCP server. Use search_mcp_tools to list/search available tools first.',
            parameters: {
                type: 'object',
                properties: {
                    server: { type: 'string', description: 'Server name (default: default)' },
                    tool: { type: 'string', description: 'Tool name to call' },
                    args: { type: 'object', description: 'Tool arguments' }
                },
                required: ['tool']
            }
        },
        {
            name: 'search_mcp_tools',
            description: 'Search or list tools from an MCP server. Prefer using query to reduce output size.',
            parameters: {
                type: 'object',
                properties: {
                    server: { type: 'string', description: 'Server name (default: default)' },
                    query: { type: 'string', description: 'Search query (optional)' }
                }
            }
        },
        {
            name: 'list_mcp_servers',
            defaultInject: true,
            description: 'List configured MCP servers with safe config summaries. Returns disabled servers too.',
            parameters: {
                type: 'object',
                properties: {}
            }
        },
        {
            name: 'list_nodes',
            defaultInject: true,
            description: 'List all registered nodes and mark which node is current for this session.',
            parameters: {
                type: 'object',
                properties: {}
            }
        },
        {
            name: 'change_current_node',
            defaultInject: true,
            description: 'Change the current node for the session. Execute future tools on the specified node.',
            parameters: {
                type: 'object',
                properties: {
                    nodeId: { type: 'string', description: 'Node ID to switch to' }
                },
                required: ['nodeId']
            }
        },
        {
            name: 'node_bootstrap_info',
            description: 'Return structured LLM-facing node bootstrap info: pairing token, BASE_URL placeholder semantics, bootstrap endpoint paths/URLs written with $BASE_URL, and example commands. This helper explains the URL principle instead of pretending the system knows the one true external address.',
            parameters: {
                type: 'object',
                properties: {}
            }
        },
        {
            name: 'node_pair_approve',
            description: 'Approve a pending node pairing request. Use node_pair_list first to see pending requests.',
            parameters: {
                type: 'object',
                properties: {
                    pendingId: { type: 'string', description: 'Pending pairing ID (from node_pair_list)' },
                    nodeId: { type: 'string', description: 'Optional node ID to assign (defaults to requested name)' },
                },
                required: ['pendingId']
            }
        },
        {
            name: 'node_pair_list',
            description: 'List all pending node pairing requests.',
            parameters: {
                type: 'object',
                properties: {}
            }
        },
        {
            name: 'create_agent',
            description: 'Create a new persistent agent (workspace + memory container) under agents/{agentName}. By default it also creates the main session, but createMainSession=false keeps only the agent definition. Prefer inherit for shared knowledge and createMainSession/session creation for runnable threads.',
            parameters: {
                type: 'object',
                properties: {
                    agentName: { type: 'string', description: 'Agent name (alphanumeric, hyphens, underscores only)' },
                    inheritMemory: { type: 'boolean', description: 'Legacy compatibility: copy memory files from the source agent into the new agent directory.' },
                    inherit: { type: 'string', description: 'Optional shared-memory parent agent name for agent.inherit.' },
                    isolatedNode: { type: 'string', description: 'Optional non-master node id to make the agent isolated and bound to that node.' },
                    createMainSession: { type: 'boolean', description: 'Whether to also create {agentName}/main (default: true).' },
                    sourceSessionId: { type: 'string', description: 'Optional source session ID to inherit current node/model from (default: current session)' },
                    convertSession: { type: 'boolean', description: 'If true, convert an existing session into the agent main session (requires createMainSession=true).' }
                },
                required: ['agentName']
            }
        },
        {
            name: 'create_session',
            description: 'Create a new session under an existing agent. Prefer this when you need a new conversation thread without duplicating the agent or its memory.',
            parameters: {
                type: 'object',
                properties: {
                    agentName: { type: 'string', description: 'Existing agent name that will own the session.' },
                    sessionName: { type: 'string', description: 'Session name without agent prefix (cannot contain /).' },
                    displayName: { type: 'string', description: 'Optional display name for the new session.' },
                    parentSessionId: { type: 'string', description: 'Optional parent session ID.' },
                    model: { type: 'string', description: 'Optional explicit model key for the new session. When omitted, the current session child-default model behavior is used.' },
                    systemPromptFiles: {
                        type: 'array',
                        description: 'Optional file list for composing the memory-file portion of the new session snapshot. When set, only these files are used as memory sources, while other system injections remain.',
                        items: { type: 'string', description: 'A file path. Relative paths resolve from the agent directory; absolute and ~/ paths are also accepted.' }
                    }
                },
                required: ['agentName', 'sessionName']
            }
        },
        {
            name: 'set_agent_inherit',
            description: 'Set or clear shared memory inheritance for an agent. Inherited memory is injected in root -> ... -> self order without deduplicating same filenames.',
            parameters: {
                type: 'object',
                properties: {
                    agentName: { type: 'string', description: 'Agent whose shared memory inheritance should be updated.' },
                    inheritAgentName: { type: 'string', description: 'Parent agent to inherit shared memory from. Use empty string to clear inheritance.' }
                },
                required: ['agentName']
            }
        },
        {
            name: 'set_agent_isolated',
            description: 'Set or clear agent-level isolation. Isolated agents are bound to a non-master node and their sessions inherit isolated restrictions.',
            parameters: {
                type: 'object',
                properties: {
                    agentName: { type: 'string', description: 'Agent whose isolation setting should be updated.' },
                    nodeId: { type: 'string', description: 'Bound non-master node id. Use empty string to clear isolation.' }
                },
                required: ['agentName']
            }
        },
        {
            name: 'move_session',
            description: 'Move/rename a session, optionally to a different agent or create a new agent. Old session ID becomes an alias.',
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: 'Source session ID (default: current session)' },
                    newSessionId: { type: 'string', description: 'New session ID without agent prefix (cannot contain /). Default to "main" if createAgent=true.' },
                    createAgent: { type: 'boolean', description: 'Whether to create a new agent (default: false)' },
                    newAgentName: { type: 'string', description: 'Target agent name. Required if createAgent=true or moving to different agent. If omitted, renames within same agent.' },
                    createAgentInheritMemory: { type: 'boolean', description: 'Whether to inherit memory when creating agent (only valid when createAgent=true)' }
                }
            }
        }
    ];

