import { useCallback, useEffect, useState } from 'react';
import { navigate, useRoute } from './router';
import { HomePage } from './pages/HomePage';
import { GameDetailPage } from './pages/GameDetailPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { MatchViewPage } from './pages/MatchViewPage';
import { LivePage } from './pages/LivePage';
import { SeatPage } from './pages/SeatPage';
import { RecoverPage } from './pages/RecoverPage';
import { LoginPage } from './pages/LoginPage';
import { RegisterPage } from './pages/RegisterPage';
import { AdminPage } from './pages/AdminPage';
import { AgentGuidePage } from './pages/AgentGuidePage';
import { getToken, logout } from './api';
import './styles.css';
import { ThemePicker } from './components/ThemePicker';

function TopBar({ route }: { route: ReturnType<typeof useRoute> }): JSX.Element {
  const [, force] = useState(0);

  // 令牌变化时刷新顶栏（登录/登出/失效后）
  useEffect(() => {
    const onStorage = () => force((n) => n + 1);
    window.addEventListener('storage', onStorage);
    window.addEventListener('aivsai:credential', onStorage);
    return () => {
      window.removeEventListener('storage', onStorage);
      window.removeEventListener('aivsai:credential', onStorage);
    };
  }, []);
  const refresh = useCallback(() => force((n) => n + 1), []);

  const hasCredential = getToken() !== null;

  const links: Array<{ path: string; label: string; active: boolean }> = [
    { path: '/', label: '游戏', active: route.view === 'home' },
    { path: '/live', label: '表演赛', active: route.view === 'live' },
    { path: '/workspace', label: '我的坦克', active: route.view === 'workspace' },
    { path: '/admin', label: '管理', active: route.view === 'admin' },
  ];

  return (
    <header className="topbar">
      <a className="brand" href="#/">
        AI 对战平台
      </a>
      <nav>
        {links.map((l) => (
          <a
            key={l.path}
            className={l.active ? 'active' : ''}
            href={`#${l.path}`}
            onClick={refresh}
          >
            {l.label}
          </a>
        ))}
      </nav>
      <span className="spacer" />
      <ThemePicker />
      {hasCredential ? (
        <span className="credential-state">
          已登录{' '}
          <button
            className="link"
            type="button"
            onClick={() => {
              void logout();
              refresh();
              navigate('/');
            }}
          >
            退出
          </button>
        </span>
      ) : (
        <a className="btn primary" href="#/login">
          登录
        </a>
      )}
    </header>
  );
}

export default function App(): JSX.Element {
  const route = useRoute();
  // 应用页一屏化（ADR 0011）：应用内页面 <main> 打 .app-page 类，宽屏时锁视口高、
  // 内容区内滚。观战/回放页也走 --scroll：其内容（对战条+横幅+画面+进度条+HP条）本就超一屏，
  // 整页区内滚可让 canvas 用自然大尺寸，不再被 --canvas 的高度压缩成小图。
  // HomePage：游客态是长滚动落地页不加类；登录态走 dashboard 一屏化（ADR 0013/0014），
  // 对局表右列内滚、页面 Y 轴不动。Agent 指南是长文阅读，加 --narrow 限宽居中。
  const hasCredential = getToken() !== null;
  const mainClass =
    route.view === 'notfound'
      ? undefined
      : route.view === 'home'
        ? hasCredential
          ? 'app-page home-dash-page'
          : undefined
        : route.view === 'agent-guide'
          ? 'app-page app-page--scroll app-page--narrow'
          : 'app-page app-page--scroll';
  return (
    <>
      <TopBar route={route} />
      <main className={mainClass}>
        {route.view === 'home' && <HomePage />}
        {route.view === 'game' && <GameDetailPage gameId={route.gameId} />}
        {route.view === 'workspace' && <WorkspacePage />}
        {route.view === 'match' && <MatchViewPage matchId={route.matchId} />}
        {route.view === 'live' && <LivePage />}
        {route.view === 'seat' && <SeatPage seatToken={route.seatToken} />}
        {route.view === 'login' && <LoginPage />}
        {route.view === 'register' && <RegisterPage />}
        {route.view === 'recover' && <RecoverPage />}
        {route.view === 'admin' && <AdminPage />}
        {route.view === 'agent-guide' && <AgentGuidePage />}
        {route.view === 'notfound' && (
          <div className="panel">
            <h2>页面不存在</h2>
            <p className="muted">
              找不到 <span className="mono">{route.path}</span>。回到<a href="#/">首页</a>。
            </p>
          </div>
        )}
      </main>
    </>
  );
}
