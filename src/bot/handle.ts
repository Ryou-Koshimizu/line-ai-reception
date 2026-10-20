// 1 件の LINE イベントを処理する。ChatSession（利用者ごとの Durable Object）から、届いた順に 1 件ずつ呼ばれる。
import type { LineEvent, LineMessage } from '../line/types';
import { replyOrPush, type LineClient } from '../line/client';
import { MAIN_QUICK, cancelConfirm, confirmedCard, holdCard, menuPicker, myBookingsCard, slotCarousel, text } from '../line/messages';
import { describeHours, formatOpening, isOpenAt, loadShop, nextOpening, type ShopInfo } from '../domain/shop';
import {
  BookingError,
  cancelBooking,
  confirmBooking,
  findAvailableSlots,
  getBooking,
  holdBooking,
  listUserBookings,
} from '../domain/booking';
import {
  appendMessage,
  ensureConversation,
  getConversation,
  markClosedNotice,
  recentMessages,
  recentUserMessageCount,
  setMode,
} from '../domain/conversation';
import { FALLBACK_TEXT, runAgent } from '../ai/agent';
import type { ChatModel } from '../ai/model';
import { addDays, formatJa, toJstLocal } from '../domain/time';
import { hashId } from '../domain/pii';
import { log } from '../domain/log';

export interface HandlerDeps {
  db: D1Database;
  line: LineClient;
  model: ChatModel | null;
  staffUserIds: string[];
  now: Date;
}

const RATE_LIMIT = 20;

/** 処理済みのイベントIDを記録する。すでにあれば false（LINE の再送や二重の配信） */
export async function markProcessed(db: D1Database, eventId: string, now: Date): Promise<boolean> {
  const r = await db
    .prepare('INSERT OR IGNORE INTO processed_events (event_id, received_at) VALUES (?1, ?2)')
    .bind(eventId, now.toISOString())
    .run();
  return r.meta.changes === 1;
}

function customerError(e: BookingError, shop: ShopInfo): string {
  switch (e.code) {
    case 'TAKEN':
      return 'その枠はちょうど埋まってしまいました。ほかの時間をお選びください。';
    case 'HOLD_EXPIRED':
      return `仮予約の期限（${shop.holdMinutes}分）が過ぎました。もう一度、時間を選んでください。`;
    case 'DEADLINE_PASSED':
      return `予約時刻の${shop.changeDeadlineHours}時間前を過ぎているため、LINE では変更・取り消しができません。お電話（${shop.phone}）でご連絡ください。`;
    case 'CLOSED':
      return 'その日は休業日です。ほかの日をお選びください。';
    case 'TOO_SOON':
      return 'その時間は受付を締め切りました。ほかの時間をお選びください。';
    case 'LIMIT_REACHED':
      return 'LINE でお取りできる予約の数の上限に達しています。予約の確認・変更からご確認ください。';
    case 'NOT_FOUND':
      return 'その予約は見つかりませんでした。「予約の確認・変更」からご確認ください。';
    default:
      return 'その時間ではお取りできませんでした。ほかの時間をお選びください。';
  }
}

async function notifyStaff(deps: HandlerDeps, displayName: string, reason: string, eventId: string): Promise<void> {
  for (const [i, staff] of deps.staffUserIds.entries()) {
    try {
      await deps.line.push(
        staff,
        [text(`【引き継ぎ】${displayName} さん\n${reason}\n管理画面の「会話」から返信できます。`)],
        `${eventId}:staff:${i}`,
      );
    } catch {
      log('warn', 'staff notification failed', { count: i });
    }
  }
}

