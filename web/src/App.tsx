import { useCallback, useEffect, useState } from 'react';
import { navigate, useRoute } from './router';
import { HomePage } from './pages/HomePage';
import { GameDetailPage } from './pages/GameDetailPage';
import { WorkspacePage } from './pages/WorkspacePage';
import { MatchViewPage } from './pages/MatchViewPage';
import { RecoverPage } from './pages/RecoverPage';
import { AdminPage } from './pages/AdminPage';
import { AgentGuidePage } from './pages/AgentGuidePage';
import { clearCredential, getCredential, getWorkspaceId } from './api';
import './styles.css';

function TopBar({ route }: { route: ReturnType<typeof useRoute> }): JSX.Element {
  const [, force] = useState(0);

  // 凭证变化时刷新顶栏（redeem/recover/退出后）
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

  const hasCredential = getCredential() !== null;

  const links: Array<{ path: string; label: string; active: boolean }> = [
    { path: '/', label: '游戏', active: route.view === 'home' },
    { path: '/workspace', label: '我的工作台', active: route.view === 'workspace' },
    { path: '/recover', label: '恢复凭证', active: route.view === 'recover' },
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
      {hasCredential && (
        <span className="credential-state">
          已绑定工作台 <span className="mono">{(getWorkspaceId() ?? '').slice(0, 8)}…</span>{' '}
          <button
            className="link"
            type="button"
            onClick={() => {
              clearCredential();
              refresh();
              navigate('/');
            }}
          >
            退出
          </button>
        </span>
      )}
    </header>
  );
}

export default function App(): JSX.Element {
  const route = useRoute();
  // 应用页一屏化（ADR 0011）：应用内页面 <main> 打 .app-page 类，宽屏时锁视口高、
  // 内容区内滚。观战/回放页也走 --scroll：其内容（对战条+横幅+画面+进度条+HP条）本就超一屏，
  // 整页区内滚可让 canvas 用自然大尺寸，不再被 --canvas 的高度压缩成小图。
  // HomePage 游客态是长滚动落地页，不加该类。
  const mainClass =
    route.view === 'home' || route.view === 'notfound'
      ? undefined
      : 'app-page app-page--scroll';
  return (
    <>
      <TopBar route={route} />
      <main className={mainClass}>
        {route.view === 'home' && <HomePage />}
        {route.view === 'game' && <GameDetailPage gameId={route.gameId} />}
        {route.view === 'workspace' && <WorkspacePage />}
        {route.view === 'match' && <MatchViewPage matchId={route.matchId} />}
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
