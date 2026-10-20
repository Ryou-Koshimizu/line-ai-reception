// LINE に送るメッセージ（テキスト・クイックリプライ・Flex Message）を組み立てる。
// 上限（クイックリプライ 13 個・カルーセル 12 枚・postback の data 300 文字・テキスト 5000 文字・カルーセル 50KB）を守る。
import type { FlexContainer, LineMessage, QuickReplyItem } from './types';
import { formatJa } from '../domain/time';
import { bookingCode, type Booking } from '../domain/booking';
import type { ShopInfo } from '../domain/shop';

const ACCENT = '#0B7A52';
const INK = '#1D2738';
const SUB = '#4A5568';

export function postbackData(params: Record<string, string>): string {
  const data = new URLSearchParams(params).toString();
  if (data.length > 300) throw new Error('POSTBACK_TOO_LONG');
  return data;
}

export function quickReplies(items: QuickReplyItem['action'][]): { items: QuickReplyItem[] } {
  return {
    items: items.slice(0, 13).map((action) => ({ type: 'action' as const, action: { ...action, label: action.label.slice(0, 20) } })),
  };
}

export function text(body: string, quick?: QuickReplyItem['action'][]): LineMessage {
  const t = body.length > 5000 ? `${body.slice(0, 4999)}…` : body;
  return quick?.length ? { type: 'text', text: t, quickReply: quickReplies(quick) } : { type: 'text', text: t };
}

export const MAIN_QUICK: QuickReplyItem['action'][] = [
  { type: 'postback', label: '予約する', data: 'a=book', displayText: '予約したい' },
  { type: 'postback', label: '予約の確認・変更', data: 'a=mine', displayText: '予約を確認したい' },
  { type: 'postback', label: 'メニューと料金', data: 'a=menu', displayText: 'メニューと料金を見たい' },
  { type: 'postback', label: '営業時間・場所', data: 'a=hours', displayText: '営業時間と場所を知りたい' },
  { type: 'postback', label: 'スタッフに相談', data: 'a=staff', displayText: 'スタッフに相談したい' },
];

export function menuPicker(shop: ShopInfo): LineMessage {
  return text(
    'ご希望のメニューを選んでください。',
    shop.menus.map((m) => ({
      type: 'postback' as const,
      label: m.name,
      data: postbackData({ a: 'slots', m: m.id }),
      displayText: `${m.name}で予約したい`,
    })),
  );
}

function bubble(props: Record<string, unknown>) {
  return { type: 'bubble' as const, ...props };
}

/** 空き枠を日ごとのカードにして横に並べる。時刻を押すとそのまま仮予約になる */
export function slotCarousel(shop: ShopInfo, menuId: string, slots: string[]): LineMessage | null {
  const menu = shop.menus.find((m) => m.id === menuId);
  if (!menu || slots.length === 0) return null;
  const byDay = new Map<string, string[]>();
  for (const s of slots) {
    const d = s.slice(0, 10);
    if (!byDay.has(d)) byDay.set(d, []);
    byDay.get(d)!.push(s);
  }
  const bubbles = [...byDay.entries()].slice(0, 10).map(([day, times]) => {
    const rows: unknown[] = [];
    const shown = times.slice(0, 18);
    for (let i = 0; i < shown.length; i += 3) {
      rows.push({
        type: 'box',
        layout: 'horizontal',
        spacing: 'sm',
        contents: shown.slice(i, i + 3).map((s) => ({
          type: 'button',
          style: 'secondary',
          height: 'sm',
          action: {
            type: 'postback',
            label: s.slice(11),
            data: postbackData({ a: 'hold', m: menu.id, s }),
            displayText: `${formatJa(s)}でお願いします`,
          },
        })),
      });
    }
    return bubble({
      size: 'kilo',
      header: {
        type: 'box',
        layout: 'vertical',
        contents: [
          { type: 'text', text: formatJa(`${day}T00:00`, false), weight: 'bold', size: 'lg', color: INK },
          { type: 'text', text: `${menu.name}・${menu.minutes}分`, size: 'sm', color: SUB },
        ],
      },
      body: { type: 'box', layout: 'vertical', spacing: 'sm', contents: rows },
    });
  });
  return {
    type: 'flex',
    altText: `${menu.name}の空き枠（${bubbles.length}日分）`,
    contents: { type: 'carousel', contents: bubbles } as FlexContainer,
    quickReply: quickReplies([{ type: 'message', label: 'ほかの日で探す', text: 'ほかの日の空きも見たい' }]),
  };
}

