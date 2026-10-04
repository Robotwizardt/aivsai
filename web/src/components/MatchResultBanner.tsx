import { MatchResult } from '../types';

/**
 * 胜负横幅（苹果风）：观战页直播面板与回放播放器共用。
 * - win：胜方名用其战场颜色高亮，横幅色条跟随胜方颜色；
 * - draw / invalid：克制的中性样式；
 * - 有 failures 诊断信息时在横幅下方附带展示。
 */
export function MatchResultBanner({
  result,
  names,
  colors,
}: {
  result: MatchResult;
  /** 双方显示名（缺省回退「参赛方 X」）。 */
  names: readonly [string?, string?];
  /** 双方战场颜色（appearance.color；缺省用中性蓝）。 */
  colors?: readonly [string?, string?];
}): JSX.Element {
  const nameOf = (side: number) => names[side] ?? `参赛方 ${side}`;
  const { outcome } = result;

  let kindClass: string;
  let headline: JSX.Element;
  let accent: string | undefined;
  if (outcome.kind === 'win' && typeof outcome.winner === 'number') {
    kindClass = 'win';
    accent = colors?.[outcome.winner] ?? 'var(--accent)';
    headline = (
      <>
        <span className="mrb-winner" style={{ color: accent }}>
          {nameOf(outcome.winner)}
        </span>{' '}
        获胜
      </>
    );
  } else if (outcome.kind === 'draw') {
    kindClass = 'draw';
    headline = <>平局</>;
  } else {
    kindClass = 'invalid';
    headline = <>无效对局</>;
  }

  return (
    <div
      className={`match-result-banner ${kindClass}`}
      style={accent ? ({ '--mrb-accent': accent } as React.CSSProperties) : undefined}
    >
      <div className="mrb-main">
        <span className="mrb-emoji" aria-hidden>
          {kindClass === 'win' ? '🏆' : kindClass === 'draw' ? '🤝' : '⚠️'}
        </span>
        <div className="mrb-text">
          <div className="mrb-headline">{headline}</div>
          {outcome.reason && <div className="mrb-reason">{outcome.reason}</div>}
        </div>
      </div>
      {kindClass !== 'invalid' && result.failures && result.failures.length > 0 && (
        <div className="mrb-failures">
          策略故障诊断（仅管理者视角）：{' '}
          {result.failures.map((f) => `${nameOf(f.entrant)}: ${f.message}`).join('；')}
        </div>
      )}
    </div>
  );
}
