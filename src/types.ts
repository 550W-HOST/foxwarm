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
    output?: string;
    error?: string;
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

// Session types
export interface SessionStats {
  totalCachedTokens: number;
  totalInputTokens: number;
  totalOutputTokens: number;
  lastUsage: TokenUsage | null;
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
    platform: string;
    channelUserId: string;
  };
  [key: string]: any;
}

export interface QueueSource {
  platform: string;
  channelUserId: string;
  username?: string;
  senderId?: string;
}

export interface QueueItem {
  type: 'user' | 'intersession' | 'background' | 'trigger' | 'onboot' | 'compact';
  source?: QueueSource;
  parts?: MessagePart[];
  summary?: string;
  keepPercent?: number;
}

export interface Session {
  id: string;
  agent?: string; // Agent name (default: 'main')
  aliases?: string[]; // Alternative session IDs that resolve to this session
  history: Message[];
  persistentMemorySnapshot: string;
  stats: SessionStats;
  busy: boolean;
  stopping?: boolean; // Flag to stop ongoing tool call recursion
  queue: QueueItem[];
  meta: SessionMeta;
  displayName?: string; // User-defined display name for the session
  archived?: boolean; // Whether the session is archived
  currentNode?: string; // Current node ID for tool execution (default: 'master')
  isolated?: boolean; // Whether this session is isolated to its node
  model?: string; // Model key for this session (default: global)
  verbose?: boolean; // Whether to broadcast tool call info (default: false)
  vectorIndexPosition?: number; // Track last indexed message position
  indexingState?: IndexingState; // Track ongoing indexing operation
  historyVersion?: number; // Incremented on compact/clear to detect changes
  nextMessageSeq?: number; // Next per-session sequence number for append-only archive logging
  parentSessionId?: string; // Parent session ID for child sessions
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
