// 実機の確かめ：wrangler dev（workerd ＋ ローカル D1 ＋ Durable Objects）に、署名付きの LINE Webhook を実際に送る。
// AI は実際に推論する（Codex CLI 経由・既定 gpt-6.1-sol）。LINE への返信は 127.0.0.1:3106 の受け口が記録する。
//
//   npm run build:web && npm run check:live
//
// 結果：docs/evidence/live-check.json（数字と判定）、web/src/demo/recordings.json（公開デモが再生する会話の記録）
import { spawn, execFileSync, type ChildProcess } from 'node:child_process';
import { createHmac, randomBytes } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync, createWriteStream, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge, type LineCall } from './live/bridge';
import { DEMO_SHOP } from '../src/domain/shop';
import { SCENARIOS, STAFF_BOOKINGS, OTHER_CUSTOMER_NAMES, FAMILY_PRELUDE, type Scenario, type Turn, type Check } from './live/scenarios';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = join(ROOT, '.wrangler', 'live-check');
const WORKER = 'http://127.0.0.1:8787';
const BRIDGE_PORT = 3106;
const MODEL = process.env.LIVE_MODEL ?? 'gpt-6.1-sol';
const EFFORT = process.env.LIVE_EFFORT ?? 'low';
const PARALLEL = Number(process.env.LIVE_PARALLEL ?? 3);
const ONLY = process.env.LIVE_ONLY?.split(',');
const SECRET = `live-${randomBytes(16).toString('hex')}`;
const ADMIN = randomBytes(24).toString('hex');
const STAFF = randomBytes(24).toString('hex');
const FALLBACK = 'このご用件は、下のボタンから選ぶか「スタッフに相談」と送ってください。';

const names: Record<string, string> = Object.fromEntries([...SCENARIOS, FAMILY_PRELUDE].map((s) => [s.user, s.name]));
for (let i = 0; i < 30; i++) names[`U-race-${i}`] = `同時予約${i + 1}`;
names['U-dedupe'] = '再送テスト';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const jst = (local: string) => new Date(`${local}:00+09:00`);

let seq = 0;
function eventFor(userId: string, turn: Pick<Turn, 'say' | 'data' | 'follow'>, at: Date, id?: string) {
  const webhookEventId = id ?? `LIVE${Date.now().toString(36).toUpperCase()}${String(++seq).padStart(5, '0')}`;
  const base = {
    webhookEventId,
    timestamp: at.getTime(),
    source: { type: 'user', userId },
    deliveryContext: { isRedelivery: false },
    mode: 'active',
    replyToken: `rt-${webhookEventId}`,
  };
  if (turn.follow) return { ...base, type: 'follow' };
  if (turn.data) return { ...base, type: 'postback', postback: { data: turn.data } };
  return { ...base, type: 'message', message: { type: 'text', id: `m${seq}`, quoteToken: 'q', text: turn.say } };
}

function sign(body: string, secret = SECRET) {
  return createHmac('sha256', secret).update(body).digest('base64');
}

async function postWebhook(events: unknown[], opts: { signature?: string | null; rawBody?: string } = {}) {
  const body = opts.rawBody ?? JSON.stringify({ destination: 'Ulivecheck', events });
  const headers: Record<string, string> = { 'content-type': 'application/json' };
  if (opts.signature !== null) headers['x-line-signature'] = opts.signature ?? sign(body);
  const res = await fetch(`${WORKER}/webhook`, { method: 'POST', headers, body });
  return res.status;
}

