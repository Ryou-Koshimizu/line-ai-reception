import { env } from 'cloudflare:test';
import { describe, expect, it } from 'vitest';
import {
  BookingError,
  addStaffBooking,
  cancelBooking,
  confirmBooking,
  expireHolds,
  findAvailableSlots,
  getBooking,
  holdBooking,
  listUserBookings,
  rescheduleBooking,
} from '../src/domain/booking';
import { DEMO_SHOP } from '../src/domain/shop';
import { NOW, at, overlappingPairs, seedShop } from './helpers';

const shop = DEMO_SHOP;
const db = () => env.DB;
const hold = (user: string, start: string, menuId = 'cut', now = NOW) =>
  holdBooking(db(), shop, { userId: user, customerName: user, menuId, start }, now);
const code = async (p: Promise<unknown>) => {
  try {
    await p;
    return 'OK';
  } catch (e) {
    if (e instanceof BookingError) return e.code;
    throw e;
  }
};

describe('空き枠', () => {
  it('定休日（火曜）と臨時休業日は空き枠を出さない', async () => {
    await seedShop();
    expect(await findAvailableSlots(db(), shop, { menuId: 'cut', dateFrom: '2026-11-10' }, NOW)).toEqual([]);
    expect(await findAvailableSlots(db(), shop, { menuId: 'cut', dateFrom: '2026-11-18' }, NOW)).toEqual([]);
  });

  it('直前（1時間以内）と過ぎた時刻は出さず、閉店までに終わる枠だけを出す', async () => {
    const slots = await findAvailableSlots(db(), shop, { menuId: 'cut-color', dateFrom: '2026-11-04', limit: 60 }, NOW);
    expect(slots[0]).toBe('2026-11-04T11:30');
    expect(slots.at(-1)).toBe('2026-11-04T17:00'); // 120 分のメニューは 19:00 閉店なら 17:00 が最後
  });

  it('午前・午後・夕方で絞り込める', async () => {
    const pm = await findAvailableSlots(db(), shop, { menuId: 'cut', dateFrom: '2026-11-06', part: 'afternoon', limit: 60 }, NOW);
    expect(pm.every((s) => s.slice(11) >= '12:00' && s.slice(11) < '17:00')).toBe(true);
    const ev = await findAvailableSlots(db(), shop, { menuId: 'cut', dateFrom: '2026-11-06', part: 'evening', limit: 60 }, NOW);
    expect(ev).toEqual(['2026-11-06T17:00', '2026-11-06T17:30', '2026-11-06T18:00', '2026-11-06T18:30', '2026-11-06T19:00']);
  });

  it('2 席とも埋まった時刻は出さない', async () => {
    await hold('u1', '2026-11-06T14:00');
    await hold('u2', '2026-11-06T14:00');
    const slots = await findAvailableSlots(db(), shop, { menuId: 'cut', dateFrom: '2026-11-06', limit: 60 }, NOW);
    expect(slots).not.toContain('2026-11-06T14:00');
    expect(slots).not.toContain('2026-11-06T13:30'); // 60 分なので 14:00 にかかる
    expect(slots).toContain('2026-11-06T15:00');
  });
});