export async function handleEvent(deps: HandlerDeps, event: LineEvent, opts: { retry?: boolean } = {}): Promise<void> {
  const { db, now } = deps;
  const userId = event.source.type === 'user' ? event.source.userId : undefined;
  if (!userId) return; // 1 対 1 のトーク以外（グループ等）は扱わない
  // 処理済みなら LINE の再送なので読み飛ばす。ただし自分の待ち行列のやり直し（途中で止まった処理）は続ける。
  // その場合も返信は「返信トークン → だめなら同じ再送キーのプッシュ」なので、LINE 側で 1 通にまとまる
  if (!(await markProcessed(db, event.webhookEventId, now)) && !opts.retry) {
    log('info', 'duplicate event skipped', { event: event.webhookEventId, type: event.type });
    return;
  }
  const user = await hashId(userId);
  const replyToken = typeof event.replyToken === 'string' ? event.replyToken : undefined;
  const shop = await loadShop(db);
  const send = (messages: LineMessage[]) => replyOrPush(deps.line, userId, replyToken, messages, event.webhookEventId);

  if (event.type === 'unfollow') return;
  if (!shop) {
    await send([text('ただいま受付の準備をしています。しばらくしてからお送りください。')]);
    return;
  }

  let conv = await getConversation(db, userId);
  if (!conv) {
    const name = (await deps.line.displayName(userId)) ?? 'お客様';
    conv = await ensureConversation(db, userId, name, now);
  }
  const displayName = conv.display_name;

  try {
    if (event.type === 'follow') {
      const greeting = `友だち追加ありがとうございます。${shop.name}です。\nご予約・ご質問はこのトークで24時間受け付けています。下のボタンから選ぶか、メッセージを送ってください。`;
      await appendMessage(db, userId, 'assistant', greeting, now);
      await send([text(greeting, MAIN_QUICK)]);
      return;
    }

    if (event.type === 'postback') {
      await handlePostback(deps, shop, { userId, displayName, data: event.postback.data, send, eventId: event.webhookEventId });
      return;
    }

    // ここからは message イベント
    if (event.message.type !== 'text' || !event.message.text) {
      await send([text('画像やスタンプには自動でお答えできません。文字で送るか、下のボタンから選んでください。', MAIN_QUICK)]);
      return;
    }
    // 保存も AI へ渡すのも、電話番号などを伏せ字にした文
    const userText = await appendMessage(db, userId, 'user', event.message.text, now);

    if (conv.mode === 'human') {
      // スタッフが引き取り中。AI は返事をしない。営業時間外なら、その旨を一度だけ自動で伝える
      const open = isOpenAt(shop, now);
      const lastNotice = conv.closed_notice_at ? new Date(conv.closed_notice_at).getTime() : 0;
      if (!open && now.getTime() - lastNotice > 12 * 3_600_000) {
        const next = nextOpening(shop, now);
        const notice = `ただいま営業時間外です。メッセージはスタッフに届いています。${next ? `${formatOpening(next, now)}以降に` : ''}スタッフから返信します。`;
        await markClosedNotice(db, userId, now);
        await appendMessage(db, userId, 'system', notice, now);
        await send([text(notice)]);
      }
      log('info', 'message held for staff', { user, mode: 'human' });
      return;
    }

    if ((await recentUserMessageCount(db, userId, now)) > RATE_LIMIT) {
      await send([text('メッセージが続いています。少し時間をおいてから、もう一度お送りください。')]);
      log('warn', 'rate limited', { user });
      return;
    }

    if (!deps.model) {
      await send([text('ご用件を下のボタンから選んでください。', MAIN_QUICK)]);
      return;
    }

    await deps.line.showLoading(userId, 20);
    const history = (await recentMessages(db, userId, 13)).slice(0, -1); // 今のメッセージは別に渡す
    const started = Date.now();
    const turnStartedAt = new Date(now.getTime());
    const result = await runAgent({
      model: deps.model,
      history,
      userText,
      ctx: {
        db,
        shop,
        userId,
        displayName,
        now,
        turnStartedAt,
        notifyStaff: (reason) => notifyStaff(deps, displayName, reason, event.webhookEventId),
      },
    });
    log('info', 'ai reply', {
      user,
      steps: result.toolCalls.length,
      ms: Date.now() - started,
      reason: result.flags.join(',') || null,
    });
    await appendMessage(db, userId, 'assistant', result.text, now);
    const quick = result.text === FALLBACK_TEXT ? MAIN_QUICK : undefined;
    await send([text(result.text, quick), ...result.ui]);
  } catch (e) {
    log('error', 'event failed', { user, type: event.type, code: e instanceof Error ? e.message.slice(0, 80) : 'unknown' });
    try {
      await send([text(FALLBACK_TEXT, MAIN_QUICK)]);
    } catch {
      /* 返信もできないときは記録だけ残す */
    }
  }
}

interface PostbackCtx {
  userId: string;
  displayName: string;
  data: string;
  eventId: string;
  send: (m: LineMessage[]) => Promise<unknown>;
}

const LABELS: Record<string, string> = {
  book: '予約したい',
  mine: '予約を確認したい',
  menu: 'メニューと料金',
  hours: '営業時間と場所',
  staff: 'スタッフに相談したい',
  slots: '空き枠を見る',
  hold: '時間を選んだ',
  confirm: '予約を確定する',
  release: '仮予約をやめる',
  cancel_ask: '予約を取り消したい',
  cancel: '取り消す',
  noop: 'そのままにする',
};

