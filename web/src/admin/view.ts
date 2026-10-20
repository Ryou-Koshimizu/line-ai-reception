// 管理画面（予約表・会話・店の情報）。公開デモと実運用の両方で同じ部品を使い、データの出どころ（source）だけを替える。
import { countTo, h, toast, transition } from '../lib/dom';
import { icon } from '../lib/icons';
import {
  addDays,
  dateLabel,
  minutes,
  weekdayJa,
  weekdayKey,
  type Booking,
  type Conversation,
  type ShopInfo,
  type StoredMessage,
  type ToolUse,
  type Weekday,
} from '../types';

export interface Stats {
  today: number;
  week: number;
  handoff: number;
  aiReplies: number;
}

export interface AdminSource {
  readonly live: boolean;
  readonly canEditShop: boolean;
  shop(): Promise<ShopInfo | null>;
  saveShop(shop: ShopInfo): Promise<void>;
  bookings(from: string, to: string): Promise<Booking[]>;
  conversations(): Promise<Conversation[]>;
  messages(userId: string): Promise<StoredMessage[]>;
  setMode(userId: string, mode: 'ai' | 'human'): Promise<void>;
  reply(userId: string, text: string): Promise<void>;
  cancel(bookingId: string): Promise<void>;
  stats(today: string): Promise<Stats>;
}

type Tab = 'bookings' | 'convs' | 'shop';

const TOOL_LABEL: Record<string, string> = {
  get_shop_info: '店の情報を確かめる',
  find_available_slots: '空き枠を探す',
  hold_booking: '仮予約する',
  confirm_booking: '予約を確定する',
  list_my_bookings: 'この方の予約を見る',
  cancel_booking: '予約を取り消す',
  reschedule_booking: '予約の日時を変える',
  handoff_to_staff: 'スタッフに引き継ぐ',
};
const DAYS: Array<[Weekday, string]> = [
  ['mon', '月'],
  ['tue', '火'],
  ['wed', '水'],
  ['thu', '木'],
  ['fri', '金'],
  ['sat', '土'],
  ['sun', '日'],
];

const SECTION: Record<string, string> = { all: 'すべて', menu: 'メニュー', hours: '営業時間', access: '場所・駐車場', policies: '決まり', faq: 'よくある質問', payment: '支払い' };
const PART: Record<string, string> = { morning: '午前', afternoon: '午後', evening: '夕方以降', any: '' };

/** 道具の入力を、人が読める短い説明にする（予約の ID などは出さない） */
function toolDetail(t: ToolUse): string {
  const i = (t.input ?? {}) as Record<string, string>;
  const when = (v?: string) => (v ? `${Number(v.slice(5, 7))}/${Number(v.slice(8, 10))}${v.length > 10 ? ` ${v.slice(11)}` : ''}` : '');
  switch (t.name) {
    case 'get_shop_info':
      return SECTION[i.section ?? ''] ?? '';
    case 'find_available_slots':
      return `${when(i.date_from)}${i.date_to && i.date_to !== i.date_from ? `〜${when(i.date_to)}` : ''} ${PART[i.part_of_day ?? ''] ?? ''}`.trim();
    case 'hold_booking':
      return when(i.start);
    case 'reschedule_booking':
      return `→ ${when(i.new_start)}`;
    case 'handoff_to_staff':
      return (i.reason ?? '').slice(0, 24);
    default:
      return '';
  }
}

function mondayOf(date: string): string {
  const wd = new Date(`${date}T00:00:00Z`).getUTCDay();
  return addDays(date, wd === 0 ? -6 : 1 - wd);
}

export class AdminView {
  readonly el: HTMLElement;
  private body: HTMLElement;
  private tabs: Record<Tab, HTMLButtonElement>;
  private convBadge: HTMLElement;
  private tab: Tab = 'bookings';
  private view: 'day' | 'week' = 'day';
  private date: string;
  private shop: ShopInfo | null = null;
  private bookingsCache: Booking[] = [];
  private seen = new Set<string>();
  private fresh = new Set<string>();
  private selectedUser: string | null = null;
  private tools: ToolUse[] | null = null;
  private statEls: Record<keyof Stats, HTMLElement> | null = null;
  onModeChange?: (userId: string, mode: 'ai' | 'human') => void;
  onReply?: (userId: string, text: string) => void;

