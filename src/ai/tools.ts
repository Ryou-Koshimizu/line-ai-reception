// AI が呼べる道具。どの道具も「今話しているお客様」の範囲でしか動かない（userId は AI から受け取らず、サーバーが渡す）。
import { z } from 'zod';
import type { ToolDef } from './model';
import type { LineMessage } from '../line/types';
import {
  BookingError,
  bookingCode,
  cancelBooking,
  confirmBooking,
  findAvailableSlots,
  getBooking,
  holdBooking,
  listUserBookings,
  rescheduleBooking,
  type Booking,
} from '../domain/booking';
import { describeHours, formatOpening, hoursOn, isOpenAt, nextOpening, type ShopInfo } from '../domain/shop';
import { addDays, formatJa, isLocalTime, toJstLocal } from '../domain/time';
import { markClosedNotice, setMode } from '../domain/conversation';
import { confirmedCard, holdCard, slotCarousel } from '../line/messages';

export interface ToolContext {
  db: D1Database;
  shop: ShopInfo;
  userId: string;
  displayName: string;
  now: Date;
  /** この返事の処理を始めた時刻。仮予約と確定を同じ返事で済ませないために使う */
  turnStartedAt: Date;
  notifyStaff: (summary: string) => Promise<void>;
}

export interface ToolOutcome {
  result: Record<string, unknown>;
  isError?: boolean;
  ui?: LineMessage;
  /** 予約が確定・変更された（返事に「確定しました」と書いてよい） */
  committed?: boolean;
}

const ymd = z
  .string()
  .regex(/^\d{4}-\d{2}-\d{2}$/)
  .refine((d) => isLocalTime(`${d}T00:00`), '存在しない日付です');
const local = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/);
const bookingId = z.string().regex(/^[A-Z0-9]{6,16}$/);

const schemas = {
  get_shop_info: z.object({ section: z.enum(['all', 'menu', 'hours', 'access', 'policies', 'faq', 'payment']) }),
  find_available_slots: z.object({
    menu_id: z.string().max(32),
    date_from: ymd,
    date_to: ymd.optional(),
    part_of_day: z.enum(['any', 'morning', 'afternoon', 'evening']).optional(),
  }),
  hold_booking: z.object({ menu_id: z.string().max(32), start: local }),
  confirm_booking: z.object({ booking_id: bookingId }),
  list_my_bookings: z.object({}),
  cancel_booking: z.object({ booking_id: bookingId }),
  reschedule_booking: z.object({ booking_id: bookingId, new_start: local }),
  handoff_to_staff: z.object({ reason: z.string().min(1).max(200) }),
} as const;

export type ToolName = keyof typeof schemas;

const obj = (properties: Record<string, unknown>, required: string[]) => ({
  type: 'object' as const,
  properties,
  required,
  additionalProperties: false,
});

export const TOOL_DEFS: ToolDef[] = [
  {
    name: 'get_shop_info',
    description:
      '店の情報（メニューと料金・営業時間と定休日・場所とアクセス・駐車場・支払い方法・予約の決まり・よくある質問）を取り出す。店について答えるときは必ずこれを使い、ここに無いことは答えない。',
    input_schema: obj({ section: { type: 'string', enum: ['all', 'menu', 'hours', 'access', 'policies', 'faq', 'payment'] } }, ['section']),
  },
  {
    name: 'find_available_slots',
    description:
      '予約の空き枠を探す。結果はお客様の画面に日ごとのカードで表示され、押すと仮予約になる。日付は YYYY-MM-DD（日本時間）。date_to を省くと date_from の 1 日だけ。最大 14 日分。',
    input_schema: obj(
      {
        menu_id: { type: 'string', description: 'get_shop_info の menu で分かるメニューの ID' },
        date_from: { type: 'string', description: 'YYYY-MM-DD' },
        date_to: { type: 'string', description: 'YYYY-MM-DD（省略可）' },
        part_of_day: {
          type: 'string',
          enum: ['any', 'morning', 'afternoon', 'evening'],
          description: '午前=morning（12時前）、午後=afternoon（12〜17時）、夕方以降=evening',
        },
      },
      ['menu_id', 'date_from'],
    ),
  },
  {
    name: 'hold_booking',
    description:
      '空き枠を仮予約する（数分間だけ押さえる）。お客様の画面に確認カードが出る。これだけでは予約は確定しない。お客様の同意を得てから、次の返事で confirm_booking を呼ぶ。',
    input_schema: obj(
      {
        menu_id: { type: 'string' },
        start: { type: 'string', description: '開始時刻 YYYY-MM-DDTHH:mm（日本時間）。find_available_slots の結果から選ぶ' },
      },
      ['menu_id', 'start'],
    ),
  },
  {
    name: 'confirm_booking',
    description: 'お客様が仮予約の内容に明確に同意したあとで、仮予約を確定する。仮予約を作ったのと同じ返事の中では使えない。',
    input_schema: obj({ booking_id: { type: 'string' } }, ['booking_id']),
  },
  {
    name: 'list_my_bookings',
    description: 'このお客様の、これからの予約と仮予約を一覧する。変更・取り消しの前に対象を確かめるのに使う。',
    input_schema: obj({}, []),
  },
  {
    name: 'cancel_booking',
    description: 'このお客様の予約を取り消す。お客様が取り消しに同意してから使う。予約時刻の直前は店の決まりにより取り消せないことがある。',
    input_schema: obj({ booking_id: { type: 'string' } }, ['booking_id']),
  },
  {
    name: 'reschedule_booking',
    description:
      'このお客様の確定済みの予約の日時を変える。新しい枠が空いていなければ元の予約のまま変わらない。お客様が新しい日時に同意してから使う。',
    input_schema: obj({ booking_id: { type: 'string' }, new_start: { type: 'string', description: 'YYYY-MM-DDTHH:mm' } }, [
      'booking_id',
      'new_start',
    ]),
  },
  {
    name: 'handoff_to_staff',
    description:
      'この会話をスタッフに引き継ぐ。以後 AI は返事をせず、スタッフが LINE で返す。お客様が人との会話を望むとき、相談・苦情・体調や肌の悩み、店の情報に無い質問で必要なときに使う。',
    input_schema: obj({ reason: { type: 'string', description: 'スタッフ向けの短い要件（個人情報は書かない）' } }, ['reason']),
  },
];

