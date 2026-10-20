// E2E 用のサーバー：wrangler dev（8787・本番と同じ Worker と静的配信）＋ LINE API の受け口（3106）。
// AI の鍵は入れない（E2E は画面と管理 API を確かめる。AI の会話は check:live で実AIを使って確かめる）。
import { spawn, execFileSync } from 'node:child_process';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { startBridge } from './live/bridge';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const STATE = join(ROOT, '.wrangler', 'e2e');
export const E2E = {
  secret: 'e2e-channel-secret-0123456789abcdef',
  owner: 'e2e-owner-token-0123456789abcdef',
  staff: 'e2e-staff-token-0123456789abcdef',
};

rmSync(STATE, { recursive: true, force: true });
mkdirSync(STATE, { recursive: true });
const wranglerBin = join(ROOT, 'node_modules/wrangler/bin/wrangler.js');
execFileSync(process.execPath, [wranglerBin, 'd1', 'migrations', 'apply', 'DB', '--local', '--persist-to', STATE], {
  cwd: ROOT,
  stdio: 'ignore',
  env: { ...process.env, CI: '1' },
});
const envFile = join(STATE, 'e2e.env');
writeFileSync(
  envFile,
  [
    'ENVIRONMENT=development',
    `LINE_CHANNEL_SECRET=${E2E.secret}`,
    'LINE_CHANNEL_ACCESS_TOKEN=e2e-token',
    'LINE_API_BASE=http://127.0.0.1:3106/line',
    `ADMIN_TOKEN=${E2E.owner}`,
    `STAFF_TOKEN=${E2E.staff}`,
  ].join('\n'),
);

const bridge = await startBridge({
  port: 3106,
  model: 'unused',
  effort: 'low',
  names: { 'U-e2e-chromium': 'テスト花子', 'U-e2e-webkit': 'テスト次郎' },
});
// LINE への送信内容は http://127.0.0.1:3106/__log で読める（試験の確認用）

const wr = spawn(
  process.execPath,
  [
    wranglerBin,
    'dev',
    '--port',
    '8787',
    '--ip',
    '127.0.0.1',
    '--inspector-port',
    '0',
    '--persist-to',
    STATE,
    '--env-file',
    envFile,
    '--show-interactive-dev-session=false',
  ],
  { cwd: ROOT, stdio: 'inherit', env: { ...process.env, CI: '1' } }, // 同じプロセスグループ：Playwright が止めると一緒に止まる
);
const stop = () => {
  try {
    wr.kill('SIGTERM');
  } catch {
    /* already stopped */
  }
  void bridge.close();
  process.exit(0);
};
process.on('SIGTERM', stop);
process.on('SIGINT', stop);
wr.on('exit', (code) => {
  void bridge.close();
  process.exit(code ?? 0);
});
