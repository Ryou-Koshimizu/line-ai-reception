// リッチメニューを LINE に登録し、全員の既定にする。
//   npm run richmenu:image                                  # richmenu/richmenu.png を作る
//   LINE_CHANNEL_ACCESS_TOKEN=... npm run richmenu:create
// 送る画像は、このリポジトリの richmenu/richmenu.png だけ（引数や環境変数で別のファイルを指せない）。
// 送る前に、PNG であること・1MB 以下・2500×1686 であることを確かめる。
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { checkRichMenuImage, richMenuDefinition } from '../src/line/richmenu';

const IMAGE = fileURLToPath(new URL('../richmenu/richmenu.png', import.meta.url));

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!token) {
  console.error('LINE_CHANNEL_ACCESS_TOKEN を環境変数に入れて実行してください');
  process.exit(1);
}
const png = new Uint8Array(readFileSync(IMAGE));
const check = checkRichMenuImage(png);
if (!check.ok) {
  console.error(`richmenu/richmenu.png を送れません：${check.reason}。npm run richmenu:image で作り直してください`);
  process.exit(1);
}

const auth = { authorization: `Bearer ${token}` };
const created = await fetch('https://api.line.me/v2/bot/richmenu', {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify(richMenuDefinition()),
});
if (!created.ok) throw new Error(`作成に失敗: ${created.status}`);
const { richMenuId } = (await created.json()) as { richMenuId: string };
if (!/^richmenu-[0-9a-f]{32}$/.test(richMenuId)) throw new Error('LINE から予期しない ID が返りました');
const image = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'image/png' },
  body: png,
});
if (!image.ok) throw new Error(`画像の登録に失敗: ${image.status}`);
const def = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, { method: 'POST', headers: auth });
if (!def.ok) throw new Error(`既定にできませんでした: ${def.status}`);
console.log(`リッチメニューを登録しました: ${richMenuId}`);
