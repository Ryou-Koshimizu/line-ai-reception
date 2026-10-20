import { describe, expect, it } from 'vitest';
import { signLineBody, timingSafeEqual, verifyLineSignature } from '../src/line/signature';

const SECRET = 'channel-secret-for-tests';
const enc = (s: string) => new TextEncoder().encode(s);

function randomBody(i: number): string {
  const words = ['予約', 'カット', 'hello', '😀', '"quoted"', '\\n', '午後', String(i)];
  const events = Array.from({ length: (i % 3) + 1 }, (_, k) => ({
    type: 'message',
    webhookEventId: `ev-${i}-${k}`,
    message: { type: 'text', text: words.slice(0, ((i + k) % words.length) + 1).join(' ') },
  }));
  return JSON.stringify({ destination: 'U0', events });
}

describe('timingSafeEqual', () => {
  it('同じ内容だけを等しいとする', () => {
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 3]))).toBe(true);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2, 4]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([1, 2, 3]), new Uint8Array([1, 2]))).toBe(false);
    expect(timingSafeEqual(new Uint8Array([]), new Uint8Array([]))).toBe(true);
  });
});

describe('X-Line-Signature の検証', () => {
  it('正しい署名は 300 通りの本文すべてで通る（誤って拒否しない）', async () => {
    for (let i = 0; i < 300; i++) {
      const body = randomBody(i);
      const sig = await signLineBody(SECRET, body);
      expect(await verifyLineSignature(SECRET, enc(body), sig)).toBe(true);
    }
  });

  it('本文を 1 バイトでも変えると拒否する（300 通り）', async () => {
    for (let i = 0; i < 300; i++) {
      const body = enc(randomBody(i));
      const sig = await signLineBody(SECRET, new TextDecoder().decode(body));
      const tampered = body.slice();
      const pos = (i * 7919) % tampered.length;
      tampered[pos] = tampered[pos]! ^ (1 << (i % 8));
      expect(await verifyLineSignature(SECRET, tampered, sig)).toBe(false);
    }
  });

  it('署名の 1 ビットを変えると拒否する', async () => {
    const body = randomBody(1);
    const sig = await signLineBody(SECRET, body);
    const bytes = Uint8Array.from(atob(sig), (c) => c.charCodeAt(0));
    for (let bit = 0; bit < bytes.length * 8; bit += 13) {
      const b = bytes.slice();
      b[bit >> 3] = b[bit >> 3]! ^ (1 << (bit & 7));
      expect(await verifyLineSignature(SECRET, enc(body), btoa(String.fromCharCode(...b)))).toBe(false);
    }
  });

  it('別のシークレットで作った署名・署名なし・形の崩れた署名を拒否する', async () => {
    const body = randomBody(2);
    const good = await signLineBody(SECRET, body);
    expect(await verifyLineSignature(SECRET, enc(body), await signLineBody('other-secret', body))).toBe(false);
    for (const bad of [
      undefined,
      null,
      '',
      ' ',
      good.slice(0, -2),
      `${good}A`,
      ` ${good}`,
      good.replace(/=$/, ''),
      '!'.repeat(44),
      good.toLowerCase(),
      'A'.repeat(44),
    ]) {
      expect(await verifyLineSignature(SECRET, enc(body), bad)).toBe(false);
    }
  });

  it('シークレットが空なら常に拒否する', async () => {
    const body = randomBody(3);
    expect(await verifyLineSignature('', enc(body), await signLineBody('x', body))).toBe(false);
  });

  it('日本語・絵文字を含む本文も、受け取ったバイト列のまま検証する', async () => {
    const body = '{"events":[{"message":{"text":"明日の午後、カットできますか？😀"}}]}';
    const sig = await signLineBody(SECRET, body);
    expect(await verifyLineSignature(SECRET, enc(body), sig)).toBe(true);
    // JSON として同じでも、空白が違えばバイト列が違うので拒否する
    expect(await verifyLineSignature(SECRET, enc(JSON.stringify(JSON.parse(body), null, 1)), sig)).toBe(false);
  });
});