  constructor(
    host: HTMLElement,
    private source: AdminSource,
    private opts: { today: string; showTools: boolean },
  ) {
    this.date = opts.today;
    this.convBadge = h('span', { class: 'badge', hidden: true });
    const mk = (tab: Tab, label: string, ic: Parameters<typeof icon>[0], extra?: HTMLElement) => {
      const b = h('button', { type: 'button', 'aria-pressed': String(tab === this.tab) }, icon(ic), label, extra ?? null);
      b.addEventListener('click', () => this.setTab(tab));
      return b;
    };
    this.tabs = {
      bookings: mk('bookings', '予約表', 'CalendarDays'),
      convs: mk('convs', '会話', 'MessageCircle', this.convBadge),
      shop: mk('shop', '店の情報', 'Store'),
    };
    const tabsEl = h(
      'div',
      { class: 'seg admin-tabs', role: 'group', 'aria-label': '管理画面の表示' },
      this.tabs.bookings,
      this.tabs.convs,
      this.tabs.shop,
    );
    this.body = h('div', { class: 'admin-body', tabindex: '-1' });
    this.el = h(
      'section',
      { class: 'admin', 'aria-label': '管理画面' },
      h('div', { class: 'admin-top' }, h('h3', {}, icon('LayoutGrid'), '管理画面'), tabsEl),
      this.body,
    );
    host.append(this.el);
  }

  setTab(tab: Tab, animate = true): void {
    if (tab === this.tab && this.body.childElementCount) return;
    this.tab = tab;
    for (const [k, b] of Object.entries(this.tabs)) b.setAttribute('aria-pressed', String(k === tab));
    const run = () => void this.render();
    if (animate) transition(run);
    else run();
  }

  get currentTab(): Tab {
    return this.tab;
  }

  /** 予約の変化を受けて描き直す。新しく現れた・時刻が変わった予約にはピンを刺す */
  async refresh(opts: { focusDate?: string; tools?: ToolUse[] | null } = {}): Promise<void> {
    if (opts.tools !== undefined) this.tools = opts.tools;
    if (opts.focusDate) this.date = opts.focusDate;
    this.shop ??= await this.source.shop();
    const from = addDays(mondayOf(this.date), -7);
    const all = await this.source.bookings(from, addDays(from, 28));
    this.fresh.clear();
    for (const b of all) {
      const key = `${b.id}@${b.start_at}@${b.status}`;
      if (this.seen.size && !this.seen.has(key) && b.status === 'confirmed') this.fresh.add(b.id);
    }
    // 見たことのある予約として覚える（表示の範囲が変わっても、前に見たものは残す）
    for (const b of all) this.seen.add(`${b.id}@${b.start_at}@${b.status}`);
    if (!this.seen.size) this.seen.add('init');
    this.bookingsCache = all;
    await this.render();
  }

  private async render(): Promise<void> {
    if (this.tab === 'bookings') this.body.replaceChildren(await this.renderBookings());
    else if (this.tab === 'convs') this.body.replaceChildren(await this.renderConvs());
    else this.body.replaceChildren(this.renderShop());
    await this.updateBadge();
  }

  private async updateBadge(): Promise<void> {
    const convs = await this.source.conversations();
    const n = convs.filter((c) => c.mode === 'human').length;
    this.convBadge.hidden = n === 0;
    this.convBadge.textContent = String(n);
    this.convBadge.setAttribute('aria-label', `引き継ぎ中 ${n} 件`);
  }