describe('仮予約 → 確定', () => {
  it('仮予約して確定できる。確定を 2 回押しても 1 件のまま', async () => {
    const b = await hold('u1', '2026-11-06T14:00');
    expect(b.status).toBe('held');
    const c1 = await confirmBooking(db(), 'u1', b.id, NOW);
    const c2 = await confirmBooking(db(), 'u1', b.id, NOW);
    expect(c1.status).toBe('confirmed');
    expect(c2.status).toBe('confirmed');
    expect(await listUserBookings(db(), 'u1', NOW)).toHaveLength(1);
  });

  it('ほかの人の仮予約は確定できない（権限）', async () => {
    const b = await hold('u1', '2026-11-06T14:00');
    expect(await code(confirmBooking(db(), 'intruder', b.id, NOW))).toBe('NOT_FOUND');
    expect((await getBooking(db(), b.id))!.status).toBe('held');
  });

  it('期限（10分）を過ぎた仮予約は確定できず、枠はほかの人に開く', async () => {
    const b = await hold('u1', '2026-11-06T14:00');
    await hold('u2', '2026-11-06T14:00');
    const later = new Date(NOW.getTime() + 11 * 60_000);
    expect(await code(confirmBooking(db(), 'u1', b.id, later))).toBe('HOLD_EXPIRED');
    await expireHolds(db(), later);
    const b3 = await hold('u3', '2026-11-06T14:00', 'cut', later);
    expect(b3.status).toBe('held');
    expect(await overlappingPairs(later)).toBe(0);
  });

  it('同じ人が別の枠を仮予約すると、前の仮予約は外れる', async () => {
    const a = await hold('u1', '2026-11-06T14:00');
    await hold('u1', '2026-11-06T16:00');
    expect((await getBooking(db(), a.id))!.status).toBe('cancelled');
    const { results } = await db().prepare('SELECT * FROM slot_locks WHERE booking_id = ?1').bind(a.id).all();
    expect(results).toHaveLength(0);
  });

  it('営業時間外・区切りに合わない時刻・先すぎる日付は仮予約できない', async () => {
    expect(await code(hold('u1', '2026-11-10T14:00'))).toBe('CLOSED');
    expect(await code(hold('u1', '2026-11-04T18:30'))).toBe('OUTSIDE_HOURS');
    expect(await code(hold('u1', '2026-11-06T14:10'))).toBe('INVALID_TIME');
    expect(await code(hold('u1', '2026-11-04T10:30'))).toBe('TOO_SOON');
    expect(await code(hold('u1', '2026-12-31T14:00'))).toBe('TOO_FAR');
    expect(await code(hold('u1', '2026-11-06T14:00', 'perm'))).toBe('UNKNOWN_MENU');
  });

  it('これからの確定済み予約は 1 人 3 件まで', async () => {
    for (const t of ['2026-11-06T10:00', '2026-11-07T10:00', '2026-11-08T10:00']) {
      const b = await hold('u1', t);
      await confirmBooking(db(), 'u1', b.id, NOW);
    }
    expect(await code(hold('u1', '2026-11-09T10:00'))).toBe('LIMIT_REACHED');
  });
});

describe('二重予約を防ぐ', () => {
  it('同じ枠に 30 人が同時に仮予約しても、通るのは席の数（2）だけ', async () => {
    const results = await Promise.all(Array.from({ length: 30 }, (_, i) => code(hold(`racer-${i}`, '2026-11-06T14:00'))));
    expect(results.filter((r) => r === 'OK')).toHaveLength(2);
    expect(results.filter((r) => r === 'TAKEN')).toHaveLength(28);
    expect(await overlappingPairs()).toBe(0);
  });

  it('長いメニューと短いメニューが部分的に重なっても、同じ席には入らない', async () => {
    await hold('a', '2026-11-06T13:00', 'cut-color'); // 13:00-15:00
    await hold('b', '2026-11-06T13:00', 'cut-color');
    expect(await code(hold('c', '2026-11-06T14:30', 'headspa'))).toBe('TAKEN');
    expect(await code(hold('d', '2026-11-06T15:00', 'headspa'))).toBe('OK');
    expect(await overlappingPairs()).toBe(0);
  });

  it('電話で受けた予約（管理画面）と LINE の予約も同じ鍵で守る', async () => {
    await addStaffBooking(db(), shop, { customerName: '電話のお客様', menuId: 'cut', start: '2026-11-06T14:00' }, NOW);
    await addStaffBooking(db(), shop, { customerName: '来店のお客様', menuId: 'cut', start: '2026-11-06T14:00' }, NOW);
    expect(await code(hold('u1', '2026-11-06T14:30'))).toBe('TAKEN');
    expect(await code(addStaffBooking(db(), shop, { customerName: 'x', menuId: 'cut', start: '2026-11-06T14:00' }, NOW))).toBe('TAKEN');
  });

  it('無作為な 300 回の操作（仮予約・確定・変更・取り消し・同時実行）のあとも重なりは 0', async () => {
    let seed = 42;
    const rand = (n: number) => {
      seed = (seed * 1103515245 + 12345) % 2 ** 31;
      return seed % n;
    };
    const times = ['10:00', '10:30', '11:00', '13:00', '13:30', '14:00', '17:00'].map((t) => `2026-11-06T${t}`);
    const menus = ['cut', 'cut-color', 'headspa', 'bangs'];
    for (let round = 0; round < 60; round++) {
      await Promise.all(
        Array.from({ length: 5 }, async (_, k) => {
          const user = `p${rand(6)}`;
          const op = rand(4);
          const mine = await listUserBookings(db(), user, NOW);
          if (op === 0 || mine.length === 0) await code(hold(user, times[rand(times.length)]!, menus[rand(menus.length)]));
          else if (op === 1) await code(confirmBooking(db(), user, mine[rand(mine.length)]!.id, NOW));
          else if (op === 2) await code(rescheduleBooking(db(), shop, user, mine[rand(mine.length)]!.id, times[rand(times.length)]!, NOW));
          else await code(cancelBooking(db(), shop, { userId: user }, mine[rand(mine.length)]!.id, NOW));
          void k;
        }),
      );
    }
    expect(await overlappingPairs()).toBe(0);
    // 鍵と予約の行が食い違っていない
    const orphan = await db()
      .prepare(
        "SELECT COUNT(*) AS n FROM slot_locks l LEFT JOIN bookings b ON b.id = l.booking_id WHERE b.id IS NULL OR b.status NOT IN ('held','confirmed')",
      )
      .first<{ n: number }>();
    expect(orphan!.n).toBe(0);
  }, 60_000); // 300 回の D1 操作。CI の Linux は手元より遅いので、件数は減らさず時間の上限だけ広げる
});

