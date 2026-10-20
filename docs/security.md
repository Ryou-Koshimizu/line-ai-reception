# Code scanning の指摘と対処

GitHub の Code scanning（CodeQL `security-extended`）で見つかった指摘と、その直し方・確かめ方の記録です。

| 指摘                             | 場所                                                        | 対処                                                                                                                            | 回帰試験                                                                                                                                                           |
| -------------------------------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `js/biased-cryptographic-random` | `src/domain/booking.ts`（予約番号）                         | 剰余（`%`）をやめ、必要なビット数だけ取り出して文字の数を超えた値は捨てて引き直す `randomCode()` に変更                         | `test/security-fixes.test.ts`：0〜255 を 1 回ずつ与えたとき 30 文字すべてがちょうど 8 回ずつ出ること、範囲外を捨てて引き直すこと、実際の乱数での均等さ（カイ二乗） |
| `js/incomplete-sanitization`     | `scripts/live/scenarios.ts`（実機の確かめで押す時刻ボタン） | 文字の置き換えで正規表現を組み立てるのをやめ、ボット側と同じ `URLSearchParams` で「s=…」を作り、postback の項目と完全一致で探す | `test/security-fixes.test.ts`：その日時のボタン 1 つだけに一致すること                                                                                             |
| `js/stack-trace-exposure`        | `scripts/live/bridge.ts`（実機の確かめ用の受け口）          | 失敗時の応答は決まった文言（`inference failed`）だけにし、詳細は手元の標準エラー出力と記録にだけ残す                            | `scripts/live/bridge.test.ts`：失敗するコマンドがスタックやパスを出しても、応答に含まれないこと                                                                    |
| `js/file-access-to-http`         | `scripts/richmenu-create.ts`（リッチメニュー画像の登録）    | 下記                                                                                                                            | `test/security-fixes.test.ts`・`scripts/live/bridge.test.ts`：送る前の確認                                                                                         |

## `js/file-access-to-http`（リッチメニュー画像の登録）について

`npm run richmenu:create` は、LINE のリッチメニューに画像を登録するため、ファイルの中身を LINE Messaging API（`https://api-data.line.me`）へ送ります。ファイルを読んで外へ送ること自体がこの道具の目的です。

送ってよいものだけを送るため、次の形にしています。

- 読むファイルは、このリポジトリの `richmenu/richmenu.png` だけ（スクリプトの位置から決まるパスで、引数や環境変数で別のファイルを指せない）
- 送る前に、PNG の署名・IHDR・2500×1686・1MB 以下を確かめ、外れたら送らずに終わる（`checkRichMenuImage()`）
- 送り先は LINE の決まった URL だけ。ID は LINE が返した `richmenu-` ＋ 16 進 32 文字の形のときだけ使う
- 開発者が手元で 1 回だけ実行する道具で、Worker（本番のサーバー）には含まれない

CodeQL はファイル → 通信という流れそのものを指摘するため、上の確認を入れても指摘が残る場合があります。その場合は「使用中・リスク対処済み（Used in production / risk accepted）」として、この文書を理由に閉じます。
