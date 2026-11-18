import { useCallback, useEffect, useRef, useState } from 'react';
import { ArrowRight, Eye, EyeOff, LogOut, UserRound, UsersRound } from 'lucide-react';
import { Dialog, Notice } from './interactions';
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

  async function signIn(values, mode) {
    const { name, email, password, signupCode } = values;
    try {
      if (mode === 'setup') await authRequest('/api/workbench-session', { name, email, password });
      if (mode === 'register') await authRequest('/api/workbench-session/register', { name, email, password, signupCode });
      const result = await authRequest('/api/auth/sign-in/email', { email, password });
      if (!result.user) throw new Error('登录状态暂不可用，请重新登录。');
      revision.current += 1;
      setSession(current => ({ ...current, user: result.user, setupRequired: false, loading: false, error: undefined }));
      channel.current?.postMessage('changed');
      if (mode === 'setup') void refresh();
    } catch (error) {
      if (mode !== 'login') await refresh();
      throw error;
    }
  }

  async function signOut() {
    await authRequest('/api/auth/sign-out', {}, session.user?.id);
    revision.current += 1;
    setSession(current => ({ ...current, user: null, setupRequired: false, loading: false, error: undefined }));
    channel.current?.postMessage('changed');
  }

  return { session, refresh, signIn, signOut };
}

export function AccountAvatar({ user }) {
  return <span className="avatar" aria-hidden="true">{user ? Array.from(user.name)[0] : <UserRound size={19} />}</span>;
}

function CredentialsForm({ session, refresh, signIn, mode, setMode }) {
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [problem, setProblem] = useState('');
  const setup = mode === 'setup';
  const registering = mode === 'register';
  const creating = setup || registering;

  async function submit(event) {
    event.preventDefault();
    if (busy) return;
    const form = new FormData(event.currentTarget);
    setBusy(true);
    setProblem('');
    try {
      await signIn({ name: form.get('name')?.trim(), email: form.get('email').trim().toLowerCase(), password: form.get('password'),
        signupCode: form.get('signupCode') ?? undefined }, mode);
    } catch (error) {
      setProblem(error.message);
    } finally {
      setBusy(false);
    }
  }

  if (session.loading) return <p className="muted" role="status">正在检查登录状态…</p>;
  if (session.error) return <>
    <Notice tone="error" announce>{session.error}</Notice>
    <button type="button" className="button" onClick={refresh}>重新检查</button>
  </>;
  if (session.ownerSetupPending) return <>
    <Notice announce>工作台负责人账号尚未配置。请联系部署管理员，你也可以关闭窗口继续以访客身份浏览。</Notice>
    <button type="button" className="button" onClick={refresh}>重新检查</button>
  </>;

  return <form className="form-stack auth-form" onSubmit={submit} aria-busy={busy}>
    {creating && <>
      <p className="muted">{setup ? '首次使用，请设置工作台的负责人账号。' : '使用邀请码创建账号，系统会为你分配独立的活动工作区。'}</p>
      <label>姓名<input name="name" autoComplete="name" maxLength={60} required /></label>
      {registering && <label>注册邀请码<input type="password" name="signupCode" autoComplete="off" required /></label>}
    </>}
    <label>邮箱<input name="email" type="email" autoComplete="username" maxLength={254} required /></label>
    <div className="auth-password">
      <label htmlFor="auth-password">密码</label>
      <div className="auth-password-input">
        <input id="auth-password" name="password" type={visible ? 'text' : 'password'}
          autoComplete={creating ? 'new-password' : 'current-password'} minLength={creating ? 12 : undefined}
          maxLength={128} aria-describedby={creating ? 'auth-password-help' : undefined} required />
        <button type="button" className="icon-button" aria-label={visible ? '隐藏密码' : '显示密码'} onClick={() => setVisible(value => !value)}>
          {visible ? <EyeOff size={19} /> : <Eye size={19} />}
        </button>
      </div>
      {creating && <p id="auth-password-help" className="muted">使用 12–128 位密码。</p>}
    </div>
    {problem && <Notice tone="error" announce>{problem}</Notice>}
    <button className="button primary auth-submit" disabled={busy}>
      {busy ? '正在处理…' : creating ? '创建账号并进入' : '登录'}{!busy && <ArrowRight size={18} aria-hidden="true" />}
    </button>
    {!setup && session.signupEnabled && <button type="button" className="button" disabled={busy}
      onClick={() => setMode(registering ? 'login' : 'register')}>{registering ? '返回登录' : '使用邀请码注册'}</button>}
  </form>;
}

export function AccountDialog({ session, refresh, signIn, signOut, workspace, openTeam, close }) {
  const [signingOut, setSigningOut] = useState(false);
  const [problem, setProblem] = useState('');
  const [pendingSync, setPendingSync] = useState(null);
  const [preferredMode, setMode] = useState('login');
  const { user, setupRequired } = session;
  const mode = setupRequired ? 'setup' : session.signupEnabled ? preferredMode : 'login';
  let title = mode === 'login' ? '登录工作台' : '创建工作台账号';
  if (user) title = '账户与会话';

  async function exitAccount(skipSync = false) {
    setSigningOut(true);
    setProblem('');
    if (!skipSync) {
      try {
        await workspace.flush();
        setPendingSync(null);
      } catch (error) {
        setPendingSync({ message: error.message, recoverable: workspace.keepPending() });
        setSigningOut(false);
        return;
      }
    }
    try {
      await signOut();
    } catch (error) {
      setProblem(error.message);
      setSigningOut(false);
    }
  }

  return <Dialog title={title} className="account-dialog" close={close}>
    {user ? <>
      <div className="account-identity">
        <AccountAvatar user={user} />
        <div><strong>{user.name}</strong><p className="muted">{user.email}</p></div>
      </div>
      {problem && <Notice tone="error" announce>{problem}</Notice>}
      {pendingSync && <>
        <Notice tone="warning" announce>{pendingSync.message} {pendingSync.recoverable
          ? '继续退出后，可以在此标签页重新登录原账号并恢复修改。关闭标签页前可导出副本。'
          : '浏览器无法保留未同步的修改。退出前可导出副本。'}</Notice>
        <div className="actions compact">
          <button type="button" className="button small" disabled={signingOut} onClick={workspace.exportPending}>导出待同步修改</button>
          <button type="button" className="button small" disabled={signingOut} onClick={() => exitAccount(true)}>
            {pendingSync.recoverable ? '保留修改并退出' : '退出并放弃未同步修改'}
          </button>
        </div>
      </>}
      <div className="actions compact">
        <button type="button" className="button" onClick={openTeam}><UsersRound size={18} aria-hidden="true" />活动团队</button>
        <button type="button" className="button" disabled={signingOut} onClick={() => exitAccount()}>
          <LogOut size={18} aria-hidden="true" />{signingOut ? '正在退出…' : '退出登录'}
        </button>
      </div>
    </> : <CredentialsForm key={mode} session={session} refresh={refresh} signIn={signIn} mode={mode} setMode={setMode} />}
  </Dialog>;
}
