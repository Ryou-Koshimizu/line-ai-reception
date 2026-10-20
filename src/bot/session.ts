import { DurableObject } from 'cloudflare:workers';
import type { Env } from '../env';
import { clockFor } from '../env';
import { lineEventSchema } from '../line/types';
import { lineClient } from '../line/client';
import { claudeModel } from '../ai/model';
import { handleEvent } from './handle';
import { log } from '../domain/log';

/**
 * LINE の利用者 1 人につき 1 つ。届いたイベントをここに積み、アラームで 1 件ずつ順番に処理する。
 * - 同じ人のメッセージが同時に処理されない（順番が入れ替わらない）
 * - Webhook にはすぐ 200 を返し、AI の処理はリクエストの時間制限の外（アラーム）で行う
 * - 同じ webhookEventId は積む時点で 1 つにまとまる
 */
export class ChatSession extends DurableObject<Env> {
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.blockConcurrencyWhile(async () => {
      ctx.storage.sql.exec(
        'CREATE TABLE IF NOT EXISTS queue (seq INTEGER PRIMARY KEY AUTOINCREMENT, event_id TEXT UNIQUE, body TEXT NOT NULL, attempts INTEGER NOT NULL DEFAULT 0)',
      );
    });
  }

  async enqueue(eventId: string, body: string): Promise<void> {
    this.ctx.storage.sql.exec('INSERT OR IGNORE INTO queue (event_id, body) VALUES (?, ?)', eventId, body);
    if ((await this.ctx.storage.getAlarm()) === null) await this.ctx.storage.setAlarm(Date.now());
  }

  /** 積まれている件数（試験用） */
  async pending(): Promise<number> {
    return this.ctx.storage.sql.exec<{ n: number }>('SELECT COUNT(*) AS n FROM queue').one().n;
  }

  override async alarm(): Promise<void> {
    for (;;) {
      const row = this.ctx.storage.sql
        .exec<{ seq: number; body: string; attempts: number }>('SELECT seq, body, attempts FROM queue ORDER BY seq LIMIT 1')
        .toArray()[0];
      if (!row) return;
      // 処理の途中で止まった（再起動・入れ替え）イベントは、次のアラームでやり直す。3 回目で諦める
      this.ctx.storage.sql.exec('UPDATE queue SET attempts = attempts + 1 WHERE seq = ?', row.seq);
      if (row.attempts >= 3) {
        log('error', 'queued event abandoned after retries', { count: row.attempts });
        this.ctx.storage.sql.exec('DELETE FROM queue WHERE seq = ?', row.seq);
        continue;
      }
      try {
        const event = lineEventSchema.parse(JSON.parse(row.body));
        const env = this.env;
        await handleEvent(
          {
            db: env.DB,
            line: lineClient(env.LINE_API_BASE, env.LINE_CHANNEL_ACCESS_TOKEN ?? ''),
            model: env.ANTHROPIC_API_KEY
              ? claudeModel({ apiKey: env.ANTHROPIC_API_KEY, model: env.CLAUDE_MODEL, baseURL: env.ANTHROPIC_BASE_URL })
              : null,
            staffUserIds: (env.STAFF_LINE_USER_IDS ?? '')
              .split(',')
              .map((s) => s.trim())
              .filter(Boolean),
            now: clockFor(env, event.timestamp),
          },
          event,
          { retry: row.attempts > 0 },
        );
      } catch (e) {
        // 1 件の失敗で後ろのイベントを止めない（同じイベントを何度も送り直して二重に返事しないよう、失敗しても消す）
        log('error', 'queued event failed', { code: e instanceof Error ? e.message.slice(0, 80) : 'unknown' });
      }
      this.ctx.storage.sql.exec('DELETE FROM queue WHERE seq = ?', row.seq);
    }
  }
}
