import type { MiddlewareHandler } from 'hono';
import type { Env } from '../env';
import { timingSafeEqual } from '../line/signature';

export type Role = 'owner' | 'staff';

async function digest(value: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value)));
}

/** 長さの違いも漏らさないよう、両方をハッシュしてから定数時間で比べる */
async function sameSecret(given: string, expected: string | undefined): Promise<boolean> {
  if (!expected || expected.length < 16) return false; // 短すぎる鍵は設定ミスとして使わない
  return timingSafeEqual(await digest(given), await digest(expected));
}

export async function roleFor(env: Env, authorization: string | undefined): Promise<Role | null> {
  const m = /^Bearer (.{1,512})$/.exec(authorization ?? '');
  if (!m) return null;
  const token = m[1]!;
  if (await sameSecret(token, env.ADMIN_TOKEN)) return 'owner';
  if (await sameSecret(token, env.STAFF_TOKEN)) return 'staff';
  return null;
}

/** owner：すべて / staff：予約と会話の操作（店の情報の編集はできない） */
export function requireRole(...allowed: Role[]): MiddlewareHandler<{ Bindings: Env; Variables: { role: Role } }> {
  return async (c, next) => {
    const role = await roleFor(c.env, c.req.header('authorization'));
    if (!role) return c.json({ error: 'ログインが必要です' }, 401);
    if (!allowed.includes(role)) return c.json({ error: 'この操作は店長（オーナー）の鍵が必要です' }, 403);
    c.set('role', role);
    await next();
  };
}
