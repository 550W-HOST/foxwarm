// Adapted in part from @tencent-weixin/openclaw-weixin v1.0.2
// foxwarm-native inbound helpers for the MVP Weixin channel.

import { MessagePart } from '../types';
import { WeixinMessage, WeixinMessageItem, WeixinMessageItemType } from './types';

const contextTokenStore = new Map<string, string>();

function contextTokenKey(userId: string): string {
  return userId;
}

export function setWeixinContextToken(userId: string, token: string): void {
  contextTokenStore.set(contextTokenKey(userId), token);
}

export function getWeixinContextToken(userId: string): string | undefined {
  return contextTokenStore.get(contextTokenKey(userId));
}

function isMediaItem(item: WeixinMessageItem): boolean {
  return item.type === WeixinMessageItemType.IMAGE
    || item.type === WeixinMessageItemType.VIDEO
    || item.type === WeixinMessageItemType.FILE
    || item.type === WeixinMessageItemType.VOICE;
}

function bodyFromItemList(itemList?: WeixinMessageItem[]): string {
  if (!itemList?.length) return '';
  for (const item of itemList) {
    if (item.type === WeixinMessageItemType.TEXT && item.text_item?.text != null) {
      const text = String(item.text_item.text);
      const ref = item.ref_msg;
      if (!ref) return text;
      if (ref.message_item && isMediaItem(ref.message_item)) return text;
      const parts: string[] = [];
      if (ref.title) parts.push(ref.title);
      if (ref.message_item) {
        const refBody = bodyFromItemList([ref.message_item]);
        if (refBody) parts.push(refBody);
      }
      return parts.length > 0 ? `[引用: ${parts.join(' | ')}]\n${text}` : text;
    }
    if (item.type === WeixinMessageItemType.VOICE && item.voice_item?.text) {
      return item.voice_item.text;
    }
  }
  return '';
}

export function buildWeixinMessageParts(message: WeixinMessage): MessagePart[] {
  const text = bodyFromItemList(message.item_list);
  if (text) {
    return [{ text }];
  }

  const mediaType = message.item_list?.find(item => isMediaItem(item))?.type;
  if (mediaType === WeixinMessageItemType.IMAGE) {
    return [{ text: '[Weixin image message received. Media handling is not supported in this MVP yet.]' }];
  }
  if (mediaType === WeixinMessageItemType.VIDEO) {
    return [{ text: '[Weixin video message received. Media handling is not supported in this MVP yet.]' }];
  }
  if (mediaType === WeixinMessageItemType.FILE) {
    return [{ text: '[Weixin file message received. File handling is not supported in this MVP yet.]' }];
  }
  if (mediaType === WeixinMessageItemType.VOICE) {
    return [{ text: '[Weixin voice message received. Voice handling is not supported in this MVP yet.]' }];
  }

  return [{ text: '[Weixin unsupported message received.]' }];
}
