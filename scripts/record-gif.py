"""README の GIF を、公開デモを Playwright で実際に操作しながら撮る。

  npm run build:web && npx vite preview --config web/vite.config.ts   # 別の端末で（127.0.0.1:3106）
  python3 scripts/record-gif.py [出力先] [場面のボタン名]

撮った画面を Pillow で GIF にまとめる（ffmpeg は使わない）。
"""
import io
import sys
import time

from PIL import Image
from playwright.sync_api import sync_playwright

OUT = sys.argv[1] if len(sys.argv) > 1 else 'docs/assets/demo.gif'
SCENARIO = sys.argv[2] if len(sys.argv) > 2 else '会話で予約する'
URL = 'http://127.0.0.1:3106/'
W, H = 1280, 800
SCALE = 0.72
FRAME_MS = 140

frames: list[tuple[Image.Image, int]] = []


def grab(page, hold_ms=FRAME_MS):
    png = page.screenshot(clip={'x': 0, 'y': 80, 'width': W, 'height': H - 80})
    img = Image.open(io.BytesIO(png)).convert('RGB')
    img = img.resize((int(W * SCALE), int((H - 80) * SCALE)), Image.LANCZOS)
    frames.append((img, hold_ms))


def film(page, seconds):
    end = time.time() + seconds
    while time.time() < end:
        t0 = time.time()
        grab(page)
        rest = FRAME_MS / 1000 - (time.time() - t0)
        if rest > 0:
            time.sleep(rest)


with sync_playwright() as p:
    browser = p.chromium.launch()
    page = browser.new_page(viewport={'width': W, 'height': H}, device_scale_factor=1)
    page.goto(URL, wait_until='networkidle')
    page.emulate_media(reduced_motion='no-preference')
    page.evaluate("document.documentElement.style.scrollBehavior = 'auto'; window.scrollTo(0, document.getElementById('demo').offsetTop - 80)")
    page.wait_for_timeout(400)
    page.get_by_role('button', name=SCENARIO).click()
    page.wait_for_timeout(900)
    film(page, 0.8)
    for _ in range(12):
        if '完了' in (page.locator('#progress').text_content() or ''):
            break
        send = page.locator('.send:not([disabled])')
        nxt = page.locator('.next:not([disabled])').last
        film(page, 0.9)
        if send.is_visible():
            send.click()
        else:
            nxt.scroll_into_view_if_needed()
            nxt.click()
        film(page, 3.4)
    film(page, 1.4)
    frames[-1] = (frames[-1][0], 2600)
    browser.close()

palette_src = frames[len(frames) // 2][0].quantize(colors=128, method=Image.Quantize.MEDIANCUT)
images = [f.quantize(palette=palette_src, dither=Image.Dither.NONE) for f, _ in frames]
durations = [d for _, d in frames]
images[0].save(OUT, save_all=True, append_images=images[1:], duration=durations, loop=0, optimize=True, disposal=1)
print(f'wrote {OUT} ({len(images)} frames)')
