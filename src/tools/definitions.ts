import { DEFAULT_EXEC_TIMEOUT_SECONDS, MAX_EXEC_TIMEOUT_SECONDS, MIN_EXEC_TIMEOUT_SECONDS } from '../../packages/shared/dist/persistentExec';
import { COMPACT_PLAN_TOOL_DEFINITION } from '../session/compactPlan';
import { MAX_AGENT_TOOL_RULES, MAX_AGENT_TOOL_RULE_IDENTITY_UTF8_BYTES } from '../permissions';
import { HANDOFF_CONFIRMATION_ENABLED } from '../config';
import { addHandoffConfirmationSchema } from '../toolCallControls';

const TOOL_RULES_SCHEMA = {
    type: 'array',
    maxItems: MAX_AGENT_TOOL_RULES,
    description: "Replace this agent's legacy isolated-tool rules. Use an empty array to clear them. These rules apply only while the agent is isolated, alongside the instance-wide authorization policy.",
    items: {
        oneOf: [
            {
                type: 'object', additionalProperties: false,
                properties: {
                    effect: { type: 'string', enum: ['allow', 'deny'] },
                    source: { type: 'string', enum: ['builtin'] },
                    tool: { type: 'string', maxLength: MAX_AGENT_TOOL_RULE_IDENTITY_UTF8_BYTES },
                },
                required: ['effect', 'source', 'tool'],
            },
            {
                type: 'object', additionalProperties: false,
                properties: {
                    effect: { type: 'string', enum: ['allow', 'deny'] },
                    source: { type: 'string', enum: ['node'] },
                    node: { type: 'string', maxLength: MAX_AGENT_TOOL_RULE_IDENTITY_UTF8_BYTES },
                    tool: { type: 'string', maxLength: MAX_AGENT_TOOL_RULE_IDENTITY_UTF8_BYTES },
                },
                required: ['effect', 'source', 'node', 'tool'],
            },
            {
                type: 'object', additionalProperties: false,
                properties: {
                    effect: { type: 'string', enum: ['allow', 'deny'] },
                    source: { type: 'string', enum: ['mcp'] },
                    server: { type: 'string', maxLength: MAX_AGENT_TOOL_RULE_IDENTITY_UTF8_BYTES },
                    tool: { type: 'string', maxLength: MAX_AGENT_TOOL_RULE_IDENTITY_UTF8_BYTES },
                },
                required: ['effect', 'source', 'server', 'tool'],
            },
        ],
    },
};

const FORCE_MODEL_SCHEMA = {
    type: 'object',
    additionalProperties: false,
    description: "Override the model or effort for the new session. Omit to use the normal inherited defaults; an empty object also leaves them unchanged.",
    properties: {
        modelId: { type: 'string', description: "Configured model key to use." },
        effort: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'xhigh', 'max'], description: "Effort override. Can be set without modelId to use the otherwise selected model." },
    },
};

