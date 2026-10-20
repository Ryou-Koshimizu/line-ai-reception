import type { D1Migration } from 'cloudflare:test';
import type { Env as AppEnv } from '../src/env';

declare global {
  namespace Cloudflare {
    interface GlobalProps {
      mainModule: typeof import('../src/index');
      durableNamespaces: 'ChatSession';
    }
    interface Env extends AppEnv {
      TEST_MIGRATIONS: D1Migration[];
    }
  }
}