const ERROR_TEXT: Record<BookingError['code'], string> = {
  UNKNOWN_MENU: 'そのメニュー ID はありません。get_shop_info の menu で確かめてください。',
  INVALID_TIME: '時刻の形が正しくないか、予約の区切りに合っていません。',
  CLOSED: 'その日は定休日・休業日です。',
  OUTSIDE_HOURS: '営業時間内に終わらない時刻です。',
  TOO_SOON: '直前すぎて予約を受け付けられない時刻です（過ぎた時刻を含む）。',
  TOO_FAR: '予約を受け付けている期間より先の日付です。',
  TAKEN: 'その枠はすでに埋まっています。find_available_slots で別の枠を探してください。',
  NOT_FOUND: 'このお客様の予約の中に、その予約は見つかりません。list_my_bookings で確かめてください。',
  HOLD_EXPIRED: '仮予約の期限が切れました。もう一度 hold_booking からやり直してください。',
  DEADLINE_PASSED: '予約時刻の直前のため、LINE では変更・取り消しができません。お電話をご案内するか、スタッフに引き継いでください。',
  LIMIT_REACHED: 'このお客様の予約がすでに上限の件数あります。',
};

function summarize(b: Booking) {
  return {
    booking_id: b.id,
    code: bookingCode(b),
    status: b.status,
    start: b.start_at,
    start_label: formatJa(b.start_at),
    end: b.end_at,
    menu: b.menu_name,
    price_yen: b.price,
    name: b.customer_name,
  };
}

function shopSection(shop: ShopInfo, section: z.infer<typeof schemas.get_shop_info>['section'], now: Date) {
  const menu = {
    menus: shop.menus.map((m) => ({ id: m.id, name: m.name, minutes: m.minutes, price_yen: m.price, description: m.description })),
  };
  const today = toJstLocal(now).slice(0, 10);
  const upcomingClosed = shop.closedDates.filter((d) => d >= today && d <= addDays(today, 60));
  const hours = {
    weekly: describeHours(shop),
    extra_closed_dates: upcomingClosed,
    last_booking_note: 'メニューの終わりが閉店時刻までに収まる枠だけ予約できます。',
  };
  const access = { name: shop.name, address: shop.address, access: shop.access, parking: shop.parking, phone: shop.phone };
  const policies = { ...shop.policies, change_deadline_hours: shop.changeDeadlineHours, hold_minutes: shop.holdMinutes };
  const all = { tagline: shop.tagline, ...menu, hours, ...access, payment: shop.payment, policies, faq: shop.faq };
  switch (section) {
    case 'menu':
      return menu;
    case 'hours':
      return hours;
    case 'access':
      return access;
    case 'policies':
      return policies;
    case 'faq':
      return { faq: shop.faq };
    case 'payment':
      return { payment: shop.payment };
    default:
      return all;
  }
}

