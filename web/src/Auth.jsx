import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, CalendarDays, Eye, EyeOff } from 'lucide-react';
import { Notice } from './interactions';
import { authRequest, sessionExpired } from './authClient';

export function useWorkbenchSession() {
  const [session, setSession] = useState({ loading: true, user: null });
  const channel = useRef(null);
  const revision = useRef(0);

  const refresh = useCallback(async () => {
    const request = ++revision.current;
    try {
      const result = await authRequest('/api/workbench-session');
      if (request === revision.current) setSession({ ...result, loading: false });
    } catch (error) {
      if (request === revision.current) setSession(current => ({ ...current, loading: false, error: error.message }));
    }
  }, []);

  useEffect(() => {
    void refresh();
    if (typeof BroadcastChannel === 'function') {
      channel.current = new BroadcastChannel('huixu.workbench-session');
      channel.current.onmessage = refresh;
    }
    window.addEventListener('focus', refresh);
    window.addEventListener(sessionExpired, refresh);
    return () => {
      revision.current += 1;
      window.removeEventListener('focus', refresh);
      window.removeEventListener(sessionExpired, refresh);
      channel.current?.close();
      channel.current = null;
    };
  }, [refresh]);

  async function signIn(values, setup) {
    const { name, email, password } = values;
    try {
      if (setup) await authRequest('/api/workbench-session', { name, email, password });
      const result = await authRequest('/api/auth/sign-in/email', { email, password });
      if (!result.user) throw new Error('登录状态暂不可用，请重新登录。');
      revision.current += 1;
      setSession({ user: result.user, setupRequired: false, loading: false });
      channel.current?.postMessage('changed');
    } catch (error) {
      if (setup) await refresh();
      throw error;
    }
  }

  async function signOut() {
    await authRequest('/api/auth/sign-out', {});
    revision.current += 1;
    setSession({ user: null, setupRequired: false, loading: false });
    channel.current?.postMessage('changed');
  }

  return { session, refresh, signIn, signOut };
}

export function AuthPage({ session, refresh, signIn }) {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const setup = session.setupRequired;

  useEffect(() => {
    document.title = (setup ? '创建账号' : '登录工作台') + ' · 会序';
  }, [setup]);

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setProblem('');
    try {
      await signIn({ name: form.get('name')?.trim(), email: form.get('email').trim().toLowerCase(), password: form.get('password') }, setup);
    } catch (error) {
      setProblem(error.message);
    } finally {
      setBusy(false);
    }
  }

  return <main className="auth-page">
    <div className="auth-layout">
      <div className="auth-art"><span className="auth-brand"><CalendarDays size={27} aria-hidden="true" />会序</span></div>
      <section className="auth-content" aria-labelledby="auth-title">
        <header className="auth-heading">
          <h1 id="auth-title">{setup ? '创建工作台账号' : '登录工作台'}</h1>
          {!session.loading && !session.error && <p>{setup ? '首次使用，请设置本机工作台的负责人账号。' : '使用你的会序账号继续筹备活动。'}</p>}
        </header>
        {session.loading && <p className="muted" role="status">正在检查登录状态…</p>}
        {session.error && <>
          <Notice tone="error" announce>{session.error}</Notice>
          <button type="button" className="button" onClick={refresh}>重新检查</button>
        </>}
        {!session.loading && !session.error && <form className="form-stack auth-form" onSubmit={submit} aria-busy={busy}>
          {setup && <label>姓名<input name="name" autoComplete="name" maxLength={60} required /></label>}
          <label>邮箱<input name="email" type="email" autoComplete="username" maxLength={254} required /></label>
          <div className="auth-password">
            <label htmlFor="auth-password">密码</label>
            <div className="auth-password-input">
              <input id="auth-password" name="password" type={visible ? 'text' : 'password'}
                autoComplete={setup ? 'new-password' : 'current-password'} minLength={setup ? 12 : undefined}
                maxLength={128} aria-describedby={setup ? 'auth-password-help' : undefined} required />
              <button type="button" className="icon-button" aria-label={visible ? '隐藏密码' : '显示密码'} onClick={() => setVisible(value => !value)}>
                {visible ? <EyeOff size={19} /> : <Eye size={19} />}
              </button>
            </div>
            {setup && <p id="auth-password-help" className="muted">使用 12–128 位密码。</p>}
          </div>
          {problem && <Notice tone="error" announce>{problem}</Notice>}
          <button className="button primary auth-submit" disabled={busy}>
            {busy ? '正在处理…' : setup ? '创建账号并进入' : '登录'}{!busy && <ArrowRight size={18} aria-hidden="true" />}
          </button>
        </form>}
      </section>
    </div>
  </main>;
}
