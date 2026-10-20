// スマホの枠の中のトーク画面。メッセージの表示と、「次に押せるもの」だけを押せるようにする役。
import { h, reduceMotion } from '../lib/dom';
import { icon, type IconName } from '../lib/icons';
import { renderFlex } from './flex';
import type { LineAction, LineMessage } from '../types';

export type Expect = { kind: 'text'; text: string } | { kind: 'tap'; data: string; label: string } | { kind: 'follow' } | null;

const RICH_MENU: Array<{ label: string; data: string; icon: IconName }> = [
  { label: '予約する', data: 'a=book', icon: 'CalendarCheck' },
  { label: '予約の確認・変更', data: 'a=mine', icon: 'ListChecks' },
  { label: 'メニューと料金', data: 'a=menu', icon: 'Store' },
  { label: '営業時間・場所', data: 'a=hours', icon: 'MapPin' },
  { label: 'よくある質問', data: 'faq', icon: 'Info' },
  { label: 'スタッフに相談', data: 'a=staff', icon: 'Headset' },
];

export class Phone {
  readonly el: HTMLElement;
  private log: HTMLElement;
  private quick: HTMLElement;
  private field: HTMLElement;
  private send: HTMLButtonElement;
  private richmenu: HTMLElement;
  private rmBar: HTMLButtonElement;
  private expect: Expect = null;
  private lastDay = '';

  constructor(
    host: HTMLElement,
    private opts: { title: string; onAct: () => void },
  ) {
    this.log = h('div', { class: 'chat-log', role: 'log', 'aria-live': 'polite', 'aria-label': 'トーク' });
    this.quick = h('div', { class: 'quick', role: 'group', 'aria-label': 'クイックリプライ' });
    this.field = h('div', { class: 'chat-field', 'aria-live': 'polite' }, h('span', { class: 'ghost hint', text: 'メッセージを入力' }));
    this.send = h('button', { type: 'button', class: 'send', 'aria-label': '送信', disabled: true }, icon('Send'));
    this.send.addEventListener('click', () => this.expect?.kind === 'text' && this.opts.onAct());
    this.richmenu = h('div', { class: 'richmenu', id: 'richmenu', role: 'group', 'aria-label': 'リッチメニュー' });
    for (const t of RICH_MENU) {
      const b = h(
        'button',
        {
          type: 'button',
          class: 'rm-tile',
          'data-action': JSON.stringify({ type: 'postback', label: t.label, data: t.data }),
          disabled: true,
        },
        icon(t.icon),
        t.label,
      );
      this.richmenu.append(b);
    }
    this.rmBar = h(
      'button',
      { type: 'button', class: 'rm-bar', 'aria-expanded': 'false', 'aria-controls': 'richmenu' },
      'メニュー',
      icon('ChevronUp'),
    );
    this.rmBar.addEventListener('click', () => this.toggleRichMenu());
    const top = h(
      'div',
      { class: 'chat-top' },
      h('span', { class: 'ic', 'aria-hidden': 'true' }, icon('ChevronLeft')),
      h('span', { class: 'title', text: opts.title }),
      h('span', { class: 'ic', 'aria-hidden': 'true' }, icon('Search')),
      h('span', { class: 'ic', 'aria-hidden': 'true' }, icon('Phone')),
      h('span', { class: 'ic', 'aria-hidden': 'true' }, icon('Menu')),
    );
    const input = h(
      'div',
      { class: 'chat-input' },
      h('span', { class: 'ic', 'aria-hidden': 'true' }, icon('Plus')),
      h('span', { class: 'ic', 'aria-hidden': 'true' }, icon('Camera')),
      this.field,
      this.send,
    );
    const screen = h('div', { class: 'screen' }, top, this.log, this.quick, input, this.rmBar, this.richmenu);
    this.el = h('div', { class: 'phone' }, screen);
    host.append(this.el);
    // 押せるボタンはどこにあっても、ここで受ける
    screen.addEventListener('click', (e) => {
      const btn = (e.target as HTMLElement).closest<HTMLButtonElement>('[data-action]');
      if (!btn || btn.disabled || !this.expect || this.expect.kind !== 'tap') return;
      const action = JSON.parse(btn.dataset.action!) as LineAction;
      if (action.type === 'postback' && action.data === this.expect.data) this.opts.onAct();
    });
  }

  reset(): void {
    this.log.replaceChildren();
    this.toggleRichMenu(false);
    this.quick.replaceChildren();
    this.lastDay = '';
    this.setExpect(null);
  }

  private scroll(): void {
    this.log.scrollTo({ top: this.log.scrollHeight, behavior: reduceMotion() ? 'auto' : 'smooth' });
  }

  day(label: string): void {
    if (label === this.lastDay) return;
    this.lastDay = label;
    this.log.append(h('div', { class: 'day-sep', text: label }));
  }

  note(text: string, cls = 'sys-note'): void {
    this.log.append(h('div', { class: `${cls} pop`, text }));
    this.scroll();
  }

