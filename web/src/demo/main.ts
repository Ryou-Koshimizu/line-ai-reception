import '../styles/base.css';
import '../styles/page.css';
import '../styles/chat.css';
import '../styles/admin.css';
import { countTo, h, revealOnScroll, transition } from '../lib/dom';
import { hydrateIcons, icon } from '../lib/icons';
import { Phone } from '../chat/phone';
import { AdminView } from '../admin/view';
import { DemoSource } from '../admin/sources';
import { Player, textOfBot } from './player';
import recordingsJson from './recordings.json';
import evidenceJson from '../../../docs/evidence/live-check.json';
import type { Recordings } from '../types';

const recordings = recordingsJson as unknown as Recordings;
const evidence = evidenceJson as unknown as {
  model: string;
  runtime: string;
  finished_at: string;
  signature: { valid_sent: number; invalid_sent: number };
  dedupe: { deliveries: number; duplicate_replies: number };
  concurrency: { attempts: number; double_bookings: number; seats: number };
  totals: {
    checks: number;
    wrong_answers: number;
    double_bookings: number;
    signature_misjudgements: number;
    worker_errors: number;
    model_errors: number;
    ai_turn_median_ms: number;
    ai_turns: number;
    scenarios: number;
    ai_scenarios: number;
  };
};

hydrateIcons();

/** UTC の時刻を、日本時間の日付（YYYY-MM-DD）にする */
const jstDate = (iso: string) => new Date(new Date(iso).getTime() + 9 * 3600_000).toISOString().slice(0, 10);

// ── ヘッダーの影
const header = document.querySelector('.site-header')!;
const onScroll = () => header.classList.toggle('scrolled', window.scrollY > 8);
window.addEventListener('scroll', onScroll, { passive: true });
onScroll();

// ── ヒーローの数字（実機の確かめの結果）
const t = evidence.totals;
const proof: Array<[string, number, string]> = [
  ['proof-wrong', t.wrong_answers, `誤答（実AIの会話 ${t.checks} 項目）`],
  ['proof-double', t.double_bookings, `二重予約（同時 ${evidence.concurrency.attempts} 人）`],
  ['proof-sig', t.signature_misjudgements, `署名の誤判定（${evidence.signature.valid_sent + evidence.signature.invalid_sent} 通）`],
];
for (const [id, value, label] of proof) {
  const el = document.getElementById(id)!;
  el.dataset.value = String(value + 9);
  countTo(el, value, { duration: 1400 });
  document.getElementById(`${id}-label`)!.textContent = label;
}

// ── 確かめた数字の一覧
const numbers: Array<[number, string, string]> = [
  [t.wrong_answers, '件', `誤答。会話の筋書き ${t.scenarios} 場面（うち実AI ${t.ai_scenarios} 場面）・${t.checks} 項目の判定のうち`],
  [
    t.double_bookings,
    '件',
    `二重予約。${evidence.concurrency.attempts} 人が同時に同じ枠（${evidence.concurrency.seats} 席）を押した結果を含む`,
  ],
  [
    t.signature_misjudgements,
    '件',
    `署名の誤判定。正しい署名 ${evidence.signature.valid_sent} 通・不正な署名 ${evidence.signature.invalid_sent} 通`,
  ],
  [evidence.dedupe.duplicate_replies, '件', `再送による二重の返事。同じイベントを ${evidence.dedupe.deliveries} 回届けた結果`],
  [t.worker_errors, '件', 'Worker のエラーの記録'],
  [Math.round(t.ai_turn_median_ms / 100) / 10, '秒', `AI の返事までの時間の中央値（${t.ai_turns} 回）`],
];
const list = document.getElementById('numbers-list')!;
numbers.forEach(([value, unit, label], i) => {
  const b = h('b', { 'data-count': String(value), text: '0' });
  if (!Number.isInteger(value)) {
    b.removeAttribute('data-count');
    b.textContent = String(value);
  }
  list.append(
    h('li', { class: 'reveal', style: `--d:${i * 0.06}s` }, h('span', {}, b, h('small', { text: unit })), h('span', { text: label })),
  );
});
document.getElementById('numbers-note')!.textContent =
  `測定：${evidence.runtime}。AI は ${evidence.model}。Worker は本番と同じ Claude Messages API の呼び出しを行い、宛先だけをこの推論につないで測りました。測定日 ${jstDate(evidence.finished_at)}。`;

