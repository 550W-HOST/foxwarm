// Adapted in part from @tencent-weixin/openclaw-weixin v1.0.2
// Minimal foxwarm-native Weixin protocol client for text in/out and QR login.

import crypto from 'crypto';
import fs from 'fs';
import path from 'path';
import { logger } from '../common';
import { BASE_DIR } from '../config';
import { WeixinGetUpdatesResponse, WeixinSendMessageRequest, WeixinTypingRequest } from './types';

export interface WeixinApiOptions {
  baseUrl: string;
  token?: string;
  timeoutMs?: number;
  routeTag?: string;
}

export const DEFAULT_WEIXIN_BASE_URL = 'https://ilinkai.weixin.qq.com';
export const DEFAULT_WEIXIN_LOGIN_BOT_TYPE = '3';
export const SESSION_EXPIRED_ERRCODE = -14;

const DEFAULT_LONG_POLL_TIMEOUT_MS = 35_000;
const DEFAULT_API_TIMEOUT_MS = 15_000;
const DEFAULT_CONFIG_TIMEOUT_MS = 10_000;

function readChannelVersion(): string {
  try {
    const pkgPath = path.resolve(BASE_DIR, 'package.json');
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8')) as { version?: string };
    return pkg.version || 'unknown';
  } catch {
    return 'unknown';
  }
}

const CHANNEL_VERSION = readChannelVersion();

function buildBaseInfo() {
  return { channel_version: CHANNEL_VERSION };
}

function ensureTrailingSlash(url: string): string {
  return url.endsWith('/') ? url : `${url}/`;
}

function randomWechatUin(): string {
  const uint32 = crypto.randomBytes(4).readUInt32BE(0);
  return Buffer.from(String(uint32), 'utf8').toString('base64');
}

function redactToken(token?: string): string | undefined {
  if (!token) return undefined;
  if (token.length <= 8) return '***';
  return `${token.slice(0, 4)}***${token.slice(-4)}`;
}

function buildHeaders(opts: { token?: string; body: string; routeTag?: string }): Record<string, string> {
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    AuthorizationType: 'ilink_bot_token',
    'Content-Length': String(Buffer.byteLength(opts.body, 'utf8')),
    'X-WECHAT-UIN': randomWechatUin(),
  };
  if (opts.token?.trim()) {
    headers.Authorization = `Bearer ${opts.token.trim()}`;
  }
  if (opts.routeTag?.trim()) {
    headers.SKRouteTag = opts.routeTag.trim();
  }
  return headers;
}

async function apiFetch(params: {
  baseUrl: string;
  endpoint: string;
  body: string;
  token?: string;
  timeoutMs: number;
  label: string;
  routeTag?: string;
}): Promise<string> {
  const base = ensureTrailingSlash(params.baseUrl);
  const url = new URL(params.endpoint, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), params.timeoutMs);

  try {
    const res = await fetch(url.toString(), {
      method: 'POST',
      headers: buildHeaders({ token: params.token, body: params.body, routeTag: params.routeTag }),
      body: params.body,
      signal: controller.signal,
    });
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`${params.label} ${res.status}: ${rawText || res.statusText}`);
    }
    return rawText;
  } finally {
    clearTimeout(timer);
  }
}

export async function getWeixinUpdates(params: {
  baseUrl: string;
  token?: string;
  getUpdatesBuf?: string;
  timeoutMs?: number;
  routeTag?: string;
}): Promise<WeixinGetUpdatesResponse> {
  const timeoutMs = params.timeoutMs ?? DEFAULT_LONG_POLL_TIMEOUT_MS;
  try {
    const rawText = await apiFetch({
      baseUrl: params.baseUrl,
      endpoint: 'ilink/bot/getupdates',
      body: JSON.stringify({
        get_updates_buf: params.getUpdatesBuf ?? '',
        base_info: buildBaseInfo(),
      }),
      token: params.token,
      timeoutMs,
      label: 'getUpdates',
      routeTag: params.routeTag,
    });
    return JSON.parse(rawText) as WeixinGetUpdatesResponse;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { ret: 0, msgs: [], get_updates_buf: params.getUpdatesBuf };
    }
    throw err;
  }
}

export async function sendWeixinMessage(params: {
  baseUrl: string;
  token?: string;
  body: WeixinSendMessageRequest;
  timeoutMs?: number;
  routeTag?: string;
}): Promise<void> {
  await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/sendmessage',
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_API_TIMEOUT_MS,
    label: 'sendMessage',
    routeTag: params.routeTag,
  });
}

export async function sendWeixinTyping(params: {
  baseUrl: string;
  token?: string;
  body: WeixinTypingRequest;
  timeoutMs?: number;
  routeTag?: string;
}): Promise<void> {
  await apiFetch({
    baseUrl: params.baseUrl,
    endpoint: 'ilink/bot/sendtyping',
    body: JSON.stringify({ ...params.body, base_info: buildBaseInfo() }),
    token: params.token,
    timeoutMs: params.timeoutMs ?? DEFAULT_CONFIG_TIMEOUT_MS,
    label: 'sendTyping',
    routeTag: params.routeTag,
  });
}

interface WeixinQrCodeResponse {
  qrcode: string;
  qrcode_img_content: string;
}

interface WeixinQrStatusResponse {
  status: 'wait' | 'scaned' | 'confirmed' | 'expired';
  bot_token?: string;
  ilink_bot_id?: string;
  baseurl?: string;
  ilink_user_id?: string;
}

type ActiveLogin = {
  sessionKey: string;
  qrcode: string;
  qrcodeUrl: string;
  startedAt: number;
};

