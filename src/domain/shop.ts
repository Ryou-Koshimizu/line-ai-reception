import { z } from 'zod';
import { WEEKDAYS, addDays, addMinutesLocal, formatJa, minutesOf, toJstLocal, weekdayOf, type Weekday } from './time';

const hhmm = z.string().regex(/^([01]\d|2[0-3]):[0-5]\d$/, '「10:00」の形で入力してください');
const ymd = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, '「2026-12-31」の形で入力してください');
const text = (max: number) => z.string().trim().max(max);

const dayHours = z
  .object({ open: hhmm, close: hhmm })
  .refine((h) => minutesOf(h.open) < minutesOf(h.close), '閉店は開店より後にしてください')
  .nullable();

export const menuSchema = z.object({
  id: z.string().regex(/^[a-z0-9-]{1,32}$/, 'ID は半角英小文字・数字・ハイフンで'),
  name: text(40).min(1),
  minutes: z.number().int().min(15).max(480),
  price: z.number().int().min(0).max(1_000_000),
  description: text(200),
});

export const shopSchema = z
  .object({
    name: text(60).min(1),
    tagline: text(120),
    address: text(120),
    access: text(200),
    phone: text(20),
    parking: text(200),
    payment: text(200),
    hours: z.object(Object.fromEntries(WEEKDAYS.map((d) => [d, dayHours])) as Record<Weekday, typeof dayHours>),
    closedDates: z.array(ymd).max(120),
    slotMinutes: z.union([z.literal(15), z.literal(30), z.literal(60)]),
    seats: z.number().int().min(1).max(10),
    leadMinutes: z
      .number()
      .int()
      .min(0)
      .max(24 * 60),
    maxDaysAhead: z.number().int().min(1).max(180),
    holdMinutes: z.number().int().min(3).max(60),
    changeDeadlineHours: z.number().int().min(0).max(72),
    menus: z.array(menuSchema).min(1).max(30),
    policies: z.object({ cancellation: text(300), lateness: text(300) }),
    faq: z.array(z.object({ q: text(100).min(1), a: text(400).min(1) })).max(40),
    links: z.array(z.string().url().max(300)).max(5),
  })
  .refine((s) => new Set(s.menus.map((m) => m.id)).size === s.menus.length, {
    message: 'メニューの ID が重複しています',
    path: ['menus'],
  })
  .refine((s) => s.menus.every((m) => m.minutes % s.slotMinutes === 0), {
    message: '所要時間は予約の区切り（分）の倍数にしてください',
    path: ['menus'],
  });

export type ShopInfo = z.infer<typeof shopSchema>;
export type Menu = z.infer<typeof menuSchema>;

export async function loadShop(db: D1Database): Promise<ShopInfo | null> {
  const row = await db.prepare('SELECT info FROM shop WHERE id = 1').first<{ info: string }>();
  if (!row) return null;
  return shopSchema.parse(JSON.parse(row.info));
}

export async function saveShop(db: D1Database, info: ShopInfo, now: Date): Promise<void> {
  await db
    .prepare('INSERT INTO shop (id, info, updated_at) VALUES (1, ?1, ?2) ON CONFLICT (id) DO UPDATE SET info = ?1, updated_at = ?2')
    .bind(JSON.stringify(info), now.toISOString())
    .run();
}

export function hoursOn(shop: ShopInfo, date: string): { open: string; close: string } | null {
  if (shop.closedDates.includes(date)) return null;
  return shop.hours[weekdayOf(date)];
}

export function isOpenAt(shop: ShopInfo, now: Date): boolean {
  const local = toJstLocal(now);
  const date = local.slice(0, 10);
  const h = hoursOn(shop, date);
  if (!h) return false;
  const t = local.slice(11);
  return t >= h.open && t < h.close;
}

/** 次に店が開く時刻（今が営業中ならその日の開店時刻ではなく「今」）。2 週間先まで探す */
export function nextOpening(shop: ShopInfo, now: Date): string | null {
  const local = toJstLocal(now);
  if (isOpenAt(shop, now)) return local;
  let date = local.slice(0, 10);
  for (let i = 0; i < 15; i++) {
    const h = hoursOn(shop, date);
    const candidate = `${date}T${h?.open ?? '00:00'}`;
    if (h && candidate > local) return candidate;
    date = addDays(date, 1);
  }
  return null;
}