function row(label: string, value: string) {
  return {
    type: 'box',
    layout: 'baseline',
    spacing: 'md',
    contents: [
      { type: 'text', text: label, size: 'sm', color: SUB, flex: 2 },
      { type: 'text', text: value, size: 'sm', color: INK, flex: 5, wrap: true },
    ],
  };
}

function bookingRows(b: Booking) {
  return [
    row('日時', `${formatJa(b.start_at)}〜${b.end_at.slice(11)}`),
    row('メニュー', b.menu_name),
    row('料金', `${b.price.toLocaleString('ja-JP')}円`),
    row('お名前', `${b.customer_name} 様`),
  ];
}

/** 仮予約の確認。「確定する」を押すまで予約は確定しない */
export function holdCard(b: Booking, holdMinutes: number): LineMessage {
  return {
    type: 'flex',
    altText: `仮予約：${formatJa(b.start_at)} ${b.menu_name}。確定ボタンを押してください`,
    contents: bubble({
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: 'この内容で予約しますか？', weight: 'bold', size: 'md', color: INK },
          { type: 'text', text: `${holdMinutes}分間、この枠を押さえています`, size: 'xs', color: SUB },
          { type: 'separator' },
          ...bookingRows(b),
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        spacing: 'sm',
        contents: [
          {
            type: 'button',
            style: 'primary',
            color: ACCENT,
            action: {
              type: 'postback',
              label: '予約を確定する',
              data: postbackData({ a: 'confirm', b: b.id }),
              displayText: '予約を確定します',
            },
          },
          {
            type: 'button',
            style: 'link',
            height: 'sm',
            action: { type: 'postback', label: 'やめる', data: postbackData({ a: 'release', b: b.id }), displayText: 'やめておきます' },
          },
        ],
      },
    }) as FlexContainer,
  };
}

export function confirmedCard(b: Booking, shop: ShopInfo): LineMessage {
  return {
    type: 'flex',
    altText: `予約が確定しました：${formatJa(b.start_at)} ${b.menu_name}`,
    contents: bubble({
      body: {
        type: 'box',
        layout: 'vertical',
        spacing: 'md',
        contents: [
          { type: 'text', text: '予約が確定しました', weight: 'bold', size: 'md', color: ACCENT },
          { type: 'text', text: `予約番号 ${bookingCode(b)}`, size: 'xs', color: SUB },
          { type: 'separator' },
          ...bookingRows(b),
          { type: 'text', text: shop.address, size: 'xs', color: SUB, wrap: true },
        ],
      },
      footer: {
        type: 'box',
        layout: 'vertical',
        contents: [
          {
            type: 'button',
            style: 'secondary',
            height: 'sm',
            action: { type: 'postback', label: '予約の確認・変更', data: 'a=mine', displayText: '予約を確認したい' },
          },
        ],
      },
    }) as FlexContainer,
  };
}

export function myBookingsCard(bookings: Booking[]): LineMessage {
  if (bookings.length === 0) return text('いまお受けしている予約はありません。', MAIN_QUICK.slice(0, 1));
  return {
    type: 'flex',
    altText: `ご予約 ${bookings.length}件`,
    contents: {
      type: 'carousel',
      contents: bookings.slice(0, 5).map((b) =>
        bubble({
          size: 'kilo',
          body: {
            type: 'box',
            layout: 'vertical',
            spacing: 'sm',
            contents: [
              { type: 'text', text: b.status === 'held' ? '仮予約（未確定）' : 'ご予約', size: 'xs', color: SUB },
              ...bookingRows(b).slice(0, 3),
            ],
          },
          footer: {
            type: 'box',
            layout: 'vertical',
            contents: [
              {
                type: 'button',
                style: 'link',
                height: 'sm',
                action: {
                  type: 'postback',
                  label: '取り消す',
                  data: postbackData({ a: 'cancel_ask', b: b.id }),
                  displayText: 'この予約を取り消したい',
                },
              },
            ],
          },
        }),
      ),
    } as FlexContainer,
    quickReply: quickReplies([{ type: 'message', label: '日時を変えたい', text: '予約の日時を変えたい' }]),
  };
}

export function cancelConfirm(b: Booking): LineMessage {
  return text(`${formatJa(b.start_at)}の${b.menu_name}を取り消しますか？`, [
    { type: 'postback', label: '取り消す', data: postbackData({ a: 'cancel', b: b.id }), displayText: '取り消します' },
    { type: 'postback', label: 'やめる', data: 'a=noop', displayText: 'やっぱりそのままで' },
  ]);
}
