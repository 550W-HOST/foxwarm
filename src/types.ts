// Message format types
export interface MessagePart {
  text?: string;
  system?: string;
  thinking?: string;
  providerMeta?: {
    thinkingSummaries?: string[]; // OpenAI Responses
    encryptedThinking?: string;  // OpenAI Responses
    signature?: string; // kimi-k2.5
  };
  functionCall?: FunctionCall;
  functionResponse?: FunctionResponse;
  inlineData?: InlineData;  // Internal format - always use this
  [key: string]: any;  // Allow additional properties for flexibility
}

export interface FunctionCall {
  id: string;
  name: string;
  args: Record<string, any>;
}

export interface FunctionResponse {
  tool_use_id: string;
  name: string;
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

export type MaybePromise<T> = T | Promise<T>;
export type SessionReply = (text: string, options?: any) => MaybePromise<void>;

export interface Message {
  role: 'user' | 'model' | 'tool';
  parts: MessagePart[];
  __meta?: {
    timestamp?: number;
    seq?: number;
    [key: string]: any;
  };
}

export interface SessionStreamEvent {
  type: 'reasoning-summary' | 'reasoning-summary-reset';
  text?: string;
}

export interface SessionTodoState {
  todo: string;
  remindEvery: number;
  anchorSeq: number;
  updatedAt: number;
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
    channelId: string;
    channelType?: string;
    channelUserId: string;
    conversationId?: string;
  };
  [key: string]: any;
}

export interface QueueSource {
  platform: string;
  channelId?: string;
  channelType?: string;
  channelUserId: string;
  conversationId?: string;
  username?: string;
  senderId?: string;
}

export interface QueueItem {
  type: 'user' | 'intersession' | 'background' | 'trigger' | 'onboot' | 'compact' | 'compact-commit';
  source?: QueueSource;
  parts?: MessagePart[];
  keepPercent?: number;
  compactGuidance?: string;
  completionMarker?: string;
  stopAfterCurrentTurn?: boolean;
  requestedBy?: 'auto' | 'command' | 'tool' | 'manual';
}

export type ContextFrontierItem =
  | { kind: 'message'; seq: number }
  | { kind: 'block'; id: number; level: number; rawStartSeq: number; rawEndSeq: number };

export interface Session {
  id: string;
  agent?: string; // Agent name (default: 'main')
  aliases?: string[]; // Alternative session IDs that resolve to this session
  history: Message[];
  persistentMemorySnapshot: string;
  stats: SessionStats;
  busy: boolean;
  busyStartedAt?: number;
  stopping?: boolean; // Flag to stop ongoing tool call recursion
  queue: QueueItem[];
  meta: SessionMeta;
  displayName?: string; // User-defined display name for the session
  archived?: boolean; // Whether the session is archived
  currentNode?: string; // Current node ID for tool execution (default: 'master')
  cwd?: string; // Default working directory for exec/terminal-style operations on currentNode
  model?: string; // Model key for this session (default: global)
  verbose?: boolean; // Whether to broadcast tool call info (default: false)
  vectorIndexPosition?: number; // Track last indexed message position
  indexingState?: IndexingState; // Track ongoing indexing operation
  historyVersion?: number; // Incremented on compact/clear to detect changes
  nextMessageSeq?: number; // Next per-session sequence number for append-only archive logging
  nextBlockId?: number; // Next per-session layered-context block id
  contextFrontier?: ContextFrontierItem[]; // Structured layered-context frontier; session.history is a rendered view
  parentSessionId?: string; // Parent session ID for child sessions
  todoState?: SessionTodoState; // Session-local todo reminder configuration
  compactThresholdTokens?: number; // Optional per-session auto-compact threshold override in tokens
  broadcast?: SessionReply; // Broadcast message to all attached channels
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
  usage?: TokenUsage;
  toolCalls?: Array<FunctionCall>;
  allParts?: MessagePart[];
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
  parameters: {
    type: string;
    properties: Record<string, any>;
    required?: string[];
  };
}

export type ToolFunction = (args: Record<string, any>, tgCtx?: any) => Promise<string>;
