// リッチメニューの定義（2500×1686・3 列 × 2 段）。押すと postback / メッセージが届き、ボットが応える。
// 画像は npm run richmenu:image で作り、npm run richmenu:create で LINE に登録する。
export const RICH_MENU_TILES = [
  { label: '予約する', icon: 'CalendarCheck', action: { type: 'postback', data: 'a=book', displayText: '予約したい' } },
  { label: '予約の確認・変更', icon: 'ListChecks', action: { type: 'postback', data: 'a=mine', displayText: '予約を確認したい' } },
  { label: 'メニューと料金', icon: 'Store', action: { type: 'postback', data: 'a=menu', displayText: 'メニューと料金を見たい' } },
  { label: '営業時間・場所', icon: 'MapPin', action: { type: 'postback', data: 'a=hours', displayText: '営業時間と場所を知りたい' } },
  { label: 'よくある質問', icon: 'Info', action: { type: 'message', text: 'よくある質問を教えてください' } },
  { label: 'スタッフに相談', icon: 'Headset', action: { type: 'postback', data: 'a=staff', displayText: 'スタッフに相談したい' } },
] as const;

export const RICH_MENU_SIZE = { width: 2500, height: 1686 } as const;

export function richMenuDefinition(name = 'AI受付メニュー') {
  const w = Math.floor(RICH_MENU_SIZE.width / 3);
  const h = Math.floor(RICH_MENU_SIZE.height / 2);
  return {
    size: RICH_MENU_SIZE,
    selected: true,
    name,
    chatBarText: 'メニュー',
    areas: RICH_MENU_TILES.map((t, i) => ({
      bounds: { x: (i % 3) * w, y: Math.floor(i / 3) * h, width: i % 3 === 2 ? RICH_MENU_SIZE.width - 2 * w : w, height: h },
      action: { ...t.action, label: t.label },
    })),
  };
}
