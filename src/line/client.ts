import type { LineMessage } from './types';
import { log } from '../domain/log';

export class LineApiError extends Error {
  constructor(
    readonly status: number,
    readonly body: string,
  ) {
    super(`LINE_API_${status}`);
  }
}

export interface LineClient {
  reply(replyToken: string, messages: LineMessage[]): Promise<void>;
  push(to: string, messages: LineMessage[], retryKey?: string): Promise<void>;
  showLoading(userId: string, seconds: number): Promise<void>;
  displayName(userId: string): Promise<string | null>;
}

/** LINE Messaging API。base は本番では https://api.line.me（手元の確かめでは差し替える） */
export function lineClient(base: string, accessToken: string, fetcher: typeof fetch = fetch): LineClient {
  async function call(method: 'GET' | 'POST', path: string, body?: unknown, headers: Record<string, string> = {}) {
    const res = await fetcher(`${base}${path}`, {
      method,
      headers: { authorization: `Bearer ${accessToken}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    if (!res.ok) throw new LineApiError(res.status, (await res.text()).slice(0, 300));
    return res;
  }
  return {
    async reply(replyToken, messages) {
      await call('POST', '/v2/bot/message/reply', { replyToken, messages: messages.slice(0, 5) });
    },
    async push(to, messages, retryKey) {
      // X-Line-Retry-Key：同じキーの再送は LINE 側で 1 回にまとめられる
      await call('POST', '/v2/bot/message/push', { to, messages: messages.slice(0, 5) }, retryKey ? { 'x-line-retry-key': retryKey } : {});
    },
    async showLoading(userId, seconds) {
      try {
        await call('POST', '/v2/bot/chat/loading/start', { chatId: userId, loadingSeconds: seconds });
      } catch (e) {
        log('warn', 'loading animation failed', { code: e instanceof LineApiError ? e.status : 'network' });
      }
    },
    async displayName(userId) {
      try {
        const res = await call('GET', `/v2/bot/profile/${encodeURIComponent(userId)}`);
        const json = (await res.json()) as { displayName?: string };
        return json.displayName?.slice(0, 40) ?? null;
      } catch {
        return null;
      }
    },
  };
}

/**
 * 返信トークンで返し、期限切れ（AI の処理が長引いた等）のときだけプッシュに切り替える。
 * プッシュには「イベントID＋連番」の再送キーを付け、二重送信を防ぐ。
 */
export async function replyOrPush(
  line: LineClient,
  userId: string,
  replyToken: string | undefined,
  messages: LineMessage[],
  retryKeySeed: string,
): Promise<'reply' | 'push'> {
  if (messages.length === 0) return 'reply';
  if (replyToken) {
    try {
      await line.reply(replyToken, messages);
      return 'reply';
    } catch (e) {
      if (!(e instanceof LineApiError && e.status === 400)) throw e;
      log('warn', 'reply token rejected, falling back to push', { code: e.status });
    }
  }
  await line.push(userId, messages, await retryKeyFor(retryKeySeed));
  return 'push';
}

/** 文字列から UUID 形式の再送キーを作る（同じ入力なら同じキー） */
export async function retryKeyFor(seed: string): Promise<string> {
  const d = new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(seed))).slice(0, 16);
  d[6] = (d[6]! & 0x0f) | 0x40;
  d[8] = (d[8]! & 0x3f) | 0x80;
  const h = [...d].map((b) => b.toString(16).padStart(2, '0')).join('');
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`;
}
