import { describe, expect, it } from 'vitest';
import { CODE_ALPHABET, randomCode } from '../src/domain/booking';
import { checkRichMenuImage } from '../src/line/richmenu';
import { slotCarousel } from '../src/line/messages';
import { DEMO_SHOP } from '../src/domain/shop';
import { bookByButtons, slotParam } from '../scripts/live/scenarios';

describe('予約番号の乱数に偏りがない（棄却サンプリング）', () => {
  it('0〜255 を 1 回ずつ与えると、30 文字のどの文字もちょうど同じ回数だけ出る（剰余なら偏る）', () => {
    const alphabet = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123'; // 30 文字（2 のべき乗でない）
    let fed = false;
    const all = new Uint8Array(256).map((_, i) => i);
    const out = randomCode(240, alphabet, (buf) => {
      if (fed) throw new Error('使い切った');
      fed = true;
      expect(buf.length).toBeGreaterThanOrEqual(256);
      buf.set(all);
      return buf;
    });
    const counts = new Map<string, number>();
    for (const c of out) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect(counts.size).toBe(30);
    expect([...counts.values()].every((n) => n === 8)).toBe(true); // 256 / 32 = 8 回ずつ。30 以上の値は捨てる
  });

  it('範囲外の値は捨てて引き直す', () => {
    let call = 0;
    const out = randomCode(3, 'ABC', (buf) => {
      call++;
      buf.fill(call === 1 ? 3 : 1); // 3 は範囲外（2 ビットで 0〜3、使うのは 0〜2）
      return buf;
    });
    expect(out).toBe('BBB');
    expect(call).toBe(2);
  });

  it('実際の乱数でも、32 文字がおおむね均等に出る（カイ二乗）', () => {
    const s = Array.from({ length: 400 }, () => randomCode(80)).join('');
    const counts = new Map<string, number>();
    for (const c of s) counts.set(c, (counts.get(c) ?? 0) + 1);
    expect([...counts.keys()].every((c) => CODE_ALPHABET.includes(c))).toBe(true);
    const expected = s.length / CODE_ALPHABET.length;
    const chi = [...CODE_ALPHABET].reduce((sum, c) => sum + ((counts.get(c) ?? 0) - expected) ** 2 / expected, 0);
    expect(chi).toBeLessThan(70); // 自由度 31 の 99.99% 点はおよそ 70
  });
});

describe('実機の確かめで押す時刻ボタンの探し方', () => {
  it('ボット側と同じ規則で符号化し、その日時のボタンだけに一致する', () => {
    const slots = ['2026-11-06T11:00', '2026-11-06T11:30', '2026-11-07T11:00'];
    const card = slotCarousel(DEMO_SHOP, 'cut', slots)!;
    const datas = [...JSON.stringify(card).matchAll(/"data":"([^"]+)"/g)].map((m) => m[1]!);
    const want = slotParam('2026-11-07T11:00');
    expect(want).toBe('s=2026-11-07T11%3A00');
    expect(datas.filter((d) => d.split('&').includes(want))).toHaveLength(1);
    const step = bookByButtons('カット', '2026-11-07T11:00', '2026-11-04T10:00')[2]!;
    expect(step.tapData).toBe(want);
  });
});

function fakePng(width: number, height: number, size = 64): Uint8Array {
  const b = new Uint8Array(size);
  b.set([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a, 0, 0, 0, 13, 0x49, 0x48, 0x44, 0x52]);
  const v = new DataView(b.buffer);
  v.setUint32(16, width);
  v.setUint32(20, height);
  return b;
}

describe('リッチメニュー画像の確認（送る前）', () => {
  it('2500×1686 の PNG だけを通す', () => {
    expect(checkRichMenuImage(fakePng(2500, 1686))).toEqual({ ok: true });
    expect(checkRichMenuImage(fakePng(2500, 843)).ok).toBe(false);
    expect(checkRichMenuImage(new TextEncoder().encode('LINE_CHANNEL_SECRET=abc\n'.repeat(4))).ok).toBe(false);
    expect(checkRichMenuImage(fakePng(2500, 1686, 1024 * 1024 + 1)).ok).toBe(false);
    const broken = fakePng(2500, 1686);
    broken[12] = 0x58;
    expect(checkRichMenuImage(broken).ok).toBe(false);
  });
});