const baseDefinitions = [
        {
            name: 'read',
            defaultInject: true,
            description: "Read a file, view an image, or list a directory. Large text files are shown as bounded excerpts with their file size; use a line range to inspect a specific section. Directory listings are non-recursive and show up to 50 entries by default.",
            parameters: {
                type: 'object',
                properties: { 
                    filePath: { type: 'string' , description: "File or directory path. Relative paths use the session working directory, or the agent directory if no working directory is set. Absolute paths and ~/ paths are accepted subject to permissions."},
                    startLine: { type: 'number', description: "First line to read, counting from 1. For directories, the first entry to list. Omit or use 0 to start at the beginning." },
                    endLine: { type: 'number', description: "Last line or directory entry to include, counting from 1. Omit or use 0 for the default range." }
                },
                required: ['filePath']
            }
        },
        {
            name: 'write',
            defaultInject: true,
            description: "Write text to a file. Existing files are protected unless overwrite is true; missing parent directories are created only when createDirs is true. Supply content for a new write, or contentRef to retry previously cached content.",
            parameters: {
                type: 'object',
                properties: { 
                    content: { type: 'string' , description: "Complete file contents. Use either content or contentRef, not both."},
                    contentRef: { type: 'string', description: "Reference returned by a write that failed because the file existed or its parent directory was missing. Reuse it with overwrite=true to write the same cached text to this or another permitted path in the same session/agent. Set createDirs=true if needed. To change the text, supply content instead. References are short-lived." },
                    filePath: { type: 'string' , description: "Destination path. Relative paths use the session working directory, or the agent directory if unset. Absolute paths and ~/ paths are accepted subject to permissions."},
                    overwrite: { type: 'boolean', description: "Allow replacement of an existing file. Defaults to false." },
                    createDirs: { type: 'boolean', description: "Create missing parent directories. Defaults to false." }
                },
                required: ['filePath']
            }
        },
        {
            name: 'edit',
            defaultInject: true,
            description: "Replace one exact occurrence of text in a file. Use apply_patch when a line-based patch is more suitable.",
            parameters: {
                type: 'object',
                properties: { 
                    filePath: { type: 'string' , description: "File to edit. Relative paths use the session working directory, or the agent directory if unset. Absolute paths and ~/ paths are accepted subject to permissions."},
                    oldText: { type: 'string', description: "Exact text to replace; it must identify a single occurrence." },
                    newText: { type: 'string', description: "Replacement text." },
                },
                required: ['filePath', 'oldText', 'newText']
            }
        },
        {
            name: 'apply_patch',
            defaultInject: true,
            description: `Add, modify, or delete files with a line-based patch. Relative paths in patch headers use the session working directory, or the agent directory if unset. Absolute paths and ~/ paths are accepted subject to permissions. Supply the patch as input.

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
                    input: { type: 'string', description: "Complete patch text in the format described above." }
                },
                required: ['input']
            }
        },
        {
            name: 'read_memory',
            defaultInject: true,
            description: "Read a file in this agent's memory directory on master. Use memory-relative paths such as MEMORY.md or notes/project.md.",
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: "Path relative to this agent's memory directory, without a memory/ prefix." },
                    startLine: { type: 'number', description: "First line to read, counting from 1. Omit or use 0 to start at the beginning." },
                    endLine: { type: 'number', description: "Last line to include, counting from 1. Omit or use 0 to read through the end." }
                },
                required: ['filePath']
            }
        },
        {
            name: 'write_memory',
            defaultInject: true,
            description: "Create a file in this agent's memory directory on master. Existing files are not overwritten; use edit_memory to change one.",
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: "Path relative to this agent's memory directory, without a memory/ prefix." },
                    content: { type: 'string', description: "Complete contents of the new file." }
                },
                required: ['filePath', 'content']
            }
        },
        {
            name: 'edit_memory',
            defaultInject: true,
            description: "Replace one exact occurrence of text in a file in this agent's memory directory on master.",
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: "Path relative to this agent's memory directory, without a memory/ prefix." },
                    oldText: { type: 'string', description: "Exact text to replace; it must identify a single occurrence." },
                    newText: { type: 'string', description: "Replacement text." }
                },
                required: ['filePath', 'oldText', 'newText']
            }
        },
        {
            name: 'delete_memory',
            defaultInject: true,
            description: "Delete one file from this agent's memory directory on master.",
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: "Path relative to this agent's memory directory, without a memory/ prefix." }
                },
                required: ['filePath']
            }
        },
        {
            name: 'apply_patch_memory',
            defaultInject: true,
            description: "Add, modify, or delete this agent's memory files on master using the apply_patch format. Paths in patch headers are relative to the memory directory; a memory/ prefix is also accepted.",
            parameters: {
                type: 'object',
                properties: {
                    input: { type: 'string', description: "Patch text using the same format as apply_patch." }
                },
                required: ['input']
            }
        },
        {
            name: 'copy_between_nodes',
            defaultInject: true,
            description: "Copy a file between two Nodes, including master. Both paths are checked against the applicable permissions. Relative paths use this agent's directory on each Node, not the session working directory.",
            parameters: {
                type: 'object',
                properties: {
                    sourceNode: { type: 'string', description: "Node containing the source file. Use master for the Main host." },
                    sourcePath: { type: 'string', description: "Source path on sourceNode. Absolute paths, ~/ paths, and paths relative to the agent directory are accepted." },
                    targetNode: { type: 'string', description: "Node that will receive the file. Use master for the Main host." },
                    targetPath: { type: 'string', description: "Destination path on targetNode. Absolute paths, ~/ paths, and paths relative to the agent directory are accepted." },
                    overwrite: { type: 'boolean', description: "Allow replacement of an existing destination file. Defaults to false." },
                },
                required: ['sourceNode', 'sourcePath', 'targetNode', 'targetPath']
            }
        },
        {
            name: 'image_crop',
            defaultInject: true,
            description: "Crop an image previously returned by a tool in this session. Returns a new image that can be viewed, cropped again, or saved with image_write_to_file.",
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: "Image ID from a tool result, such as the value in [IMAGE: id=...]." },
                    x: { type: 'number', description: "Left edge of the crop, in pixels." },
                    y: { type: 'number', description: "Top edge of the crop, in pixels." },
                    width: { type: 'number', description: "Crop width in pixels." },
                    height: { type: 'number', description: "Crop height in pixels." },
                },
                required: ['id', 'x', 'y', 'width', 'height']
            }
        },
        {
            name: 'image_write_to_file',
            defaultInject: true,
            description: "Save an image previously returned by a tool in this session. The saved file can be reused or delivered with send_file.",
            parameters: {
                type: 'object',
                properties: {
                    id: { type: 'string', description: "Image ID from a previous tool result." },
                    filePath: { type: 'string', description: "Destination path. On master, relative paths use the session working directory or, if unset, the agent directory. On other Nodes, they use that Node's agent directory. Absolute paths and ~/ paths are also accepted." },
                    overwrite: { type: 'boolean', description: "Allow replacement of an existing file. Defaults to false." },
                    node: { type: 'string', description: "Node on which to save the image. Defaults to the current Node." },
                },
                required: ['id', 'filePath']
            }
        },
        {
            name: 'exec',
            defaultInject: true,
            description: "Run a shell command on the current Node. Output is saved in a command log and shown as a bounded preview. If the command outlasts timeout, it continues in the background and returns an execId; a later event reports completion. The timeout does not kill the command. Avoid adding head or tail just to shorten the preview: that changes the captured output. If you need both a complete log and a filtered view, save the complete output separately or use tee with a filter that consumes the whole stream.",
            parameters: {
                type: 'object',
                properties: {
                    command: { type: 'string' , description: "Shell command or pipeline to execute."},
                    cwd: { type: 'string', description: "Working directory for this command. Relative paths use the session working directory, or the Node's default directory if unset. When omitted, execution uses that same default chain; on master, the final default is the agent directory." },
                    timeout: { type: 'number', minimum: MIN_EXEC_TIMEOUT_SECONDS, description: `Seconds to wait before returning a still-running command as a background execution. Defaults to ${DEFAULT_EXEC_TIMEOUT_SECONDS}; values above ${MAX_EXEC_TIMEOUT_SECONDS} are reduced to ${MAX_EXEC_TIMEOUT_SECONDS} with a warning.` }
                },
                required: ['command']
            }
        },
        {
            name: 'create_child_session',
            defaultInject: true,
            description: "Create a child session under this session's agent, optionally with a copy of the current conversation. Supply an initial message to start its work. Ask the child to report back with send_to_session; creation alone does not deliver its eventual result.",
            parameters: {
                type: 'object',
                properties: {
                    suffix: { type: 'string', description: "Name for the child. For agent/main, research produces agent/research; for other parent sessions, it is appended to the parent ID." },
                    fork: { type: 'boolean', description: "Copy the parent's current context into the child. Defaults to false, which starts a separate conversation.", default: false },
                    message: { type: 'string', description: "Initial task or message to send immediately after creation. Omit to create the child without starting a turn." },
                    afterSend: { type: 'string', enum: ['continue', 'finish', 'wait'], description: "What this session does after creation and any initial delivery: continue (default), finish the turn without waiting, or wait for a reply. The wait option requires a nonempty initial message; other incoming activity can also resume the session." },
                    node: { type: 'string', description: "Node for the new child session. Omit to inherit the parent's current Node." },
                    forceModel: FORCE_MODEL_SCHEMA,
                },
                required: ['suffix']
            }
        },
        {
            name: 'send_to_session',
            defaultInject: true,
            description: "Send a message to another session. Use this to assign work or report results across sessions. For a completed child report, use afterSend=finish; use wait only when you need a later response.",
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: "Target Session ID. <main> selects this agent's main session; <parent> selects this session's direct parent and requires one to exist. Access is subject to session permissions." },
                    message: { type: 'string', description: "Message to deliver." },
                    afterSend: { type: 'string', enum: ['continue', 'finish', 'wait'], description: "What this session does after successful delivery: continue (default), finish the turn without waiting, or wait for a response. Other incoming activity can also resume a waiting session." },
                },
                required: ['sessionId', 'message']
            }
        },
        {
            name: 'wait',
            defaultInject: true,
            description: "End the current turn and wait for more information before continuing. Specify what you are waiting for using at least one of the options below. Incoming messages or other events can resume the session even while the specified work is still pending. If another tool in the same batch returns an error, this wait is canceled so you can handle the error.",
            parameters: {
                type: 'object',
                allOf: [{ not: { required: ['waitAllSessions', 'waitAnySessions'] } }],
                properties: {
                    reason: { type: 'string', description: "Briefly explain what you are waiting for." },
                    wakeIfNoActivityAfterSeconds: { type: 'number', exclusiveMinimum: 0, description: "Resume after this many seconds if nothing else has resumed the session. Use this as a fallback so you can check progress or decide what to do next." },
                    waitAllSessions: {
                        type: 'array',
                        description: "Session IDs from which you need responses before continuing the dependent work. Use this only when every listed session must respond. Cannot be combined with waitAnySessions.",
                        uniqueItems: true,
                        minItems: 2,
                        items: { type: 'string', pattern: '.*\\S.*', description: "Session ID." }
                    },
                    waitAnySessions: {
                        type: 'array', minItems: 1, uniqueItems: true,
                        description: "Session IDs from which you expect a response. Use this when a response from any one of them is enough to continue.",
                        items: { type: 'string', pattern: '.*\\S.*', description: "Session ID." }
                    },
                    waitExecIds: {
                        type: 'array',
                        description: "Background executions whose completion you are waiting for. Use an active execId owned by this session or agent, or one whose completion is already queued. Use the execId returned by exec, not a process ID or file path.",
                        minItems: 1, uniqueItems: true,
                        items: { type: 'string', description: "Execution ID returned by exec." }
                    },
                    waitForInput: { type: 'boolean', enum: [true], description: "Set to true when waiting for a user message or another external event that is not covered by the session or execution options." }
                }
            } as any
        },
        {
            name: 'send_to_channel',
            defaultInject: true,
            description: "Send a message to a specific user conversation, room, or group. Normal replies already go to this session's receiving channels; use this tool when the user explicitly requests delivery to a particular destination.",
            parameters: {
                type: 'object',
                properties: {
                    channelTargetId: { type: 'string', description: "Destination in the form <channel-instance-id>:<conversation-id>." },
                    message: { type: 'string', description: "Message to deliver." }
                },
                required: ['channelTargetId', 'message']
            }
        },
        {
            name: 'send_file',
            defaultInject: true,
            description: "Deliver a file or image from a Node to users. Choose either one channelTargetId or a sessionId whose attached channels should receive it. With neither, delivery uses the current session.",
            parameters: {
                type: 'object',
                properties: {
                    channelTargetId: { type: 'string', description: "One destination in the form <channel-instance-id>:<conversation-id>. Do not combine with sessionId." },
                    sessionId: { type: 'string', description: "Session whose attached channels should receive the file. Defaults to the current session; do not combine with channelTargetId." },
                    filePath: { type: 'string', description: "Path on the selected Node. On master, relative paths use the current session working directory or, if unset, its agent directory. On other Nodes, they use that Node's agent directory. Absolute paths and ~/ paths are accepted." },
                    node: { type: 'string', description: "Node containing the file. Defaults to the current Node." },
                    caption: { type: 'string', description: "Text to accompany the file, where the destination supports captions." },
                    text: { type: 'string', description: "Alternative name for caption." }
                },
                required: ['filePath']
            }
        },
        {
            name: 'session',
            defaultInject: true,
            description: "Inspect this session's status, list sessions, or change a session's display name. Status includes the current Node and working directory, model and effort settings, context usage, and recent children.",
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['status', 'list', 'update-display-name'], description: "status (default) inspects this session; list returns a page of sessions; update-display-name sets or clears a session's display name." },
                    start: { type: 'number', description: "Zero-based offset for list, ordered by most recent activity. Defaults to 0." },
                    count: { type: 'number', description: "Number of sessions to return for list. Defaults to 20." },
                    sessionId: { type: 'string', description: "Target for update-display-name. Defaults to this session; status always describes this session." },
                    name: { type: 'string', description: "New display name for update-display-name. An empty string clears it." }
                },
                required: [] as string[]
            }
        },
        {
            name: 'list_agents',
            defaultInject: true,
            description: "List agents and the number of sessions belonging to each.",
            parameters: {
                type: 'object',
                properties: {},
                required: [] as string[]
            }
        },
        {
            name: 'skill',
            defaultInject: true,
            description: "List available skills or read a skill's instructions and resource list. Skills may come from the agent, its inherited agents, or the global collection. Read any needed resource files separately; loading instructions does not enable additional tools.",
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'load'], description: "list shows available skills; load reads one skill." },
                    skillName: { type: 'string', description: "Skill to read when action is load." },
                    agentName: { type: 'string', description: "Agent whose available skills to use. Defaults to this session's agent." }
                },
                required: ['action']
            }
        },
        {
            name: 'get_session_messages',
            defaultInject: true,
            description: "Read a page of a session's messages and its current execution state. Defaults to the latest 10 messages. Filters narrow the selected page, not the entire conversation; use recall for semantic search or older context.",
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: "Session to read." },
                    start: { type: 'number', description: "Zero-based message offset. Negative values count back from the end; -10 starts at the tenth-last message." },
                    count: { type: 'number', description: "Number of messages to retrieve." },
                    previewLength: { type: 'number', description: "Total character budget for the response. Omit or use 0 for the default; other values are bounded to 1,000-20,000." },
                    contentFilter: { type: 'string', description: "Keep selected messages whose full text or tool content contains this text, ignoring case. Previews show the matching area when possible." },
                    includeRegex: { type: 'string', description: "Keep selected messages matching this regular expression, ignoring case." },
                    excludeRegex: { type: 'string', description: "Exclude selected messages matching this regular expression, ignoring case." },
                    toolDetail: { type: 'string', enum: ['names', 'snippets', 'full'], description: "Tool display detail: names (default) shows name, ID, and status; snippets adds short excerpts; full includes arguments and results within the response budget." }
                },
                required: ['sessionId']
            }
        },
        {
            name: 'get_archived_messages',
            description: "Read archived messages by sequence number, including messages no longer present in the active conversation.",
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: "Session to read. Defaults to this session." },
                    startSeq: { type: 'number', description: "First message sequence number to include." },
                    endSeq: { type: 'number', description: "Last message sequence number to include." },
                    previewLength: { type: 'number', description: "Maximum preview characters per message. Defaults to 1,000." }
                }
            }
        },
        {
            name: 'get_archived_blocks',
            description: "Read archived context-block summaries by block ID.",
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: "Session to read. Defaults to this session." },
                    startId: { type: 'number', description: "First block ID to include." },
                    endId: { type: 'number', description: "Last block ID to include." },
                    previewLength: { type: 'number', description: "Maximum preview characters per summary. Defaults to 1,000." }
                }
            }
        },
        {
            name: 'recall',
            defaultInject: true,
            description: "Recover earlier conversation context. Use target to open a known context block or message range, or vector_query to search by meaning. Filters narrow the retrieved items; they do not change which range is opened or replace semantic search.",
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: "Session for exact context lookup. Defaults to this session." },
                    target: { type: 'string', description: "What to open: overview (default), blocks, a block such as B#126, its raw messages with msg:B#126, or messages such as msg#10637 or msg#10637-10680. block#126 is also accepted." },
                    vector_query: { type: 'string', description: "Search earlier context by meaning and return matching messages or block summaries." },
                    limit: { type: 'number', description: "Maximum semantic search results. Defaults to 5, up to 20." },
                    scope: { type: 'string', enum: ['all', 'current-session', 'current-agent'], description: "Scope for semantic search. Searches stay within this agent; legacy isolated agents are further limited to the current session." },
                    agentName: { type: 'string', description: "Agent for semantic search. Only this session's agent is supported." },
                    previewLength: { type: 'number', description: "Total character budget for the response. Omit or use 0 for the default; other values are bounded to 1,000-20,000." },
                    contentFilter: { type: 'string', description: "Keep retrieved items containing this text, ignoring case, and show the matching area when possible. Omit to read the complete selected context." },
                    includeRegex: { type: 'string', description: "Keep retrieved items matching this regular expression, ignoring case." },
                    excludeRegex: { type: 'string', description: "Exclude retrieved items matching this regular expression, ignoring case." },
                    preferBlocks: { type: 'boolean', description: "Give context-block summaries a small ranking preference in semantic search." },
                    toolDetail: { type: 'string', enum: ['names', 'snippets', 'full'], description: "Tool display detail: names (default) shows name, ID, and status; snippets adds short excerpts; full includes arguments and results within the response budget." }
                }
            }
        },
        {
            name: 'delete_session',
            description: "Permanently delete another session. The current session cannot delete itself.",
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: "Session to delete." }
                },
                required: ['sessionId']
            }
        },
        {
            name: 'set_goal',
            defaultInject: true,
            description: "Keep a goal reminder in this session during substantial work that may span compaction. Use it when this session will perform the work over many steps, not for short tasks or work mostly delegated to children. The reminder survives compaction and applies only to this session.",
            parameters: {
                type: 'object',
                properties: {
                    goal: { type: 'string', description: "Goal to remember. An empty string clears it." },
                    remindEvery: { type: 'number', description: "Number of subsequent non-reminder messages between reminders. Omit to keep the current interval, or use the default of 20 if none is set." },
                    clear: { type: 'boolean', description: "Remove the current goal reminder." }
                }
            }
        },
        {
            name: 'set_session_child_model',
            description: "Inspect or change the default model and effort for future child or related new sessions. Unset settings follow the source session's normal model and effort defaults.",
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: "Session whose defaults to inspect or change. Defaults to this session." },
                    model: { type: 'string', description: "Configured model key for future child or related new sessions." },
                    effort: { type: 'string', enum: ['none', 'low', 'medium', 'high', 'xhigh', 'max', 'default', 'unset'], description: "Effort setting; use default or unset to clear the override." },
                    clear: { type: 'boolean', description: "Clear only the model override. Do not combine with model." }
                }
            }
        },
        {
            name: 'set_session_compact_threshold',
            description: "Inspect or change the context-token threshold that triggers automatic compaction for a session. Without an override, the threshold follows the active model's context window.",
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: "Session to inspect or change. Defaults to this session." },
                    thresholdTokens: { type: 'number', description: "Token threshold for automatic compaction. Omit to inspect the current setting." },
                    clear: { type: 'boolean', description: "Remove the override and use the model-derived default." }
                }
            }
        },
        {
            name: 'update_session_snapshot',
            description: "Refresh a session's prompt snapshot after changes to its memory files, inheritance, or available skills.",
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: "Session to refresh. Defaults to this session." }
                }
            }
        },
        {
            name: 'stop_session',
            description: "Request that a running session stop its current turn. An in-flight model request may be aborted; a tool already running may need to finish.",
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: "Session to stop." }
                },
                required: ['sessionId']
            }
        },
        COMPACT_PLAN_TOOL_DEFINITION,
        {
            name: 'compact_session',
            description: "Start compaction for this session or another idle session. The target uses a separate planning turn to produce a summary plan with submit_compact_plan; this call does not return the candidates or supply the final summary.",
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: "Session to compact. Defaults to this session." },
                    summary: { type: 'string', description: "Additional instructions for the compaction planner, not the final summary or plan." },
                    keepPercent: { type: 'number', description: "Recent history to retain, expressed as a fraction from 0 to 1 or a percentage from 1 to 100." }
                }
            }
        },
        {
            name: 'create_timer',
            description: "Schedule a message for a session, once or on a recurring schedule. Choose one of at, afterSeconds, or cron. Timers survive restarts. Load the timer-automation skill before creating or changing timers.",
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: "Session that owns the timer. Defaults to this session." },
                    at: { type: ['string', 'number'], description: "One-time trigger time as an ISO date-time string or Unix epoch milliseconds." },
                    afterSeconds: { type: 'number', description: "Seconds from now until a one-time trigger." },
                    cron: { type: 'string', description: "Cron schedule for recurring triggers." },
                    message: { type: 'string', description: "Message delivered on each trigger." },
                    newSession: { type: 'boolean', description: "Deliver each trigger to a newly created session instead of the owner session." },
                    sessionPrefix: { type: 'string', description: "Name prefix for newly created sessions. Defaults to timer; applies when newSession is true." },
                    agentName: { type: 'string', description: "Agent for newly created sessions. Defaults to the owner session's agent; applies when newSession is true." }
                },
                required: ['message']
            }
        },
        {
            name: 'list_timers',
            description: "List timers owned by a session.",
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: "Owner Session ID. Defaults to this session." }
                }
            }
        },
        {
            name: 'update_timer',
            description: "Change an existing timer. Omitted fields keep their current values. To change its schedule, supply exactly one of at, afterSeconds, or cron. Load the timer-automation skill before changing timers.",
            parameters: {
                type: 'object',
                properties: {
                    timerId: { type: 'string', description: "Timer to update." },
                    sessionId: { type: 'string', description: "Owner Session ID. Defaults to this session." },
                    at: { type: ['string', 'number'], description: "New one-time trigger time as an ISO date-time string or Unix epoch milliseconds." },
                    afterSeconds: { type: 'number', description: "Seconds from now until the rescheduled one-time trigger." },
                    cron: { type: 'string', description: "New recurring cron schedule." },
                    message: { type: 'string', description: "Replacement message for future triggers." },
                    newSession: { type: 'boolean', description: "Use a new session for each trigger when true. Setting false returns delivery to the owner and clears new-session target settings." },
                    sessionPrefix: { type: 'string', description: "Name prefix for new sessions; applies only when newSession is true." },
                    agentName: { type: 'string', description: "Agent for new sessions; applies only when newSession is true and defaults to the owner session's agent." }
                },
                required: ['timerId']
            }
        },
        {
            name: 'delete_timer',
            description: "Delete a timer so it no longer fires.",
            parameters: {
                type: 'object',
                properties: {
                    timerId: { type: 'string', description: "Timer to delete." },
                    sessionId: { type: 'string', description: "Owner Session ID. Defaults to this session." }
                },
                required: ['timerId']
            }
        },
        {
            name: 'browse_open',
            description: "Open a browser tab at a URL and return its tab ID for later browser calls.",
            parameters: {
                type: 'object',
                properties: {
                    url: { type: 'string', description: "URL to open." }
                },
                required: ['url']
            }
        },
        {
            name: 'browse_list',
            description: "List open browser tabs with their IDs, titles, and URLs.",
            parameters: {
                type: 'object',
                properties: {}
            }
        },
        {
            name: 'browse_get',
            description: "Read a browser tab's text or capture its screenshot.",
            parameters: {
                type: 'object',
                properties: {
                    tabId: { type: 'string', description: "Tab ID returned by browse_open or browse_list." },
                    screenshot: { 
                        type: ['boolean', 'string'], 
                        description: "Omit or set false for text. Set true to return an image, or provide an absolute path beginning with / to save the screenshot there.",
                        default: false 
                    }
                },
                required: ['tabId']
            }
        },
        {
            name: 'browse_close',
            description: "Close a browser tab.",
            parameters: {
                type: 'object',
                properties: {
                    tabId: { type: 'string', description: "Tab to close." }
                },
                required: ['tabId']
            }
        },
        {
            name: 'browse_interact',
            description: "Interact with a browser tab: click, type, fill, press a key, scroll, wait, evaluate JavaScript, or navigate.",
            parameters: {
                type: 'object',
                properties: {
                    tabId: { type: 'string', description: "Tab to control." },
                    action: { 
                        type: 'string', 
                        description: "Browser action to perform.",
                        enum: ['click', 'type', 'fill', 'press', 'scroll', 'wait', 'evaluate', 'goto', 'back', 'forward', 'reload']
                    },
                    params: { 
                        type: 'object', 
                        description: "Arguments for the action, such as {selector: '#id'} for click, {selector: 'input', text: 'hello'} for fill, {key: 'Enter'} for press, {y: 500} for scroll, {url: 'https://example.com'} for goto, or {code: 'document.title'} for evaluate.",
                        properties: {
                            selector: { type: 'string', description: "CSS selector for the target element." },
                            text: { type: 'string', description: "Text to type or fill." },
                            key: { type: 'string', description: "Key to press, such as Enter, Tab, or Escape." },
                            y: { type: 'number', description: "Vertical scroll distance in pixels." },
                            url: { type: 'string', description: "Destination URL for goto." },
                            code: { type: 'string', description: "JavaScript to evaluate in the tab." },
                            timeout: { type: 'number', description: "Action timeout in milliseconds. Defaults to 5,000." }
                        }
                    }
                },
                required: ['tabId', 'action']
            }
        },
        {
            name: 'search_tools',
            defaultInject: true,
            description: "Find tools and their calling schemas. Results include a toolId or explicit source fields you can pass to call_tool. Search builtin for session and management tools, node for file, shell, browser, and other Node tools, or mcp for connected servers. Use limit=1 when looking up one known tool.",
            parameters: {
                type: 'object',
                properties: {
                    query: { type: 'string', description: "Words to match in tool names and descriptions. Results matching more words rank higher. Omit to list tools." },
                    sources: {
                        type: 'array',
                        description: "Sources to search. Defaults to builtin, mcp, and node.",
                        items: { type: 'string', enum: ['builtin', 'mcp', 'node'] }
                    },
                    server: { type: 'string', description: "Limit MCP results to this server. Omit to search all enabled MCP servers." },
                    nodeId: { type: 'string', description: "Node to search. Omit to search the current Node, or master when no Node is selected; this does not search every Node." },
                    limit: { type: 'integer', minimum: 1, maximum: 200, description: "Maximum results. Defaults to 5, up to 200." },
                    includeSchema: { type: 'boolean', description: "Include input schemas for up to the first 10 results. Defaults to true; remaining results use short summaries." }
                }
            }
        },
        {
            name: 'call_tool',
            defaultInject: true,
            description: "Call a tool found with search_tools. Supply its toolId, or identify it with source and name plus server or nodeId when needed. Put the tool's arguments in args. File, shell, and browser tools use source=node; session and management tools use builtin. Calling through this tool applies the target tool's normal permissions.",
            parameters: {
                type: 'object',
                properties: {
                    toolId: { type: 'string', description: "Tool ID returned by search_tools, such as builtin:list_timers, mcp:server/tool, or node:node-id/tool." },
                    source: { type: 'string', enum: ['builtin', 'mcp', 'node'], description: "Tool source when not using toolId." },
                    name: { type: 'string', description: "Tool name when not using toolId." },
                    server: { type: 'string', description: "MCP server name. Required for source=mcp unless included in toolId." },
                    nodeId: { type: 'string', description: "Node for source=node. Omit or use current to select this session's current Node." },
                    args: { type: 'object', description: "Arguments for the selected tool.", additionalProperties: true },
                    argsJson: { type: 'string', description: "Arguments encoded as a JSON object string when args cannot be supplied, for example {\"filePath\":\"README.md\"}." }
                }
            }
        },
        {
            name: 'run_script',
            defaultInject: true,
            description: "Run ToolScript code to coordinate tool calls. Supply a script file or inline code defining main(args). Returns a runId for inspecting or resuming the run. A run that reaches its time budget at a safe pause point can be resumed with continue_script.",
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: "Script path. Relative paths use the session working directory, or the agent directory if unset." },
                    code: { type: 'string', description: "Inline ToolScript defining def main(args):. When supplied, a filePath is not required." },
                    args: { type: 'object', description: "Input object available to the script as args.", additionalProperties: true },
                    argsJson: { type: 'string', description: "Input encoded as a JSON object string when args cannot be supplied." },
                    mode: { type: 'string', enum: ['foreground', 'background'], description: "foreground (default) runs until a result or pause; background starts a run that can continue independently." },
                    timeoutSecs: { type: 'number', description: "Time budget in seconds for this run segment. Defaults to 30. At a safe pause point after the budget is reached, the run pauses for continue_script rather than failing." }
                },
                required: []
            }
        },
        {
            name: 'start_toolscript_run',
            description: "Start a background ToolScript run. Retained for existing automation; use run_script with mode=background for new calls.",
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: "Script path. Relative paths use the session working directory, or the agent directory if unset." },
                    code: { type: 'string', description: "Inline ToolScript defining def main(args):. When supplied, a filePath is not required." },
                    args: { type: 'object', description: "Input object available to the script as args.", additionalProperties: true },
                    argsJson: { type: 'string', description: "Input encoded as a JSON object string when args cannot be supplied." },
                    mode: { type: 'string', enum: ['foreground', 'background'], description: "Run mode. Defaults to background for this compatibility entry point." },
                    timeoutSecs: { type: 'number', description: "Time budget in seconds for this run segment. Defaults to 30. At a safe pause point after the budget is reached, the run pauses for continue_script rather than failing." }
                },
                required: []
            }
        },
        {
            name: 'continue_script',
            defaultInject: true,
            description: "Resume a ToolScript run paused for agent input or a time budget. Use the runId and continuationId from the pause result. The returned stdout contains only newly produced output; get_toolscript_run returns the accumulated output.",
            parameters: {
                type: 'object',
                properties: {
                    runId: { type: 'string', description: "Run ID returned by run_script." },
                    continuationId: { type: 'string', description: "Continuation ID from the pause result." },
                    input: { type: 'string', description: "Text returned to the script's paused ask_agent call. Encode structured input as JSON text. Ignored when resuming a time-budget pause." },
                    timeoutSecs: { type: 'number', description: "Time budget for this continuation, in seconds. Defaults to the previous segment's budget." }
                },
                required: ['runId', 'continuationId']
            }
        },
        {
            name: 'list_toolscript_runs',
            description: "List this session's ToolScript runs with their status and progress summaries.",
            parameters: {
                type: 'object',
                properties: {
                    limit: { type: 'number', description: "Maximum runs to return. Defaults to 20, up to 200." },
                    status: { type: 'string', enum: ['running', 'waiting', 'completed', 'failed', 'cancelled'], description: "Include only runs with this status." }
                }
            }
        },
        {
            name: 'get_toolscript_run',
            description: "Inspect a ToolScript run, including its status, pause details, accumulated output, and tool activity.",
            parameters: {
                type: 'object',
                properties: {
                    runId: { type: 'string', description: "Run to inspect." }
                },
                required: ['runId']
            }
        },
        {
            name: 'cancel_toolscript_run',
            description: "Cancel an active or paused ToolScript run owned by this session. It also attempts to release any sessions the run controls.",
            parameters: {
                type: 'object',
                properties: {
                    runId: { type: 'string', description: "Run to cancel." }
                },
                required: ['runId']
            }
        },
        {
            name: 'mcp_config',
            description: "Add or update an MCP server connection. Successful changes apply to subsequent calls without restarting Foxwarm; use enable=false to disable a server. Load the mcp-management skill before changing connections. Use this tool rather than editing the configuration file when the change must apply immediately.",
            parameters: {
                type: 'object',
                properties: {
                    name: { type: 'string', description: "Name identifying the server." },
                    url: { type: 'string', description: "MCP endpoint URL. Use its streamable HTTP endpoint for streamable-http or auto, or its SSE endpoint for sse." },
                    command: { type: 'string', description: "Executable to start for stdio transport." },
                    args: { type: 'array', items: { type: 'string' }, description: "Command-line arguments for the stdio server." },
                    env: { type: 'object', description: "Additional environment variables for the stdio server.", additionalProperties: { type: 'string' } },
                    envJson: { type: 'string', description: "Environment variables as a JSON object string when env cannot be supplied. All values must be strings." },
                    cwd: { type: 'string', description: "Working directory for the stdio server." },
                    stderr: { type: 'string', description: "How to handle the stdio server's standard error stream: inherit, pipe, or ignore." },
                    token: { type: 'string', description: "Bearer token for the Authorization header." },
                    headers: { type: 'object', description: "HTTP request headers. An explicit Authorization header takes precedence over token.", additionalProperties: { type: 'string' } },
                    headersJson: { type: 'string', description: "HTTP headers as a JSON object string when headers cannot be supplied. All values must be strings." },
                    transport: { type: 'string', description: "Connection transport. Defaults to auto." },
                    type: { type: 'string', description: "Alternative name for transport." },
                    description: { type: 'string', description: "Short description of the server." },
                    timeoutSeconds: { type: 'number', minimum: 0, maximum: 3600, description: "Time limit for calls to this server, in seconds, from 1 to 3,600. Use 0 to restore the MCP SDK default. Does not change connection or tool-listing timeouts." },
                    enable: { type: 'boolean', description: "Whether this server is enabled." }
                },
                required: ['name']
            }
        },
        {
            name: 'list_mcp_servers',
            description: "List configured MCP servers, including disabled ones, with redacted connection summaries. A null timeoutSeconds means the MCP SDK default is used.",
            parameters: {
                type: 'object',
                properties: {}
            }
        },
        {
            name: 'node',
            defaultInject: true,
            description: "List available Nodes, select this session's execution Node, or manage a Node through its configured provider. Provider operations may create or remove resources; inspect the provider's behavior before assuming what will be retained or deleted.",
            parameters: {
                type: 'object',
                properties: {
                    action: { type: 'string', enum: ['list', 'select', 'create', 'ensure', 'inspect', 'destroy'], description: "list shows Nodes; select changes this session's Node; create or ensure uses a provider; inspect shows a Node's details; destroy requests its removal." },
                    nodeId: { type: 'string', description: "Node to select, inspect, or destroy. For create or ensure, supply it when requesting a specific Node ID." },
                    providerId: { type: 'string', description: "Configured provider to use for create or ensure. Existing Nodes identify their own provider for inspect or destroy." },
                    parameters: { type: 'object', description: "Provider-specific options for the lifecycle operation.", additionalProperties: true },
                    parametersJson: { type: 'string', description: "Provider options as a JSON object string when parameters cannot be supplied." },
                    confirmation: { type: 'string', description: "For destroy, exactly: destroy node <nodeId>." }
                },
                required: ['action']
            }
        },
        {
            name: 'node_bootstrap_info',
            description: "Get Node setup instructions, bootstrap endpoints, and the pairing token. Choose a BASE_URL reachable from the new Node and substitute it into the returned commands. Treat the pairing token as a secret.",
            parameters: {
                type: 'object',
                properties: {}
            }
        },
        {
            name: 'node_pair_approve',
            description: "Approve a pending Node pairing request. First inspect node_pair_list and verify the request is from the Node you intend to trust.",
            parameters: {
                type: 'object',
                properties: {
                    pendingId: { type: 'string', description: "Pending request ID from node_pair_list." },
                    nodeId: { type: 'string', description: "Node ID to assign. Defaults to the requested name." },
                },
                required: ['pendingId']
            }
        },
        {
            name: 'node_pair_list',
            description: "List Node pairing requests awaiting approval.",
            parameters: {
                type: 'object',
                properties: {}
            }
        },
        {
            name: 'create_agent',
            description: "Create an agent with its own persistent workspace and memory. A main session is also created by default. Use create_session instead when you only need another conversation under an existing agent.",
            parameters: {
                type: 'object',
                properties: {
                    agentName: { type: 'string', description: "New agent name, using letters, numbers, hyphens, or underscores." },
                    inheritMemory: { type: 'boolean', description: "Copy memory files from the source agent once. Use inherit for ongoing shared-memory inheritance." },
                    inherit: { type: 'string', description: "Agent whose memory should be inherited by the new agent." },
                    isolatedNode: { type: 'string', description: "Non-master Node to bind when creating an isolated agent." },
                    toolRules: TOOL_RULES_SCHEMA,
                    createMainSession: { type: 'boolean', description: "Also create the agent's main session. Defaults to true." },
                    sourceSessionId: { type: 'string', description: "Session whose current Node and model provide creation defaults. Defaults to this session." },
                    convertSession: { type: 'boolean', description: "Convert an existing session into this agent's main session. Requires createMainSession=true." }
                },
                required: ['agentName']
            }
        },
        {
            name: 'create_session',
            description: "Create a conversation under an existing agent, reusing that agent's memory and workspace. Use forceModel only when intentionally overriding the normal model or effort defaults.",
            parameters: {
                type: 'object',
                properties: {
                    agentName: { type: 'string', description: "Existing agent that will own the session." },
                    sessionName: { type: 'string', description: "Session name without the agent prefix; it cannot contain /." },
                    displayName: { type: 'string', description: "Display name for the new session." },
                    parentSessionId: { type: 'string', description: "Existing session to record as the new session's parent." },
                    forceModel: FORCE_MODEL_SCHEMA,
                    systemPromptFiles: {
                        type: 'array',
                        description: "Memory source files for the new prompt snapshot. When supplied, these replace the default memory-file selection; other system instructions remain.",
                        items: { type: 'string', description: "File path. Relative paths use the agent directory; absolute paths and ~/ paths are accepted." }
                    }
                },
                required: ['agentName', 'sessionName']
            }
        },
        {
            name: 'set_agent_inherit',
            description: "Set or clear an agent's shared-memory inheritance. Memory is included from the oldest ancestor through the agent itself; files with the same name are not deduplicated.",
            parameters: {
                type: 'object',
                properties: {
                    agentName: { type: 'string', description: "Agent to update." },
                    inheritAgentName: { type: 'string', description: "Agent to inherit from. An empty string clears inheritance." }
                },
                required: ['agentName']
            }
        },
        {
            name: 'set_agent_isolated',
            description: "Set or clear legacy agent-level isolation and its non-master Node binding. These restrictions apply to all sessions in the agent, in addition to any instance-wide tool authorization policy.",
            parameters: {
                type: 'object',
                properties: {
                    agentName: { type: 'string', description: "Agent to update." },
                    nodeId: { type: 'string', description: "Non-master Node to bind. An empty string clears isolation; omission leaves the current binding unchanged." },
                    toolRules: { ...TOOL_RULES_SCHEMA, description: "Replace this agent's legacy isolated-tool rules. Use an empty array to clear them. These rules apply only while the agent is isolated." },
                },
                required: ['agentName']
            }
        },
        {
            name: 'set_tool_rules',
            defaultInject: false,
            description: "Install a complete tool authorization policy from a file on master. The candidate is validated before atomically replacing state/tool-authorization.yaml. Your current permissions must allow both this operation and reading the candidate file.",
            parameters: {
                type: 'object',
                properties: {
                    filePath: { type: 'string', description: "Path on master to the complete candidate YAML policy." }
                },
                required: ['filePath'],
                additionalProperties: false
            }
        },
        {
            name: 'move_session',
            description: "Rename a session or move it to another agent, optionally creating that agent. The old Session ID remains an alias.",
            parameters: {
                type: 'object',
                properties: {
                    sessionId: { type: 'string', description: "Session to move. Defaults to this session." },
                    newSessionId: { type: 'string', description: "New session name without an agent prefix or /. Defaults to main when createAgent is true." },
                    createAgent: { type: 'boolean', description: "Create the destination agent. Defaults to false." },
                    newAgentName: { type: 'string', description: "Destination agent. Required when creating an agent or moving across agents; omit to rename within the source agent." },
                    createAgentInheritMemory: { type: 'boolean', description: "Copy source memory when creating the destination agent. Applies only when createAgent is true." },
                    parentSessionId: { type: 'string', description: "Existing parent session to assign after the move. Omit to keep the current parent relation." }
                }
            }
        }
];

export function buildToolDefinitions(handoffConfirmationEnabled: boolean) {
    return baseDefinitions.map(definition => addHandoffConfirmationSchema(definition, handoffConfirmationEnabled));
}

export const definitions = buildToolDefinitions(HANDOFF_CONFIRMATION_ENABLED);

