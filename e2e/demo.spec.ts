import { test, expect } from '@playwright/test';
import { axe, playToEnd } from './helpers';
import recordings from '../web/src/demo/recordings.json' with { type: 'json' };

const scenarios = (recordings as { scenarios: Array<{ id: string; title: string; ai: boolean; turns: unknown[] }> }).scenarios.filter(
  (s) => s.turns.length,
);

test.describe('公開デモ（記録の再生）', () => {
  test('最初の画面に見出し・説明・ボタンと、再生であることの表示がある', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByRole('heading', { level: 1 })).toContainText('予約まで取る');
    await expect(page.getByRole('link', { name: 'デモを動かす' })).toBeVisible();
    await expect(page.locator('#replay-badge')).toContainText('実AIの記録を再生しています');
    await axe(page, 'デモの最初の画面');
  });

  for (const s of scenarios) {
    test(`場面「${s.title}」を最後まで操作できる`, async ({ page }) => {
      await page.goto('/#demo');
      await page.locator('#scenarios').getByRole('button', { name: s.title }).click();
      await expect(page.locator('#progress')).toHaveText(
        new RegExp(`^0 / ${s.turns.filter((t) => !(t as { prelude?: boolean }).prelude).length}`),
      );
      await playToEnd(page);
      await expect(page.locator('.chat-log')).toContainText('この記録はここまでです');
      // 管理画面が同じ時点の状態に変わっている
      await expect(page.locator('.admin .stat b').first()).not.toHaveText('');
      if (s.ai) await expect(page.locator('.tools li').first()).toBeVisible();
    });
  }

  test('予約の確定で予約表にピンが刺さり、日と週を切り替えられる', async ({ page }) => {
    await page.goto('/#demo');
    await page.locator('#scenarios').getByRole('button', { name: '会話で予約する' }).click();
    await playToEnd(page);
    await expect(page.locator('.cal .bk', { hasText: 'あおい' })).toBeVisible();
    await expect(page.locator('.cal .pin')).toHaveCount(1);
    await page.getByRole('button', { name: '週', exact: true }).click();
    await expect(page.locator('.cal.week')).toBeVisible();
    await expect(page.locator('.cal-col-head')).toHaveCount(7);
    await axe(page, '予約が確定した後の体験');
  });

  test('管理画面で「人が引き取る」にすると AI が止まり、スタッフの返信がトークに出る', async ({ page }) => {
    await page.goto('/#demo');
    await page.locator('#scenarios').getByRole('button', { name: 'よくある質問' }).click();
    await page.locator('.admin-tabs').getByRole('button', { name: /会話/ }).click();
    const sw = page.getByRole('switch', { name: '人が引き取る' });
    await sw.click();
    await expect(page.locator('.chat-log')).toContainText('スタッフが会話を引き取りました');
    await expect(page.locator('.send')).toBeDisabled();
    const field = page.getByRole('textbox', { name: 'スタッフとして返信' });
    await expect(field).toBeEnabled();
    await field.fill('担当の田中です。駐車場は向かいのコインパーキングをご利用ください。');
    await page.getByRole('button', { name: '送る' }).click();
    await expect(page.locator('.chat-log .msg.bot').last()).toContainText('担当の田中です');
    await axe(page, '会話の引き取り');
    await page.getByRole('switch', { name: '人が引き取る' }).click();
    await expect(page.locator('.send')).toBeEnabled();
  });

  test('店の情報を編集して保存できる（デモではブラウザの中だけ）', async ({ page }) => {
    await page.goto('/#demo');
    await page.locator('.admin-tabs').getByRole('button', { name: '店の情報' }).click();
    const price = page.getByRole('spinbutton', { name: 'メニュー1の料金（円）' });
    await price.fill('5200');
    await page.getByRole('button', { name: '保存する' }).click();
    await expect(page.locator('.toast')).toContainText('ブラウザの中に保存しました');
    await axe(page, '店の情報');
  });

  test('スマホ幅ではトークと管理画面をタブで切り替える', async ({ page }) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await page.goto('/#demo');
    await expect(page.locator('.phone')).toBeVisible();
    await expect(page.locator('.pane-admin')).toBeHidden();
    await page.locator('.stage-tabs').getByRole('button', { name: '管理画面' }).click();
    await expect(page.locator('.pane-admin')).toBeVisible();
    await expect(page.locator('.phone')).toBeHidden();
    await axe(page, 'スマホ幅の管理画面');
  });
});
