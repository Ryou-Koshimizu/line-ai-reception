// リッチメニューの画像（2500×1686 の PNG）を、アイコン集（lucide）と店名から Playwright で描き出す
import { chromium } from '@playwright/test';
import { mkdirSync } from 'node:fs';
import * as lucide from 'lucide';
import { RICH_MENU_SIZE, RICH_MENU_TILES } from '../src/line/richmenu';

function svg(name: string): string {
  const node = (lucide as unknown as Record<string, Array<[string, Record<string, string>]>>)[name]!;
  const inner = node
    .map(
      ([tag, attrs]) =>
        `<${tag} ${Object.entries(attrs)
          .map(([k, v]) => `${k}="${v}"`)
          .join(' ')}/>`,
    )
    .join('');
  return `<svg viewBox="0 0 24 24" width="220" height="220" fill="none" stroke="#0b7a52" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">${inner}</svg>`;
}

const tiles = RICH_MENU_TILES.map((t) => `<div class="t">${svg(t.icon)}<b>${t.label}</b></div>`).join('');
const html = `<!doctype html><meta charset="utf-8"><style>
body{margin:0;width:${RICH_MENU_SIZE.width}px;height:${RICH_MENU_SIZE.height}px;display:grid;grid-template-columns:repeat(3,1fr);grid-template-rows:repeat(2,1fr);gap:28px;padding:28px;box-sizing:border-box;background:#e3e9f1;font-family:'Hiragino Sans','Noto Sans JP',sans-serif}
.t{display:grid;place-items:center;align-content:center;gap:44px;border-radius:72px;background:#e3e9f1;box-shadow:24px 24px 48px rgba(141,158,186,.55),-24px -24px 48px #fff}
b{font-size:88px;color:#18212f;white-space:nowrap}
</style>${tiles}`;

const out = 'richmenu/richmenu.png';
mkdirSync('richmenu', { recursive: true });
const browser = await chromium.launch();
const page = await browser.newPage({ viewport: { width: RICH_MENU_SIZE.width, height: RICH_MENU_SIZE.height } });
await page.setContent(html);
await page.screenshot({ path: out, type: 'png' });
await browser.close();
console.log(`wrote ${out}`);