const WEEKDAY_LABEL: Record<Weekday, string> = { mon: '月', tue: '火', wed: '水', thu: '木', fri: '金', sat: '土', sun: '日' };

/** AI に渡す・自動応答に使う、店の情報の文章表現 */
export function describeHours(shop: ShopInfo): string {
  const order: Weekday[] = ['mon', 'tue', 'wed', 'thu', 'fri', 'sat', 'sun'];
  const lines = order.map((d) => {
    const h = shop.hours[d];
    return `${WEEKDAY_LABEL[d]}曜 ${h ? `${h.open}〜${h.close}` : '定休日'}`;
  });
  return lines.join(' / ');
}

export function describeMenus(shop: ShopInfo): string {
  return shop.menus.map((m) => `${m.name}（${m.minutes}分・${m.price.toLocaleString('ja-JP')}円）`).join('、');
}

export function formatOpening(local: string, now: Date): string {
  const today = toJstLocal(now).slice(0, 10);
  const label = local.slice(0, 10) === today ? '本日' : local.slice(0, 10) === addDays(today, 1) ? '明日' : formatJa(local, false);
  return `${label} ${local.slice(11)}`;
}

export { addMinutesLocal };

/** 公開デモと手元の確かめに使う架空の店。実在の店・人とは関係ありません */
export const DEMO_SHOP: ShopInfo = {
  name: 'ヘアサロン こもれび',
  tagline: '駅から3分、木の香りのする小さな美容室',
  address: '東京都架空区みどり町1-2-3 こもれびビル2階',
  access: 'みどり町駅 東口から徒歩3分。1階がパン屋さんのビルの2階です。',
  phone: '03-0000-0000',
  parking: '専用の駐車場はありません。ビルの向かいにコインパーキング（30分200円）があります。',
  payment: '現金、クレジットカード、交通系IC、QRコード決済が使えます。',
  hours: {
    mon: { open: '10:00', close: '19:00' },
    tue: null,
    wed: { open: '10:00', close: '19:00' },
    thu: { open: '10:00', close: '20:00' },
    fri: { open: '10:00', close: '20:00' },
    sat: { open: '09:00', close: '18:00' },
    sun: { open: '09:00', close: '18:00' },
  },
  closedDates: ['2026-11-18'],
  slotMinutes: 30,
  seats: 2,
  leadMinutes: 60,
  maxDaysAhead: 30,
  holdMinutes: 10,
  changeDeadlineHours: 3,
  menus: [
    { id: 'cut', name: 'カット', minutes: 60, price: 4800, description: 'シャンプー・ブロー込み。' },
    { id: 'cut-color', name: 'カット＋カラー', minutes: 120, price: 9800, description: '白髪染め・おしゃれ染めどちらも可。' },
    { id: 'headspa', name: 'ヘッドスパ', minutes: 30, price: 3000, description: '炭酸泉を使った頭皮のケア。' },
    { id: 'bangs', name: '前髪カット', minutes: 30, price: 1100, description: '前髪だけのカット。' },
  ],
  policies: {
    cancellation:
      '予約の変更・取り消しは、予約時刻の3時間前までLINEでできます。それ以降はお電話でご連絡ください。キャンセル料はいただいていません。',
    lateness: '15分以上遅れる場合は、内容を短くするか別の日に変更をお願いすることがあります。',
  },
  faq: [
    {
      q: '子ども連れでも大丈夫ですか',
      a: 'はい。ベビーカーのまま入れます。お子さまのカットは小学生まで3,300円です（予約は「カット」でお取りください）。',
    },
    { q: '男性も利用できますか', a: 'はい、男性のお客さまも多くいらっしゃいます。' },
    { q: '指名はできますか', a: 'スタイリストは2名です。指名のご希望は予約後にメッセージでお知らせください。' },
    { q: '縮毛矯正やパーマはできますか', a: '現在は受け付けていません。' },
  ],
  links: [],
};
