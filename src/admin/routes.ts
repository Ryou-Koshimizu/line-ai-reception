import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../env';
import { requireRole, type Role } from './auth';
import { DEMO_SHOP, loadShop, saveShop, shopSchema } from '../domain/shop';
import { BookingError, addStaffBooking, cancelBooking, listBookings } from '../domain/booking';
import { appendMessage, getConversation, listConversations, markRead, recentMessages, setMode } from '../domain/conversation';
import { lineClient, retryKeyFor } from '../line/client';
import { text } from '../line/messages';
import { addDays, toJstLocal } from '../domain/time';

type App = { Bindings: Env; Variables: { role: Role } };
export const admin = new Hono<App>();

const anyone = requireRole('owner', 'staff');
const ownerOnly = requireRole('owner');
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

admin.get('/me', anyone, (c) => c.json({ role: c.get('role') }));

admin.get('/shop', anyone, async (c) => {
  const shop = await loadShop(c.env.DB);
  return c.json({ shop, configured: !!shop, template: shop ? null : DEMO_SHOP });
});

admin.put('/shop', ownerOnly, async (c) => {
  const body = await c.req.json().catch(() => null);
  const parsed = shopSchema.safeParse(body);
  if (!parsed.success)
    return c.json(
      {
        error: '入力に誤りがあります',
        issues: parsed.error.issues.slice(0, 10).map((i) => ({ path: i.path.join('.'), message: i.message })),
      },
      400,
    );
  await saveShop(c.env.DB, parsed.data, new Date());
  return c.json({ shop: parsed.data });
});

admin.get('/bookings', anyone, async (c) => {
  const from = ymd.safeParse(c.req.query('from'));
  const to = ymd.safeParse(c.req.query('to'));
  if (!from.success || !to.success || to.data < from.data || to.data > addDays(from.data, 62))
    return c.json({ error: 'from / to は YYYY-MM-DD で、62 日以内にしてください' }, 400);
  const bookings = await listBookings(c.env.DB, `${from.data}T00:00`, `${addDays(to.data, 1)}T00:00`);
  return c.json({ bookings });
});

const staffBooking = z.object({
  customerName: z.string().trim().min(1).max(40),
  menuId: z.string().max(32),
  start: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/),
});

admin.post('/bookings', anyone, async (c) => {
  const parsed = staffBooking.safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: '入力に誤りがあります' }, 400);
  const shop = await loadShop(c.env.DB);
  if (!shop) return c.json({ error: '先に店の情報を登録してください' }, 409);
  try {
    const booking = await addStaffBooking(c.env.DB, shop, parsed.data, new Date());
    return c.json({ booking }, 201);
  } catch (e) {
    if (e instanceof BookingError) return c.json({ error: e.code }, e.code === 'TAKEN' ? 409 : 400);
    throw e;
  }
});

admin.post('/bookings/:id/cancel', anyone, async (c) => {
  const shop = await loadShop(c.env.DB);
  if (!shop) return c.json({ error: '先に店の情報を登録してください' }, 409);
  try {
    const booking = await cancelBooking(c.env.DB, shop, 'staff', c.req.param('id'), new Date());
    return c.json({ booking });
  } catch (e) {
    if (e instanceof BookingError) return c.json({ error: e.code }, 404);
    throw e;
  }
});

admin.get('/conversations', anyone, async (c) => c.json({ conversations: await listConversations(c.env.DB) }));

admin.get('/conversations/:userId/messages', anyone, async (c) => {
  const userId = c.req.param('userId');
  if (!(await getConversation(c.env.DB, userId))) return c.json({ error: '会話が見つかりません' }, 404);
  await markRead(c.env.DB, userId);
  return c.json({ messages: await recentMessages(c.env.DB, userId, 100) });
});

admin.post('/conversations/:userId/mode', anyone, async (c) => {
  const parsed = z.object({ mode: z.enum(['ai', 'human']) }).safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: 'mode は ai か human です' }, 400);
  const userId = c.req.param('userId');
  const ok = await setMode(c.env.DB, userId, parsed.data.mode, parsed.data.mode === 'human' ? 'スタッフが管理画面で引き取り' : null);
  if (!ok) return c.json({ error: '会話が見つかりません' }, 404);
  await appendMessage(
    c.env.DB,
    userId,
    'system',
    parsed.data.mode === 'human' ? 'スタッフが会話を引き取りました' : 'AI の受付に戻しました',
    new Date(),
  );
  return c.json({ mode: parsed.data.mode });
});

admin.post('/conversations/:userId/reply', anyone, async (c) => {
  const parsed = z
    .object({ text: z.string().trim().min(1).max(2000), requestId: z.string().uuid() })
    .safeParse(await c.req.json().catch(() => null));
  if (!parsed.success) return c.json({ error: '本文と requestId（UUID）が必要です' }, 400);
  const userId = c.req.param('userId');
  const conv = await getConversation(c.env.DB, userId);
  if (!conv) return c.json({ error: '会話が見つかりません' }, 404);
  if (conv.mode !== 'human') return c.json({ error: '先に「人が引き取る」に切り替えてください' }, 409);
  const line = lineClient(c.env.LINE_API_BASE, c.env.LINE_CHANNEL_ACCESS_TOKEN ?? '');
  // 画面で 2 回押されても、同じ requestId なら LINE 側で 1 通にまとまる
  await line.push(userId, [text(parsed.data.text)], await retryKeyFor(`staff-reply:${parsed.data.requestId}`));
  await appendMessage(c.env.DB, userId, 'staff', parsed.data.text, new Date());
  return c.json({ ok: true });
});

admin.get('/stats', anyone, async (c) => {
  const today = toJstLocal(new Date()).slice(0, 10);
  const db = c.env.DB;
  const [todayCount, weekCount, human, aiReplies] = await Promise.all([
    db
      .prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed' AND start_at >= ?1 AND start_at < ?2")
      .bind(`${today}T00:00`, `${addDays(today, 1)}T00:00`)
      .first<{ n: number }>(),
    db
      .prepare("SELECT COUNT(*) AS n FROM bookings WHERE status = 'confirmed' AND start_at >= ?1 AND start_at < ?2")
      .bind(`${today}T00:00`, `${addDays(today, 7)}T00:00`)
      .first<{ n: number }>(),
    db.prepare("SELECT COUNT(*) AS n FROM conversations WHERE mode = 'human'").first<{ n: number }>(),
    db
      .prepare("SELECT COUNT(*) AS n FROM messages WHERE role = 'assistant' AND created_at >= ?1")
      .bind(new Date(Date.now() - 7 * 86_400_000).toISOString())
      .first<{ n: number }>(),
  ]);
  return c.json({ today: todayCount?.n ?? 0, week: weekCount?.n ?? 0, handoff: human?.n ?? 0, aiReplies: aiReplies?.n ?? 0 });
});