async function adminGet<T>(path: string): Promise<T> {
  const res = await fetch(`${WORKER}/api/admin${path}`, { headers: { authorization: `Bearer ${ADMIN}` } });
  if (!res.ok) throw new Error(`admin ${path} ${res.status}`);
  return (await res.json()) as T;
}
async function adminSend(method: string, path: string, body: unknown) {
  const res = await fetch(`${WORKER}/api/admin${path}`, {
    method,
    headers: { authorization: `Bearer ${ADMIN}`, 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
  if (!res.ok) throw new Error(`admin ${method} ${path} ${res.status} ${await res.text()}`);
  return res.json();
}

function d1(sql: string): Array<Record<string, unknown>> {
  const out = execFileSync(
    process.execPath,
    [
      join(ROOT, 'node_modules/wrangler/bin/wrangler.js'),
      'd1',
      'execute',
      'DB',
      '--local',
      '--persist-to',
      STATE,
      '--json',
      '--command',
      sql,
    ],
    { cwd: ROOT, encoding: 'utf8', env: { ...process.env, CI: '1' } },
  );
  return JSON.parse(out)[0].results;
}

type Booking = {
  id: string;
  line_user_id: string | null;
  customer_name: string;
  menu_id: string;
  menu_name: string;
  start_at: string;
  end_at: string;
  seat: number;
  status: string;
};

export interface Ctx {
  bridge: Awaited<ReturnType<typeof startBridge>>;
}

async function waitFor<T>(fn: () => T | undefined | Promise<T | undefined>, timeoutMs: number, label: string): Promise<T> {
  const until = Date.now() + timeoutMs;
  for (;;) {
    const v = await fn();
    if (v !== undefined) return v;
    if (Date.now() > until) throw new Error(`timeout: ${label}`);
    await sleep(250);
  }
}

function repliesFor(ctx: Ctx, replyToken: string, userId: string, after: number): LineCall[] {
  return ctx.bridge.lineCalls.filter(
    (c) => (c.kind === 'reply' && c.replyToken === replyToken) || (c.kind === 'push' && c.to === userId && c.at >= after),
  );
}

/** 直前の返事の中から、ラベル（または正規表現）に合うボタンの postback data を探す */
function findButton(messages: unknown[], label: string | RegExp, byData = false): string | undefined {
  let found: string | undefined;
  const walk = (node: unknown) => {
    if (found || !node || typeof node !== 'object') return;
    const n = node as Record<string, unknown>;
    if (n.type === 'postback' && typeof n.label === 'string' && typeof n.data === 'string') {
      // data で探すときは「&」で区切った項目のどれかと完全一致（部分一致で別の時刻を拾わない）
      const hit = byData
        ? typeof label === 'string' && n.data.split('&').includes(label)
        : typeof label === 'string'
          ? n.label === label
          : label.test(n.label);
      if (hit) found = n.data;
    }
    for (const v of Object.values(n)) {
      if (Array.isArray(v)) v.forEach(walk);
      else if (typeof v === 'object') walk(v);
    }
  };
  messages.forEach(walk);
  return found;
}

export function textOf(messages: unknown[]): string {
  return (messages as Array<{ type: string; text?: string; altText?: string }>)
    .map((m) => (m.type === 'text' ? m.text : `［カード］${m.altText}`))
    .join('\n');
}

interface ToolUse {
  name: string;
  input: unknown;
  ok: boolean;
}
function toolsBetween(ctx: Ctx, name: string, from: number, to: number): ToolUse[] {
  const calls = ctx.bridge.modelCalls.filter((c) => c.displayName === name && c.at >= from && c.at <= to);
  const uses: ToolUse[] = [];
  for (const [i, c] of calls.entries()) {
    for (const block of c.response.content as Array<{ type: string; name?: string; input?: unknown; id?: string }>) {
      if (block.type !== 'tool_use') continue;
      const next = calls[i + 1];
      const lastMsg = (next?.request.messages.at(-1) ?? { content: [] }) as {
        content: Array<{ type: string; tool_use_id?: string; is_error?: boolean }>;
      };
      const result = Array.isArray(lastMsg.content)
        ? lastMsg.content.find((b) => b.type === 'tool_result' && b.tool_use_id === block.id)
        : undefined;
      uses.push({ name: block.name!, input: block.input, ok: !!result && !result.is_error });
    }
  }
  return uses;
}

export interface TurnRecord {
  at: string;
  user: { text?: string; tap?: string; data?: string; follow?: boolean };
  bot: unknown[];
  tools: ToolUse[];
  ms: number;
  prelude?: boolean;
  snapshot: { bookings: Booking[]; mode: string };
}

async function snapshot(userId: string) {
  const { bookings } = await adminGet<{ bookings: Booking[] }>('/bookings?from=2026-11-02&to=2026-11-15');
  const { conversations } = await adminGet<{ conversations: Array<{ line_user_id: string; mode: string }> }>('/conversations');
  return { bookings, mode: conversations.find((c) => c.line_user_id === userId)?.mode ?? 'ai' };
}

async function runTurn(ctx: Ctx, s: Scenario, turn: Turn, prev: unknown[], prelude = false): Promise<TurnRecord> {
  let data = turn.data;
  let tapLabel: string | undefined;
  if (turn.tap || turn.tapData) {
    data = turn.tapData ? findButton(prev, turn.tapData, true) : findButton(prev, turn.tap!);
    tapLabel = typeof turn.tap === 'string' ? turn.tap : undefined;
    if (!data) throw new Error(`${s.id}: ボタン「${String(turn.tap ?? turn.tapData)}」が見つかりません`);
    const m = /[?&]?s=([^&]+)/.exec(data);
    if (!tapLabel && m) tapLabel = decodeURIComponent(m[1]!).slice(11);
  }
  const at = jst(turn.at);
  const ev = eventFor(s.user, { say: turn.say, data, follow: turn.follow }, at);
  const sentAt = Date.now();
  const status = await postWebhook([ev]);
  if (status !== 200) throw new Error(`${s.id}: webhook ${status}`);
  let bot: unknown[] = [];
  if (turn.expectReply === false) {
    await sleep(6000);
    const got = repliesFor(ctx, ev.replyToken, s.user, sentAt);
    bot = got.flatMap((g) => g.messages ?? []);
  } else {
    const got = await waitFor(
      () => {
        const r = repliesFor(ctx, ev.replyToken, s.user, sentAt);
        return r.length ? r : undefined;
      },
      240_000,
      `${s.id} reply`,
    );
    await sleep(300);
    bot = got.flatMap((g) => g.messages ?? []);
  }
  const ms = Date.now() - sentAt;
  return {
    at: turn.at,
    user: turn.follow
      ? { follow: true }
      : turn.say
        ? { text: turn.say }
        : { tap: tapLabel ?? turn.label ?? String(turn.tap ?? data), data },
    bot,
    tools: toolsBetween(ctx, s.name, sentAt, Date.now()),
    ms,
    ...(prelude ? { prelude: true } : {}),
    snapshot: await snapshot(s.user),
  };
}

async function runScenario(ctx: Ctx, s: Scenario) {
  const records: TurnRecord[] = [];
  let prev: unknown[] = [];
  for (const t of s.prelude ?? []) {
    const r = await runTurn(ctx, s, t, prev, true);
    records.push(r);
    prev = r.bot;
  }
  for (const t of s.turns) {
    // すでにスタッフが引き取っている会話には AI は返事をしない（前の通で引き継ぎ済みなら、返事を待たない）
    const mode = records.at(-1)?.snapshot.mode;
    const r = await runTurn(ctx, s, mode === 'human' ? { ...t, expectReply: false } : t, prev);
    records.push(r);
    prev = r.bot;
  }
  const { bookings } = await adminGet<{ bookings: Booking[] }>('/bookings?from=2026-11-01&to=2026-12-04');
  const all = d1(
    `SELECT id, line_user_id, status, start_at, menu_id FROM bookings WHERE line_user_id = '${s.user.replace(/'/g, '')}'`,
  ) as Array<Pick<Booking, 'id' | 'status' | 'start_at' | 'menu_id'>>;
  const { conversations } = await adminGet<{ conversations: Array<{ line_user_id: string; mode: string }> }>('/conversations');
  const mode = conversations.find((c) => c.line_user_id === s.user)?.mode ?? 'ai';
  const checks: Check[] = s.check({ turns: records.filter((r) => !r.prelude), userBookings: all, allBookings: bookings, mode, textOf });
  // すべての会話に共通：決まった「うまく答えられません」を出していない
  for (const [i, r] of records.entries())
    if (textOf(r.bot).includes(FALLBACK))
      checks.push({ name: `${i + 1} 通目で応答の失敗（決まり文句）を出していない`, pass: false, detail: textOf(r.bot) });
  return { records, checks };
}

function overlaps(bookings: Booking[]): number {
  let n = 0;
  for (let i = 0; i < bookings.length; i++)
    for (let j = i + 1; j < bookings.length; j++) {
      const a = bookings[i]!;
      const b = bookings[j]!;
      if (a.seat === b.seat && a.start_at < b.end_at && b.start_at < a.end_at) n++;
    }
  return n;
}

async function main() {
  const startedAt = new Date();
  rmSync(STATE, { recursive: true, force: true });
  mkdirSync(STATE, { recursive: true });
  execFileSync(
    process.execPath,
    [join(ROOT, 'node_modules/wrangler/bin/wrangler.js'), 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', STATE],
    {
      cwd: ROOT,
      stdio: 'ignore',
      env: { ...process.env, CI: '1' },
    },
  );
  const envFile = join(STATE, 'live.env');
  writeFileSync(
    envFile,
    [
      'ENVIRONMENT=development',
      `LINE_CHANNEL_SECRET=${SECRET}`,
      'LINE_CHANNEL_ACCESS_TOKEN=live-check-token',
      `LINE_API_BASE=http://127.0.0.1:${BRIDGE_PORT}/line`,
      `ANTHROPIC_BASE_URL=http://127.0.0.1:${BRIDGE_PORT}/anthropic`,
      'ANTHROPIC_API_KEY=live-check-key',
      `ADMIN_TOKEN=${ADMIN}`,
      `STAFF_TOKEN=${STAFF}`,
      'STAFF_LINE_USER_IDS=U-staff-live',
    ].join('\n'),
  );
  const bridge = await startBridge({ port: BRIDGE_PORT, model: MODEL, effort: EFFORT, names });
  const ctx: Ctx = { bridge };
  const logPath = join(STATE, 'wrangler.log');
  const logStream = createWriteStream(logPath);
  const wr: ChildProcess = spawn(
    process.execPath,
    [
      join(ROOT, 'node_modules/wrangler/bin/wrangler.js'),
      'dev',
      '--port',
      '8787',
      '--ip',
      '127.0.0.1',
      '--inspector-port',
      '0',
      '--persist-to',
      STATE,
      '--env-file',
      envFile,
      '--show-interactive-dev-session=false',
      '--log-level',
      'log',
    ],
    { cwd: ROOT, detached: true, stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, CI: '1' } },
  );
  wr.stdout!.pipe(logStream);
  wr.stderr!.pipe(logStream);
  const stop = () => {
    try {
      process.kill(-wr.pid!, 'SIGTERM');
    } catch {
      /* already stopped */
    }
  };
  process.on('SIGINT', () => {
    stop();
    process.exit(130);
  });

  const report: Record<string, unknown> = {
    started_at: startedAt.toISOString(),
    runtime: 'wrangler dev（workerd）＋ ローカル D1 ＋ Durable Objects',
    model: `${MODEL}（Codex CLI 経由・推論の深さ ${EFFORT}）`,
    model_note: 'Worker は本番と同じ Claude Messages API の呼び出しを行い、宛先だけを Codex CLI につないだ受け口に向けた',
  };
  let failures = 0;
  try {
    await waitFor(async () => ((await fetch(`${WORKER}/api/health`).catch(() => null))?.ok ? true : undefined), 60_000, 'worker start');

    // ── 準備：店の情報と、架空のお客様の既存予約（電話で受けた分）
    await adminSend('PUT', '/shop', DEMO_SHOP);
    for (const b of STAFF_BOOKINGS) await adminSend('POST', '/bookings', b);

    // ── 1. 署名の検証（正しい 100 通・不正 100 通）
    const sig = { valid_sent: 0, valid_accepted: 0, invalid_sent: 0, invalid_rejected: 0, false_reject: 0, false_accept: 0 };
    const variants: Array<(body: string) => { body: string; signature: string | null }> = [
      (b) => ({ body: b, signature: sign(b, 'another-channel-secret') }),
      (b) => ({ body: b.replace('unfollow', 'unfollOw'), signature: sign(b) }),
      (b) => ({ body: b, signature: null }),
      (b) => ({ body: b, signature: sign(b).slice(0, -4) }),
      (b) => ({ body: `${b} `, signature: sign(b) }),
      (b) => ({
        body: b,
        signature: Buffer.from(Buffer.from(sign(b), 'base64').map((x: number, i: number) => (i === 7 ? x ^ 1 : x))).toString('base64'),
      }),
      (b) => ({ body: b, signature: 'invalid signature value' }),
      (b) => ({ body: b, signature: sign(b).toLowerCase() }),
      (b) => ({ body: b, signature: '' }),
      (b) => ({ body: JSON.stringify(JSON.parse(b), null, 2), signature: sign(b) }),
    ];
    for (let i = 0; i < 100; i++) {
      const ev = {
        type: 'unfollow',
        webhookEventId: `SIGOK${String(i).padStart(4, '0')}`,
        timestamp: Date.now(),
        source: { type: 'user', userId: `U-sig-${i}` },
        mode: 'active',
      };
      const body = JSON.stringify({ destination: 'Ulivecheck', events: [ev] });
      sig.valid_sent++;
      const okStatus = await postWebhook([], { rawBody: body, signature: sign(body) });
      if (okStatus === 200) sig.valid_accepted++;
      else sig.false_reject++;
      const bad = { ...ev, webhookEventId: `SIGNG${String(i).padStart(4, '0')}` };
      const badBody = JSON.stringify({ destination: 'Ulivecheck', events: [bad] });
      const v = variants[i % variants.length]!(badBody);
      sig.invalid_sent++;
      const badStatus = await postWebhook([], { rawBody: v.body, signature: v.signature });
      if (badStatus === 401) sig.invalid_rejected++;
      else sig.false_accept++;
    }
    await sleep(3000);
    const processedOk = Number(d1("SELECT COUNT(*) AS n FROM processed_events WHERE event_id LIKE 'SIGOK%'")[0]!.n);
    const processedNg = Number(d1("SELECT COUNT(*) AS n FROM processed_events WHERE event_id LIKE 'SIGNG%'")[0]!.n);
    report.signature = { ...sig, processed_valid: processedOk, processed_invalid: processedNg };
    if (sig.false_reject || sig.false_accept || processedOk !== 100 || processedNg !== 0) failures++;
    console.log('signature', report.signature);

    // ── 2. 再送の重複排除（同じ webhookEventId を 4 回。うち 1 回は isRedelivery）
    const dupEv = eventFor('U-dedupe', { data: 'a=menu' }, jst('2026-11-04T10:15'), 'DEDUPE000001');
    for (let i = 0; i < 3; i++) await postWebhook([dupEv]);
    await postWebhook([{ ...dupEv, deliveryContext: { isRedelivery: true } }]);
    await Promise.all([postWebhook([dupEv]), postWebhook([dupEv])]);
    await sleep(5000);
    const dupReplies = bridge.lineCalls.filter((c) => c.kind === 'reply' && c.replyToken === dupEv.replyToken).length;
    report.dedupe = { deliveries: 6, replies: dupReplies, duplicate_replies: Math.max(0, dupReplies - 1) };
    if (dupReplies !== 1) failures++;
    console.log('dedupe', report.dedupe);

    // ── 3. 同時予約：30 人が同じ枠（2 席）を同時に押す → 確定まで
    const raceAt = jst('2026-11-04T10:20');
    const raceEvents = Array.from({ length: 30 }, (_, i) => eventFor(`U-race-${i}`, { data: 'a=hold&m=cut&s=2026-11-09T15%3A00' }, raceAt));
    const raceStatuses = await Promise.all(raceEvents.map((e) => postWebhook([e])));
    const raceReplies = await waitFor(
      () => {
        const r = raceEvents.map((e) => bridge.lineCalls.find((c) => c.kind === 'reply' && c.replyToken === e.replyToken));
        return r.every(Boolean) ? (r as LineCall[]) : undefined;
      },
      60_000,
      'race replies',
    );
    const holders = raceReplies.map((r, i) => ({ i, confirm: findButton(r.messages ?? [], '予約を確定する') })).filter((h) => h.confirm);
    const confirmEvents = holders.flatMap((h) => [
      eventFor(`U-race-${h.i}`, { data: h.confirm! }, jst('2026-11-04T10:22')),
      eventFor(`U-race-${h.i}`, { data: h.confirm! }, jst('2026-11-04T10:22')), // 確定ボタンの 2 度押し
    ]);
    await Promise.all(confirmEvents.map((e) => postWebhook([e])));
    await sleep(5000);
    const raceRows = d1("SELECT status, seat FROM bookings WHERE start_at = '2026-11-09T15:00'") as Array<{ status: string; seat: number }>;
    const confirmedRace = raceRows.filter((r) => r.status === 'confirmed').length;
    report.concurrency = {
      attempts: 30,
      accepted_webhooks: raceStatuses.filter((s) => s === 200).length,
      holds_granted: holders.length,
      told_taken: raceReplies.filter((r) => textOf(r.messages ?? []).includes('埋まってしまいました')).length,
      confirm_presses: confirmEvents.length,
      confirmed: confirmedRace,
      seats: DEMO_SHOP.seats,
      double_bookings: Math.max(0, confirmedRace - DEMO_SHOP.seats),
    };
    if (holders.length !== DEMO_SHOP.seats || confirmedRace !== DEMO_SHOP.seats) failures++;
    console.log('concurrency', report.concurrency);

    // ── 4. 実 AI の会話（筋書き）
    // 「ほかの人の予約番号」の筋書きのために、先に家族の予約を作り、その予約番号（先頭 6 文字）を文に入れる
    await runScenario(ctx, FAMILY_PRELUDE);
    const family = d1("SELECT id FROM bookings WHERE line_user_id = 'U-live-family' AND status = 'confirmed'")[0];
    if (!family) throw new Error('家族の予約を作れませんでした');
    for (const s of SCENARIOS) for (const t of s.turns) if (t.say) t.say = t.say.replace('FAMILY', String(family.id).slice(0, 6));
    const scenarios = SCENARIOS.filter((s) => !ONLY || ONLY.includes(s.id));
    const results: Array<{ id: string; title: string; ai: boolean; checks: Check[]; records: TurnRecord[] }> = [];
    const queue = [...scenarios];
    await Promise.all(
      Array.from({ length: PARALLEL }, async () => {
        for (let s = queue.shift(); s; s = queue.shift()) {
          const t0 = Date.now();
          try {
            const { records, checks } = await runScenario(ctx, s);
            results.push({ id: s.id, title: s.title, ai: s.ai, checks, records });
            const bad = checks.filter((c) => !c.pass);
            console.log(`${bad.length ? 'NG' : 'OK'} ${s.id} ${s.title} (${Math.round((Date.now() - t0) / 1000)}s)`, bad.length ? bad : '');
          } catch (e) {
            results.push({
              id: s.id,
              title: s.title,
              ai: s.ai,
              checks: [{ name: '最後まで進む', pass: false, detail: String(e) }],
              records: [],
            });
            console.log(`NG ${s.id}`, String(e));
          }
        }
      }),
    );
    results.sort((a, b) => SCENARIOS.findIndex((s) => s.id === a.id) - SCENARIOS.findIndex((s) => s.id === b.id));
    const wrongAnswers = results.flatMap((r) => r.checks.filter((c) => !c.pass).map((c) => ({ scenario: r.id, ...c })));
    if (wrongAnswers.length) failures++;

    // ── 5. 全体の不変条件
    const { bookings: finalBookings } = await adminGet<{ bookings: Booking[] }>('/bookings?from=2026-11-01&to=2026-12-04');
    const overlapCount = overlaps(finalBookings);
    if (overlapCount) failures++;
    await sleep(500);
    const log = readFileSync(logPath, 'utf8');
    const errorLines = log.split('\n').filter((l) => /"level":"error"|✘ \[ERROR\]|Uncaught/.test(l));
    const modelErrors = bridge.modelCalls.filter((c) => c.error);
    if (errorLines.length || modelErrors.length) failures++;
    const aiTurns = results
      .filter((r) => r.ai)
      .flatMap((r) => r.records.filter((t) => !t.prelude && t.tools.length + 1 > 0 && t.user.text));
    const latencies = aiTurns.map((t) => t.ms).sort((a, b) => a - b);
    const median = latencies.length ? latencies[Math.floor(latencies.length / 2)]! : 0;
    // 記録に PII（電話番号など）が残っていないか：保存された全メッセージを走査
    const stored = d1('SELECT text FROM messages') as Array<{ text: string }>;
    const piiLeaks = stored.filter((m) => /0\d{1,4}-\d{1,4}-\d{3,4}|@[a-z]+\.[a-z]/i.test(m.text)).length;
    if (piiLeaks) failures++;

    report.scenarios = results.map((r) => ({
      id: r.id,
      title: r.title,
      ai: r.ai,
      turns: r.records.filter((t) => !t.prelude).length,
      passed: r.checks.filter((c) => c.pass).length,
      failed: r.checks.filter((c) => !c.pass).length,
      checks: r.checks,
    }));
    report.totals = {
      scenarios: results.length,
      ai_scenarios: results.filter((r) => r.ai).length,
      checks: results.reduce((n, r) => n + r.checks.length, 0),
      wrong_answers: wrongAnswers.length,
      double_bookings: overlapCount + (report.concurrency as { double_bookings: number }).double_bookings,
      signature_misjudgements: sig.false_accept + sig.false_reject,
      duplicate_replies: (report.dedupe as { duplicate_replies: number }).duplicate_replies,
      worker_errors: errorLines.length,
      model_errors: modelErrors.length,
      model_error_samples: modelErrors.slice(0, 5).map((e) => e.error?.slice(0, 200)),
      pii_in_stored_messages: piiLeaks,
      model_calls: bridge.modelCalls.length,
      ai_turns: aiTurns.length,
      ai_turn_median_ms: median,
      ai_turn_max_ms: latencies.at(-1) ?? 0,
    };
    report.finished_at = new Date().toISOString();
    report.passed = failures === 0;
    console.log('totals', report.totals);
    if (errorLines.length) console.log(errorLines.slice(0, 10).join('\n'));

    mkdirSync(join(ROOT, 'docs/evidence'), { recursive: true });
    writeFileSync(join(ROOT, 'docs/evidence/live-check.json'), `${JSON.stringify(report, null, 2)}\n`);
    // 公開デモ用の記録（AI を使った会話と、ボタンだけの予約）
    if (!ONLY) {
      const demo = results
        .filter((r) => SCENARIOS.find((s) => s.id === r.id)?.demo)
        .map((r) => {
          const s = SCENARIOS.find((x) => x.id === r.id)!;
          return {
            id: r.id,
            title: s.demo!.title,
            summary: s.demo!.summary,
            ai: r.ai,
            user: { name: s.name, id: s.user },
            turns: r.records,
          };
        });
      writeFileSync(
        join(ROOT, 'web/src/demo/recordings.json'),
        `${JSON.stringify({ recorded_at: report.finished_at, model: report.model, runtime: report.runtime, shop: DEMO_SHOP, staff_names: OTHER_CUSTOMER_NAMES, scenarios: demo }, null, 1)}\n`,
      );
    }
  } finally {
    stop();
    await bridge.close();
    logStream.end();
  }
  console.log(failures === 0 ? 'LIVE CHECK PASSED' : `LIVE CHECK FAILED (${failures})`);
  process.exit(failures === 0 ? 0 : 1);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
