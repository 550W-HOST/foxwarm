import type { ModelEffort } from './config';

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
    /** Ordered, concrete-model-scoped OpenAI Responses output metadata. */
    openaiResponses?: OpenAIResponsesPartMeta;
  };
  functionCall?: FunctionCall;
  functionResponse?: FunctionResponse;
  toolUseId?: string;
  inlineData?: InlineData;  // Transient ingress/provider-boundary compatibility shape
  inlineDataRef?: InlineDataRef;
  imageMeta?: ImageMeta;
  [key: string]: any;  // Allow additional properties for flexibility
}

/**
 * Opaque OpenAI Responses output metadata which must be replayed only to the
 * concrete model that produced it. The output item is kept on a MessagePart
 * so provider output ordering survives the provider-neutral history shape.
 */
export interface OpenAIResponsesPartMeta {
  sourceModelId: string;
  outputItem?: Record<string, any>;
  annotations?: Array<Record<string, any>>;
}

export interface FunctionCall {
  id: string;
  name: string;
  args: Record<string, any>;
  rawArgsText?: string;
  argsParseError?: string;
}

/**
 * Message-level opaque provider metadata. Persisted with assistant messages
 * and echoed back verbatim on later provider requests.
 */
export interface MessageProviderMeta {
  /**
   * OpenAI Chat Completions `provider_specific_fields` (e.g.
   * `reasoning_signature`), captured from the assistant message and sent back
   * unchanged on subsequent requests to the same concrete model.
   */
  providerSpecificFields: Record<string, unknown>;
  /** Canonical concrete model id which produced `providerSpecificFields`. */
  sourceModelId: string;
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
  blobId?: string;
  apiPath?: string; // WebUI transport-only; never written by canonical persistence.
  format?: string;
  path?: string; // Legacy archive reference; current writers use blobId.
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
  /** Message-level provider metadata echoed back on later requests. */
  providerMeta?: MessageProviderMeta;
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
  /**
   * Provider-reported reasoning tokens within `outputTokens`, when that
   * provider protocol exposes the component separately. This is not an
   * additional total.
   */
  reasoningTokens?: number;
  outputTokens: number;
}

export interface SessionMeta {
  lastMessageTime: number;
  messageCount?: number; // Cached message count for quick access
  /** Durable receipts for idempotent externally acknowledged session events. */
  acceptedExternalEventIds?: string[];
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
  qqbotMessageId?: string; // QQ Bot inbound msg_id for binding a passive reply to the originating turn
  preferDirectReply?: boolean; // Persisted routing intent; true targets the originating live reply path when available
}

export interface QueueItem {
  type: 'user' | 'intersession' | 'background' | 'trigger' | 'onboot' | 'compact-commit';
  source?: QueueSource;
  sourceSessionId?: string;
  /** Browser-generated identity propagated to the persisted user message. */
  clientMessageId?: string;
  parts?: MessagePart[];
  message?: Message;
  waitTimeoutId?: string;
  /** Durable producer identity used to make acknowledged external events idempotent. */
  externalEventId?: string;
}

export interface CompactionRequest {
  keepPercent?: number;
  compactGuidance?: string;
  completionMarker?: string;
}

const CURRENT_QUEUE_ITEM_TYPES = new Set<QueueItem['type']>([
  'user',
  'intersession',
  'background',
  'trigger',
  'onboot',
  'compact-commit',
]);

export function isQueueItem(value: unknown): value is QueueItem {
  if (!value || typeof value !== 'object') return false;
  const item = value as Record<string, unknown>;
  if (!CURRENT_QUEUE_ITEM_TYPES.has(item.type as QueueItem['type'])) return false;
  if (item.type === 'compact-commit') return true;
  return (Array.isArray(item.parts) && item.parts.length > 0)
    || (!!item.message && typeof item.message === 'object');
}

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
  effort?: ModelEffort; // Explicit effort override; undefined => selected concrete leaf default
  childModelDefault?: string; // Default model override for child/new sessions spawned from this session; undefined => follow session.model
  childEffortDefault?: ModelEffort; // Default effort override for child/new sessions; undefined => follow session.effort/model default
  verbose?: boolean; // Whether to broadcast tool call info (default: false)
  vectorIndexPosition?: number; // Track last indexed message position
  indexingState?: IndexingState; // Track ongoing indexing operation
  historyVersion?: number; // Incremented on compact/clear to detect changes
  nextMessageSeq?: number; // Next per-session sequence number for append-only archive logging
  nextBlockId?: number; // Next per-session layered-context block id
  parentSessionId?: string; // Parent session ID for child sessions
  goalState?: SessionGoalState; // Session-local goal reminder configuration
  compactThresholdTokens?: number; // Optional per-session auto-compact threshold override in tokens
  /** Last durable session-worker mailbox row incorporated into this authoritative state file. */
  lastAppliedMailboxId?: number;
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
  /** Message-level provider metadata carried to the persisted assistant message. */
  providerMeta?: MessageProviderMeta;
  /** Timing of the successful provider request which produced this result. */
  previousLlmRequest?: {
    completedAt: number;
    durationMs: number;
  };
  /** Durable canonical request journal identity, when journaling succeeded before send. */
  llmRequestId?: string;
  /** Physical provider attempt which produced this successful result. */
  llmAttempt?: number;
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
