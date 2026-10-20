import type { ChatSession } from './bot/session';

export interface Env {
  DB: D1Database;
  CHAT: DurableObjectNamespace<ChatSession>;
  ASSETS: Fetcher;
  ENVIRONMENT: string;
  CLAUDE_MODEL: string;
  LINE_API_BASE: string;
  ANTHROPIC_BASE_URL: string;
  LINE_CHANNEL_SECRET?: string;
  LINE_CHANNEL_ACCESS_TOKEN?: string;
  ANTHROPIC_API_KEY?: string;
  ADMIN_TOKEN?: string;
  STAFF_TOKEN?: string;
  STAFF_LINE_USER_IDS?: string;
}

/** 手元の確かめ（ENVIRONMENT=development）のときだけ、イベントの時刻を「今」として扱う。本番では常に実時刻。 */
export function clockFor(env: Pick<Env, 'ENVIRONMENT'>, eventTimestamp?: number): Date {
  if (env.ENVIRONMENT === 'development' && eventTimestamp) return new Date(eventTimestamp);
  return new Date();
}
