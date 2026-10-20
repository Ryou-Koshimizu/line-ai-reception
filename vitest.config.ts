import { cloudflareTest, readD1Migrations } from '@cloudflare/vitest-plugin';
import { defineConfig } from 'vitest/config';

// すべての試験を Workers の実行環境（workerd）＋ D1 ＋ Durable Objects の中で動かす
export default defineConfig(async () => {
  const migrations = await readD1Migrations('./migrations');
  return {
    plugins: [
      cloudflareTest({
        wrangler: { configPath: './wrangler.jsonc' },
        miniflare: {
          bindings: {
            TEST_MIGRATIONS: migrations,
            ENVIRONMENT: 'test',
            LINE_CHANNEL_SECRET: 'test-channel-secret-0123456789',
            LINE_CHANNEL_ACCESS_TOKEN: 'test-access-token',
            LINE_API_BASE: 'https://line.test',
            ADMIN_TOKEN: 'owner-token-0123456789abcdef',
            STAFF_TOKEN: 'staff-token-0123456789abcdef',
          },
        },
      }),
    ],
    test: {
      include: ['test/**/*.test.ts'],
      setupFiles: ['./test/setup.ts'],
    },
  };
});