  // ── 予約表 ──
  private async renderBookings(): Promise<HTMLElement> {
    const grid = h('div', { class: 'bento-admin' });
    const stats = await this.source.stats(this.opts.today);
    const statDefs: Array<[keyof Stats, string]> = [
      ['today', '今日の予約'],
      ['week', 'この 7 日の予約'],
      ['handoff', '引き継ぎ中の会話'],
      ['aiReplies', 'AI の返事（7 日）'],
    ];
    const prev = this.statEls;
    const els = {} as Record<keyof Stats, HTMLElement>;
    for (const [k, label] of statDefs) {
      const b = h('b', { 'data-value': prev?.[k]?.dataset.value ?? '0', text: prev?.[k]?.textContent ?? '0' });
      els[k] = b;
      const tile = h('div', { class: 'tile stat' }, b, h('span', { text: label }));
      grid.append(tile);
      const before = Number(b.dataset.value);
      if (before !== stats[k]) {
        countTo(b, stats[k]);
        if (prev) tile.classList.add('bump');
      }
    }
    this.statEls = els;
    grid.append(this.renderCalendarTile(), this.renderSide());
    return grid;
  }

  private renderCalendarTile(): HTMLElement {
    const prevBtn = h(
      'button',
      { type: 'button', class: 'icon-btn', 'aria-label': this.view === 'day' ? '前の日' : '前の週' },
      icon('ChevronLeft'),
    );
    const nextBtn = h(
      'button',
      { type: 'button', class: 'icon-btn', 'aria-label': this.view === 'day' ? '次の日' : '次の週' },
      icon('ChevronRight'),
    );
    const step = this.view === 'day' ? 1 : 7;
    prevBtn.addEventListener('click', () => this.go(addDays(this.date, -step)));
    nextBtn.addEventListener('click', () => this.go(addDays(this.date, step)));
    const dayBtn = h('button', { type: 'button', 'aria-pressed': String(this.view === 'day'), text: '日' });
    const weekBtn = h('button', { type: 'button', 'aria-pressed': String(this.view === 'week'), text: '週' });
    dayBtn.addEventListener('click', () => this.setView('day'));
    weekBtn.addEventListener('click', () => this.setView('week'));
    const label =
      this.view === 'day'
        ? dateLabel(this.date)
        : `${dateLabel(mondayOf(this.date)).replace(/\(.\)/, '')}〜${dateLabel(addDays(mondayOf(this.date), 6)).replace(/\(.\)/, '')}`;
    const head = h(
      'div',
      { class: 'cal-head' },
      prevBtn,
      h('span', { class: 'date', 'aria-live': 'polite', text: label }),
      nextBtn,
      h('div', { class: 'seg', role: 'group', 'aria-label': '表示の単位' }, dayBtn, weekBtn),
    );
    return h(
      'div',
      { class: 'tile tile-cal' },
      h('h4', {}, icon('CalendarDays'), '予約表'),
      head,
      this.renderCalendar(),
      h(
        'div',
        { class: 'cal-legend' },
        h('span', {}, h('i'), 'LINE の予約'),
        h('span', {}, h('i', { class: 'staff' }), '電話・来店（スタッフ入力）'),
        h('span', {}, h('i', { class: 'held' }), '仮予約（確定待ち）'),
      ),
    );
  }

  private go(date: string): void {
    this.date = date;
    transition(() => void this.refresh({}));
  }

  private setView(v: 'day' | 'week'): void {
    if (v === this.view) return;
    this.view = v;
    transition(() => void this.render());
  }

  private hourRange(): [number, number] {
    const hours = Object.values(this.shop?.hours ?? {}).filter(Boolean) as Array<{ open: string; close: string }>;
    if (!hours.length) return [9, 20];
    return [
      Math.floor(Math.min(...hours.map((x) => minutes(x.open))) / 60),
      Math.ceil(Math.max(...hours.map((x) => minutes(x.close))) / 60),
    ];
  }

