// 実機の確かめ用の受け口（bridge）の試験。node:test で動かす（npm run test:scripts）
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { chmodSync, mkdtempSync, writeFileSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { BRIDGE_ERROR_BODY, startBridge } from './bridge';
import { checkRichMenuImage } from '../../src/line/richmenu';

test('推論が失敗しても、応答には決まった文言だけを返す（スタックやパスを出さない）', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'bridge-test-'));
  const fake = join(dir, 'codex');
  // 失敗時に、スタックトレースのような詳細を出して終わる偽のコマンド
  writeFileSync(
    fake,
    '#!/bin/sh\necho \'{"type":"error","message":"Error: boom\\\\n    at secret (/Users/someone/project/file.ts:1:1)"}\'\necho "Error: boom\n    at secret (/Users/someone/project/file.ts:1:1)" 1>&2\nexit 1\n',
  );
  chmodSync(fake, 0o755);
  const errors: string[] = [];
  const original = console.error;
  console.error = (...a: unknown[]) => void errors.push(a.join(' '));
  const bridge = await startBridge({ port: 3106, model: 'x', effort: 'low', names: {}, codexBin: fake });
  try {
    const res = await fetch('http://127.0.0.1:3106/anthropic/v1/messages', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ system: [{ type: 'text', text: 'x' }], tools: [], messages: [{ role: 'user', content: 'こんにちは' }] }),
    });
    assert.equal(res.status, 500);
    const text = await res.text();
    assert.deepEqual(JSON.parse(text), BRIDGE_ERROR_BODY);
    assert.doesNotMatch(text, /at secret|\/Users\/|file\.ts|boom/);
    // 詳細は手元の記録（標準エラー出力と modelCalls）にだけ残る
    assert.ok(errors.some((e) => e.includes('boom')));
    assert.match(bridge.modelCalls[0]!.error ?? '', /boom/);
  } finally {
    console.error = original;
    await bridge.close();
  }
});

test('リポジトリのリッチメニュー画像は、送る前の確認を通る', () => {
  const png = new Uint8Array(readFileSync(fileURLToPath(new URL('../../richmenu/richmenu.png', import.meta.url))));
  assert.deepEqual(checkRichMenuImage(png), { ok: true });
});
