import { env } from 'cloudflare:test';
import type { LineClient } from '../src/line/client';
import { LineApiError } from '../src/line/client';
import type { LineMessage } from '../src/line/types';
import type { ChatModel, ContentBlock, ModelRequest } from '../src/ai/model';
import { DEMO_SHOP, saveShop, type ShopInfo } from '../src/domain/shop';
import { fromJstLocal } from '../src/domain/time';
import { lineEventSchema, type LineEvent } from '../src/line/types';

/** 試験の「今」：2026-11-04（水）10:12 日本時間・営業中 */
export const NOW = fromJstLocal('2026-11-04T10:12');
export const at = (local: string) => fromJstLocal(local);

export async function seedShop(shop: ShopInfo = DEMO_SHOP) {
  await saveShop(env.DB, shop, NOW);
  return shop;
}

export interface SentRecord {
  kind: 'reply' | 'push';
  to?: string;
  token?: string;
  retryKey?: string;
  messages: LineMessage[];
}

export function fakeLine(opts: { replyFails?: boolean; names?: Record<string, string> } = {}) {
  const sent: SentRecord[] = [];
  const loading: string[] = [];
  const client: LineClient = {
    async reply(token, messages) {
      if (opts.replyFails) throw new LineApiError(400, '{"message":"Invalid reply token"}');
      sent.push({ kind: 'reply', token, messages });
    },
    async push(to, messages, retryKey) {
      sent.push({ kind: 'push', to, messages, retryKey });
    },
    async showLoading(userId) {
      loading.push(userId);
    },
    async displayName(userId) {
      return opts.names?.[userId] ?? 'テスト 太郎';
    },
  };
  return { client, sent, loading };
}

type Step = ContentBlock[] | ((req: ModelRequest) => ContentBlock[]);

/** 筋書きどおりに返す AI。呼ばれた内容（system・messages）も記録する */
export function scriptedModel(steps: Step[]): ChatModel & { requests: ModelRequest[] } {
  const requests: ModelRequest[] = [];
  let i = 0;
  return {
    id: 'scripted',
    requests,
    async create(req) {
      requests.push(structuredClone(req));
      const step = steps[Math.min(i++, steps.length - 1)]!;
      const content = typeof step === 'function' ? step(req) : step;
      return { content, stop_reason: content.some((b) => b.type === 'tool_use') ? 'tool_use' : 'end_turn' };
    },
  };
}

let toolSeq = 0;
export const say = (text: string): ContentBlock => ({ type: 'text', text, citations: null }) as ContentBlock;
export const call = (name: string, input: Record<string, unknown>): ContentBlock =>
  ({ type: 'tool_use', id: `toolu_${++toolSeq}`, name, input }) as ContentBlock;

let eventSeq = 0;
function baseEvent(userId: string, ts: Date) {
  return {
    webhookEventId: `01TESTEVENT${String(++eventSeq).padStart(10, '0')}`,
    timestamp: ts.getTime(),
    source: { type: 'user', userId },
    deliveryContext: { isRedelivery: false },
    mode: 'active',
  };
}
export function textEvent(userId: string, text: string, ts = NOW): LineEvent {
  return lineEventSchema.parse({
    ...baseEvent(userId, ts),
    type: 'message',
    replyToken: `rt-${eventSeq}`,
    message: { type: 'text', id: `m${eventSeq}`, text },
  });
}
export function postbackEvent(userId: string, data: string, ts = NOW): LineEvent {
  return lineEventSchema.parse({ ...baseEvent(userId, ts), type: 'postback', replyToken: `rt-${eventSeq}`, postback: { data } });
}
export function followEvent(userId: string, ts = NOW): LineEvent {
  return lineEventSchema.parse({ ...baseEvent(userId, ts), type: 'follow', replyToken: `rt-${eventSeq}` });
}

export function textsOf(sent: SentRecord[]): string[] {
  return sent.flatMap((s) => s.messages.map((m) => (m.type === 'text' ? m.text : `[flex] ${m.altText}`)));
}

/** 同じ席で時間が重なる有効な予約の組（0 であるべき） */
export async function overlappingPairs(now: Date = NOW): Promise<number> {
  const row = await env.DB.prepare(
    `SELECT COUNT(*) AS n FROM bookings a JOIN bookings b
       ON a.id < b.id AND a.seat = b.seat AND a.start_at < b.end_at AND b.start_at < a.end_at
     WHERE a.status IN ('held','confirmed') AND b.status IN ('held','confirmed')
       AND (a.status = 'confirmed' OR a.hold_expires_at > ?1) AND (b.status = 'confirmed' OR b.hold_expires_at > ?1)`,
  )
    .bind(now.toISOString())
    .first<{ n: number }>();
  return row?.n ?? 0;
}
