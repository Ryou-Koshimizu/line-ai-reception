import { addDays, addMinutesLocal, fromJstLocal, isLocalTime, toJstLocal } from './time';
import { hoursOn, type Menu, type ShopInfo } from './shop';

export type BookingStatus = 'held' | 'confirmed' | 'cancelled' | 'expired';
export interface Booking {
  id: string;
  line_user_id: string | null;
  source: 'line' | 'staff';
  customer_name: string;
  menu_id: string;
  menu_name: string;
  price: number;
  start_at: string;
  end_at: string;
  seat: number;
  status: BookingStatus;
  hold_expires_at: string | null;
  created_at: string;
  updated_at: string;
}

/** 予約の操作で起きる、利用者に説明できる失敗 */
export class BookingError extends Error {
  constructor(
    readonly code:
      | 'UNKNOWN_MENU'
      | 'INVALID_TIME'
      | 'CLOSED'
      | 'OUTSIDE_HOURS'
      | 'TOO_SOON'
      | 'TOO_FAR'
      | 'TAKEN'
      | 'NOT_FOUND'
      | 'HOLD_EXPIRED'
      | 'DEADLINE_PASSED'
      | 'LIMIT_REACHED',
  ) {
    super(code);
  }
}

const MAX_UPCOMING_PER_USER = 3;

export function unitsOf(shop: ShopInfo, start: string, minutes: number): string[] {
  const units: string[] = [];
  for (let m = 0; m < minutes; m += shop.slotMinutes) units.push(addMinutesLocal(start, m));
  return units;
}

function findMenu(shop: ShopInfo, menuId: string): Menu {
  const menu = shop.menus.find((m) => m.id === menuId);
  if (!menu) throw new BookingError('UNKNOWN_MENU');
  return menu;
}

/** 予約できる時刻かどうか（営業時間・区切り・締め切り）。空きは見ない */
export function validateStart(shop: ShopInfo, menu: Menu, start: string, now: Date, window = true): void {
  if (!isLocalTime(start)) throw new BookingError('INVALID_TIME');
  const date = start.slice(0, 10);
  const hours = hoursOn(shop, date);
  if (!hours) throw new BookingError('CLOSED');
  const end = addMinutesLocal(start, menu.minutes);
  const [, mm] = start.slice(11).split(':').map(Number);
  if (mm! % shop.slotMinutes !== 0) throw new BookingError('INVALID_TIME');
  if (start.slice(11) < hours.open || end.slice(0, 10) !== date || end.slice(11) > hours.close) throw new BookingError('OUTSIDE_HOURS');
  if (!window) return;
  if (fromJstLocal(start).getTime() < now.getTime() + shop.leadMinutes * 60_000) throw new BookingError('TOO_SOON');
  if (date > addDays(toJstLocal(now).slice(0, 10), shop.maxDaysAhead)) throw new BookingError('TOO_FAR');
}

async function purgeExpired(db: D1Database, now: Date): Promise<void> {
  const iso = now.toISOString();
  await db.batch([
    db.prepare('DELETE FROM slot_locks WHERE expires_at IS NOT NULL AND expires_at <= ?1').bind(iso),
    db.prepare("UPDATE bookings SET status = 'expired', updated_at = ?1 WHERE status = 'held' AND hold_expires_at <= ?1").bind(iso),
  ]);
}

async function busyUnits(db: D1Database, from: string, to: string, now: Date): Promise<Map<string, Set<number>>> {
  const { results } = await db
    .prepare('SELECT unit, seat FROM slot_locks WHERE unit >= ?1 AND unit < ?2 AND (expires_at IS NULL OR expires_at > ?3)')
    .bind(from, to, now.toISOString())
    .all<{ unit: string; seat: number }>();
  const map = new Map<string, Set<number>>();
  for (const r of results) {
    if (!map.has(r.unit)) map.set(r.unit, new Set());
    map.get(r.unit)!.add(r.seat);
  }
  return map;
}

export interface SlotQuery {
  menuId: string;
  dateFrom: string;
  dateTo?: string;
  part?: 'morning' | 'afternoon' | 'evening' | 'any';
  limit?: number;
}

