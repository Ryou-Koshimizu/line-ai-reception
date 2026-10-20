type Attrs = Record<string, string | number | boolean | undefined | null>;
type Child = Node | string | null | undefined | false;

/** 小さな要素作成の道具。文字は textContent で入れる（HTML として解釈しない） */
export function h<K extends keyof HTMLElementTagNameMap>(tag: K, attrs: Attrs = {}, ...children: Child[]): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  for (const [k, v] of Object.entries(attrs)) {
    if (v === undefined || v === null || v === false) continue;
    if (k === 'class') el.className = String(v);
    else if (k === 'text') el.textContent = String(v);
    else if (k === 'style') el.setAttribute('style', String(v));
    else el.setAttribute(k, v === true ? '' : String(v));
  }
  for (const c of children) if (c !== null && c !== undefined && c !== false) el.append(c);
  return el;
}

export const reduceMotion = () => window.matchMedia('(prefers-reduced-motion: reduce)').matches;

/** View Transitions があれば使い、なければそのまま変える */
export function transition(update: () => void): void {
  const doc = document as Document & { startViewTransition?: (cb: () => void) => unknown };
  if (doc.startViewTransition && !reduceMotion()) doc.startViewTransition(update);
  else update();
}

/** 数字を、前の値から新しい値までなめらかに数える */
export function countTo(el: HTMLElement, to: number, opts: { duration?: number; format?: (n: number) => string } = {}): void {
  const fmt = opts.format ?? ((n: number) => Math.round(n).toLocaleString('ja-JP'));
  const from = Number(el.dataset.value ?? '0');
  el.dataset.value = String(to);
  if (reduceMotion() || from === to) {
    el.textContent = fmt(to);
    return;
  }
  const duration = opts.duration ?? 900;
  const start = performance.now();
  const step = (now: number) => {
    const t = Math.min(1, (now - start) / duration);
    const eased = 1 - Math.pow(1 - t, 4);
    el.textContent = fmt(from + (to - from) * eased);
    if (t < 1) requestAnimationFrame(step);
  };
  requestAnimationFrame(step);
}

/** 画面に入ったら .in を付けて出す。数字は data-count で数える */
export function revealOnScroll(root: ParentNode = document): void {
  const items = root.querySelectorAll<HTMLElement>('.reveal, [data-count]');
  if (!('IntersectionObserver' in window)) {
    items.forEach((el) => el.classList.add('in'));
    return;
  }
  const io = new IntersectionObserver(
    (entries) => {
      for (const e of entries) {
        if (!e.isIntersecting) continue;
        const el = e.target as HTMLElement;
        el.classList.add('in');
        if (el.dataset.count) countTo(el, Number(el.dataset.count), { duration: 1300 });
        io.unobserve(el);
      }
    },
    { rootMargin: '0px 0px -8% 0px' },
  );
  items.forEach((el) => io.observe(el));
}

export function toast(message: string): void {
  let el = document.querySelector<HTMLElement>('.toast');
  if (!el) {
    el = h('div', { class: 'toast', role: 'status', 'aria-live': 'polite' });
    document.body.append(el);
  }
  el.textContent = message;
  el.classList.add('show');
  window.clearTimeout(Number(el.dataset.timer));
  el.dataset.timer = String(window.setTimeout(() => el!.classList.remove('show'), 3800));
}
