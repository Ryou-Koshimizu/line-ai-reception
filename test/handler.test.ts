import { env } from 'cloudflare:test';
import { afterEach, describe, expect, it, vi } from 'vitest';
import { handleEvent, type HandlerDeps } from '../src/bot/handle';
import { getConversation, recentMessages, setMode } from '../src/domain/conversation';
import type { ChatModel } from '../src/ai/model';
import { NOW, at, call, fakeLine, followEvent, postbackEvent, say, scriptedModel, seedShop, textEvent, textsOf } from './helpers';

function deps(line: ReturnType<typeof fakeLine>, model: ChatModel | null = null, now = NOW, staff: string[] = []): HandlerDeps {
  return { db: env.DB, line: line.client, model, staffUserIds: staff, now };
}

afterEach(() => vi.restoreAllMocks());

describe('友だち追加・ボタン', () => {
  it('友だち追加であいさつとクイックリプライを返す', async () => {
    await seedShop();
    const line = fakeLine();
    await handleEvent(deps(line), followEvent('U1'));
    const msg = line.sent[0]!.messages[0]!;
    expect(msg.type === 'text' && msg.text).toContain('ヘアサロン こもれび');
    expect(msg.quickReply!.items.map((i) => i.action.label)).toEqual([
      '予約する',
      '予約の確認・変更',
      'メニューと料金',
      '営業時間・場所',
      'スタッフに相談',
    ]);
  });

  it('ボタンだけで「メニュー → 空き枠 → 仮予約 → 確定」まで進める（AI なし）', async () => {
    await seedShop();
    const line = fakeLine();
    const d = deps(line);
    await handleEvent(d, postbackEvent('U1', 'a=book'));
    await handleEvent(d, postbackEvent('U1', 'a=slots&m=cut'));
    const carousel = line.sent[1]!.messages[1]!;
    expect(carousel.type).toBe('flex');
    const firstButton = JSON.stringify(carousel).match(/"data":"(a=hold[^"]+)"/)![1]!;
    await handleEvent(d, postbackEvent('U1', firstButton));
    const holdJson = JSON.stringify(line.sent[2]!.messages[0]);
    const confirmData = holdJson.match(/"data":"(a=confirm[^"]+)"/)![1]!;
    await handleEvent(d, postbackEvent('U1', confirmData));
    expect(textsOf(line.sent).at(-1)).toContain('予約が確定しました');
    const row = await env.DB.prepare("SELECT status, customer_name FROM bookings WHERE line_user_id = 'U1'").first();
    expect(row).toMatchObject({ status: 'confirmed', customer_name: 'テスト 太郎' });
  });

  it('同じ枠を 2 人がボタンで取り合うと、後の人には別の時間を案内する（2 席とも埋まった後）', async () => {
    await seedShop();
    const line = fakeLine();
    const d = deps(line);
    const data = 'a=hold&m=cut&s=2026-11-06T14%3A00';
    await handleEvent(d, postbackEvent('A', data));
    await handleEvent(d, postbackEvent('B', data));
    await handleEvent(d, postbackEvent('C', data));
    const last = line.sent.at(-1)!.messages[0]!;
    expect(last.type === 'text' && last.text).toContain('ちょうど埋まってしまいました');
    expect(last.quickReply!.items[0]!.action.label).toBe('ほかの時間を見る');
  });
});

