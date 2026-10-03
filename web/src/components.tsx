import { useEffect, useState } from 'react';
import { copyTextToClipboard, getWorkspaceMe, renameWorkspace } from './api';
import { WorkspaceInfo } from './types';

/** 加载中/错误/空数据/复制按钮等通用小组件。 */

// ---------------------------------------------------------------- 基础

export function Loading({ text = '加载中…' }: { text?: string }): JSX.Element {
  return <p className="muted">{text}</p>;
}

export function ErrorBox({ error }: { error: unknown }): JSX.Element {
  const message =
    error instanceof Error
      ? error.message
      : typeof error === 'string'
        ? error
        : '发生未知错误';
  return <div className="message error">{message}</div>;
}

/** 骨架屏：数据加载期间代替「加载中…」文本。 */
export function Skeleton({ rows = 3, card = false }: { rows?: number; card?: boolean }): JSX.Element {
  if (card) {
    return (
      <div className="card-grid">
        {Array.from({ length: rows }, (_, i) => (
          <div key={i} className="skeleton-card" aria-hidden>
            <div className="skeleton-block skeleton-icon" />
            <div className="skeleton-block" style={{ width: '60%' }} />
            <div className="skeleton-block" style={{ width: '85%' }} />
          </div>
        ))}
      </div>
    );
  }
  return (
    <div className="skeleton-rows" aria-hidden>
      {Array.from({ length: rows }, (_, i) => (
        <div key={i} className="skeleton-block" style={{ width: `${92 - i * 9}%` }} />
      ))}
    </div>
  );
}

/** 空数据占位：图标 + 提示。 */
export function EmptyState({
  icon = '🗂️',
  text,
  hint,
}: {
  icon?: string;
  text: string;
  hint?: string;
}): JSX.Element {
  return (
    <div className="empty-state">
      <div className="empty-icon" aria-hidden>
        {icon}
      </div>
      <div>{text}</div>
      {hint != null && <div className="empty-hint">{hint}</div>}
    </div>
  );
}

/** 复制按钮：点击后短暂变为「已复制」；HTTP 下自动走降级（见 copyTextToClipboard）。 */
export function CopyButton({ text, label = '复制' }: { text: string; label?: string }): JSX.Element {
  const [copied, setCopied] = useState(false);
  const onCopy = async () => {
    await copyTextToClipboard(text);
    setCopied(true);
    window.setTimeout(() => setCopied(false), 2000);
  };
  return (
    <button type="button" className={`copy-btn${copied ? ' copied' : ''}`} onClick={onCopy}>
      {copied ? '已复制' : label}
    </button>
  );
}

/** 绿色成功横幅：显示后自动消失。 */
export function SuccessBanner({
  text,
  durationMs = 3000,
  onDone,
}: {
  text: string;
  durationMs?: number;
  onDone: () => void;
}): JSX.Element {
  useEffect(() => {
    const timer = window.setTimeout(onDone, durationMs);
    return () => window.clearTimeout(timer);
  }, [durationMs, onDone]);
  return <div className="message ok">{text}</div>;
}

/**
 * 「坦克名@工作台名」消歧展示（ADR 0010）。
 * bot（无工作台）只显示名字；无名字回退 id 前缀。
 */
export function EntrantName({
  name,
  entrantId,
  workspaceNickname,
}: {
  name: string | null | undefined;
  entrantId?: string;
  workspaceNickname?: string | null;
}): JSX.Element {
  const label = name ?? (entrantId ? entrantId.slice(0, 8) : '—');
  return (
    <span className="entrant-name" title={entrantId}>
      {label}
      {workspaceNickname ? <span className="ws-name muted"> @{workspaceNickname}</span> : null}
    </span>
  );
}

/**
 * 工作台昵称显示 + 改名（ADR 0010）。拉取当前昵称，点「改名」切输入框，撞名/失败给出提示。
 * 放在首页横幅与工作台页顶部。
 */
