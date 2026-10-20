import { env, runDurableObjectAlarm } from 'cloudflare:test';
import { exports } from 'cloudflare:workers';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { signLineBody } from '../src/line/signature';
import { seedShop } from './helpers';

const SECRET = 'test-channel-secret-0123456789';

function body(events: unknown[]) {
  return JSON.stringify({ destination: 'Ubot', events });
}
function textEvent(id: string, userId: string, text: string) {
  return {
    type: 'message',
    webhookEventId: id,
    timestamp: Date.now(),
    source: { type: 'user', userId },
    deliveryContext: { isRedelivery: false },
    mode: 'active',
    replyToken: `rt-${id}`,
    message: { type: 'text', id: `m-${id}`, text },
  };
}
async function post(raw: string, signature?: string | null) {
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (signature !== null) headers['x-line-signature'] = signature ?? (await signLineBody(SECRET, raw));
  return exports.default.fetch(new Request('https://bot.test/webhook', { method: 'POST', headers, body: raw }));
}
const stubFor = (userId: string) => env.CHAT.get(env.CHAT.idFromName(userId));

afterEach(() => vi.restoreAllMocks());

describe('POST /webhook', () => {
  it('署名なし・不正な署名は 401、正しい署名は 200', async () => {
    const raw = body([]);
    expect((await post(raw, null)).status).toBe(401);
    expect((await post(raw, await signLineBody('wrong-secret', raw))).status).toBe(401);
    expect((await post(raw)).status).toBe(200); // LINE の「検証」ボタン（events が空）
  });

  it('署名は正しいが JSON が壊れていれば 400', async () => {
    expect((await post('{"events":')).status).toBe(400);
  });

  it('同じイベントが 3 回届いても、積むのは 1 件・返事も 1 通', async () => {
    await seedShop();
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }));
    const raw = body([textEvent('EV-DUP-1', 'U-dup', 'こんにちは')]);
    for (let i = 0; i < 3; i++) expect((await post(raw)).status).toBe(200);
    const stub = stubFor('U-dup');
    expect(await stub.pending()).toBe(1);
    await runDurableObjectAlarm(stub);
    expect(await stub.pending()).toBe(0);
    const replies = fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/v2/bot/message/reply'));
    expect(replies).toHaveLength(1);
    // 処理済みの記録が残り、後から同じ ID が来ても処理しない
    expect((await post(raw)).status).toBe(200);
    await runDurableObjectAlarm(stub);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).endsWith('/v2/bot/message/reply'))).toHaveLength(1);
  });

  it('同じ人の複数のメッセージは届いた順に処理する', async () => {
    await seedShop();
    const order: string[] = [];
    vi.spyOn(globalThis, 'fetch').mockImplementation(async (_url, init) => {
      const text = (init?.body as string | undefined) ?? '';
      if (text.includes('replyToken')) order.push(JSON.parse(text).replyToken);
      return new Response('{}', { status: 200 });
    });
    await post(body([textEvent('EV-A', 'U-order', '1'), textEvent('EV-B', 'U-order', '2')]));
    await post(body([textEvent('EV-C', 'U-order', '3')]));
    await runDurableObjectAlarm(stubFor('U-order'));
    expect(order).toEqual(['rt-EV-A', 'rt-EV-B', 'rt-EV-C']);
  });

  it('グループのイベントや知らない種類のイベントは読み飛ばす', async () => {
    const raw = body([
      { ...textEvent('EV-G', 'U-g', 'hi'), source: { type: 'group', groupId: 'G1', userId: 'U-g' } },
      { type: 'beacon', webhookEventId: 'EV-X', timestamp: 0, source: { type: 'user', userId: 'U-x' } },
    ]);
    expect((await post(raw)).status).toBe(200);
    expect(await stubFor('U-g').pending()).toBe(0);
  });

  it('1MB を超える本文は受け取らない', async () => {
    const big = body([textEvent('EV-BIG', 'U-big', 'x'.repeat(1_100_000))]);
    expect((await post(big)).status).toBe(413);
  });
});
