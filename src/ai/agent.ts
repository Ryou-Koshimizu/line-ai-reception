import type { ChatModel, ContentBlock, MessageParam } from './model';
import { TOOL_DEFS, runTool, type ToolContext } from './tools';
import { buildSystem } from './prompt';
import { guardReply } from './guard';
import type { LineMessage } from '../line/types';
import type { StoredMessage } from '../domain/conversation';
import { log } from '../domain/log';

export interface AgentResult {
  text: string;
  ui: LineMessage[];
  toolCalls: Array<{ name: string; ok: boolean }>;
  flags: string[];
  handedOff: boolean;
}

const MAX_STEPS = 6;
const MAX_INPUT = 1000;
export const FALLBACK_TEXT = 'このご用件は、下のボタンから選ぶか「スタッフに相談」と送ってください。スタッフが確認します。';

/** 保存済みの会話（伏せ字済み）を、AI に渡す形に直す。役割が続くときはまとめる */
export function historyToMessages(history: StoredMessage[]): MessageParam[] {
  const out: Array<{ role: 'user' | 'assistant'; text: string }> = [];
  for (const m of history) {
    if (m.role === 'system') continue;
    const role = m.role === 'user' ? 'user' : 'assistant';
    const text = m.role === 'staff' ? `（スタッフ）${m.text}` : m.text;
    const last = out[out.length - 1];
    if (last && last.role === role) last.text += `\n${text}`;
    else out.push({ role, text });
  }
  while (out[0] && out[0].role !== 'user') out.shift();
  return out.map((m) => ({ role: m.role, content: m.text }));
}

export async function runAgent(opts: {
  model: ChatModel;
  ctx: ToolContext;
  history: StoredMessage[];
  userText: string;
}): Promise<AgentResult> {
  const { model, ctx } = opts;
  const system = buildSystem(ctx.shop, ctx.displayName, ctx.now);
  const messages: MessageParam[] = historyToMessages(opts.history);
  const userText = opts.userText.slice(0, MAX_INPUT);
  if (messages.length && messages[messages.length - 1]!.role === 'user') {
    const last = messages[messages.length - 1]!;
    last.content = `${last.content as string}\n${userText}`;
  } else messages.push({ role: 'user', content: userText });

  const ui = new Map<string, LineMessage>();
  const toolCalls: AgentResult['toolCalls'] = [];
  let committed = false;
  let handedOff = false;
  let finalText = '';

  for (let step = 0; step < MAX_STEPS; step++) {
    const res = await model.create({ system, tools: TOOL_DEFS, messages });
    if (res.stop_reason === 'refusal') {
      finalText = '';
      break;
    }
    messages.push({ role: 'assistant', content: res.content as MessageParam['content'] });
    const uses = res.content.filter((b): b is Extract<ContentBlock, { type: 'tool_use' }> => b.type === 'tool_use');
    const text = res.content
      .filter((b): b is Extract<ContentBlock, { type: 'text' }> => b.type === 'text')
      .map((b) => b.text)
      .join('\n')
      .trim();
    if (uses.length === 0 || res.stop_reason !== 'tool_use') {
      finalText = text;
      break;
    }
    const results = [];
    for (const use of uses) {
      const outcome = await runTool(use.name, use.input, ctx);
      toolCalls.push({ name: use.name, ok: !outcome.isError });
      log('info', 'tool', { tool: use.name, ok: !outcome.isError, code: (outcome.result.code as string) ?? null });
      if (outcome.ui) ui.set(use.name === 'reschedule_booking' ? 'confirm_booking' : use.name, outcome.ui);
      if (outcome.committed) committed = true;
      if (use.name === 'handoff_to_staff' && !outcome.isError) handedOff = true;
      results.push({
        type: 'tool_result' as const,
        tool_use_id: use.id,
        content: JSON.stringify(outcome.result),
        ...(outcome.isError ? { is_error: true } : {}),
      });
    }
    messages.push({ role: 'user', content: results });
  }

  const guarded = guardReply({ text: finalText, committed, allowedLinks: ctx.shop.links });
  // 1 回の返事で出すカードは、最後に意味のあるものだけ（空き枠 → 仮予約 → 確定 の順に新しいものを優先）
  const order = ['confirm_booking', 'hold_booking', 'find_available_slots'];
  const card = order.map((k) => ui.get(k)).find(Boolean);
  return {
    text: guarded.text || FALLBACK_TEXT,
    ui: card ? [card] : [],
    toolCalls,
    flags: guarded.flags,
    handedOff,
  };
}
