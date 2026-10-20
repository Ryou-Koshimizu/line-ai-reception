// LINE の Flex Message（このボットが送る範囲：bubble / carousel / box / text / button / separator）を画面に描く
import { h } from '../lib/dom';
import type { FlexNode, LineAction } from '../types';

const SIZE: Record<string, string> = { xxs: 'xs', xs: 'xs', sm: 'sm', md: 'md', lg: 'lg', xl: 'lg', xxl: 'lg' };

function node(n: FlexNode): HTMLElement | null {
  switch (n.type) {
    case 'box': {
      const layout = n.layout === 'horizontal' ? 'h' : n.layout === 'baseline' ? 'b' : 'v';
      const gap = n.spacing === 'sm' ? 6 : n.spacing === 'md' ? 9 : n.spacing === 'lg' ? 12 : 0;
      const box = h('div', { class: `fx-box ${layout}`, style: `gap:${gap}px` });
      for (const c of (n.contents as FlexNode[]) ?? []) {
        const el = node(c);
        if (el) box.append(el);
      }
      return box;
    }
    case 'text': {
      const cls = ['fx-text', SIZE[String(n.size ?? 'md')] ?? 'md', n.weight === 'bold' ? 'bold' : ''].join(' ');
      const style = [n.color ? `color:${String(n.color)}` : '', typeof n.flex === 'number' ? `flex:${n.flex} 1 0` : '']
        .filter(Boolean)
        .join(';');
      return h('p', { class: cls, style, text: String(n.text ?? '') });
    }
    case 'separator':
      return h('div', { class: 'fx-sep', role: 'presentation' });
    case 'button': {
      const action = n.action as LineAction;
      const style = String(n.style ?? 'link');
      const btn = h('button', {
        type: 'button',
        class: `fx-btn ${style} ${n.height === 'sm' ? 'sm' : ''}`,
        style: style === 'primary' ? `background:${String(n.color ?? '#0B7A52')}` : '',
        text: action.label,
        'data-action': JSON.stringify(action),
        disabled: true,
      });
      return btn;
    }
    default:
      return null;
  }
}

function section(cls: string, n: unknown): HTMLElement | null {
  if (!n || typeof n !== 'object') return null;
  const inner = node(n as FlexNode);
  if (!inner) return null;
  return h('div', { class: cls }, inner);
}

export function renderBubble(b: FlexNode, i = 0): HTMLElement {
  const el = h('div', { class: `flex-bubble ${b.size === 'kilo' ? 'kilo' : ''}`, style: `--i:${i}` });
  for (const [key, cls] of [
    ['header', 'flex-header'],
    ['body', 'flex-body'],
    ['footer', 'flex-footer'],
  ] as const) {
    const s = section(cls, b[key]);
    if (s) el.append(s);
  }
  return el;
}

export function renderFlex(contents: FlexNode, altText: string): HTMLElement {
  if (contents.type === 'carousel') {
    const wrap = h('div', { class: 'carousel', role: 'group', 'aria-label': altText });
    (contents.contents as FlexNode[]).forEach((b, i) => wrap.append(renderBubble(b, i)));
    return wrap;
  }
  const one = renderBubble(contents);
  one.setAttribute('role', 'group');
  one.setAttribute('aria-label', altText);
  return one;
}
