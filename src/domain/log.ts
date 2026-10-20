// 記録（console）には、決まった項目だけを出す。メッセージ本文・名前・電話番号は出さない。
type Field = string | number | boolean | null | undefined;
const ALLOWED = new Set([
  'user',
  'event',
  'type',
  'tool',
  'ok',
  'code',
  'status',
  'ms',
  'steps',
  'count',
  'mode',
  'booking',
  'reason',
  'role',
]);

export function log(level: 'info' | 'warn' | 'error', message: string, fields: Record<string, Field> = {}): void {
  const safe: Record<string, Field> = {};
  for (const [k, v] of Object.entries(fields)) if (ALLOWED.has(k)) safe[k] = v;
  const line = JSON.stringify({ level, message, ...safe });
  if (level === 'error') console.error(line);
  else if (level === 'warn') console.warn(line);
  else console.log(line);
}