describe('変更・取り消し', () => {
  async function confirmed(user: string, start: string, menu = 'cut') {
    const b = await hold(user, start, menu);
    return confirmBooking(db(), user, b.id, NOW);
  }

  it('空いている枠へ変更でき、元の枠は開く', async () => {
    const b = await confirmed('u1', '2026-11-06T14:00');
    const moved = await rescheduleBooking(db(), shop, 'u1', b.id, '2026-11-07T11:00', NOW);
    expect(moved.start_at).toBe('2026-11-07T11:00');
    const slots = await findAvailableSlots(db(), shop, { menuId: 'cut', dateFrom: '2026-11-06', limit: 60 }, NOW);
    expect(slots).toContain('2026-11-06T14:00');
  });

  it('自分の予約と重なる時刻（30分ずらす）にも変更できる', async () => {
    const b = await confirmed('u1', '2026-11-06T14:00');
    await confirmed('u2', '2026-11-06T14:00');
    const moved = await rescheduleBooking(db(), shop, 'u1', b.id, '2026-11-06T14:30', NOW);
    expect(moved.start_at).toBe('2026-11-06T14:30');
    expect(await overlappingPairs()).toBe(0);
  });

  it('変更先が埋まっていれば、元の予約はそのまま残る', async () => {
    const b = await confirmed('u1', '2026-11-06T14:00');
    await confirmed('u2', '2026-11-07T11:00');
    await confirmed('u3', '2026-11-07T11:00');
    expect(await code(rescheduleBooking(db(), shop, 'u1', b.id, '2026-11-07T11:00', NOW))).toBe('TAKEN');
    const still = await getBooking(db(), b.id);
    expect(still!.start_at).toBe('2026-11-06T14:00');
    const { results } = await db().prepare('SELECT unit FROM slot_locks WHERE booking_id = ?1 ORDER BY unit').bind(b.id).all();
    expect(results.map((r) => r.unit)).toEqual(['2026-11-06T14:00', '2026-11-06T14:30']);
  });

  it('ほかの人の予約は変更・取り消しできない（権限）', async () => {
    const b = await confirmed('u1', '2026-11-06T14:00');
    expect(await code(rescheduleBooking(db(), shop, 'intruder', b.id, '2026-11-07T11:00', NOW))).toBe('NOT_FOUND');
    expect(await code(cancelBooking(db(), shop, { userId: 'intruder' }, b.id, NOW))).toBe('NOT_FOUND');
    expect((await getBooking(db(), b.id))!.status).toBe('confirmed');
  });

  it('予約の 3 時間前を過ぎると LINE からは取り消せないが、スタッフは取り消せる', async () => {
    const b = await confirmed('u1', '2026-11-04T13:00');
    const late = at('2026-11-04T10:30');
    expect(await code(cancelBooking(db(), shop, { userId: 'u1' }, b.id, late))).toBe('DEADLINE_PASSED');
    expect(await code(rescheduleBooking(db(), shop, 'u1', b.id, '2026-11-05T13:00', late))).toBe('DEADLINE_PASSED');
    expect((await cancelBooking(db(), shop, 'staff', b.id, late)).status).toBe('cancelled');
  });

  it('取り消すと枠が開き、取り消しを 2 回しても壊れない', async () => {
    const b = await confirmed('u1', '2026-11-06T14:00');
    await cancelBooking(db(), shop, { userId: 'u1' }, b.id, NOW);
    expect((await cancelBooking(db(), shop, { userId: 'u1' }, b.id, NOW)).status).toBe('cancelled');
    const { results } = await db().prepare('SELECT * FROM slot_locks WHERE booking_id = ?1').bind(b.id).all();
    expect(results).toHaveLength(0);
  });
});
