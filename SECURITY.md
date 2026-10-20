# Security Policy

## 脆弱性の報告

公開の Issue ではなく、GitHub の [Private vulnerability reporting](https://github.com/Ryou-Koshimizu/line-ai-reception/security/advisories/new) から非公開で報告してください。影響を受けるファイル・再現手順（架空のデータで）・想定される影響を添えてください。受領の連絡は 7 日以内を目安に行います。

## このリポジトリが行っている対策

| 脅威                       | 対策                                                                                                                        | 確かめている試験                                                                             |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------- |
| なりすましの Webhook       | `X-Line-Signature` を受け取ったバイト列の HMAC-SHA256 と定数時間で比較。形の崩れた署名は比べる前に拒否                      | `test/signature.test.ts`・`test/webhook.test.ts`・実機の確かめ（正しい 100 通・不正 100 通） |
| 再送による二重処理         | `webhookEventId` を待ち行列と D1 の両方で一意に。プッシュには再送キー                                                       | `test/handler.test.ts`・`test/webhook.test.ts`                                               |
| 二重予約                   | 席 × コマの主キーを持つ鍵の表と予約の行を 1 つのトランザクションで書く                                                      | `test/booking.test.ts`（同時 30 件・無作為 300 操作）                                        |
| ほかの人の予約の操作       | AI の道具は利用者 ID をサーバーから受け取り、AI の入力に含めない                                                            | `test/agent.test.ts`・`test/booking.test.ts`                                                 |
| プロンプトインジェクション | 店の事実は道具の結果だけを根拠にする指示、確定していない「確定しました」の差し替え、登録外の URL の除去、道具の入力の型検査 | `test/agent.test.ts`・実機の確かめ                                                           |
| 管理画面の不正利用         | 鍵（Bearer）を SHA-256 にしてから定数時間で比較。スタッフの鍵では店の情報を編集できない                                     | `test/admin.test.ts`・`e2e/admin-live.spec.ts`                                               |
| 個人情報の残存             | 電話番号・メール・カード番号・郵便番号を保存前に伏せ字。記録（ログ）は決まった項目だけ                                      | `test/handler.test.ts`・`test/units.test.ts`                                                 |

Code scanning の指摘と対処の記録は [docs/security.md](docs/security.md)。

## 秘密情報について

チャネルシークレット・アクセストークン・Claude API の鍵・管理画面の鍵は `wrangler secret put` で設定し、リポジトリには含めません。`.dev.vars` はコミットしない設定です。
