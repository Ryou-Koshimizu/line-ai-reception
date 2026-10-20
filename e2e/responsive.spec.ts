import { test, expect, type Page } from '@playwright/test';
import { E2E } from './helpers';

// 25 種の画面の大きさで：横はみ出し 0・ヘッダー 80px・ヒーロー＝画面の高さ − 80px・ヒーローの中身が最初の画面に収まる・文字の欠けと重なり 0
const SIZES: Array<[number, number]> = [
  [280, 653],
  [320, 568],
  [360, 640],
  [375, 667],
  [390, 844],
  [393, 852],
  [412, 915],
  [430, 932],
  [568, 320],
  [667, 375],
  [844, 390],
  [932, 430],
  [600, 960],
  [768, 1024],
  [820, 1180],
  [1024, 768],
  [1024, 1366],
  [1180, 820],
  [1280, 720],
  [1366, 768],
  [1440, 900],
  [1536, 864],
  [1920, 1080],
  [2560, 1440],
  [3840, 2160],
];

interface Box {
  sel: string;
  top: number;
  bottom: number;
  left: number;
  right: number;
  clipped: boolean;
}

async function layout(page: Page, selectors: string[]) {
  return page.evaluate((sels) => {
    const boxes: Box[] = [];
    for (const sel of sels) {
      for (const el of document.querySelectorAll<HTMLElement>(sel)) {
        if (!el.offsetParent && getComputedStyle(el).position !== 'fixed') continue; // 表示していないもの
        const r = el.getBoundingClientRect();
        if (r.width === 0 || r.height === 0) continue;
        boxes.push({
          sel,
          top: r.top,
          bottom: r.bottom,
          left: r.left,
          right: r.right,
          clipped:
            el.scrollWidth > el.clientWidth + 1 &&
            getComputedStyle(el).overflowX !== 'visible' &&
            getComputedStyle(el).textOverflow !== 'ellipsis' &&
            getComputedStyle(el).overflowX !== 'auto',
        });
      }
    }
    return {
      boxes,
      vw: window.innerWidth,
      vh: window.innerHeight,
      sw: document.documentElement.scrollWidth,
      header: document.querySelector('.site-header')!.getBoundingClientRect().height,
    };
  }, selectors);
}

function overlaps(a: Box, b: Box) {
  return a.left < b.right - 1 && b.left < a.right - 1 && a.top < b.bottom - 1 && b.top < a.bottom - 1;
}

async function checkFirstView(page: Page, heroSel: string, items: string[], label: string) {
  const l = await layout(page, [heroSel, ...items]);
  expect(l.sw, `${label}：横はみ出し`).toBeLessThanOrEqual(l.vw);
  expect(l.header, `${label}：ヘッダーの高さ`).toBeCloseTo(80, 0);
  const hero = l.boxes.find((b) => b.sel === heroSel)!;
  expect(hero.top, `${label}：ヒーローの上端`).toBeCloseTo(80, 0);
  expect(hero.bottom - hero.top, `${label}：ヒーローの高さ`).toBeCloseTo(l.vh - 80, 0);
  const inner = l.boxes.filter((b) => b.sel !== heroSel);
  expect(inner.length, `${label}：ヒーローの中身`).toBeGreaterThan(0);
  for (const b of inner) {
    expect(b.bottom, `${label}：${b.sel} が画面の下にはみ出す`).toBeLessThanOrEqual(l.vh + 0.5);
    expect(b.top, `${label}：${b.sel} がヘッダーに隠れる`).toBeGreaterThanOrEqual(80 - 0.5);
    expect(b.left, `${label}：${b.sel} が左にはみ出す`).toBeGreaterThanOrEqual(-0.5);
    expect(b.right, `${label}：${b.sel} が右にはみ出す`).toBeLessThanOrEqual(l.vw + 0.5);
    expect(b.clipped, `${label}：${b.sel} の文字が欠ける`).toBe(false);
  }
  for (let i = 0; i < inner.length; i++)
    for (let j = i + 1; j < inner.length; j++)
      expect(overlaps(inner[i]!, inner[j]!), `${label}：${inner[i]!.sel} と ${inner[j]!.sel} が重なる`).toBe(false);
}

for (const [w, h] of SIZES) {
  test(`${w}x${h}：デモ・体験・管理画面が最初の画面に収まる`, async ({ page }) => {
    await page.setViewportSize({ width: w, height: h });
    await page.emulateMedia({ reducedMotion: 'reduce' });
    // デモのヒーロー
    await page.goto('/');
    await page.waitForLoadState('networkidle');
    await checkFirstView(page, '.hero', ['.hero .eyebrow', '.hero h1', '.hero .lead', '.hero-actions', '.hero .proof'], `${w}x${h} デモ`);
    // 体験（業務アプリの画面）：ヘッダーの下からちょうど画面の高さに収まり、主な操作が見えている
    await page.evaluate(() => window.scrollTo(0, document.getElementById('demo')!.offsetTop - 80));
    await page.waitForTimeout(150);
    const stage = await layout(page, ['#demo', '#scenarios', '.chat-input', '.player-bar', '.stage-tabs']);
    const st = stage.boxes.find((b) => b.sel === '#demo')!;
    expect(stage.sw).toBeLessThanOrEqual(stage.vw);
    expect(st.top, '体験の上端').toBeCloseTo(80, 0);
    expect(st.bottom - st.top, '体験の高さ').toBeCloseTo(stage.vh - 80, 0);
    for (const b of stage.boxes.filter((x) => x.sel !== '#demo')) {
      expect(b.bottom, `体験：${b.sel} が画面の下にはみ出す`).toBeLessThanOrEqual(stage.vh + 0.5);
      expect(b.right, `体験：${b.sel} が右にはみ出す`).toBeLessThanOrEqual(stage.vw + 0.5);
    }
    // 管理画面の入口（ログイン＝ヒーロー）
    await page.goto('/admin/');
    await checkFirstView(
      page,
      '#login',
      ['.login-card .eyebrow', '.login-card h1', '.login-card .lead', '.token-label', '.login-card .hero-actions'],
      `${w}x${h} ログイン`,
    );
    // ログイン後：予約表のタブと日付の操作が最初の画面に見えている
    await page.getByLabel('鍵').fill(E2E.staff);
    await page.getByRole('button', { name: 'ログイン' }).click();
    await expect(page.locator('.cal')).toBeVisible();
    const app = await layout(page, ['#app', '.admin-tabs', '.cal-head']);
    expect(app.sw).toBeLessThanOrEqual(app.vw);
    const appBox = app.boxes.find((b) => b.sel === '#app')!;
    expect(appBox.bottom - appBox.top, '管理画面の高さ').toBeCloseTo(app.vh - 80, 0);
    for (const b of app.boxes.filter((x) => x.sel !== '#app')) {
      expect(b.bottom, `管理画面：${b.sel} が画面の下にはみ出す`).toBeLessThanOrEqual(app.vh + 0.5);
      expect(b.right, `管理画面：${b.sel} が右にはみ出す`).toBeLessThanOrEqual(app.vw + 0.5);
    }
  });
}