  private renderCalendar(): HTMLElement {
    const [startH, endH] = this.hourRange();
    const hourPx = this.view === 'day' ? 46 : 38;
    const seats = this.shop?.seats ?? 1;
    const days = this.view === 'day' ? [this.date] : Array.from({ length: 7 }, (_, i) => addDays(mondayOf(this.date), i));
    const cols = this.view === 'day' ? seats : 7;
    const height = (endH - startH) * hourPx;
    const grid = h('div', { class: 'cal-grid', style: `--cols:${cols};--hour:${hourPx}px` });
    grid.append(h('span'));
    if (this.view === 'day') for (let s = 1; s <= seats; s++) grid.append(h('div', { class: 'cal-col-head', text: `席 ${s}` }));
    else
      for (const d of days)
        grid.append(
          h('div', { class: `cal-col-head ${d === this.opts.today ? 'today' : ''}`, text: `${Number(d.slice(8))}(${weekdayJa(d)})` }),
        );
    const times = h('div', { class: 'cal-times', style: `height:${height}px`, 'aria-hidden': 'true' });
    for (let hr = startH; hr <= endH; hr++) {
      const t = h('span', { text: `${hr}:00`, style: `top:${(hr - startH) * hourPx}px` });
      if (hr === startH) t.style.transform = 'none';
      if (hr === endH) t.style.transform = 'translateY(-100%)';
      times.append(t);
    }
    grid.append(times);
    const place = (b: Booking, col: HTMLElement, half?: number) => {
      const top = ((minutes(b.start_at.slice(11)) - startH * 60) / 60) * hourPx;
      const len = ((minutes(b.end_at.slice(11)) - minutes(b.start_at.slice(11))) / 60) * hourPx;
      const pos = half === undefined ? '' : half === 1 ? 'left:2px;right:50%;' : 'left:50%;right:2px;';
      const el = h(
        'div',
        {
          class: `bk ${len < 30 ? 'short' : ''} ${b.source === 'staff' || !b.line_user_id ? 'staff' : ''} ${b.status === 'held' ? 'held' : ''} ${this.fresh.has(b.id) ? 'fresh' : ''}`,
          style: `${pos}top:${top + 1}px;height:${Math.max(18, len - 3)}px`,
          title: `${b.start_at.slice(11)}〜${b.end_at.slice(11)} ${b.menu_name} ${b.customer_name}`,
        },
        h('b', { text: `${b.start_at.slice(11)} ${b.customer_name}` }),
        h('span', { text: `${b.menu_name}${b.status === 'held' ? '（仮）' : ''}` }),
      );
      col.append(el);
      if (this.fresh.has(b.id)) {
        const pin = h('span', { class: 'pin', style: `top:${top}px;${half === 2 ? 'left:50%' : 'left:4px'}` }, icon('Pin'));
        col.append(pin);
      }
    };
    const active = this.bookingsCache.filter((b) => b.status === 'held' || b.status === 'confirmed');
    if (this.view === 'day') {
      const closed = !this.isOpenDay(this.date);
      for (let s = 1; s <= seats; s++) {
        const col = h('div', { class: `cal-col ${closed ? 'closed' : ''}`, style: `height:${height}px` });
        if (closed && s === 1) col.append(h('span', { class: 'closed-label', text: '定休日' }));
        for (const b of active.filter((x) => x.start_at.startsWith(this.date) && x.seat === s)) place(b, col);
        grid.append(col);
      }
    } else {
      for (const d of days) {
        const closed = !this.isOpenDay(d);
        const col = h('div', { class: `cal-col ${closed ? 'closed' : ''}`, style: `height:${height}px` });
        if (closed) col.append(h('span', { class: 'closed-label', text: '休' }));
        for (const b of active.filter((x) => x.start_at.startsWith(d))) place(b, col, seats > 1 ? Math.min(b.seat, 2) : undefined);
        grid.append(col);
      }
    }
    const count = active.filter((b) => days.some((d) => b.start_at.startsWith(d))).length;
    return h('div', { class: `cal ${this.view}`, role: 'region', 'aria-label': `予約表（${count}件）` }, grid);
  }

  private isOpenDay(date: string): boolean {
    if (!this.shop) return true;
    if (this.shop.closedDates.includes(date)) return false;
    return !!this.shop.hours[weekdayKey(date)];
  }

