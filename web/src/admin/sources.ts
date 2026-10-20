import type { AdminSource, Stats } from './view';
import { addDays, type Booking, type Conversation, type ShopInfo, type StoredMessage } from '../types';

/** 公開デモ用：記録の再生で状態が変わる。編集はブラウザの中だけ */
export class DemoSource implements AdminSource {
  readonly live = false;
  readonly canEditShop = true;
  private bookingsNow: Booking[] = [];
  private convs = new Map<string, Conversation>();
  private msgs = new Map<string, StoredMessage[]>();
  private seq = 0;
  private clock = '2026-11-04T10:00';

  constructor(private shopInfo: ShopInfo) {}

  setClock(local: string): void {
    this.clock = local;
  }
  setBookings(list: Booking[]): void {
    this.bookingsNow = structuredClone(list);
  }
  upsertConversation(userId: string, name: string, patch: Partial<Conversation> = {}): void {
    const cur = this.convs.get(userId) ?? {
      line_user_id: userId,
      display_name: name,
      mode: 'ai',
      last_message: null,
      last_at: this.clock,
      unread: 0,
    };
    this.convs.set(userId, { ...cur, ...patch });
  }
  push(userId: string, role: StoredMessage['role'], text: string): void {
    const list = this.msgs.get(userId) ?? [];
    list.push({ id: ++this.seq, role, text, created_at: this.clock });
    this.msgs.set(userId, list);
    const c = this.convs.get(userId);
    if (c && role !== 'system')
      this.convs.set(userId, { ...c, last_message: text.length > 40 ? `${text.slice(0, 39)}…` : text, last_at: this.clock });
  }
  modeOf(userId: string): 'ai' | 'human' {
    return this.convs.get(userId)?.mode ?? 'ai';
  }
  resetConversation(userId: string): void {
    this.msgs.delete(userId);
    this.convs.delete(userId);
  }

  async shop() {
    return this.shopInfo;
  }
  async saveShop(shop: ShopInfo) {
    this.shopInfo = structuredClone(shop);
    try {
      sessionStorage.setItem('demo-shop', JSON.stringify(shop));
    } catch {
      /* 保存できない環境でも画面は動かす */
    }
  }
  async bookings(from: string, to: string) {
    return this.bookingsNow.filter((b) => b.start_at >= from && b.start_at < `${to}T99`);
  }
  async conversations() {
    return [...this.convs.values()].sort((a, b) => b.last_at.localeCompare(a.last_at));
  }
  async messages(userId: string) {
    return this.msgs.get(userId) ?? [];
  }
  async setMode(userId: string, mode: 'ai' | 'human') {
    const c = this.convs.get(userId);
    if (c) this.convs.set(userId, { ...c, mode });
    this.push(userId, 'system', mode === 'human' ? 'スタッフが会話を引き取りました' : 'AI の受付に戻しました');
  }
  async reply(userId: string, text: string) {
    this.push(userId, 'staff', text);
  }
  async cancel() {
    /* デモでは予約表を記録どおりに保つ */
  }
  async stats(today: string): Promise<Stats> {
    const confirmed = this.bookingsNow.filter((b) => b.status === 'confirmed');
    return {
      today: confirmed.filter((b) => b.start_at.startsWith(today)).length,
      week: confirmed.filter((b) => b.start_at >= today && b.start_at < addDays(today, 7)).length,
      handoff: [...this.convs.values()].filter((c) => c.mode === 'human').length,
      aiReplies: [...this.msgs.values()].flat().filter((m) => m.role === 'assistant').length,
    };
  }
}

export class ApiError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/** 実運用：Worker の /api/admin を、鍵（Bearer）付きで呼ぶ */
export class ApiSource implements AdminSource {
  readonly live = true;
  constructor(
    private token: string,
    readonly canEditShop: boolean,
  ) {}

  static async login(token: string): Promise<ApiSource> {
    const res = await fetch('/api/admin/me', { headers: { authorization: `Bearer ${token}` } });
    if (!res.ok) throw new ApiError(res.status, res.status === 401 ? '鍵が違います' : '接続できませんでした');
    const { role } = (await res.json()) as { role: 'owner' | 'staff' };
    return new ApiSource(token, role === 'owner');
  }

  private async call<T>(path: string, init: RequestInit = {}): Promise<T> {
    const res = await fetch(`/api/admin${path}`, {
      ...init,
      headers: { authorization: `Bearer ${this.token}`, ...(init.body ? { 'content-type': 'application/json' } : {}) },
    });
    const json = (await res.json().catch(() => ({}))) as { error?: string };
    if (!res.ok) throw new ApiError(res.status, json.error ?? '操作できませんでした');
    return json as T;
  }

  async shop() {
    const r = await this.call<{ shop: ShopInfo | null; template: ShopInfo | null }>('/shop');
    return r.shop ?? r.template;
  }
  async saveShop(shop: ShopInfo) {
    await this.call('/shop', { method: 'PUT', body: JSON.stringify(shop) });
  }
  async bookings(from: string, to: string) {
    return (await this.call<{ bookings: Booking[] }>(`/bookings?from=${from}&to=${to}`)).bookings;
  }
  async conversations() {
    return (await this.call<{ conversations: Conversation[] }>('/conversations')).conversations;
  }
  async messages(userId: string) {
    return (await this.call<{ messages: StoredMessage[] }>(`/conversations/${encodeURIComponent(userId)}/messages`)).messages;
  }
  async setMode(userId: string, mode: 'ai' | 'human') {
    await this.call(`/conversations/${encodeURIComponent(userId)}/mode`, { method: 'POST', body: JSON.stringify({ mode }) });
  }
  async reply(userId: string, text: string) {
    await this.call(`/conversations/${encodeURIComponent(userId)}/reply`, {
      method: 'POST',
      body: JSON.stringify({ text, requestId: crypto.randomUUID() }),
    });
  }
  async cancel(bookingId: string) {
    await this.call(`/bookings/${encodeURIComponent(bookingId)}/cancel`, { method: 'POST' });
  }
  async stats() {
    return this.call<Stats>('/stats');
  }
}
