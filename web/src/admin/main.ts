import '../styles/base.css';
import '../styles/page.css';
import '../styles/admin.css';
import { hydrateIcons } from '../lib/icons';
import { AdminView } from './view';
import { ApiSource, ApiError } from './sources';

hydrateIcons();

const KEY = 'line-ai-reception:token';
const form = document.getElementById('login-form') as HTMLFormElement;
const tokenInput = document.getElementById('token') as HTMLInputElement;
const errorEl = document.getElementById('login-error')!;
const login = document.getElementById('login')!;
const app = document.getElementById('app')!;
const logout = document.getElementById('logout')!;
const role = document.getElementById('role')!;

const read = () => {
  try {
    return sessionStorage.getItem(KEY);
  } catch {
    return null;
  }
};
const write = (v: string | null) => {
  try {
    if (v) sessionStorage.setItem(KEY, v);
    else sessionStorage.removeItem(KEY);
  } catch {
    /* 保存できない環境では、このページを開いている間だけ使う */
  }
};

function today(): string {
  return new Date(Date.now() + 9 * 3600_000).toISOString().slice(0, 10);
}

async function start(token: string): Promise<void> {
  const source = await ApiSource.login(token);
  write(token);
  login.hidden = true;
  app.hidden = false;
  logout.hidden = false;
  role.hidden = false;
  role.textContent = source.canEditShop ? '店長' : 'スタッフ';
  const view = new AdminView(document.getElementById('admin-host')!, source, { today: today(), showTools: false });
  await view.refresh({});
  setInterval(() => void view.refresh({}), 30_000);
}

form.addEventListener('submit', async (e) => {
  e.preventDefault();
  errorEl.textContent = '';
  try {
    await start(tokenInput.value.trim());
  } catch (err) {
    errorEl.textContent = err instanceof ApiError ? err.message : 'サーバーに接続できませんでした';
  }
});
logout.addEventListener('click', () => {
  write(null);
  location.reload();
});

const saved = read();
if (saved) start(saved).catch(() => write(null));