  private renderSide(): HTMLElement {
    const side = h('div', { class: 'tile-side' });
    if (this.opts.showTools) {
      const list = h('ul', { class: 'tools' });
      if (!this.tools?.length) list.append(h('li', { class: 'empty', text: 'この返事では道具を使っていません' }));
      this.tools?.forEach((t, i) => {
        const detail = toolDetail(t);
        list.append(
          h(
            'li',
            { class: t.ok ? 'ok' : 'ng', style: `--i:${i}` },
            icon(t.ok ? 'CircleCheck' : 'X'),
            TOOL_LABEL[t.name] ?? t.name,
            h('small', { text: t.ok ? detail : '拒否・失敗' }),
          ),
        );
      });
      side.append(h('div', { class: 'tile' }, h('h4', {}, icon('Wand'), 'AI が使った道具'), list));
    }
    const today = this.bookingsCache
      .filter((b) => b.start_at.startsWith(this.date) && (b.status === 'confirmed' || b.status === 'held'))
      .sort((a, b) => a.start_at.localeCompare(b.start_at));
    const ul = h('ul', { class: 'upcoming' });
    if (!today.length) ul.append(h('li', { class: 'empty', text: 'この日の予約はありません' }));
    for (const b of today) {
      const row = h('li', {}, h('time', { text: b.start_at.slice(11) }), h('span', { text: `${b.customer_name}・${b.menu_name}` }));
      if (this.source.live) {
        const c = h('button', { type: 'button', class: 'btn small', text: '取消' });
        c.addEventListener('click', async () => {
          if (!confirm(`${b.start_at.slice(11)} ${b.customer_name} の予約を取り消しますか？`)) return;
          await this.source.cancel(b.id);
          toast('予約を取り消しました');
          await this.refresh({});
        });
        row.append(c);
      } else
        row.append(
          h('span', {
            class: `chip ${b.status === 'held' ? 'amber' : b.line_user_id ? 'green' : 'blue'}`,
            text: b.status === 'held' ? '仮' : b.line_user_id ? 'LINE' : '電話',
          }),
        );
      ul.append(row);
    }
    side.append(h('div', { class: 'tile' }, h('h4', {}, icon('ListChecks'), `${dateLabel(this.date)}の予約`), ul));
    return side;
  }

  // ── 会話 ──
  selectConversation(userId: string): void {
    this.selectedUser = userId;
  }

  private async renderConvs(): Promise<HTMLElement> {
    const convs = await this.source.conversations();
    if (!this.selectedUser || !convs.some((c) => c.line_user_id === this.selectedUser)) this.selectedUser = convs[0]?.line_user_id ?? null;
    const list = h('div', { class: 'conv-list', role: 'list' });
    for (const c of convs) {
      const b = h(
        'button',
        { type: 'button', class: 'conv', role: 'listitem', 'aria-current': String(c.line_user_id === this.selectedUser) },
        h('span', { class: 'av', 'aria-hidden': 'true', text: c.display_name.slice(0, 1) }),
        h('span', { class: 'nm' }, h('b', { text: c.display_name }), h('span', { text: c.last_message ?? '' })),
        h('span', { class: `chip ${c.mode === 'human' ? 'amber' : 'green'}`, text: c.mode === 'human' ? '人が対応' : 'AI' }),
      );
      b.addEventListener('click', () => {
        this.selectedUser = c.line_user_id;
        transition(() => void this.render());
      });
      list.append(b);
    }
    if (!convs.length) list.append(h('p', { class: 'empty', text: '会話はありません' }));
    const grid = h(
      'div',
      { class: 'bento-admin' },
      h('div', { class: 'tile tile-convs' }, h('h4', {}, icon('MessageCircle'), '会話の一覧'), list),
    );
    const current = convs.find((c) => c.line_user_id === this.selectedUser);
    if (current) grid.append(await this.renderThread(current));
    return grid;
  }

