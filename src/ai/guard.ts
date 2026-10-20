// AI の返事を LINE に出す前の最後の検査。
// 道具の結果と食い違う「確定しました」、店が登録していない URL、Markdown の記号、長すぎる文を直す。

// 「確定しました」「承りました」「変更しました」「取り消しました」など、終わったことを言い切る表現
const COMMIT_CLAIM = /(確定|変更|取り消し|キャンセル)(いた)?しました(?!ら)|予約[をが]?(承り|お受けし)ました|予約[がは]?完了(いた)?しました/;
const URL_RE = /https?:\/\/[^\s)）」』]+/g;

export interface GuardInput {
  text: string;
  committed: boolean;
  allowedLinks: string[];
}

export function guardReply({ text, committed, allowedLinks }: GuardInput): { text: string; flags: string[] } {
  const flags: string[] = [];
  let out = text
    .replace(/\*\*(.+?)\*\*/g, '$1')
    .replace(/^#{1,6}\s*/gm, '')
    .replace(/^\s*[-*]\s+/gm, '・')
    .replace(/`([^`]+)`/g, '$1')
    .trim();
  out = out.replace(URL_RE, (url) => {
    if (allowedLinks.some((l) => url.startsWith(l))) return url;
    flags.push('url_removed');
    return '（リンクは省略しました）';
  });
  if (!committed && COMMIT_CLAIM.test(out)) {
    flags.push('unverified_commit_claim');
    out =
      'まだ手続きは終わっていません。表示されたカードのボタンから進めてください。うまくいかないときは「スタッフに相談」と送ってください。';
  }
  if (out.length > 800) {
    flags.push('truncated');
    out = `${out.slice(0, 790)}…`;
  }
  if (!out) {
    flags.push('empty');
    out = '';
  }
  return { text: out, flags };
}
