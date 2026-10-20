-- 店の情報（1 店舗 1 行）。中身は src/domain/shop.ts の ShopInfo（JSON）
CREATE TABLE shop (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  info TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

-- 予約。時刻は日本時間の "YYYY-MM-DDTHH:mm"
CREATE TABLE bookings (
  id TEXT PRIMARY KEY,
  line_user_id TEXT,                -- スタッフが手入力した予約は NULL
  source TEXT NOT NULL CHECK (source IN ('line', 'staff')),
  customer_name TEXT NOT NULL,
  menu_id TEXT NOT NULL,
  menu_name TEXT NOT NULL,
  price INTEGER NOT NULL,
  start_at TEXT NOT NULL,
  end_at TEXT NOT NULL,
  seat INTEGER NOT NULL,
  status TEXT NOT NULL CHECK (status IN ('held', 'confirmed', 'cancelled', 'expired')),
  hold_expires_at TEXT,             -- 仮予約の期限（UTC ISO）。確定で NULL
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
CREATE INDEX bookings_user ON bookings (line_user_id, status);
CREATE INDEX bookings_start ON bookings (start_at);

-- 二重予約を防ぐ鍵。席 × 30 分の 1 コマにつき 1 行だけ入れられる（主キーで強制）。
-- 仮予約・確定・変更・取り消しは、bookings と slot_locks をまとめて 1 つのトランザクション（D1 batch）で書く。
CREATE TABLE slot_locks (
  unit TEXT NOT NULL,               -- コマの開始 "YYYY-MM-DDTHH:mm"
  seat INTEGER NOT NULL,
  booking_id TEXT NOT NULL REFERENCES bookings (id),
  expires_at TEXT,                  -- 仮予約のあいだだけ入る（UTC ISO）
  PRIMARY KEY (unit, seat)
);
CREATE INDEX slot_locks_booking ON slot_locks (booking_id);
CREATE INDEX slot_locks_expiry ON slot_locks (expires_at) WHERE expires_at IS NOT NULL;

-- LINE の再送（同じ webhookEventId）を 1 回だけ処理するための記録
CREATE TABLE processed_events (
  event_id TEXT PRIMARY KEY,
  received_at TEXT NOT NULL
);

-- 会話。mode = 'ai'（AI が返事）/ 'human'（スタッフが引き取り中）
CREATE TABLE conversations (
  line_user_id TEXT PRIMARY KEY,
  display_name TEXT NOT NULL,
  mode TEXT NOT NULL DEFAULT 'ai' CHECK (mode IN ('ai', 'human')),
  handoff_reason TEXT,
  last_message TEXT,
  last_at TEXT NOT NULL,
  unread INTEGER NOT NULL DEFAULT 0,
  closed_notice_at TEXT             -- 営業時間外の自動応答を最後に送った時刻（UTC ISO）
);
CREATE INDEX conversations_last ON conversations (last_at);

-- 会話のメッセージ。電話番号・メールなどは保存前に伏せ字にする（src/domain/pii.ts）
CREATE TABLE messages (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  line_user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'staff', 'system')),
  text TEXT NOT NULL,
  created_at TEXT NOT NULL
);
CREATE INDEX messages_user ON messages (line_user_id, id);