  private async renderThread(c: Conversation): Promise<HTMLElement> {
    const human = c.mode === 'human';
    const sw = h(
      'button',
      { type: 'button', class: 'switch', role: 'switch', 'aria-checked': String(human) },
      h('span', { class: 'track', 'aria-hidden': 'true' }, h('span', { class: 'knob' })),
      '人が引き取る',
    );
    sw.addEventListener('click', async () => {
      const next = human ? 'ai' : 'human';
      sw.setAttribute('aria-checked', String(!human));
      await this.source.setMode(c.line_user_id, next);
      this.onModeChange?.(c.line_user_id, next);
      setTimeout(() => transition(() => void this.render()), 320);
    });
    const thread = h('div', { class: 'thread', role: 'log', 'aria-label': `${c.display_name} さんとの会話` });
    for (const m of await this.source.messages(c.line_user_id)) thread.append(h('div', { class: `t ${m.role}`, text: m.text }));
    const field = h('input', {
      class: 'field',
      type: 'text',
      'aria-label': 'スタッフとして返信',
      placeholder: human ? 'スタッフとして返信' : '「人が引き取る」にすると返信できます',
      disabled: !human,
      maxlength: '2000',
    }) as HTMLInputElement;
    const send = h('button', { type: 'button', class: 'btn primary small', disabled: !human }, icon('Send'), '送る');
    const doSend = async () => {
      const text = field.value.trim();
      if (!text) return;
      send.disabled = true;
      await this.source.reply(c.line_user_id, text);
      this.onReply?.(c.line_user_id, text);
      field.value = '';
      await this.render();
    };
    send.addEventListener('click', () => void doSend());
    field.addEventListener('keydown', (e) => e.key === 'Enter' && !e.isComposing && void doSend());
    requestAnimationFrame(() => (thread.scrollTop = thread.scrollHeight));
    return h(
      'div',
      { class: 'tile tile-thread' },
      h(
        'div',
        { class: 'thread-head' },
        h('b', { text: `${c.display_name} さん` }),
        h('span', { class: `chip ${human ? 'amber' : 'green'}`, text: human ? 'スタッフが対応中・AI は返事をしません' : 'AI が受付中' }),
        sw,
      ),
      h('p', { class: 'empty', text: '保存される会話は、電話番号・メールアドレスなどを伏せ字にしたものです。' }),
      thread,
      h('div', { class: 'reply-box' }, field, send),
    );
  }