// ── 体験（トーク＋管理画面）
const badge = document.getElementById('replay-badge')!;
badge.append(
  h(
    'span',
    {},
    h('b', { text: '実AIの記録を再生しています。' }),
    h('span', { class: 'more', text: ` 記録 ${jstDate(recordings.recorded_at)}・${recordings.model}` }),
  ),
);

const source = new DemoSource(recordings.shop);
// ほかの場面の会話も、一覧に並べる（それぞれの記録の最後の状態）
for (const r of recordings.scenarios) {
  const last = r.turns.at(-1);
  if (!last) continue;
  source.setClock(last.at);
  source.upsertConversation(`demo-${r.id}`, r.user.name, { mode: last.snapshot.mode });
  for (const turn of r.turns) {
    source.push(`demo-${r.id}`, 'user', turn.user.text ?? (turn.user.follow ? '（友だち追加）' : `［ボタン］${turn.user.tap ?? ''}`));
    if (turn.bot.length) source.push(`demo-${r.id}`, 'assistant', textOfBot(turn.bot));
  }
}

let player: Player;
const phone = new Phone(document.getElementById('phone-host')!, { title: recordings.shop.name, onAct: () => void player.act() });
const admin = new AdminView(document.getElementById('admin-host')!, source, { today: '2026-11-04', showTools: true });
const progress = document.getElementById('progress')!;
const autoBtn = document.getElementById('auto') as HTMLButtonElement;
player = new Player(phone, admin, source, (s) => {
  progress.textContent = s.finished ? `${s.total} / ${s.total} 完了` : `${s.step} / ${s.total}`;
  if (s.finished && autoBtn.getAttribute('aria-pressed') === 'true') setAuto(false);
});

function setAuto(on: boolean) {
  autoBtn.setAttribute('aria-pressed', String(on));
  autoBtn.replaceChildren(icon(on ? 'Pause' : 'Play'), on ? '止める' : '自動で再生');
  player.setAuto(on);
}
autoBtn.addEventListener('click', () => setAuto(autoBtn.getAttribute('aria-pressed') !== 'true'));

const scenarioHost = document.getElementById('scenarios')!;
const buttons = recordings.scenarios
  .filter((r) => r.turns.length)
  .map((r, i) => {
    const b = h('button', { type: 'button', 'aria-pressed': String(i === 0), title: r.summary }, icon(r.ai ? 'Sparkles' : 'Hand'), r.title);
    b.addEventListener('click', () => {
      buttons.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
      setAuto(false);
      transition(() => void player.load(r));
    });
    scenarioHost.append(b);
    return b;
  });
document.getElementById('restart')!.addEventListener('click', () => {
  const i = buttons.findIndex((b) => b.getAttribute('aria-pressed') === 'true');
  setAuto(false);
  void player.load(recordings.scenarios.filter((r) => r.turns.length)[Math.max(0, i)]!);
});

// スマホ幅：トークと管理画面を切り替える
const stageBody = document.getElementById('stage-body')!;
document.querySelectorAll<HTMLButtonElement>('.stage-tabs button').forEach((b, _, all) =>
  b.addEventListener('click', () => {
    all.forEach((x) => x.setAttribute('aria-pressed', String(x === b)));
    transition(() => (stageBody.dataset.tab = b.dataset.tab!));
  }),
);

const first = recordings.scenarios.find((r) => r.turns.length);
if (first) void player.load(first);
revealOnScroll();