describe('AI の返事', () => {
  it('入力中の表示を出してから、AI の返事とカードを返す', async () => {
    await seedShop();
    const line = fakeLine();
    const model = scriptedModel([[call('find_available_slots', { menu_id: 'cut', date_from: '2026-11-06' })], [say('6日の空きです。')]]);
    await handleEvent(deps(line, model), textEvent('U1', '6日にカットできますか'));
    expect(line.loading).toEqual(['U1']);
    expect(line.sent[0]!.messages.map((m) => m.type)).toEqual(['text', 'flex']);
  });

  it('引き継ぎ中（人が対応）は AI を呼ばない。営業時間外なら一度だけ自動で知らせる', async () => {
    await seedShop();
    const line = fakeLine();
    const model = scriptedModel([[say('呼ばれてはいけない')]]);
    await handleEvent(deps(line, model), followEvent('U1'));
    await setMode(env.DB, 'U1', 'human', 'test');
    await handleEvent(deps(line, model), textEvent('U1', 'よろしくお願いします'));
    expect(model.requests).toHaveLength(0);
    expect(line.sent).toHaveLength(1); // あいさつだけ（営業中なので自動応答なし）
    const night = at('2026-11-04T21:00');
    await handleEvent(deps(line, model, night), textEvent('U1', 'まだですか', night));
    await handleEvent(deps(line, model, night), textEvent('U1', 'もしもし', night));
    const notices = textsOf(line.sent).filter((t) => t.includes('営業時間外'));
    expect(notices).toHaveLength(1);
    expect(notices[0]).toContain('明日 10:00以降');
  });

  it('AI が引き継ぎを選ぶと、会話が「人が対応」になりスタッフに知らせが届く', async () => {
    await seedShop();
    const line = fakeLine();
    const model = scriptedModel([[call('handoff_to_staff', { reason: '髪のダメージの相談' })], [say('スタッフにおつなぎしました。')]]);
    await handleEvent(deps(line, model, NOW, ['U-staff']), textEvent('U1', 'スタッフと話したい'));
    expect((await getConversation(env.DB, 'U1'))!.mode).toBe('human');
    const staffPush = line.sent.find((s) => s.to === 'U-staff')!;
    expect(textsOf([staffPush])[0]).toContain('髪のダメージの相談');
  });

  it('AI の鍵がなければ、ボタンで選べる案内を返す', async () => {
    await seedShop();
    const line = fakeLine();
    await handleEvent(deps(line, null), textEvent('U1', 'こんにちは'));
    expect(line.sent[0]!.messages[0]!.quickReply!.items).toHaveLength(5);
  });

  it('10 分に 20 通を超えると、AI を呼ばずに少し待つよう伝える', async () => {
    await seedShop();
    const line = fakeLine();
    const model = scriptedModel([[say('はい')]]);
    for (let i = 0; i < 22; i++) await handleEvent(deps(line, model), textEvent('U1', `メッセージ${i}`));
    expect(model.requests).toHaveLength(20);
    expect(textsOf(line.sent).at(-1)).toContain('少し時間をおいて');
  });
});

describe('再送・届け方', () => {
  it('同じ webhookEventId は 1 回だけ処理する', async () => {
    await seedShop();
    const line = fakeLine();
    const model = scriptedModel([[say('はい')]]);
    const ev = textEvent('U1', 'こんにちは');
    await handleEvent(deps(line, model), ev);
    await handleEvent(deps(line, model), ev);
    await handleEvent(deps(line, model), { ...ev, deliveryContext: { isRedelivery: true } });
    expect(line.sent).toHaveLength(1);
    expect(model.requests).toHaveLength(1);
  });

  it('返信トークンが切れていたら、再送キー付きのプッシュに切り替える', async () => {
    await seedShop();
    const line = fakeLine({ replyFails: true });
    await handleEvent(deps(line, scriptedModel([[say('はい')]])), textEvent('U1', 'こんにちは'));
    expect(line.sent[0]).toMatchObject({ kind: 'push', to: 'U1' });
    expect(line.sent[0]!.retryKey).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
  });

  it('画像・スタンプには文字で送るよう案内する', async () => {
    await seedShop();
    const line = fakeLine();
    const ev = textEvent('U1', 'x');
    await handleEvent(deps(line), { ...ev, message: { type: 'sticker', id: 's1' } } as typeof ev);
    expect(textsOf(line.sent)[0]).toContain('文字で送るか');
  });
});

describe('個人情報', () => {
  it('電話番号・メールは伏せ字で保存し、記録（console）には本文も名前も出さない', async () => {
    await seedShop();
    const logs: string[] = [];
    for (const k of ['log', 'warn', 'error'] as const)
      vi.spyOn(console, k).mockImplementation((...a: unknown[]) => void logs.push(a.join(' ')));
    const line = fakeLine({ names: { U1: '佐藤 みどり' } });
    const model = scriptedModel([[say('承知しました。')]]);
    await handleEvent(deps(line, model), textEvent('U1', '電話は090-1234-5678、メールは midori@example.com です'));
    const stored = (await recentMessages(env.DB, 'U1')).map((m) => m.text).join('\n');
    expect(stored).toContain('［電話番号］');
    expect(stored).toContain('［メール］');
    expect(stored).not.toMatch(/090|midori/);
    // AI にも伏せ字の文だけが渡る
    expect(JSON.stringify(model.requests[0]!.messages)).not.toMatch(/090-1234|midori@/);
    const all = logs.join('\n');
    expect(all).not.toMatch(/090|midori|佐藤|電話は/);
    expect(all).not.toContain('U1');
  });
});
