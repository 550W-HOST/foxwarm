// Message format types
export interface MessagePart {
  text?: string;
  system?: string;
  systemPayload?: boolean;
  thinking?: string;
  providerMeta?: {
    thinkingSummaries?: string[]; // OpenAI Responses
    encryptedThinking?: string;  // OpenAI Responses
    signature?: string; // kimi-k2.5
  };
  functionCall?: FunctionCall;
  functionResponse?: FunctionResponse;
  toolUseId?: string;
  inlineData?: InlineData;  // Internal format - always use this
  inlineDataRef?: InlineDataRef;
  imageMeta?: ImageMeta;
  [key: string]: any;  // Allow additional properties for flexibility
}

export interface FunctionCall {
  id: string;
  name: string;
  args: Record<string, any>;
  rawArgsText?: string;
  argsParseError?: string;
}

export interface FunctionResponse {
  tool_use_id: string;
  name: string;
  /**
   * Internal timing for the model request which produced this tool batch.
   * It is persisted with the first tool response so serializers never need to
   * infer it from neighboring history.
   */
  previousLlmRequest?: {
    time: string;
    durationMs: number;
  };
  response: {
    output?: any;
    content?: any;
    error?: any;
    inlineData?: InlineData;
    inlineDataItems?: InlineData[];
    [key: string]: any;
  };
}

export interface InlineData {
  mimeType?: string;
  mime_type?: string;
  data: string;
}

export interface InlineDataRef {
  imageId: string;
  format: string;
  path: string;
  mimeType: string;
  byteLength: number;
  sha256: string;
  width?: number;
  height?: number;
}

export interface ImageMeta {
  imageId: string;
  mimeType?: string;
  width?: number;
  height?: number;
  sizeBytes?: number;
  sha256?: string;
}

export type MaybePromise<T> = T | Promise<T>;
export type SessionReply = (text: string, options?: any) => MaybePromise<void>;
export type SessionBroadcast = (text: string, options?: any) => void;

export interface Message {
  role: 'user' | 'model' | 'tool';
  /**
   * Whether this persisted timeline message should be included in future
   * model-facing context. Defaults to true for legacy/ordinary messages.
   * Set false for display-only notices that should remain visible in history
   * and archives without influencing later LLM calls or compaction prompts.
   */
  modelVisible?: boolean;
  parts: MessagePart[];
  __meta?: {
    timestamp?: number;
    seq?: number;
    /** Canonical provider-prefixed model id used to create this model message. */
    modelId?: string;
    /** Resolved virtual models-config key requested for this model message, when applicable. */
    virtualModelKey?: string;
    /** Token usage reported for the model call that produced this model message. */
    usage?: TokenUsage;
    /** Structured CTX-BLOCK metadata for rendered layered-context block messages. */
    contextBlock?: ContextBlockMessageMeta;
    /** Structured active-frontier entry used to render this message, if known. */
    contextFrontierItem?: ContextFrontierItem;
    /** Present when a raw message is intentionally preserved after a covering block. */
    preservedFromBlockId?: number;
    [key: string]: any;
  };
}

export interface ToolScriptSubCall {
  id: string;
  name: string;
  status: 'running' | 'completed' | 'failed';
  startedAt: number;
  completedAt?: number;
  durationMs?: number;
  error?: string;
  argsSummary?: string;
}

export interface ModelStreamToolCall {
  index: number;
  id?: string;
  name?: string;
}

export type ChannelTurnToolStatus = 'running' | 'success' | 'error';

export interface ChannelTurnToolRef {
  id: string;
  name: string;
}

export interface ChannelTurnToolResult extends ChannelTurnToolRef {
  status: Exclude<ChannelTurnToolStatus, 'running'>;
}

export type ChannelTurnProgress =
  | { type: 'llm-start' }
  | { type: 'tool-calls-start'; calls: ChannelTurnToolRef[]; text?: string }
  | { type: 'tool-calls-finish'; results: ChannelTurnToolResult[] };

export interface SessionStreamEvent {
  type: 'model-stream-reset' | 'model-stream-update' | 'toolscript-progress';
  // model-stream-* fields:
  streamId?: string;
  iteration?: number;
  reasoning?: string;
  text?: string;
  toolCalls?: ModelStreamToolCall[];
  // toolscript-progress fields:
  runId?: string;
  toolUseId?: string;
  subCalls?: ToolScriptSubCall[];
}

export interface SessionGoalState {
  goal: string;
  remindEvery: number;
  anchorSeq: number;
  updatedAt: number;
}

export interface ContextBlockMessageMeta {
  id: number;
  level: number;
  rawStartSeq: number;
  rawEndSeq: number;
  sourceKind: 'message' | 'block';
  sourceStart: number;
  sourceEnd: number;
  sourceBlockIds?: number[];
  rawStartTimestamp?: number;
  rawEndTimestamp?: number;
  createdAt?: number;
  sourceSessionId?: string;
  inherited?: boolean;
}

// Session types
export interface SessionStats {
  totalCachedTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastUsage: TokenUsage | null;
}

