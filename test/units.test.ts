import { describe, expect, it } from 'vitest';
import { redact } from '../src/domain/pii';
import { addMinutesLocal, formatJa, fromJstLocal, toJstLocal } from '../src/domain/time';
import { DEMO_SHOP, isOpenAt, nextOpening, shopSchema } from '../src/domain/shop';
import { MAIN_QUICK, holdCard, menuPicker, postbackData, slotCarousel, text } from '../src/line/messages';
import type { Booking } from '../src/domain/booking';

describe('伏せ字（個人情報）', () => {
  it.each([
    ['090-1234-5678', '［電話番号］'],
    ['09012345678', '［電話番号］'],
    ['０９０－１２３４－５６７８', '［電話番号］'],
    ['03-1234-5678', '［電話番号］'],
    ['+81 90-1234-5678', '［電話番号］'],
    ['(03)1234-5678', '［電話番号］'],
    ['taro.yamada+salon@example.co.jp', '［メール］'],
    ['4111 1111 1111 1111', '［カード番号］'],
    ['〒150-0001', '［郵便番号］'],
  ])('%s を伏せる', (input, label) => {
    expect(redact(`連絡先は${input}です`)).toBe(`連絡先は${label}です`);
  });

  it.each(['11月6日 14:00 にカット', '2026-11-06T14:00', '料金は4,800円', '予約番号 ABC234', '30分200円'])('伏せ字にしない：%s', (s) => {
    expect(redact(s)).toBe(s);
  });
});

describe('日本時間', () => {
  it('UTC との往復と、日付をまたぐ足し算', () => {
    expect(toJstLocal(new Date('2026-11-04T15:30:00Z'))).toBe('2026-11-05T00:30');
    expect(fromJstLocal('2026-11-05T00:30').toISOString()).toBe('2026-11-04T15:30:00.000Z');
    expect(addMinutesLocal('2026-12-31T23:30', 60)).toBe('2027-01-01T00:30');
    expect(formatJa('2026-11-06T14:00')).toBe('11月6日(金) 14:00');
    expect(() => fromJstLocal('2026-02-30T10:00')).toThrow();
  });

  it('営業中かどうかと次の営業開始', () => {
    expect(isOpenAt(DEMO_SHOP, fromJstLocal('2026-11-04T10:12'))).toBe(true);
    expect(isOpenAt(DEMO_SHOP, fromJstLocal('2026-11-04T19:00'))).toBe(false);
    expect(nextOpening(DEMO_SHOP, fromJstLocal('2026-11-09T20:00'))).toBe('2026-11-11T10:00'); // 火曜は定休
    expect(nextOpening(DEMO_SHOP, fromJstLocal('2026-11-17T22:00'))).toBe('2026-11-19T10:00'); // 18 日は臨時休業
  });
});

describe('LINE のメッセージの上限', () => {
  it('架空の店の情報は検査を通る', () => {
    expect(shopSchema.safeParse(DEMO_SHOP).success).toBe(true);
  });

  it('クイックリプライは 13 個・ラベル 20 文字まで、テキストは 5000 文字まで', () => {
    const many = Array.from({ length: 20 }, (_, i) => ({
      type: 'message' as const,
      label: `とても長いラベルの選択肢その${i}番目です`,
      text: 'x',
    }));
    const m = text('x'.repeat(6000), many);
    expect(m.type === 'text' && m.text.length).toBe(5000);
    expect(m.quickReply!.items).toHaveLength(13);
    expect(m.quickReply!.items.every((i) => i.action.label.length <= 20)).toBe(true);
    expect(MAIN_QUICK.length).toBeLessThanOrEqual(13);
    expect(menuPicker(DEMO_SHOP).quickReply!.items).toHaveLength(4);
  });

  it('空き枠のカルーセルは 10 日・1 日 12 枠まで、postback は 300 文字まで', () => {
    const slots: string[] = [];
    for (let d = 1; d <= 20; d++)
      for (let h = 9; h < 19; h++) slots.push(`2026-12-${String(d).padStart(2, '0')}T${String(h).padStart(2, '0')}:00`);
    const m = slotCarousel(DEMO_SHOP, 'cut', slots)!;
    expect(m.type).toBe('flex');
    const contents = (m as { contents: { contents: unknown[] } }).contents.contents;
    expect(contents).toHaveLength(10);
    const json = JSON.stringify(m);
    for (const [, data] of json.matchAll(/"data":"([^"]+)"/g)) expect(data!.length).toBeLessThanOrEqual(300);
    expect(() => postbackData({ a: 'x'.repeat(400) })).toThrow();
    expect(slotCarousel(DEMO_SHOP, 'cut', [])).toBeNull();
  });

  it('仮予約カードは確定とやめるの 2 つのボタンを持つ', () => {
    const b = {
      id: 'ABCDEFGHJKLM',
      menu_name: 'カット',
      start_at: '2026-11-06T14:00',
      end_at: '2026-11-06T15:00',
      price: 4800,
      customer_name: 'さくら',
    } as Booking;
    const json = JSON.stringify(holdCard(b, 10));
    expect(json).toContain('a=confirm&b=ABCDEFGHJKLM');
    expect(json).toContain('a=release&b=ABCDEFGHJKLM');
    expect(json).toContain('4,800円');
  });
});
