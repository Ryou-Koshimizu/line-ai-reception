// 記録の再生。閲覧者が「記録で実際に押されたボタン・送られた文」を押すと、次の 1 手を再生する。
import type { Phone, Expect } from '../chat/phone';
import type { AdminView } from '../admin/view';
import type { DemoSource } from '../admin/sources';
import { dateLabel, type LineMessage, type Recording, type TurnRecord } from '../types';

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

export function textOfBot(messages: LineMessage[]): string {
  return messages.map((m) => (m.type === 'text' ? m.text : `［カード］${m.altText}`)).join('\n');
}

function userText(t: TurnRecord): string {
  if (t.user.follow) return '（友だち追加）';
  return t.user.text ?? `［ボタン］${t.user.tap ?? ''}`;
}

export interface PlayerState {
  step: number;
  total: number;
  finished: boolean;
  busy: boolean;
  paused: boolean;
}

export class Player {
  private rec!: Recording;
  private main: TurnRecord[] = [];
  private idx = 0;
  private busy = false;
  private paused = false;
  private auto = false;
  private token = 0;

  constructor(
    private phone: Phone,
    private admin: AdminView,
    private source: DemoSource,
    private onState: (s: PlayerState) => void,
  ) {
    admin.onModeChange = (userId, mode) => {
      if (userId !== this.userId) return;
      this.paused = mode === 'human';
      this.phone.note(mode === 'human' ? 'スタッフが会話を引き取りました。AI は返事をしません。' : 'AI の受付に戻りました。');
      this.prompt();
    };
    admin.onReply = (userId, text) => {
      if (userId !== this.userId) return;
      this.phone.bot([{ type: 'text', text }], this.clock(), { staff: true });
    };
  }

  get userId(): string {
    return `demo-${this.rec.id}`;
  }

  private clock(): string {
    const t = this.main[Math.min(this.idx, this.main.length - 1)] ?? this.rec.turns.at(-1);
    return t?.at.slice(11) ?? '';
  }

  private emit(): void {
    this.onState({ step: this.idx, total: this.main.length, finished: this.idx >= this.main.length, busy: this.busy, paused: this.paused });
  }

  async load(rec: Recording): Promise<void> {
    const my = ++this.token;
    this.rec = rec;
    this.main = rec.turns.filter((t) => !t.prelude);
    const prelude = rec.turns.filter((t) => t.prelude);
    this.idx = 0;
    this.busy = false;
    this.paused = false;
    this.phone.reset();
    this.source.resetConversation(this.userId);
    const first = rec.turns[0]!;
    this.source.setClock(first.at);
    this.phone.day(dateLabel(first.at.slice(0, 10)));
    this.source.upsertConversation(this.userId, rec.user.name, { mode: 'ai' });
    for (const t of prelude) {
      this.phone.user(t.user, t.at.slice(11), false);
      this.phone.bot(t.bot, t.at.slice(11), { animate: false });
      this.source.push(this.userId, 'user', userText(t));
      this.source.push(this.userId, 'assistant', textOfBot(t.bot));
    }
    if (prelude.length) this.phone.note('ここから再生します', 'history-sep');
    const base = prelude.at(-1)?.snapshot ?? this.main[0]!.snapshot;
    this.source.setBookings(base.bookings);
    const mine = base.bookings.find((b) => b.line_user_id === rec.user.id);
    if (my !== this.token) return;
    await this.admin.refresh({ focusDate: mine?.start_at.slice(0, 10) ?? '2026-11-04', tools: null });
    this.admin.selectConversation(this.userId);
    this.prompt();
  }

  private expectFor(t: TurnRecord): Expect {
    if (t.user.follow) return { kind: 'follow' };
    if (t.user.text) return { kind: 'text', text: t.user.text };
    return { kind: 'tap', data: t.user.data ?? '', label: t.user.tap ?? '' };
  }

  private prompt(): void {
    this.emit();
    const t = this.main[this.idx];
    if (!t || this.paused || this.busy) {
      this.phone.setExpect(null);
      return;
    }
    const e = this.expectFor(t);
    if (e?.kind === 'follow') this.phone.followButton(() => void this.act());
    this.phone.setExpect(e);
    if (this.auto) {
      const my = this.token;
      setTimeout(() => my === this.token && this.auto && !this.busy && void this.act(), 1500);
    }
  }

  setAuto(on: boolean): void {
    this.auto = on;
    if (on && !this.busy) this.prompt();
  }

  async act(): Promise<void> {
    const t = this.main[this.idx];
    if (!t || this.busy || this.paused) return;
    const my = this.token;
    this.busy = true;
    this.phone.setExpect(null);
    this.emit();
    this.source.setClock(t.at);
    this.phone.user(t.user, t.at.slice(11));
    this.source.push(this.userId, 'user', userText(t));
    await sleep(450);
    if (my !== this.token) return;
    if (t.bot.length === 0) {
      await sleep(700);
      this.phone.note('スタッフが対応中のため、AI は返事をしません');
    } else {
      const stop = this.phone.typing();
      const wait = this.rec.ai && t.user.text ? Math.min(2400, Math.max(900, t.ms / 10)) : 500;
      await sleep(wait);
      stop();
      if (my !== this.token) return;
      this.phone.bot(t.bot, t.at.slice(11), { latencyMs: this.rec.ai && (t.user.text || t.tools.length) ? t.ms : undefined });
      this.source.push(this.userId, 'assistant', textOfBot(t.bot));
    }
    // 管理画面：予約表と会話の状態を、記録したその時点のものにする
    const before = this.idx > 0 ? this.main[this.idx - 1]!.snapshot : (this.rec.turns.find((x) => x.prelude)?.snapshot ?? t.snapshot);
    this.source.setBookings(t.snapshot.bookings);
    this.source.upsertConversation(this.userId, this.rec.user.name, { mode: t.snapshot.mode });
    const changed = t.snapshot.bookings.find((b) => {
      const prev = before.bookings.find((x) => x.id === b.id);
      return !prev || prev.start_at !== b.start_at || prev.status !== b.status;
    });
    const removed = before.bookings.find((b) => !t.snapshot.bookings.some((x) => x.id === b.id));
    const focus = changed?.start_at.slice(0, 10) ?? removed?.start_at.slice(0, 10);
    if (focus && this.admin.currentTab !== 'bookings') this.admin.setTab('bookings');
    await this.admin.refresh({ focusDate: focus, tools: this.rec.ai ? t.tools : null });
    this.idx++;
    this.busy = false;
    if (this.idx >= this.main.length) this.phone.note('この記録はここまでです。上のボタンからほかの場面も試せます。');
    this.prompt();
  }
}
