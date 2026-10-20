import { redact } from './pii';

export type Mode = 'ai' | 'human';
export type Role = 'user' | 'assistant' | 'staff' | 'system';

export interface Conversation {
  line_user_id: string;
  display_name: string;
  mode: Mode;
  handoff_reason: string | null;
  last_message: string | null;
  last_at: string;
  unread: number;
  closed_notice_at: string | null;
}

export interface StoredMessage {
  id: number;
  line_user_id: string;
  role: Role;
  text: string;
  created_at: string;
}

const preview = (text: string) => (text.length > 60 ? `${text.slice(0, 59)}…` : text);

export async function ensureConversation(db: D1Database, userId: string, displayName: string, now: Date): Promise<Conversation> {
  await db
    .prepare('INSERT INTO conversations (line_user_id, display_name, last_at) VALUES (?1, ?2, ?3) ON CONFLICT (line_user_id) DO NOTHING')
    .bind(userId, displayName.slice(0, 40), now.toISOString())
    .run();
  return (await getConversation(db, userId))!;
}

export async function getConversation(db: D1Database, userId: string): Promise<Conversation | null> {
  return db.prepare('SELECT * FROM conversations WHERE line_user_id = ?1').bind(userId).first<Conversation>();
}

/** 保存の前に必ず伏せ字にする。保存した文はそのまま AI の履歴にも使う */
export async function appendMessage(db: D1Database, userId: string, role: Role, text: string, now: Date): Promise<string> {
  const safe = redact(text).slice(0, 2000);
  const iso = now.toISOString();
  await db.batch([
    db.prepare('INSERT INTO messages (line_user_id, role, text, created_at) VALUES (?1, ?2, ?3, ?4)').bind(userId, role, safe, iso),
    db
      .prepare(
        `UPDATE conversations SET last_message = ?2, last_at = ?3, unread = CASE WHEN ?4 = 'user' THEN unread + 1 ELSE unread END WHERE line_user_id = ?1`,
      )
      .bind(userId, preview(safe), iso, role),
  ]);
  return safe;
}

export async function recentMessages(db: D1Database, userId: string, limit = 12): Promise<StoredMessage[]> {
  const { results } = await db
    .prepare('SELECT * FROM messages WHERE line_user_id = ?1 ORDER BY id DESC LIMIT ?2')
    .bind(userId, limit)
    .all<StoredMessage>();
  return results.reverse();
}

export async function setMode(db: D1Database, userId: string, mode: Mode, reason: string | null): Promise<boolean> {
  const r = await db
    .prepare('UPDATE conversations SET mode = ?2, handoff_reason = ?3 WHERE line_user_id = ?1')
    .bind(userId, mode, reason ? redact(reason).slice(0, 200) : null)
    .run();
  return r.meta.changes === 1;
}

export async function markClosedNotice(db: D1Database, userId: string, now: Date): Promise<void> {
  await db.prepare('UPDATE conversations SET closed_notice_at = ?2 WHERE line_user_id = ?1').bind(userId, now.toISOString()).run();
}

export async function markRead(db: D1Database, userId: string): Promise<void> {
  await db.prepare('UPDATE conversations SET unread = 0 WHERE line_user_id = ?1').bind(userId).run();
}

export async function listConversations(db: D1Database, limit = 100): Promise<Conversation[]> {
  const { results } = await db.prepare('SELECT * FROM conversations ORDER BY last_at DESC LIMIT ?1').bind(limit).all<Conversation>();
  return results;
}

/** 1 人あたりの AI 応答の回数制限（10 分で 20 通） */
export async function recentUserMessageCount(db: D1Database, userId: string, now: Date): Promise<number> {
  const since = new Date(now.getTime() - 10 * 60_000).toISOString();
  const row = await db
    .prepare("SELECT COUNT(*) AS n FROM messages WHERE line_user_id = ?1 AND role = 'user' AND created_at > ?2")
    .bind(userId, since)
    .first<{ n: number }>();
  return row?.n ?? 0;
}
