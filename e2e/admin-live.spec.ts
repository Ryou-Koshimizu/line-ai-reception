import { test, expect } from '@playwright/test';
import { E2E, axe, seedShop, sendWebhook } from './helpers';

// 実運用の管理画面（/admin/）：wrangler dev の Worker と D1 に対して、鍵でログインして操作する
test.describe('管理画面（実運用）', () => {
  test.beforeEach(async ({ request }) => {
    await seedShop(request);
  });

  test('違う鍵ではログインできない', async ({ page }) => {
    await page.goto('/admin/');
    await axe(page, '管理画面のログイン');
    await page.getByLabel('鍵').fill('this-is-not-the-right-token');
    await page.getByRole('button', { name: 'ログイン' }).click();
    await expect(page.getByRole('alert')).toHaveText('鍵が違います');
    await expect(page.locator('#app')).toBeHidden();
  });

  test('スタッフの鍵：予約表と会話は使えるが、店の情報は編集できない', async ({ page }) => {
    await page.goto('/admin/');
    await page.getByLabel('鍵').fill(E2E.staff);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await expect(page.locator('#role')).toHaveText('スタッフ');
    await expect(page.locator('.cal')).toBeVisible();
    await page.locator('.admin-tabs').getByRole('button', { name: '店の情報' }).click();
    await expect(page.getByRole('button', { name: '保存する' })).toBeDisabled();
    await expect(page.locator('.shop-form')).toContainText('店長（オーナー）の鍵');
  });

  test('店長の鍵：電話の予約が予約表に出て、LINE の会話を引き取ってスタッフとして返信できる', async ({ page, request }, info) => {
    const day = info.project.name === 'webkit' ? '2026-12-02' : '2026-12-03';
    const userId = `U-e2e-${info.project.name}`;
    const add = await request.post('/api/admin/bookings', {
      headers: { authorization: `Bearer ${E2E.owner}` },
      data: { customerName: `電話の${info.project.name}様`, menuId: 'cut', start: `${day}T13:00` },
    });
    expect(add.status()).toBe(201);
    // LINE からメッセージが届く（AI の鍵がないので、ボタンの案内を返す）
    const res = await sendWebhook(request, [
      {
        type: 'message',
        webhookEventId: `E2E-${info.project.name}-${Date.now()}`,
        timestamp: Date.now(),
        source: { type: 'user', userId },
        deliveryContext: { isRedelivery: false },
        mode: 'active',
        replyToken: `rt-e2e-${info.project.name}`,
        message: { type: 'text', id: 'm1', text: '電話は 090-1234-5678 です。予約の相談をしたいです' },
      },
    ]);
    expect(res.status()).toBe(200);

    await page.goto('/admin/');
    await page.getByLabel('鍵').fill(E2E.owner);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await expect(page.locator('#role')).toHaveText('店長');
    await axe(page, '管理画面（ログイン後）');

    // 予約表をその日へ送る
    for (let i = 0; i < 60; i++) {
      if ((await page.locator('.cal-head .date').textContent())?.startsWith(`${Number(day.slice(5, 7))}月${Number(day.slice(8))}日`)) break;
      await page.getByRole('button', { name: '次の日' }).click();
    }
    await expect(page.locator('.cal .bk', { hasText: `電話の${info.project.name}様` })).toBeVisible();

    // 会話：伏せ字で保存され、引き取ると返信できる
    await page.locator('.admin-tabs').getByRole('button', { name: /会話/ }).click();
    await expect.poll(async () => page.locator('.conv').count(), { timeout: 15_000 }).toBeGreaterThan(0);
    await page.locator('.conv', { hasText: 'お客様' }).first().click();
    await expect(page.locator('.thread')).toContainText('［電話番号］');
    await expect(page.locator('.thread')).not.toContainText('090-1234-5678');
    await page.getByRole('switch', { name: '人が引き取る' }).click();
    await expect(page.getByRole('textbox', { name: 'スタッフとして返信' })).toBeEnabled();
    await page.getByRole('textbox', { name: 'スタッフとして返信' }).fill('スタッフの田中です。ご希望の日時をお知らせください。');
    await page.getByRole('button', { name: '送る' }).click();
    await expect(page.locator('.thread')).toContainText('スタッフの田中です');
    const log = (await (await request.get('http://127.0.0.1:3106/__log')).json()) as Array<{
      kind: string;
      to?: string;
      retryKey?: string;
    }>;
    const push = log.find((c) => c.kind === 'push' && c.to === userId);
    expect(push?.retryKey).toMatch(/^[0-9a-f-]{36}$/);
    await axe(page, '会話の引き取り（実運用）');
  });

  test('店長の鍵：店の情報を保存すると API に反映される', async ({ page, request }) => {
    await page.goto('/admin/');
    await page.getByLabel('鍵').fill(E2E.owner);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await page.locator('.admin-tabs').getByRole('button', { name: '店の情報' }).click();
    await page.getByRole('spinbutton', { name: 'メニュー3の料金（円）' }).fill('3300');
    await page.getByRole('button', { name: '保存する' }).click();
    await expect(page.locator('.toast')).toContainText('保存しました');
    const shop = (await (await request.get('/api/admin/shop', { headers: { authorization: `Bearer ${E2E.staff}` } })).json()) as {
      shop: { menus: Array<{ price: number }> };
    };
    expect(shop.shop.menus[2]!.price).toBe(3300);
    await axe(page, '店の情報（実運用）');
  });
});
