// Adapted in part from @tencent-weixin/openclaw-weixin v1.0.2
// Minimal foxwarm-native Weixin protocol types for the MVP text channel.

export const WeixinMessageItemType = {
  NONE: 0,
  TEXT: 1,
  IMAGE: 2,
  VOICE: 3,
  FILE: 4,
  VIDEO: 5,
} as const;

export const WeixinMessageType = {
  NONE: 0,
  USER: 1,
  BOT: 2,
} as const;

export const WeixinMessageState = {
  NEW: 0,
  GENERATING: 1,
  FINISH: 2,
} as const;

export interface WeixinBaseInfo {
  channel_version?: string;
}

export interface WeixinTextItem {
  text?: string;
}

export interface WeixinVoiceItem {
  text?: string;
}

export interface WeixinRefMessage {
  title?: string;
  message_item?: WeixinMessageItem;
}

export interface WeixinMessageItem {
  type?: number;
  text_item?: WeixinTextItem;
  voice_item?: WeixinVoiceItem;
  ref_msg?: WeixinRefMessage;
}

export interface WeixinMessage {
  seq?: number;
  message_id?: number;
  from_user_id?: string;
  to_user_id?: string;
  client_id?: string;
  create_time_ms?: number;
  update_time_ms?: number;
  session_id?: string;
  group_id?: string;
  message_type?: number;
  message_state?: number;
  item_list?: WeixinMessageItem[];
  context_token?: string;
}

export interface WeixinGetUpdatesResponse {
  ret?: number;
  errcode?: number;
  errmsg?: string;
  msgs?: WeixinMessage[];
  get_updates_buf?: string;
  longpolling_timeout_ms?: number;
}

export interface WeixinSendMessageRequest {
  msg?: WeixinMessage;
}

export interface WeixinTypingRequest {
  ilink_user_id?: string;
  typing_ticket?: string;
  status?: number;
}