/** 空き枠を探す（席のどれか 1 つが、メニューの所要時間ぶん続けて空いている開始時刻） */
export async function findAvailableSlots(db: D1Database, shop: ShopInfo, q: SlotQuery, now: Date): Promise<string[]> {
  const menu = findMenu(shop, q.menuId);
  const today = toJstLocal(now).slice(0, 10);
  const from = q.dateFrom < today ? today : q.dateFrom;
  const lastDay = addDays(today, shop.maxDaysAhead);
  let to = q.dateTo && q.dateTo >= from ? q.dateTo : from;
  if (to > lastDay) to = lastDay;
  if (to > addDays(from, 13)) to = addDays(from, 13);
  const limit = Math.min(q.limit ?? 24, 60);
  const busy = await busyUnits(db, `${from}T00:00`, `${addDays(to, 1)}T00:00`, now);
  const slots: string[] = [];
  for (let date = from; date <= to; date = addDays(date, 1)) {
    const hours = hoursOn(shop, date);
    if (!hours) continue;
    for (let start = `${date}T${hours.open}`; ; start = addMinutesLocal(start, shop.slotMinutes)) {
      const end = addMinutesLocal(start, menu.minutes);
      if (end.slice(0, 10) !== date || end.slice(11) > hours.close) break;
      try {
        validateStart(shop, menu, start, now);
      } catch {
        continue;
      }
      const hour = Number(start.slice(11, 13));
      const part = q.part ?? 'any';
      if (part === 'morning' && hour >= 12) continue;
      if (part === 'afternoon' && (hour < 12 || hour >= 17)) continue;
      if (part === 'evening' && hour < 17) continue;
      const units = unitsOf(shop, start, menu.minutes);
      const free = Array.from({ length: shop.seats }, (_, i) => i + 1).some((seat) => units.every((u) => !busy.get(u)?.has(seat)));
      if (free) slots.push(start);
      if (slots.length >= limit) return slots;
    }
  }
  return slots;
}

function newId(): string {
  // 推測されにくい 12 文字（予約番号として客にも見せる先頭 6 文字は大文字英数字）
  const bytes = crypto.getRandomValues(new Uint8Array(12));
  const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // 32 文字。紛らわしい 0/O/1/I は使わない
  return [...bytes].map((b) => alphabet[b % alphabet.length]).join('');
}

function isConstraintError(e: unknown): boolean {
  return e instanceof Error && /UNIQUE constraint failed|SQLITE_CONSTRAINT/i.test(e.message);
}

/**
 * 席を 1 つ選んで、予約の行とコマの鍵を 1 つのトランザクションで書く。
 * 同時に同じコマを取りに来ても、slot_locks の主キーがどちらか一方だけを通す。
 */
async function insertWithSeat(
  db: D1Database,
  shop: ShopInfo,
  units: string[],
  expiresAt: string | null,
  buildBookingStatement: (seat: number) => D1PreparedStatement[],
  bookingId: string,
): Promise<number> {
  for (let seat = 1; seat <= shop.seats; seat++) {
    try {
      await db.batch([
        ...buildBookingStatement(seat),
        ...units.map((u) =>
          db
            // 予約の行が生きているときだけ鍵を入れる（同時の取り消しで鍵だけ残らないように）
            .prepare(
              "INSERT INTO slot_locks (unit, seat, booking_id, expires_at) SELECT ?1, ?2, ?3, ?4 WHERE EXISTS (SELECT 1 FROM bookings WHERE id = ?3 AND status IN ('held','confirmed'))",
            )
            .bind(u, seat, bookingId, expiresAt),
        ),
      ]);
      return seat;
    } catch (e) {
      if (isConstraintError(e)) continue;
      throw e;
    }
  }
  throw new BookingError('TAKEN');
}

export interface HoldInput {
  userId: string;
  customerName: string;
  menuId: string;
  start: string;
}

