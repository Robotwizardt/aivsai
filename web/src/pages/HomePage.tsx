import { FormEvent, useState } from 'react';
import * as api from '../api';
import { href } from '../router';
import { CredentialBundle } from '../types';
import { ErrorBox, Loading, useAsync } from '../components';

const PACING_LABEL: Record<string, string> = {
  instant: '即时制',
  'turn-based': '回合制',
};

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

  // 凭证失效被清掉时的说明（读取后清空，只提示一次）
  const staleNotice = api.takeUnauthorizedNotice();

  return (
    <>
      {staleNotice != null && <div className="message error">{staleNotice}</div>}
      {bundle && <CredentialNotice bundle={bundle} />}
      {!hasCredential && !bundle && (
        <div className="panel">
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
              <button className="primary" type="submit" disabled={submitting || inviteCode.trim() === ''}>
                {submitting ? '兑换中…' : '兑换邀请码'}
              </button>
            </div>
          </form>
          {error != null && <ErrorBox error={error} />}
        </div>
      )}

      <div className="panel">
        <h2>游戏</h2>
        {games.loading && <Loading />}
        {games.error != null && <ErrorBox error={games.error} />}
        {games.data &&
          (games.data.length === 0 ? (
            <p className="muted">暂无已开放游戏。</p>
          ) : (
            <div className="card-grid">
              {games.data.map((g) => (
                <a key={g.id} className="game-card" href={href(`/game/${encodeURIComponent(g.id)}`)}>
                  <div className="game-name">{g.name}</div>
                  <div className="game-meta">
                    ID：{g.id} · {PACING_LABEL[g.pacing] ?? g.pacing}
                  </div>
                </a>
              ))}
            </div>
          ))}
      </div>

      <div className="panel">
        <h2>全部对局</h2>
        <AllMatches />
      </div>
    </>
  );
}

function AllMatches(): JSX.Element {
  const matches = useAsync(() => api.listMatches(), [api.getCredential()]);
  if (matches.loading) return <Loading />;
  if (matches.error) return <ErrorBox error={matches.error} />;
  const list = matches.data ?? [];
  if (list.length === 0) return <p className="muted">暂无对局记录。</p>;
  return (
    <table className="data">
      <thead>
        <tr>
          <th>对局</th>
          <th>游戏</th>
          <th>类型</th>
          <th>状态</th>
          <th>结果</th>
        </tr>
      </thead>
      <tbody>
        {list.map((m) => (
          <tr key={m.matchId}>
            <td>
              <a href={href(`/match/${encodeURIComponent(m.matchId)}`)} className="mono">
                {m.matchId.slice(0, 8)}…
              </a>
            </td>
            <td>{m.gameId}</td>
            <td>
              <span className={`tag ${m.kind}`}>{m.kind === 'official' ? '正式' : '训练'}</span>
            </td>
            <td>{m.phase}</td>
            <td>{m.result ? m.result.outcome.kind : '—'}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}
