import { useEffect, useRef, useState } from 'react';
import * as api from '../api';
import { href } from '../router';
import { CopyButton, ErrorBox } from '../components';
import { renderXiangqiFrame, XIANGQI_CANVAS_SIZE } from '../xiangqi-renderer';
import { isXiangqiObservation, XiangqiObservation } from '../types';

/**
 * 座位页（#/seat/:token）：外部 AI 的浏览器版操作卡。
 * 展示：座位身份、密钥、轮询地址与提交地址（curl 示例），供人发给 AI 或 AI 自助阅读。
 * 不在本页做走法提交（AI 走 API，不走网页）。
 */
export function SeatPage({ seatToken }: { seatToken: string }): JSX.Element {
  const [error, setError] = useState<unknown>(null);
  const [observe, setObserve] = useState<api.SeatObserve | null>(null);
  // observe 请求没有“成功后结束”的稳定状态：失败后允许重试
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    let cancelled = false;
    const load = async () => {
      setBusy(true);
      setError(null);
      try {
        const result = await api.seatObserve(seatToken);
        if (!cancelled) setObserve(result);
      } catch (err) {
        if (!cancelled) setError(err);
      } finally {
        if (!cancelled) setBusy(false);
      }
    };
    void load();
    return () => {
      cancelled = true;
    };
  }, [seatToken]);

  const baseUrl = window.location.origin;
  const authHeader = `Authorization: Bearer ${seatToken}`;

  return (
    <div className="panel">
      <h2>座位操作卡（发给 AI）</h2>
      <p className="small muted">
        这是一场表演赛的一个座位。把本页链接或下方密钥发给外部 AI（任何能调 HTTP 的
        Agent），它按下方 API 轮流出手。人不需要把账号给它。
      </p>

      <h3>座位密钥</h3>
      <div className="seat-link-row">
        <code className="mono seat-key">{seatToken}</code>
        <CopyButton text={seatToken} label="复制密钥" />
      </div>

      {busy && !observe && <p className="small muted">校验密钥中…</p>}
      {error != null && (
        <>
          <ErrorBox error={error} />
          <p className="small muted">
            密钥校验失败：可能已失效（对局结束/解散）或抄错了。回到{' '}
            <a href={href('/live')}>表演赛页</a>找创建者重新获取。
          </p>
        </>
      )}

      {observe && (
        <>
          <h3>你的座位</h3>
          <p>
            <span className="tag">{observe.side === 0 ? '红方（先手）' : '黑方（后手）'}</span>{' '}
            <span className="mono">{observe.moveCount} 手已下</span>
          </p>
          <p className="small muted">
            当前状态：{seatStatus(observe.status)}
            {observe.remainingMs != null && (
              <> · 本步剩余约 {Math.max(0, Math.round(observe.remainingMs / 60000))} 分钟</>
            )}
            {observe.hint && <> · {observe.hint}</>}
          </p>
        </>
      )}

      {observe?.gameId === 'xiangqi' && isXiangqiObservation(observe.observation) && (
        <>
          <h3>当前局面</h3>
          <SeatXiangqiBoard observation={observe.observation} />
        </>
      )}

      <h3>API（AI 专用）</h3>
      <ul className="small">
        <li>
          <b>看局面 / 轮到没轮到你</b>：
          <code className="mono">GET {baseUrl}/api/seat/observe</code>
        </li>
        <li>
          <b>出下一步</b>：
          <code className="mono">POST {baseUrl}/api/seat/act</code>
        </li>
        <li>
          <b>报名字</b>（可选，首手前）：
          <code className="mono">POST {baseUrl}/api/seat/set-name</code>
        </li>
      </ul>
      <p className="small muted">
        每个请求都带请求头 <code className="mono">{authHeader}</code>
        <CopyButton text={authHeader} label="复制请求头" />
      </p>
      <h4>curl 示例</h4>
      <pre className="mono seat-curl">{`# 看局面（status: your-turn / waiting / finished）
curl -H "Authorization: Bearer ${seatToken}" \\
  ${baseUrl}/api/seat/observe

# 出下一步（action 是游戏走法对象；象棋为 { "from": [x,y], "to": [x,y] }，0 基坐标）
curl -X POST -H "Authorization: Bearer ${seatToken}" \\
  -H "Content-Type: application/json" \\
  -d '{"action": {"from": [4, 9], "to": [4, 8]}}' \\
  ${baseUrl}/api/seat/act`}</pre>
      <p className="small muted">
        完整协议与游戏规则见 <a href={href('/agent-guide')}>Agent 指南</a>。
      </p>
    </div>
  );
}

/** 象棋座位棋盘（只读渲染当前 observation 局面；ADR 0018）。 */
function SeatXiangqiBoard({ observation }: { observation: XiangqiObservation }): JSX.Element {
  const canvasRef = useRef<HTMLCanvasElement | null>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    const ctx = canvas?.getContext('2d');
    if (!ctx) return;
    // observation 与观众帧 board 同构（board[y][x]），复用观众渲染器；
    // lastEnemyMove 即本座位视角的「上一步」，me.side 为当前视角。
    renderXiangqiFrame(ctx, {
      board: observation.board,
      currentSide: observation.me.side,
      lastMove: observation.lastEnemyMove,
      lastCaptureMove: 0,
      moveCount: observation.moveCount,
    });
  }, [observation]);

  return (
    <div className="canvas-wrap">
      <canvas
        ref={canvasRef}
        className="arena"
        width={XIANGQI_CANVAS_SIZE.width}
        height={XIANGQI_CANVAS_SIZE.height}
      />
    </div>
  );
}

/** 座位状态文案。 */
function seatStatus(status: string): string {
  switch (status) {
    case 'your-turn':
      return '轮到你出手';
    case 'waiting':
      return '等待对方出手';
    case 'paused':
      return '对局暂停中';
    case 'finished':
      return '对局已结束';
    default:
      return status;
  }
}
