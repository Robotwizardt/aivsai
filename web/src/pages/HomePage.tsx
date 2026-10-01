import { FormEvent, useState } from 'react';
import * as api from '../api';
import { href } from '../router';
import { CredentialBundle } from '../types';
import {
  CopyButton,
  EmptyState,
  ErrorBox,
  MatchKindTag,
  MatchPhaseTag,
  OutcomeTag,
  RelativeTime,
  Skeleton,
  useAsync,
} from '../components';

const PACING_LABEL: Record<string, string> = {
  instant: '即时制',
  'turn-based': '回合制',
};

const GAME_ICONS: Record<string, string> = {
  tank: '🛡️',
  gomoku: '⬛',
};

function gameIcon(gameId: string): string {
  return GAME_ICONS[gameId] ?? '🎮';
}

/** 兑换成功后的一次性凭据展示（重要：只显示一次）。 */
function CredentialNotice({ bundle }: { bundle: CredentialBundle }): JSX.Element {
  return (
    <div className="message ok">
      <p style={{ margin: '0 0 8px' }}>
        <strong>工作台已创建。</strong>请立即保存以下凭据（只显示这一次）：
      </p>
      <p className="mono" style={{ margin: '0 0 4px' }}>
        工作台凭证：{bundle.credential}
      </p>
      <p className="mono" style={{ margin: '0 0 8px' }}>
        恢复码：{bundle.recoveryCode}
      </p>
      <p className="small muted" style={{ margin: 0 }}>
        凭证已自动存入本浏览器；恢复码请抄写到别处保管，凭证丢失时可用它找回（见顶部「恢复凭证」）。
      </p>
    </div>
  );
}

export function HomePage(): JSX.Element {
  const games = useAsync(() => api.listGames());
  const [inviteCode, setInviteCode] = useState('');
  const [nickname, setNickname] = useState('');
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<unknown>(null);
  const [bundle, setBundle] = useState<CredentialBundle | null>(null);

  const onRedeem = async (e: FormEvent) => {
    e.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const b = await api.redeemInvite(inviteCode.trim(), nickname.trim() || undefined);
      api.saveCredential(b);
      setBundle(b);
      setInviteCode('');
      setNickname('');
    } catch (err) {
      setError(err);
    } finally {
      setSubmitting(false);
    }
  };

  const hasCredential = api.getCredential() !== null;
  const isGuest = !hasCredential && !bundle;

  // 凭证失效被清掉时的说明（读取后清空，只提示一次）
  const staleNotice = api.takeUnauthorizedNotice();

  return (
    <>
      {staleNotice != null && <div className="message error">{staleNotice}</div>}
      {bundle && <CredentialNotice bundle={bundle} />}

      {isGuest ? (
        <>
          {/* 游客视角：hero + 邀请码兑换 */}
          <div className="hero">
            <div className="hero-copy">
              <h1>AI 对战平台</h1>
              <p>
                编写策略代码，创建你的参赛对象，与其他 Agent 在同一竞技场中对战。
                观看直播对局、冲击排行榜——一切由一个私密工作台统一管理。
              </p>
              <div className="hero-actions">
                <button
                  type="button"
                  className="primary"
                  onClick={() =>
                    document.getElementById('redeem')?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }
                >
                  使用邀请码开始
                </button>
                <button
                  type="button"
                  className="ghost"
                  onClick={() =>
                    document
                      .getElementById('matches-anchor')
                      ?.scrollIntoView({ behavior: 'smooth', block: 'start' })
                  }
                >
                  观战最近对局
                </button>
              </div>
            </div>
            <div className="panel hero-panel" id="redeem">
              <h2>输入邀请码创建工作台</h2>
              <p className="small muted">
                邀请码由平台所有者发放，一次性兑换一个私密工作台；工作台统一管理你在各游戏中的参赛对象、策略与对局。
              </p>
              <form className="stack" onSubmit={onRedeem}>
                <label className="field">
                  邀请码
                  <input
                    type="text"
                    value={inviteCode}
                    onChange={(e) => setInviteCode(e.target.value)}
                    placeholder="例如 INVITE-XXXX"
                    required
                  />
                </label>
                <label className="field">
                  昵称（可选）
                  <input
                    type="text"
                    value={nickname}
                    onChange={(e) => setNickname(e.target.value)}
                    placeholder="展示用昵称"
                  />
                </label>
                <div>
                  <button
                    className="primary"
                    type="submit"
                    disabled={submitting || inviteCode.trim() === ''}
                  >
                    {submitting ? '兑换中…' : '兑换邀请码'}
                  </button>
                </div>
              </form>
              {error != null && <ErrorBox error={error} />}
            </div>
          </div>

          <div className="panel">
            <h2>公开观战 · 游戏</h2>
            {games.loading && <Skeleton card rows={4} />}
            {games.error != null && <ErrorBox error={games.error} />}
            {games.data && <GameGrid games={games.data} />}
          </div>

          <div className="panel" id="matches-anchor">
            <h2>公开观战 · 最近对局</h2>
            <AllMatches />
          </div>
        </>
      ) : (
        <>
          {/* 已绑定工作台视角 */}
          <div className="panel workspace-banner">
            <div>
              <h2 style={{ margin: '0 0 4px' }}>我的工作台</h2>
              <div className="small muted">
                工作台 ID：
                <span className="mono">{api.getWorkspaceId()?.slice(0, 8) ?? '—'}</span>
                {api.getWorkspaceId() && (
                  <>
                    {' '}
                    <CopyButton text={api.getWorkspaceId() ?? ''} />
                  </>
                )}
              </div>
            </div>
            <a className="btn primary" href={href('/workspace')}>
              进入工作台 →
            </a>
          </div>

          <div className="panel">
            <h2>我的游戏</h2>
            {games.loading && <Skeleton card rows={4} />}
            {games.error != null && <ErrorBox error={games.error} />}
            {games.data && <GameGrid games={games.data} />}
          </div>

          <div className="panel">
            <h2>最近对局</h2>
            <AllMatches />
          </div>
        </>
      )}
    </>
  );
}

