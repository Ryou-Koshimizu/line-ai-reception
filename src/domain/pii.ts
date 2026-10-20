// 個人情報を保存・記録の前に伏せ字にする。会話の保存（messages テーブル）と AI への履歴の両方がこれを通る。
// 電話番号・メールアドレス・カード番号らしき数字・郵便番号が対象。名前は予約に必要なので bookings にだけ保存する。

/** 全角の数字・記号を半角へ（検出のため。表示はしない） */
function toHalfWidth(text: string): string {
  return text
    .replace(/[０-９]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/[－ー―‐−]/g, (c, offset, all) => (/\d/.test(all[offset - 1] ?? '') ? '-' : c))
    .replace(/＋/g, '+')
    .replace(/＠/g, '@');
}

const PATTERNS: Array<[RegExp, string]> = [
  [/[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}/g, '［メール］'],
  // カード番号（13〜16 桁、区切りあり・なし）
  [/\b(?:\d[ -]?){12,15}\d\b/g, '［カード番号］'],
  // 電話番号：(03)1234-5678 の形
  [/\(0\d{1,4}\)\s?\d{1,4}[ -]?\d{3,4}\b/g, '［電話番号］'],
  // 電話番号：+81 / 0 から始まる 10〜11 桁（区切りあり・なし・括弧）
  [/(?:\+81[ -]?\(?0?\)?|\b0)\d{1,4}[ -]?\(?\d{1,4}\)?[ -]?\d{3,4}\b/g, '［電話番号］'],
  // 郵便番号
  [/〒?\s?\b\d{3}-\d{4}\b/g, '［郵便番号］'],
];

export function redact(text: string): string {
  let out = toHalfWidth(text);
  for (const [re, label] of PATTERNS) out = out.replace(re, label);
  return out;
}

/** 記録に残す利用者の識別子（LINE のユーザーID をそのまま出さない） */
export async function hashId(id: string): Promise<string> {
  const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(`line-ai-reception:${id}`));
  return [...new Uint8Array(digest).slice(0, 6)].map((b) => b.toString(16).padStart(2, '0')).join('');
}