/** 仮予約（holdMinutes のあいだ枠を押さえる）。同じ人のほかの仮予約は外す */
export async function holdBooking(db: D1Database, shop: ShopInfo, input: HoldInput, now: Date): Promise<Booking> {
  const menu = findMenu(shop, input.menuId);
  validateStart(shop, menu, input.start, now);
  await purgeExpired(db, now);
  const nowIso = now.toISOString();
  // 同じ人の古い仮予約を外す
  const oldHolds = await db
    .prepare("SELECT id FROM bookings WHERE line_user_id = ?1 AND status = 'held'")
    .bind(input.userId)
    .all<{ id: string }>();
  for (const h of oldHolds.results) await releaseHold(db, h.id, nowIso);
  const upcoming = await db
    .prepare("SELECT COUNT(*) AS n FROM bookings WHERE line_user_id = ?1 AND status = 'confirmed' AND start_at >= ?2")
    .bind(input.userId, toJstLocal(now))
    .first<{ n: number }>();
  if ((upcoming?.n ?? 0) >= MAX_UPCOMING_PER_USER) throw new BookingError('LIMIT_REACHED');

  const id = newId();
  const end = addMinutesLocal(input.start, menu.minutes);
  const expiresAt = new Date(now.getTime() + shop.holdMinutes * 60_000).toISOString();
  const units = unitsOf(shop, input.start, menu.minutes);
  const seat = await insertWithSeat(
    db,
    shop,
    units,
    expiresAt,
    (s) => [
      db
        .prepare(
          `INSERT INTO bookings (id, line_user_id, source, customer_name, menu_id, menu_name, price, start_at, end_at, seat, status, hold_expires_at, created_at, updated_at)
           VALUES (?1, ?2, 'line', ?3, ?4, ?5, ?6, ?7, ?8, ?9, 'held', ?10, ?11, ?11)`,
        )
        .bind(id, input.userId, input.customerName.slice(0, 40), menu.id, menu.name, menu.price, input.start, end, s, expiresAt, nowIso),
    ],
    id,
  );
  return {
    id,
    line_user_id: input.userId,
    source: 'line',
    customer_name: input.customerName.slice(0, 40),
    menu_id: menu.id,
    menu_name: menu.name,
    price: menu.price,
    start_at: input.start,
    end_at: end,
    seat,
    status: 'held',
    hold_expires_at: expiresAt,
    created_at: nowIso,
    updated_at: nowIso,
  };
}

async function releaseHold(db: D1Database, bookingId: string, nowIso: string): Promise<void> {
  await db.batch([
    db.prepare('DELETE FROM slot_locks WHERE booking_id = ?1').bind(bookingId),
    db.prepare("UPDATE bookings SET status = 'cancelled', updated_at = ?2 WHERE id = ?1 AND status = 'held'").bind(bookingId, nowIso),
  ]);
}

export async function getBooking(db: D1Database, id: string): Promise<Booking | null> {
  return db.prepare('SELECT * FROM bookings WHERE id = ?1').bind(id).first<Booking>();
}

/** 自分の仮予約を確定する。他人の予約・期限切れは確定できない（条件付き更新で強制） */
export async function confirmBooking(db: D1Database, userId: string, bookingId: string, now: Date): Promise<Booking> {
  const iso = now.toISOString();
  const cond = "id = ?1 AND line_user_id = ?2 AND status = 'held' AND hold_expires_at > ?3";
  const [locks, upd] = await db.batch([
    db
      .prepare(`UPDATE slot_locks SET expires_at = NULL WHERE booking_id = ?1 AND EXISTS (SELECT 1 FROM bookings WHERE ${cond})`)
      .bind(bookingId, userId, iso),
    db
      .prepare(`UPDATE bookings SET status = 'confirmed', hold_expires_at = NULL, updated_at = ?3 WHERE ${cond}`)
      .bind(bookingId, userId, iso),
  ]);
  void locks;
  if (upd!.meta.changes === 1) return (await getBooking(db, bookingId))!;
  const current = await getBooking(db, bookingId);
  if (!current || current.line_user_id !== userId) throw new BookingError('NOT_FOUND');
  if (current.status === 'confirmed') return current; // 2 回押しても 1 件のまま
  throw new BookingError('HOLD_EXPIRED');
}

function checkDeadline(shop: ShopInfo, booking: Booking, now: Date): void {
  if (fromJstLocal(booking.start_at).getTime() - now.getTime() < shop.changeDeadlineHours * 3_600_000)
    throw new BookingError('DEADLINE_PASSED');
}

/** 取り消し。actor が 'staff' のときは誰の予約でも、締め切りなしで取り消せる */
export async function cancelBooking(
  db: D1Database,
  shop: ShopInfo,
  actor: { userId: string } | 'staff',
  bookingId: string,
  now: Date,
): Promise<Booking> {
  const current = await getBooking(db, bookingId);
  if (!current || (actor !== 'staff' && current.line_user_id !== actor.userId)) throw new BookingError('NOT_FOUND');
  if (current.status === 'cancelled') return current;
  if (current.status !== 'held' && current.status !== 'confirmed') throw new BookingError('NOT_FOUND');
  if (actor !== 'staff' && current.status === 'confirmed') checkDeadline(shop, current, now);
  const iso = now.toISOString();
  const [, upd] = await db.batch([
    db
      .prepare(
        "DELETE FROM slot_locks WHERE booking_id = ?1 AND EXISTS (SELECT 1 FROM bookings WHERE id = ?1 AND status IN ('held','confirmed'))",
      )
      .bind(bookingId),
    db
      .prepare(
        "UPDATE bookings SET status = 'cancelled', hold_expires_at = NULL, updated_at = ?2 WHERE id = ?1 AND status IN ('held','confirmed')",
      )
      .bind(bookingId, iso),
  ]);
  if (upd!.meta.changes !== 1) throw new BookingError('NOT_FOUND');
  return (await getBooking(db, bookingId))!;
}