  user(content: { text?: string; tap?: string; follow?: boolean }, time: string, animate = true): void {
    if (content.follow) {
      this.note('友だち追加しました');
      return;
    }
    const bubble = content.text
      ? h('div', { class: 'bubble', text: content.text })
      : h('div', { class: 'bubble tap' }, icon('Hand'), content.tap ?? '');
    const msg = h(
      'div',
      { class: `msg me ${animate ? 'pop' : ''}` },
      h('div', { class: 'stack' }, bubble),
      h('div', { class: 'meta' }, h('span', { text: '既読' }), h('span', { text: time })),
    );
    this.log.append(msg);
    this.scroll();
  }

  /** 友だち追加の場面：トークの真ん中に「友だち追加」を出す */
  followButton(onClick: () => void): void {
    const b = h('button', { type: 'button', class: 'btn primary small follow-btn next pop' }, icon('UserRound'), '友だち追加する');
    b.addEventListener('click', () => {
      b.remove();
      onClick();
    });
    this.log.append(h('div', { class: 'sys-note follow-wrap' }, b));
    this.scroll();
  }

  typing(): () => void {
    const el = h(
      'div',
      { class: 'msg bot pop', 'aria-label': '入力中' },
      h('span', { class: 'avatar' }, icon('Store')),
      h('div', { class: 'stack' }, h('div', { class: 'bubble typing' }, h('i'), h('i'), h('i'))),
    );
    this.log.append(el);
    this.scroll();
    return () => el.remove();
  }

  bot(messages: LineMessage[], time: string, opts: { animate?: boolean; latencyMs?: number; staff?: boolean } = {}): void {
    const animate = opts.animate ?? true;
    messages.forEach((m, i) => {
      const delay = animate ? `animation-delay:${i * 140}ms` : '';
      if (m.type === 'flex' && m.contents.type === 'carousel') {
        const row = renderFlex(m.contents, m.altText);
        this.log.append(row);
        return;
      }
      const content = m.type === 'text' ? h('div', { class: 'bubble', text: m.text }) : renderFlex(m.contents, m.altText);
      const msg = h(
        'div',
        { class: `msg bot ${animate ? 'pop' : ''}`, style: delay },
        h('span', { class: `avatar ${opts.staff ? 'staff' : ''}` }, icon(opts.staff ? 'UserRound' : 'Store')),
        h(
          'div',
          { class: 'stack' },
          i === 0 ? h('span', { class: 'who', text: opts.staff ? 'スタッフ' : this.opts.title }) : null,
          content,
        ),
        h('div', { class: 'meta' }, h('span', { text: time })),
      );
      this.log.append(msg);
    });
    if (opts.latencyMs) {
      this.log.append(h('div', { class: 'latency' }, icon('Clock'), `記録時の応答 ${(opts.latencyMs / 1000).toFixed(1)} 秒`));
    }
    // クイックリプライは最後のメッセージのもの
    const last = messages.at(-1);
    this.quick.replaceChildren();
    for (const [i, item] of (last?.quickReply?.items ?? []).entries()) {
      this.quick.append(
        h('button', {
          type: 'button',
          class: 'qr',
          style: `--i:${i}`,
          'data-action': JSON.stringify(item.action),
          disabled: true,
          text: item.action.label,
        }),
      );
    }
    this.scroll();
  }

  private toggleRichMenu(force?: boolean): void {
    const open = force ?? this.rmBar.getAttribute('aria-expanded') !== 'true';
    this.rmBar.setAttribute('aria-expanded', String(open));
    this.richmenu.classList.toggle('open', open);
  }

  /** 次に押せるもの（記録で実際に押されたもの）だけを押せるようにする */
  setExpect(e: Expect): void {
    this.expect = e;
    const all = this.el.querySelectorAll<HTMLButtonElement>('[data-action]');
    let target: HTMLButtonElement | undefined;
    all.forEach((b) => {
      b.classList.remove('next');
      b.disabled = true;
      b.removeAttribute('title');
    });
    if (e?.kind === 'tap') {
      // 新しいものから探す（同じ時刻のボタンが複数の日にあっても、記録の data で決まる）
      for (const b of [...all].reverse()) {
        const a = JSON.parse(b.dataset.action!) as LineAction;
        if (a.type === 'postback' && a.data === e.data) {
          target = b;
          break;
        }
      }
      if (target) {
        target.disabled = false;
        target.classList.add('next');
        if (target.classList.contains('rm-tile')) this.toggleRichMenu(true);
        // カルーセルの中なら、そのカードまで横に送る
        const card = target.closest('.flex-bubble');
        const rail = target.closest('.carousel');
        if (card && rail) rail.scrollTo({ left: (card as HTMLElement).offsetLeft - 40, behavior: reduceMotion() ? 'auto' : 'smooth' });
      }
    }
    const ghost = this.field.querySelector('.ghost')!;
    if (e?.kind === 'text') {
      ghost.textContent = e.text;
      ghost.classList.remove('hint');
      this.send.disabled = false;
      this.field.setAttribute('aria-label', `送る文：${e.text}`);
    } else {
      ghost.textContent = e?.kind === 'tap' ? `光っている「${e.label}」を押してください` : 'メッセージを入力';
      ghost.classList.add('hint');
      this.send.disabled = true;
      this.field.removeAttribute('aria-label');
    }
    if (e?.kind !== 'tap' || !target?.classList.contains('rm-tile')) this.toggleRichMenu(false);
  }
}
