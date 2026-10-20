// 日本時間（UTC+9・夏時間なし）の「YYYY-MM-DDTHH:mm」文字列で予約の時刻を扱う。
// 文字列のまま大小比較でき、D1 の主キーにもそのまま使える。
const JST_OFFSET_MS = 9 * 60 * 60 * 1000;
export const WEEKDAYS = ['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const;
export type Weekday = (typeof WEEKDAYS)[number];
const WEEKDAY_JA = ['日', '月', '火', '水', '木', '金', '土'];

const pad = (n: number) => String(n).padStart(2, '0');

export function toJstLocal(date: Date): string {
  const d = new Date(date.getTime() + JST_OFFSET_MS);
  return `${d.getUTCFullYear()}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}T${pad(d.getUTCHours())}:${pad(d.getUTCMinutes())}`;
}

export function fromJstLocal(local: string): Date {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/.exec(local);
  if (!m) throw new Error('INVALID_LOCAL_TIME');
  const [, y, mo, d, h, mi] = m.map(Number) as [number, number, number, number, number, number];
  const date = new Date(Date.UTC(y, mo - 1, d, h, mi) - JST_OFFSET_MS);
  if (toJstLocal(date) !== local) throw new Error('INVALID_LOCAL_TIME');
  return date;
}

export function isLocalTime(value: string): boolean {
  try {
    fromJstLocal(value);
    return true;
  } catch {
    return false;
  }
}

export function addMinutesLocal(local: string, minutes: number): string {
  return toJstLocal(new Date(fromJstLocal(local).getTime() + minutes * 60_000));
}

export function addDays(date: string, days: number): string {
  return addMinutesLocal(`${date}T00:00`, days * 24 * 60).slice(0, 10);
}

export function weekdayOf(date: string): Weekday {
  return WEEKDAYS[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}

/** "2026-11-06T14:00" → "11月6日(木) 14:00" */
export function formatJa(local: string, withTime = true): string {
  const [date, time] = local.split('T') as [string, string];
  const [, m, d] = date.split('-').map(Number);
  const w = WEEKDAY_JA[new Date(`${date}T00:00:00Z`).getUTCDay()];
  return `${m}月${d}日(${w})${withTime ? ` ${time}` : ''}`;
}

export function minutesOf(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}