async function handlePostback(deps: HandlerDeps, shop: ShopInfo, p: PostbackCtx): Promise<void> {
  const { db, now } = deps;
  const params = new URLSearchParams(p.data);
  const action = params.get('a') ?? '';
  await appendMessage(db, p.userId, 'user', `［ボタン］${LABELS[action] ?? action}`, now);
  const say = async (messages: LineMessage[]) => {
    const first = messages[0];
    if (first?.type === 'text') await appendMessage(db, p.userId, 'assistant', first.text, now);
    else if (first) await appendMessage(db, p.userId, 'assistant', `［カード］${first.altText}`, now);
    await p.send(messages);
  };
  try {
    switch (action) {
      case 'book':
        return void (await say([menuPicker(shop)]));
      case 'slots': {
        const menuId = params.get('m') ?? '';
        const today = toJstLocal(now).slice(0, 10);
        const slots = await findAvailableSlots(db, shop, { menuId, dateFrom: today, dateTo: addDays(today, 6), limit: 200 }, now);
        const card = slotCarousel(shop, menuId, slots);
        if (!card)
          return void (await say([
            text('この1週間は空きがありません。日にちを指定してメッセージでお送りください（例：「来週の土曜の午後」）。'),
          ]));
        return void (await say([text('空いている時間です。カードを横にめくって、時間を押してください。'), card]));
      }
      case 'hold': {
        const b = await holdBooking(
          db,
          shop,
          { userId: p.userId, customerName: p.displayName, menuId: params.get('m') ?? '', start: params.get('s') ?? '' },
          now,
        );
        return void (await say([holdCard(b, shop.holdMinutes)]));
      }
      case 'confirm': {
        const b = await confirmBooking(db, p.userId, params.get('b') ?? '', now);
        return void (await say([confirmedCard(b, shop)]));
      }
      case 'release': {
        const b = await getBooking(db, params.get('b') ?? '');
        if (b && b.line_user_id === p.userId && b.status === 'held') await cancelBooking(db, shop, { userId: p.userId }, b.id, now);
        return void (await say([text('仮予約をやめました。またいつでもどうぞ。', MAIN_QUICK.slice(0, 1))]));
      }
      case 'mine':
        return void (await say([myBookingsCard(await listUserBookings(db, p.userId, now))]));
      case 'cancel_ask': {
        const b = await getBooking(db, params.get('b') ?? '');
        if (!b || b.line_user_id !== p.userId || (b.status !== 'confirmed' && b.status !== 'held')) throw new BookingError('NOT_FOUND');
        return void (await say([cancelConfirm(b)]));
      }
      case 'cancel': {
        const b = await cancelBooking(db, shop, { userId: p.userId }, params.get('b') ?? '', now);
        return void (await say([text(`${formatJa(b.start_at)}の${b.menu_name}を取り消しました。またのご予約をお待ちしています。`)]));
      }
      case 'menu': {
        const lines = shop.menus.map(
          (m) => `・${m.name} ${m.price.toLocaleString('ja-JP')}円（${m.minutes}分）${m.description ? `\n  ${m.description}` : ''}`,
        );
        return void (await say([text(`メニューと料金です。\n${lines.join('\n')}`, MAIN_QUICK.slice(0, 1))]));
      }
      case 'hours':
        return void (await say([
          text(`営業時間：${describeHours(shop)}\n場所：${shop.address}\n${shop.access}\n駐車場：${shop.parking}`, MAIN_QUICK.slice(0, 1)),
        ]));
      case 'staff': {
        await setMode(db, p.userId, 'human', 'お客様がボタンからスタッフへの相談を希望');
        await notifyStaff(deps, p.displayName, 'ボタンからスタッフへの相談を希望', p.eventId);
        const open = isOpenAt(shop, now);
        const next = nextOpening(shop, now);
        const msg = open
          ? 'スタッフにおつなぎしました。このトークでご用件をお送りください。スタッフから返信します。'
          : `スタッフにおつなぎしました。ただいま営業時間外のため、${next ? `${formatOpening(next, now)}以降に` : ''}スタッフから返信します。ご用件を先にお送りいただけます。`;
        return void (await say([text(msg)]));
      }
      case 'noop':
        return void (await say([text('そのままにしておきますね。')]));
      default:
        return void (await say([text('ご用件を下のボタンから選んでください。', MAIN_QUICK)]));
    }
  } catch (e) {
    if (!(e instanceof BookingError)) throw e;
    const menuId = params.get('m');
    const retry = menuId
      ? [
          {
            type: 'postback' as const,
            label: 'ほかの時間を見る',
            data: `a=slots&m=${encodeURIComponent(menuId)}`,
            displayText: 'ほかの時間を見たい',
          },
        ]
      : MAIN_QUICK;
    await say([text(customerError(e, shop), retry)]);
  }
}
