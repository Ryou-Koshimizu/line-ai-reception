// 画面側で使う形（サーバーの src/domain と同じ項目）
export type Weekday = 'mon' | 'tue' | 'wed' | 'thu' | 'fri' | 'sat' | 'sun';
export interface Menu {
  id: string;
  name: string;
  minutes: number;
  price: number;
  description: string;
}
export interface ShopInfo {
  name: string;
  tagline: string;
  address: string;
  access: string;
  phone: string;
  parking: string;
  payment: string;
  hours: Record<Weekday, { open: string; close: string } | null>;
  closedDates: string[];
  slotMinutes: number;
  seats: number;
  leadMinutes: number;
  maxDaysAhead: number;
  holdMinutes: number;
  changeDeadlineHours: number;
  menus: Menu[];
  policies: { cancellation: string; lateness: string };
  faq: Array<{ q: string; a: string }>;
  links: string[];
}
export interface Booking {
  id: string;
  line_user_id: string | null;
  source?: 'line' | 'staff';
  customer_name: string;
  menu_id: string;
  menu_name: string;
  price?: number;
  start_at: string;
  end_at: string;
  seat: number;
  status: 'held' | 'confirmed' | 'cancelled' | 'expired';
}
export interface Conversation {
  line_user_id: string;
  display_name: string;
  mode: 'ai' | 'human';
  last_message: string | null;
  last_at: string;
  unread: number;
}
export interface StoredMessage {
  id: number;
  role: 'user' | 'assistant' | 'staff' | 'system';
  text: string;
  created_at: string;
}
export interface ToolUse {
  name: string;
  input: unknown;
  ok: boolean;
}
export type LineAction = { type: 'postback'; label: string; data: string; displayText?: string } | { type: 'message'; label: string; text: string };
export type LineMessage =
  | { type: 'text'; text: string; quickReply?: { items: Array<{ type: 'action'; action: LineAction }> } }
  | { type: 'flex'; altText: string; contents: FlexNode; quickReply?: { items: Array<{ type: 'action'; action: LineAction }> } };
export type FlexNode = { type: string; [k: string]: unknown };

export interface TurnRecord {
  at: string;
  user: { text?: string; tap?: string; data?: string; follow?: boolean };
  bot: LineMessage[];
  tools: ToolUse[];
  ms: number;
  prelude?: boolean;
  snapshot: { bookings: Booking[]; mode: 'ai' | 'human' };
}
export interface Recording {
  id: string;
  title: string;
  summary: string;
  ai: boolean;
  user: { name: string };
  turns: TurnRecord[];
}
export interface Recordings {
  recorded_at: string;
  model: string;
  runtime: string;
  shop: ShopInfo;
  staff_names: string[];
  scenarios: Recording[];
}

const WD = ['日', '月', '火', '水', '木', '金', '土'];
export function weekdayJa(date: string): string {
  return WD[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}
export function weekdayKey(date: string): Weekday {
  return (['sun', 'mon', 'tue', 'wed', 'thu', 'fri', 'sat'] as const)[new Date(`${date}T00:00:00Z`).getUTCDay()]!;
}
export function addDays(date: string, n: number): string {
  const d = new Date(`${date}T00:00:00Z`);
  d.setUTCDate(d.getUTCDate() + n);
  return d.toISOString().slice(0, 10);
}
export function dateLabel(date: string): string {
  const [, m, d] = date.split('-').map(Number);
  return `${m}月${d}日(${weekdayJa(date)})`;
}
export function minutes(hhmm: string): number {
  const [h, m] = hhmm.split(':').map(Number);
  return h! * 60 + m!;
}