const activeLogins = new Map<string, ActiveLogin>();
const ACTIVE_LOGIN_TTL_MS = 5 * 60_000;
const QR_LONG_POLL_TIMEOUT_MS = 35_000;

function isLoginFresh(login: ActiveLogin): boolean {
  return Date.now() - login.startedAt < ACTIVE_LOGIN_TTL_MS;
}

function purgeExpiredLogins(): void {
  for (const [key, login] of activeLogins.entries()) {
    if (!isLoginFresh(login)) {
      activeLogins.delete(key);
    }
  }
}

async function fetchQrCode(baseUrl: string, botType: string, routeTag?: string): Promise<WeixinQrCodeResponse> {
  const base = ensureTrailingSlash(baseUrl);
  const url = new URL(`ilink/bot/get_bot_qrcode?bot_type=${encodeURIComponent(botType)}`, base);
  const headers: Record<string, string> = {};
  if (routeTag?.trim()) {
    headers.SKRouteTag = routeTag.trim();
  }
  const res = await fetch(url.toString(), { headers });
  if (!res.ok) {
    const body = await res.text().catch(() => '(unreadable)');
    throw new Error(`Failed to fetch QR code: ${res.status} ${body || res.statusText}`);
  }
  return await res.json() as WeixinQrCodeResponse;
}

async function pollQrStatus(baseUrl: string, qrcode: string, routeTag?: string): Promise<WeixinQrStatusResponse> {
  const base = ensureTrailingSlash(baseUrl);
  const url = new URL(`ilink/bot/get_qrcode_status?qrcode=${encodeURIComponent(qrcode)}`, base);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), QR_LONG_POLL_TIMEOUT_MS);
  try {
    const headers: Record<string, string> = {
      'iLink-App-ClientVersion': '1',
    };
    if (routeTag?.trim()) {
      headers.SKRouteTag = routeTag.trim();
    }
    const res = await fetch(url.toString(), { headers, signal: controller.signal });
    const rawText = await res.text();
    if (!res.ok) {
      throw new Error(`Failed to poll QR status: ${res.status} ${rawText || res.statusText}`);
    }
    return JSON.parse(rawText) as WeixinQrStatusResponse;
  } catch (err) {
    if (err instanceof Error && err.name === 'AbortError') {
      return { status: 'wait' };
    }
    throw err;
  } finally {
    clearTimeout(timer);
  }
}

export async function startWeixinQrLogin(params: {
  baseUrl?: string;
  botType?: string;
  sessionKey?: string;
  force?: boolean;
  routeTag?: string;
}): Promise<{ sessionKey: string; qrcodeUrl?: string; message: string }> {
  const baseUrl = params.baseUrl?.trim() || DEFAULT_WEIXIN_BASE_URL;
  const botType = params.botType?.trim() || DEFAULT_WEIXIN_LOGIN_BOT_TYPE;
  const sessionKey = params.sessionKey?.trim() || crypto.randomUUID();

  purgeExpiredLogins();
  const existing = activeLogins.get(sessionKey);
  if (!params.force && existing && isLoginFresh(existing)) {
    return {
      sessionKey,
      qrcodeUrl: existing.qrcodeUrl,
      message: '二维码已就绪，请使用微信扫描。',
    };
  }

  const qr = await fetchQrCode(baseUrl, botType, params.routeTag);
  activeLogins.set(sessionKey, {
    sessionKey,
    qrcode: qr.qrcode,
    qrcodeUrl: qr.qrcode_img_content,
    startedAt: Date.now(),
  });

  logger.info({ baseUrl, botType, sessionKey }, 'Weixin QR login started');
  return {
    sessionKey,
    qrcodeUrl: qr.qrcode_img_content,
    message: '使用微信扫描二维码后，再执行 /weixin wait <sessionKey> 完成登录。',
  };
}

export async function waitForWeixinQrLogin(params: {
  sessionKey: string;
  baseUrl?: string;
  timeoutMs?: number;
  routeTag?: string;
}): Promise<{ connected: boolean; botToken?: string; userId?: string; baseUrl?: string; message: string }> {
  const baseUrl = params.baseUrl?.trim() || DEFAULT_WEIXIN_BASE_URL;
  const timeoutMs = Math.max(params.timeoutMs ?? 60_000, 1_000);
  const login = activeLogins.get(params.sessionKey);
  if (!login) {
    return { connected: false, message: '当前没有进行中的登录，请先执行 /weixin login。' };
  }
  if (!isLoginFresh(login)) {
    activeLogins.delete(params.sessionKey);
    return { connected: false, message: '二维码已过期，请重新执行 /weixin login。' };
  }

  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const status = await pollQrStatus(baseUrl, login.qrcode, params.routeTag);
    if (status.status === 'confirmed' && status.bot_token) {
      activeLogins.delete(params.sessionKey);
      logger.info({ sessionKey: params.sessionKey, userId: status.ilink_user_id, token: redactToken(status.bot_token) }, 'Weixin QR login confirmed');
      return {
        connected: true,
        botToken: status.bot_token,
        userId: status.ilink_user_id,
        baseUrl: status.baseurl || baseUrl,
        message: '微信登录成功。',
      };
    }
    if (status.status === 'expired') {
      activeLogins.delete(params.sessionKey);
      return { connected: false, message: '二维码已过期，请重新执行 /weixin login。' };
    }
    await new Promise((resolve) => setTimeout(resolve, 1_000));
  }

  return {
    connected: false,
    message: '登录仍未完成，请稍后重试 /weixin wait <sessionKey>。',
  };
}