export async function runTool(name: string, rawInput: unknown, ctx: ToolContext): Promise<ToolOutcome> {
  if (!(name in schemas)) return { result: { error: `${name} という道具はありません` }, isError: true };
  const parsed = schemas[name as ToolName].safeParse(rawInput ?? {});
  if (!parsed.success)
    return {
      result: { error: '入力の形が正しくありません', detail: parsed.error.issues.slice(0, 3).map((i) => i.message) },
      isError: true,
    };
  const input = parsed.data as Record<string, string>;
  const { db, shop, userId, now } = ctx;
  try {
    switch (name as ToolName) {
      case 'get_shop_info':
        return { result: { source: '店の情報（管理画面で店が登録した内容）', data: shopSection(shop, input.section as 'all', now) } };
      case 'find_available_slots': {
        const menu = shop.menus.find((m) => m.id === input.menu_id);
        if (!menu) throw new BookingError('UNKNOWN_MENU');
        // 歩く日数を有限にする：最大 14 日分、かつ予約を受け付けている期間まで（findAvailableSlots と同じ丸め）
        const lastDay = addDays(toJstLocal(now).slice(0, 10), shop.maxDaysAhead);
        let dateTo = input.date_to && input.date_to >= input.date_from! ? input.date_to : input.date_from!;
        if (dateTo > addDays(input.date_from!, 13)) dateTo = addDays(input.date_from!, 13);
        if (dateTo > lastDay) dateTo = lastDay;
        const slots = await findAvailableSlots(
          db,
          shop,
          { menuId: menu.id, dateFrom: input.date_from!, dateTo, part: (input.part_of_day as 'any') ?? 'any', limit: 36 },
          now,
        );
        const closedDays: string[] = [];
        for (let d = input.date_from!; d <= dateTo; d = addDays(d, 1)) if (!hoursOn(shop, d)) closedDays.push(d);
        let suggestion: string[] = [];
        if (slots.length === 0) {
          // 希望の範囲に空きがなければ、その先 7 日の空きを少しだけ添える
          const from = addDays(dateTo, 1);
          suggestion = await findAvailableSlots(db, shop, { menuId: menu.id, dateFrom: from, dateTo: addDays(from, 6), limit: 6 }, now);
        }
        const shown = slots.length ? slots : suggestion;
        return {
          result: {
            menu: { id: menu.id, name: menu.name, minutes: menu.minutes, price_yen: menu.price },
            available: slots.map((s) => ({ start: s, label: formatJa(s) })),
            closed_days_in_range: closedDays.map((d) => formatJa(`${d}T00:00`, false)),
            nearest_other_slots: suggestion.map((s) => ({ start: s, label: formatJa(s) })),
            shown_to_customer: shown.length > 0 ? '空き枠をカードで表示しました' : 'カードは表示していません',
          },
          ui: slotCarousel(shop, menu.id, shown) ?? undefined,
        };
      }
      case 'hold_booking': {
        const b = await holdBooking(db, shop, { userId, customerName: ctx.displayName, menuId: input.menu_id!, start: input.start! }, now);
        return {
          result: {
            ...summarize(b),
            hold_minutes: shop.holdMinutes,
            next: '確認カードを表示しました。お客様の同意を待ってから confirm_booking を呼んでください。',
          },
          ui: holdCard(b, shop.holdMinutes),
        };
      }
      case 'confirm_booking': {
        const existing = await getBooking(db, input.booking_id!);
        if (
          existing &&
          existing.line_user_id === userId &&
          existing.status === 'held' &&
          existing.created_at >= ctx.turnStartedAt.toISOString()
        )
          return {
            result: { error: '仮予約を作ったのと同じ返事の中では確定できません。お客様に内容を確認し、同意の返事を待ってください。' },
            isError: true,
          };
        const b = await confirmBooking(db, userId, input.booking_id!, now);
        return { result: summarize(b), ui: confirmedCard(b, shop), committed: true };
      }
      case 'list_my_bookings': {
        const list = await listUserBookings(db, userId, now);
        return { result: { bookings: list.map(summarize) } };
      }
      case 'cancel_booking': {
        const b = await cancelBooking(db, shop, { userId }, input.booking_id!, now);
        return { result: summarize(b), committed: true };
      }
      case 'reschedule_booking': {
        const b = await rescheduleBooking(db, shop, userId, input.booking_id!, input.new_start!, now);
        return { result: summarize(b), ui: confirmedCard(b, shop, '予約の日時を変更しました'), committed: true };
      }
      case 'handoff_to_staff': {
        await setMode(db, userId, 'human', input.reason!);
        const open = isOpenAt(shop, now);
        const next = nextOpening(shop, now);
        // 営業時間外であることはこの返事で伝えるので、続くメッセージに同じ自動応答を重ねない
        if (!open) await markClosedNotice(db, userId, now);
        await ctx.notifyStaff(input.reason!);
        return {
          result: {
            handed_off: true,
            shop_open_now: open,
            next_opening: open || !next ? null : formatOpening(next, now),
            tell_customer: open
              ? 'スタッフに引き継いだこと、スタッフからこのトークで返事があることを伝える。'
              : `営業時間外のため、次の営業開始（${next ? formatOpening(next, now) : '次の営業日'}）以降にスタッフから返事があることを伝える。`,
          },
        };
      }
    }
  } catch (e) {
    if (e instanceof BookingError) return { result: { error: ERROR_TEXT[e.code], code: e.code }, isError: true };
    throw e;
  }
}
