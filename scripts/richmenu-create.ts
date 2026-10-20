// リッチメニューを LINE に登録し、全員の既定にする。
//   LINE_CHANNEL_ACCESS_TOKEN=... npm run richmenu:create
import { readFileSync } from 'node:fs';
import { richMenuDefinition } from '../src/line/richmenu';

const token = process.env.LINE_CHANNEL_ACCESS_TOKEN;
if (!token) {
  console.error('LINE_CHANNEL_ACCESS_TOKEN を環境変数に入れて実行してください');
  process.exit(1);
}
const auth = { authorization: `Bearer ${token}` };
const created = await fetch('https://api.line.me/v2/bot/richmenu', {
  method: 'POST',
  headers: { ...auth, 'content-type': 'application/json' },
  body: JSON.stringify(richMenuDefinition()),
});
if (!created.ok) throw new Error(`作成に失敗: ${created.status} ${await created.text()}`);
const { richMenuId } = (await created.json()) as { richMenuId: string };
const image = await fetch(`https://api-data.line.me/v2/bot/richmenu/${richMenuId}/content`, {
  method: 'POST',
  headers: { ...auth, 'content-type': 'image/png' },
  body: readFileSync('richmenu/richmenu.png'),
});
if (!image.ok) throw new Error(`画像の登録に失敗: ${image.status} ${await image.text()}`);
const def = await fetch(`https://api.line.me/v2/bot/user/all/richmenu/${richMenuId}`, { method: 'POST', headers: auth });
if (!def.ok) throw new Error(`既定にできませんでした: ${def.status} ${await def.text()}`);
console.log(`リッチメニューを登録しました: ${richMenuId}`);