export function WorkspaceNicknameEditor(): JSX.Element {
  const [info, setInfo] = useState<WorkspaceInfo | null>(null);
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    getWorkspaceMe()
      .then((d: WorkspaceInfo) => {
        setInfo(d);
        setDraft(d.nickname ?? '');
      })
      .catch(() => setInfo(null));
  }, []);

  const submit = async () => {
    const nickname = draft.trim();
    if (!nickname) {
      setError('昵称不能为空');
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const updated = await renameWorkspace(nickname);
      setInfo(updated);
      setEditing(false);
    } catch (e) {
      setError(e instanceof Error ? e.message : '改名失败');
    } finally {
      setBusy(false);
    }
  };

  if (!info) return <></>;

  if (editing) {
    return (
      <span className="ws-nickname-editor">
        <input
          className="ws-nickname-input"
          value={draft}
          autoFocus
          placeholder="输入工作台名"
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') submit();
            if (e.key === 'Escape') setEditing(false);
          }}
        />
        <button type="button" className="btn primary" disabled={busy} onClick={submit}>
          {busy ? '保存中…' : '保存'}
        </button>
        <button type="button" className="btn" onClick={() => setEditing(false)}>
          取消
        </button>
        {error && <span className="ws-nickname-error">{error}</span>}
      </span>
    );
  }

  return (
    <span className="ws-nickname">
      <strong>{info.nickname ?? '未命名工作台'}</strong>
      <button
        type="button"
        className="link"
        style={{ marginLeft: 6 }}
        onClick={() => {
          setDraft(info.nickname ?? '');
          setError(null);
          setEditing(true);
        }}
      >
        ✎ 改名
      </button>
    </span>
  );
}

/** async 数据加载器：自动请求 + loading + error，reload 可手动刷新。 */
export function useAsync<T>(loader: () => Promise<T>, deps: readonly unknown[] = []): {
  data: T | null;
  error: unknown;
  loading: boolean;
  reload: () => void;
} {
  const [data, setData] = useState<T | null>(null);
  const [error, setError] = useState<unknown>(null);
  const [loading, setLoading] = useState(true);
  const [seq, setSeq] = useState(0);
  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    loader()
      .then((v) => {
        if (!cancelled) {
          setData(v);
          setLoading(false);
        }
      })
      .catch((e: unknown) => {
        if (!cancelled) {
          setError(e);
          setLoading(false);
        }
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...deps, seq]);
  return { data, error, loading, reload: () => setSeq((s) => s + 1) };
}

// ---------------------------------------------------------------- 时间

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function relativeTime(ms: number, now = Date.now()): string {
  const diff = Math.max(0, now - ms);
  const min = Math.floor(diff / 60_000);
  if (min < 1) return '刚刚';
  if (min < 60) return `${min} 分钟前`;
  const hour = Math.floor(min / 60);
  if (hour < 24) return `${hour} 小时前`;
  const day = Math.floor(hour / 24);
  if (day < 30) return `${day} 天前`;
  return formatTime(ms);
}

/** 相对时间展示，悬停可见完整时间。 */
export function RelativeTime({ at }: { at: number }): JSX.Element {
  return (
    <span className="small" title={formatTime(at)}>
      {relativeTime(at)}
    </span>
  );
}

// ---------------------------------------------------------------- 标签

export const PHASE_LABEL: Record<string, string> = {
  queued: '排队中',
  running: '运行中',
  finished: '已完成',
  invalid: '无效',
};

export function MatchPhaseTag({ phase }: { phase: string }): JSX.Element {
  return <span className={`tag phase-${phase}`}>{PHASE_LABEL[phase] ?? phase}</span>;
}

export function MatchKindTag({ kind }: { kind: string }): JSX.Element {
  return (
    <span className={`tag ${kind}`}>{kind === 'official' ? '正式' : kind === 'training' ? '训练' : kind}</span>
  );
}

export function OutcomeTag({
  outcome,
}: {
  outcome: { kind: 'win' | 'draw' | 'invalid'; winner?: 0 | 1 } | null;
}): JSX.Element {
  if (!outcome) return <span className="muted">—</span>;
  if (outcome.kind === 'win') {
    return (
      <span className="tag win">
        {typeof outcome.winner === 'number' ? `胜方 ${outcome.winner}` : '有胜方'}
      </span>
    );
  }
  if (outcome.kind === 'draw') return <span className="tag draw">平局</span>;
  return <span className="tag invalid">无效</span>;
}
