import { test, expect } from '@playwright/test';
import { playToEnd } from './helpers';

// 遅い端末の再現：画面の切り替え（View Transitions）の描き直しを 900ms 遅らせ、Chromium では CPU も 1/6 にする。
// 切り替えの途中で押しても、押せる状態のボタンが別物に差し替わって押し損ねないことを確かめる。
test.describe('遅い端末でも押し損ねない', () => {
  test.beforeEach(async ({ page, browserName }) => {
    await page.addInitScript(() => {
      const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
      const original = doc.startViewTransition?.bind(document);
      if (!original) return;
      doc.startViewTransition = (cb: () => void) =>
        original(() => new Promise<void>((r) => setTimeout(() => (cb(), r()), 900)) as unknown as void);
    });
    if (browserName === 'chromium') {
      const cdp = await page.context().newCDPSession(page);
      await cdp.send('Emulation.setCPUThrottlingRate', { rate: 6 });
    }
  });

  const cases: Array<[string, string]> = [
    ['会話で予約する', '14時でお願いします'],
    ['ボタンだけで予約する', 'ヘッドスパ'],
    ['予約の日時を変える', '日曜日の同じ時間'],
  ];
  for (const [scenario, mark] of cases) {
    test(`場面「${scenario}」に切り替えてすぐ操作しても、最後まで進む`, async ({ page }) => {
      test.setTimeout(180_000);
      await page.goto('/#demo');
      await expect(page.locator('#progress')).toHaveText(/^0 \//);
      await page.locator('#scenarios').getByRole('button', { name: scenario }).click();
      await playToEnd(page);
      await expect(page.locator('.chat-log')).toContainText(mark);
      await expect(page.locator('.chat-log')).toContainText('この記録はここまでです');
    });
  }
});
