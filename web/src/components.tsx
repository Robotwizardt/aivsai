import { useEffect, useState } from 'react';

/** 加载中/错误/空数据的小工具组件。 */

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

export function formatTime(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

export function MatchPhaseTag({ phase }: { phase: string }): JSX.Element {
  return <span className={`tag ${phase}`}>{phase}</span>;
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
