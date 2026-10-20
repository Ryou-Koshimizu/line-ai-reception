import { createHmac } from 'node:crypto';
import { expect, type Page, type APIRequestContext } from '@playwright/test';
import AxeBuilder from '@axe-core/playwright';
import { DEMO_SHOP } from '../src/domain/shop';

export const E2E = {
  secret: 'e2e-channel-secret-0123456789abcdef',
  owner: 'e2e-owner-token-0123456789abcdef',
  staff: 'e2e-staff-token-0123456789abcdef',
};

export async function seedShop(request: APIRequestContext) {
  const res = await request.put('/api/admin/shop', { headers: { authorization: `Bearer ${E2E.owner}` }, data: DEMO_SHOP });
  expect(res.status()).toBe(200);
}

export async function sendWebhook(request: APIRequestContext, events: unknown[]) {
  const body = JSON.stringify({ destination: 'Ue2e', events });
  const sig = createHmac('sha256', E2E.secret).update(body).digest('base64');
  return request.post('/webhook', { headers: { 'content-type': 'application/json', 'x-line-signature': sig }, data: body });
}

/** WCAG 2.1 A/AA の違反を数える（0 件であること） */
export async function axe(page: Page, label: string) {
  // 出てくる動き（不透明度の変化）の途中で測らないよう、動きを止めた状態で測る
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.waitForFunction(() =>
    document.getAnimations().every((a) => a.playState !== 'running' || a.effect?.getTiming().iterations === Infinity),
  );
  await page.waitForTimeout(100);
  const result = await new AxeBuilder({ page }).withTags(['wcag2a', 'wcag2aa', 'wcag21a', 'wcag21aa']).analyze();
  const summary = result.violations.map(
    (v) =>
      `${v.id}: ${v.nodes.length} 件 ${v.nodes
        .slice(0, 2)
        .map((n) => n.target.join(' '))
        .join(' | ')}`,
  );
  expect(summary, `${label} の axe 違反`).toEqual([]);
}

/** 体験の筋書きを最後まで進める（光っているボタン・送信を順に押す） */
export async function playToEnd(page: Page) {
  const progress = page.locator('#progress');
  const stage = page.locator('#demo');
  for (let i = 0; i < 20; i++) {
    // 場面の切り替え（描き直し）が終わるまで待ってから、押せるものを毎回取り直す
    await expect(stage).not.toHaveAttribute('data-loading', /.*/);
    if ((await progress.textContent())?.includes('完了')) return;
    const before = await progress.textContent();
    const send = page.locator('.send:not([disabled])');
    const next = page.locator('.next:not([disabled])').last();
    await expect(send.or(next).first()).toBeVisible();
    // click は押す直前に要素を取り直し、見える位置まで送ってから押す
    if (await send.isVisible()) await send.click();
    else await next.click();
    await expect(progress).not.toHaveText(before ?? '', { timeout: 15_000 });
  }
  throw new Error('筋書きが終わりませんでした');
}