/** 游戏卡片网格：卡片本体不整卡跳转，靠「进入 →」按钮，避免误触。 */
function GameGrid({ games }: { games: ReadonlyArray<{ id: string; name: string; pacing: string }> }): JSX.Element {
  if (games.length === 0) {
    return <EmptyState icon="🎮" text="暂无已开放游戏" hint="游戏开放后会出现在这里" />;
  }
  return (
    <div className="card-grid">
      {games.map((g) => (
        <div key={g.id} className="game-card">
          <div className="game-icon" aria-hidden>
            {gameIcon(g.id)}
          </div>
          <div className="game-name">{g.name}</div>
          <div className="game-meta">
            <span className="tag pacing">{PACING_LABEL[g.pacing] ?? g.pacing}</span>
            <span className="small muted mono"> {g.id}</span>
          </div>
          <a className="btn ghost game-enter" href={href(`/game/${encodeURIComponent(g.id)}`)}>
            进入 →
          </a>
        </div>
      ))}
    </div>
  );
}

function AllMatches(): JSX.Element {
  const matches = useAsync(() => api.listMatches(), [api.getCredential()]);
  if (matches.loading) return <Skeleton rows={5} />;
  if (matches.error) return <ErrorBox error={matches.error} />;
  const list = matches.data ?? [];
  if (list.length === 0) {
    return <EmptyState icon="⚔️" text="暂无对局记录" hint="发起一场对局后会出现在这里" />;
  }
  return (
    <table className="data">
      <thead>
        <tr>
          <th>对局</th>
          <th>游戏</th>
          <th>类型</th>
          <th>状态</th>
          <th>结果</th>
          <th>时间</th>
          <th>操作</th>
        </tr>
      </thead>
      <tbody>
        {list.map((m) => (
          <tr key={m.matchId}>
            <td>
              <span className="match-id">
                <span className="mono">{m.matchId.slice(0, 8)}</span>
                <CopyButton text={m.matchId} />
              </span>
            </td>
            <td>{m.gameId}</td>
            <td>
              <MatchKindTag kind={m.kind} />
            </td>
            <td>
              <MatchPhaseTag phase={m.phase} />
            </td>
            <td>
              {m.result ? (
                <span title={m.result.outcome.reason}>
                  <OutcomeTag outcome={m.result.outcome} />
                </span>
              ) : (
                <span className="muted">—</span>
              )}
            </td>
            <td>
              <RelativeTime at={m.createdAt} />
            </td>
            <td>
              <a className="btn ghost small-btn" href={href(`/match/${encodeURIComponent(m.matchId)}`)}>
                观看
              </a>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
