import { Hono } from 'hono';
import { secureHeaders } from 'hono/secure-headers';
import type { Env } from './env';
import { verifyLineSignature } from './line/signature';
import { lineEventSchema, webhookBodySchema } from './line/types';
import { admin } from './admin/routes';
import { expireHolds } from './domain/booking';
import { log } from './domain/log';

export { ChatSession } from './bot/session';

const MAX_BODY = 1_000_000;
const app = new Hono<{ Bindings: Env }>();

app.use('*', secureHeaders({ crossOriginResourcePolicy: 'same-origin' }));
app.use('/api/*', async (c, next) => {
  await next();
  c.header('cache-control', 'no-store');
});

app.post('/webhook', async (c) => {
  const secret = c.env.LINE_CHANNEL_SECRET;
  if (!secret) {
    log('error', 'LINE_CHANNEL_SECRET is not set');
    return c.text('not configured', 500);
  }
  if (Number(c.req.header('content-length') ?? 0) > MAX_BODY) return c.text('too large', 413);
  const raw = await c.req.arrayBuffer();
  if (raw.byteLength > MAX_BODY) return c.text('too large', 413);
  // 署名は「受け取ったバイト列そのもの」で検証する（JSON に直してからでは一致しない）
  if (!(await verifyLineSignature(secret, raw, c.req.header('x-line-signature')))) {
    log('warn', 'invalid signature', { status: 401 });
    return c.text('invalid signature', 401);
  }
  let body: unknown;
  try {
    body = JSON.parse(new TextDecoder().decode(raw));
  } catch {
    return c.text('bad request', 400);
  }
  const parsed = webhookBodySchema.safeParse(body);
  if (!parsed.success) return c.text('bad request', 400);

  let queued = 0;
  for (const raw of parsed.data.events) {
    const event = lineEventSchema.safeParse(raw);
    if (!event.success) continue; // 扱わない種類のイベント
    const e = event.data;
    if (e.source.type !== 'user' || !e.source.userId) continue;
    // 利用者ごとの Durable Object に積む。同じ webhookEventId は 1 つにまとまる
    const stub = c.env.CHAT.get(c.env.CHAT.idFromName(e.source.userId));
    await stub.enqueue(e.webhookEventId, JSON.stringify(e));
    queued++;
  }
  log('info', 'webhook accepted', { count: queued });
  return c.text('ok');
});

app.route('/api/admin', admin);
app.get('/api/health', (c) => c.json({ ok: true }));
app.all('/api/*', (c) => c.json({ error: 'not found' }, 404));

app.onError((err, c) => {
  log('error', 'unhandled', { code: err.message.slice(0, 80) });
  return c.json({ error: 'internal error' }, 500);
});

export default {
  fetch: app.fetch,
  async scheduled(_controller: ScheduledController, env: Env): Promise<void> {
    const now = new Date();
    await expireHolds(env.DB, now);
    await env.DB.prepare('DELETE FROM processed_events WHERE received_at < ?1')
      .bind(new Date(now.getTime() - 7 * 86_400_000).toISOString())
      .run();
  },
} satisfies ExportedHandler<Env>;

export { app };