export interface SessionTokenTotals {
  cachedTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export interface TokenUsage {
  cachedTokens: number;
  inputTokens: number;
  outputTokens: number;
}

export interface SessionMeta {
  lastMessageTime: number;
  messageCount?: number; // Cached message count for quick access
  lastChannel?: {
    channelId: string; // Configured channel instance id
    channelType?: string; // Adapter/platform type
    channelUserId: string; // Legacy alias of conversationId
    conversationId?: string; // Preferred channel-side conversation target id
  };
  [key: string]: any;
}

export interface QueueSource {
  platform: string; // Legacy alias of channelType
  channelId?: string; // Configured channel instance id
  channelType?: string; // Adapter/platform type
  channelUserId: string; // Legacy alias of conversationId
  conversationId?: string; // Preferred channel-side conversation target id
  username?: string;
  senderId?: string;
  weworkStreamId?: string; // WeWork intelligent-bot stream id for binding channel broadcasts to the originating turn
}

export interface QueueItem {
  type: 'user' | 'intersession' | 'background' | 'trigger' | 'onboot' | 'retry' | 'compact' | 'compact-commit';
  source?: QueueSource;
  sourceSessionId?: string;
  parts?: MessagePart[];
  message?: Message;
  waitTimeoutId?: string;
  keepPercent?: number;
  compactGuidance?: string;
  completionMarker?: string;
  stopAfterCurrentTurn?: boolean;
  requestedBy?: 'auto' | 'command' | 'tool' | 'manual';
}

export type ContextFrontierItem =
  | { kind: 'message'; seq: number; preservedFromBlockId?: number }
  | { kind: 'block'; id: number; level: number; rawStartSeq: number; rawEndSeq: number };

export interface Session {
  id: string;
  agent?: string; // Agent name (default: 'main')
  aliases?: string[]; // Alternative session IDs that resolve to this session
  history: Message[];
  systemPromptFiles?: string[]; // Optional file list overriding the memory-file portion of snapshot composition
  persistentMemorySnapshot: string;
  promptCacheKey?: string; // Stable low-sensitivity routing key passed to OpenAI as prompt_cache_key
  stats: SessionStats;
  busy: boolean;
  busyStartedAt?: number;
  stopping?: boolean; // Flag to stop ongoing tool call recursion
  queue: QueueItem[];
  meta: SessionMeta;
  displayName?: string; // User-defined display name for the session
  archived?: boolean; // Whether the session is archived
  pinned?: boolean; // Whether the session is presentation-pinned at the top of the WebUI session list
  sidebarOrder?: number; // Optional WebUI sidebar sibling ordering key; lower sorts first within a parent group
  currentNode?: string; // Current node ID for tool execution (default: 'master')
  cwd?: string; // Default working directory for exec/terminal-style operations on currentNode
  model?: string; // Model key for this session (default: global)
  childModelDefault?: string; // Default model override for child/new sessions spawned from this session; undefined => follow session.model
  verbose?: boolean; // Whether to broadcast tool call info (default: false)
  vectorIndexPosition?: number; // Track last indexed message position
  indexingState?: IndexingState; // Track ongoing indexing operation
  historyVersion?: number; // Incremented on compact/clear to detect changes
  nextMessageSeq?: number; // Next per-session sequence number for append-only archive logging
  nextBlockId?: number; // Next per-session layered-context block id
  contextFrontier?: ContextFrontierItem[]; // Structured layered-context frontier; session.history is a rendered view
  parentSessionId?: string; // Parent session ID for child sessions
  goalState?: SessionGoalState; // Session-local goal reminder configuration
  compactThresholdTokens?: number; // Optional per-session auto-compact threshold override in tokens
  broadcast?: SessionBroadcast; // Broadcast message to all attached channels (fire-and-forget)
}

export interface IndexingState {
  inProgress: boolean;
  startPosition: number; // Position where indexing started
  endPosition: number; // Target end position
  startTime: number; // Timestamp when indexing started
  historyVersion: number; // History version when indexing started
  chunks?: string[]; // Text chunks being indexed (for recovery)
}

// LLM types
export interface ChatResult {
  text: string;
  /** Canonical provider-prefixed model id used for the LLM request. */
  modelId?: string;
  /** Resolved virtual models-config key requested for the LLM request, when applicable. */
  virtualModelKey?: string;
  usage?: TokenUsage;
  toolCalls?: Array<FunctionCall>;
  allParts?: MessagePart[];
  /** Timing of the successful provider request which produced this result. */
  previousLlmRequest?: {
    completedAt: number;
    durationMs: number;
  };
}

export interface AnthropicMessage {
  role: 'user' | 'assistant' | 'tool';
  content: string | AnthropicContentBlock[];
}

export interface OpenAIResponsesContent {
  type: 'input_text' | 'input_image' | 'output_text' | 'reasoning';
  text?: string;
  image_url?: string;
  summary?: Array<{ text: string; type: 'summary_text' }>;
  encrypted_content?: string;
}

export interface AnthropicContentBlock {
  type: 'text' | 'thinking' | 'tool_use' | 'tool_result' | 'image';
  text?: string;
  thinking?: string;
  signature?: string;  // For kimi-k2.5 thinking signature
  id?: string;
  name?: string;
  input?: Record<string, any>;
  tool_use_id?: string;
  content?: string;
  source?: {
    type: string;
    media_type: string;
    data: string;
  };
}

// Tool types
export interface ToolDefinition {
  name: string;
  description: string;
  defaultInject?: boolean;
  parameters: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

export type ToolFunction = (args: Record<string, any>, tgCtx?: any) => Promise<string>;