  // ── 店の情報 ──
  private renderShop(): HTMLElement {
    const shop = this.shop;
    if (!shop) return h('p', { class: 'empty', text: '店の情報を読み込めませんでした' });
    const draft: ShopInfo = structuredClone(shop);
    const editable = this.source.canEditShop;
    const input = (label: string, value: string, set: (v: string) => void, type = 'text') => {
      const el = h('input', { class: 'field', type, value, disabled: !editable }) as HTMLInputElement;
      el.addEventListener('input', () => set(el.value));
      return h('label', {}, label, el);
    };
    const area = (label: string, value: string, set: (v: string) => void) => {
      const el = h('textarea', { class: 'field', rows: '2', disabled: !editable }) as HTMLTextAreaElement;
      el.value = value;
      el.addEventListener('input', () => set(el.value));
      return h('label', {}, label, el);
    };
    const basics = h(
      'div',
      { class: 'tile' },
      h('h4', {}, icon('Store'), '基本'),
      input('店名', draft.name, (v) => (draft.name = v)),
      input('住所', draft.address, (v) => (draft.address = v)),
      input('電話', draft.phone, (v) => (draft.phone = v), 'tel'),
      area('行き方', draft.access, (v) => (draft.access = v)),
      area('駐車場', draft.parking, (v) => (draft.parking = v)),
      area('支払い方法', draft.payment, (v) => (draft.payment = v)),
    );
    const hours = h('div', { class: 'hours-grid' });
    for (const [key, label] of DAYS) {
      const cur = draft.hours[key];
      const open = h('input', {
        class: 'field',
        type: 'time',
        value: cur?.open ?? '10:00',
        'aria-label': `${label}曜の開店`,
        disabled: !editable || !cur,
      }) as HTMLInputElement;
      const close = h('input', {
        class: 'field',
        type: 'time',
        value: cur?.close ?? '19:00',
        'aria-label': `${label}曜の閉店`,
        disabled: !editable || !cur,
      }) as HTMLInputElement;
      const off = h('input', {
        type: 'checkbox',
        checked: !cur,
        disabled: !editable,
        'aria-label': `${label}曜を定休日にする`,
      }) as HTMLInputElement;
      const sync = () => {
        draft.hours[key] = off.checked ? null : { open: open.value, close: close.value };
        open.disabled = close.disabled = !editable || off.checked;
      };
      [open, close, off].forEach((x) => x.addEventListener('input', sync));
      hours.append(h('b', { text: label }), open, close, h('label', { class: 'check' }, off, '定休'));
    }
    const hoursTile = h('div', { class: 'tile' }, h('h4', {}, icon('Clock'), '営業時間・定休日'), hours);
    const menuRows = h('div', { class: 'menu-rows' });
    draft.menus.forEach((m, i) => {
      const name = h('input', {
        class: 'field',
        value: m.name,
        'aria-label': `メニュー${i + 1}の名前`,
        disabled: !editable,
      }) as HTMLInputElement;
      const mins = h('input', {
        class: 'field',
        type: 'number',
        step: '30',
        min: '30',
        value: String(m.minutes),
        'aria-label': `メニュー${i + 1}の所要（分）`,
        disabled: !editable,
      }) as HTMLInputElement;
      const price = h('input', {
        class: 'field',
        type: 'number',
        step: '100',
        min: '0',
        value: String(m.price),
        'aria-label': `メニュー${i + 1}の料金（円）`,
        disabled: !editable,
      }) as HTMLInputElement;
      name.addEventListener('input', () => (m.name = name.value));
      mins.addEventListener('input', () => (m.minutes = Number(mins.value)));
      price.addEventListener('input', () => (m.price = Number(price.value)));
      menuRows.append(h('div', { class: 'menu-row' }, name, mins, price));
    });
    const menuTile = h('div', { class: 'tile' }, h('h4', {}, icon('ListChecks'), 'メニュー（名前・分・円）'), menuRows);
    const rules = h(
      'div',
      { class: 'tile' },
      h('h4', {}, icon('ShieldCheck'), '予約の決まり'),
      input('同時に受けられる席の数', String(draft.seats), (v) => (draft.seats = Number(v)), 'number'),
      input('仮予約を押さえておく時間（分）', String(draft.holdMinutes), (v) => (draft.holdMinutes = Number(v)), 'number'),
      input(
        'LINE で変更・取り消しできる締め切り（予約の何時間前まで）',
        String(draft.changeDeadlineHours),
        (v) => (draft.changeDeadlineHours = Number(v)),
        'number',
      ),
      area('取り消しの決まり', draft.policies.cancellation, (v) => (draft.policies.cancellation = v)),
    );
    const save = h('button', { type: 'button', class: 'btn primary', disabled: !editable }, icon('Save'), '保存する');
    save.addEventListener('click', async () => {
      try {
        save.disabled = true;
        await this.source.saveShop(draft);
        this.shop = draft;
        toast(
          this.source.live
            ? '保存しました。次の返事から AI がこの内容を根拠に答えます。'
            : 'ブラウザの中に保存しました（このデモの会話は記録の再生です）。',
        );
      } catch (e) {
        toast(e instanceof Error ? e.message : '保存できませんでした');
      } finally {
        save.disabled = false;
      }
    });
    const note = editable
      ? this.source.live
        ? 'AI は、ここに登録した内容だけを根拠にお客様へ答えます。'
        : 'このデモでは、ブラウザの中だけに保存します。'
      : '店の情報の編集は、店長（オーナー）の鍵でログインしたときにできます。';
    return h(
      'div',
      { class: 'shop-form' },
      basics,
      hoursTile,
      menuTile,
      rules,
      h('div', { class: 'form-actions' }, save, h('span', { class: 'empty', text: note })),
    );
  }
}
