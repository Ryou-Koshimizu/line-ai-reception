import { exports } from 'cloudflare:workers';
import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { DEMO_SHOP } from '../src/domain/shop';
import { ensureConversation } from '../src/domain/conversation';
import { NOW, seedShop } from './helpers';

const OWNER = 'owner-token-0123456789abcdef';
const STAFF = 'staff-token-0123456789abcdef';

function api(path: string, init: RequestInit & { token?: string } = {}) {
  const headers = new Headers(init.headers);
  if (init.token) headers.set('authorization', `Bearer ${init.token}`);
  if (init.body) headers.set('content-type', 'application/json');
  return exports.default.fetch(new Request(`https://bot.test/api/admin${path}`, { ...init, headers }));
}

afterEach(() => vi.restoreAllMocks());

describe('管理 API の権限', () => {
  it('鍵がない・違う・形が崩れた鍵は 401', async () => {
    expect((await api('/bookings?from=2026-11-01&to=2026-11-07')).status).toBe(401);
    expect((await api('/bookings?from=2026-11-01&to=2026-11-07', { token: 'nope' })).status).toBe(401);
    expect((await api('/bookings?from=2026-11-01&to=2026-11-07', { token: `${OWNER}x` })).status).toBe(401);
    const res = await exports.default.fetch(new Request('https://bot.test/api/admin/me', { headers: { authorization: OWNER } }));
    expect(res.status).toBe(401);
  });

  it('スタッフの鍵は予約と会話を扱えるが、店の情報は編集できない（403）', async () => {
    await seedShop();
    expect(await (await api('/me', { token: STAFF })).json()).toEqual({ role: 'staff' });
    expect((await api('/bookings?from=2026-11-01&to=2026-11-07', { token: STAFF })).status).toBe(200);
    expect((await api('/shop', { token: STAFF, method: 'PUT', body: JSON.stringify(DEMO_SHOP) })).status).toBe(403);
    expect((await api('/shop', { token: OWNER, method: 'PUT', body: JSON.stringify({ ...DEMO_SHOP, name: '新しい名前' }) })).status).toBe(
      200,
    );
    const shop = (await (await api('/shop', { token: STAFF })).json()) as { shop: { name: string } };
    expect(shop.shop.name).toBe('新しい名前');
  });

  it('店の情報の誤り（閉店が開店より前・ID の重複）は 400 で理由を返す', async () => {
    const bad = {
      ...DEMO_SHOP,
      hours: { ...DEMO_SHOP.hours, mon: { open: '19:00', close: '10:00' } },
      menus: [DEMO_SHOP.menus[0], DEMO_SHOP.menus[0]],
    };
    const res = await api('/shop', { token: OWNER, method: 'PUT', body: JSON.stringify(bad) });
    expect(res.status).toBe(400);
    const json = (await res.json()) as { issues: Array<{ message: string }> };
    expect(json.issues.map((i) => i.message).join()).toContain('閉店は開店より後');
  });

  it('電話の予約を入れられ、同じ枠が埋まっていれば 409', async () => {
    await seedShop();
    const body = JSON.stringify({ customerName: '電話のお客様', menuId: 'cut', start: '2026-11-06T14:00' });
    expect((await api('/bookings', { token: STAFF, method: 'POST', body })).status).toBe(201);
    expect((await api('/bookings', { token: STAFF, method: 'POST', body })).status).toBe(201);
    expect((await api('/bookings', { token: STAFF, method: 'POST', body })).status).toBe(409);
    const list = (await (await api('/bookings?from=2026-11-06&to=2026-11-06', { token: STAFF })).json()) as { bookings: unknown[] };
    expect(list.bookings).toHaveLength(2);
  });

  it('期間の指定が崩れていれば 400', async () => {
    expect((await api('/bookings?from=2026-11-06&to=2026-01-01', { token: STAFF })).status).toBe(400);
    expect((await api('/bookings?from=x&to=y', { token: STAFF })).status).toBe(400);
  });
});

describe('会話の引き取り', () => {
  it('「人が引き取る」に切り替えてから返信でき、AI のままでは返信できない（409）', async () => {
    await ensureConversation(env.DB, 'U1', 'さくら', NOW);
    const fetchSpy = vi.spyOn(globalThis, 'fetch').mockImplementation(async () => new Response('{}', { status: 200 }));
    const reply = (id: string) =>
      api('/conversations/U1/reply', { token: STAFF, method: 'POST', body: JSON.stringify({ text: 'スタッフの田中です', requestId: id }) });
    expect((await reply(crypto.randomUUID())).status).toBe(409);
    expect((await api('/conversations/U1/mode', { token: STAFF, method: 'POST', body: JSON.stringify({ mode: 'human' }) })).status).toBe(
      200,
    );
    const id = crypto.randomUUID();
    expect((await reply(id)).status).toBe(200);
    const push = fetchSpy.mock.calls.find(([url]) => String(url).endsWith('/v2/bot/message/push'))!;
    expect(new Headers(push[1]!.headers).get('x-line-retry-key')).toMatch(/^[0-9a-f-]{36}$/);
    const msgs = (await (await api('/conversations/U1/messages', { token: STAFF })).json()) as { messages: Array<{ role: string }> };
    expect(msgs.messages.map((m) => m.role)).toEqual(['system', 'staff']);
    expect(
      (await api('/conversations/nobody/mode', { token: STAFF, method: 'POST', body: JSON.stringify({ mode: 'human' }) })).status,
    ).toBe(404);
  });
});