/** 確定済みの予約の日時を変える。新しい枠が取れなければ元の予約はそのまま（同じトランザクション） */
export async function rescheduleBooking(
  db: D1Database,
  shop: ShopInfo,
  userId: string,
  bookingId: string,
  newStart: string,
  now: Date,
): Promise<Booking> {
  const current = await getBooking(db, bookingId);
  if (!current || current.line_user_id !== userId || current.status !== 'confirmed') throw new BookingError('NOT_FOUND');
  checkDeadline(shop, current, now);
  const menu = findMenu(shop, current.menu_id);
  validateStart(shop, menu, newStart, now);
  if (newStart === current.start_at) return current;
  await purgeExpired(db, now);
  const end = addMinutesLocal(newStart, menu.minutes);
  const iso = now.toISOString();
  const units = unitsOf(shop, newStart, menu.minutes);
  await insertWithSeat(
    db,
    shop,
    units,
    null,
    (seat) => [
      db.prepare('DELETE FROM slot_locks WHERE booking_id = ?1').bind(bookingId),
      db
        .prepare("UPDATE bookings SET start_at = ?2, end_at = ?3, seat = ?4, updated_at = ?5 WHERE id = ?1 AND status = 'confirmed'")
        .bind(bookingId, newStart, end, seat, iso),
    ],
    bookingId,
  );
  return (await getBooking(db, bookingId))!;
}

/** スタッフが電話・来店で受けた予約を入れる（LINE を通らない予約も同じ鍵で守る） */
export async function addStaffBooking(
  db: D1Database,
  shop: ShopInfo,
  input: { customerName: string; menuId: string; start: string },
  now: Date,
): Promise<Booking> {
  const menu = findMenu(shop, input.menuId);
  validateStart(shop, menu, input.start, now, false); // 電話の当日予約なども入れられるよう、締め切りは見ない
  await purgeExpired(db, now);
  const id = newId();
  const end = addMinutesLocal(input.start, menu.minutes);
  const iso = now.toISOString();
  await insertWithSeat(
    db,
    shop,
    unitsOf(shop, input.start, menu.minutes),
    null,
    (seat) => [
      db
        .prepare(
          `INSERT INTO bookings (id, line_user_id, source, customer_name, menu_id, menu_name, price, start_at, end_at, seat, status, hold_expires_at, created_at, updated_at)
           VALUES (?1, NULL, 'staff', ?2, ?3, ?4, ?5, ?6, ?7, ?8, 'confirmed', NULL, ?9, ?9)`,
        )
        .bind(id, input.customerName.slice(0, 40), menu.id, menu.name, menu.price, input.start, end, seat, iso),
    ],
    id,
  );
  return (await getBooking(db, id))!;
}

export async function listUserBookings(db: D1Database, userId: string, now: Date): Promise<Booking[]> {
  const { results } = await db
    .prepare(
      "SELECT * FROM bookings WHERE line_user_id = ?1 AND ((status = 'confirmed' AND end_at > ?2) OR (status = 'held' AND hold_expires_at > ?3)) ORDER BY start_at",
    )
    .bind(userId, toJstLocal(now), now.toISOString())
    .all<Booking>();
  return results;
}

export async function listBookings(db: D1Database, from: string, to: string): Promise<Booking[]> {
  const { results } = await db
    .prepare("SELECT * FROM bookings WHERE start_at >= ?1 AND start_at < ?2 AND status IN ('held','confirmed') ORDER BY start_at, seat")
    .bind(from, to)
    .all<Booking>();
  return results;
}

/** 定期実行：期限切れの仮予約を外す */
export async function expireHolds(db: D1Database, now: Date): Promise<void> {
  await purgeExpired(db, now);
}

export function bookingCode(b: Pick<Booking, 'id'>): string {
  return b.id.slice(0, 6);
}
