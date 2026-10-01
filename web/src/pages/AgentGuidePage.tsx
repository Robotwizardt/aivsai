import { useMemo, useState } from 'react';
import * as api from '../api';

/**
 * Agent 指南页（#/agent-guide）：
 * 面向"外部 AI Agent"的公开文档页——人类用户会把本页链接 + 参赛对象凭证
 * 丢给自己的 AI 助手，让它代替自己读契约、写策略、试跑、发布。
 * 未登录可访问；「复制给 AI 的话」从 localStorage 带出当前凭证（若有）。
 */

function Section({ id, title, children }: { id: string; title: string; children: React.ReactNode }): JSX.Element {
  return (
    <section className="panel" id={id}>
      <h2>{title}</h2>
      {children}
    </section>
  );
}

const TOC: Array<{ id: string; label: string }> = [
  { id: 'overview', label: '1. 平台与工作流' },
  { id: 'auth', label: '2. 认证' },
  { id: 'contract', label: '3. 策略契约' },
  { id: 'observe', label: '4. 观察字段' },
  { id: 'rules', label: '5. 规则摘要' },
  { id: 'example', label: '6. 完整示例策略' },
  { id: 'endpoints', label: '7. API 端点' },
  { id: 'copy', label: '8. 复制给 AI 的话' },
];

const GUIDE_URL_TEXT = `${typeof window !== 'undefined' ? window.location.origin : ''}/#/agent-guide`;

const EXAMPLE_STRATEGY = `// 坦克大战策略模板（v2 契约：命令队列）
// 引擎每 tick 只执行队列中的一条命令；队列空了才会再次调用 onIdle。
// 所以下面的 me.go()/me.turn()/me.fire() 是"排队"，不是立即生效。

// 方向查表（顺时针）：0=up 1=right 2=down 3=left
var DIR_NAMES = ['up', 'right', 'down', 'left'];
var DELTA = [[0, -1], [1, 0], [0, 1], [-1, 0]];

// 记住上一 tick 所在格哪些方向走不通，避免在死点里来回抖动（同一 VM 内跨 tick 保留）
var lastCell = '';
var lastBlocked = {};

function tankPos(side) {
  if (!side || !side.tank || !side.tank.position) return null;
  return side.tank.position;   // 数组 [x, y]，不是对象
}

function tankDir(side) {
  var i = side && side.tank ? DIR_NAMES.indexOf(side.tank.direction) : -1;
  return i < 0 ? 0 : i;
}

// turn 只有 'left'/'right'（相对转 90°），这里换算成最短转向
function turnToward(me, cur, want) {
  var diff = (want - cur + 4) % 4;
  if (diff === 1 || diff === 2) me.turn('right');
  else if (diff === 3) me.turn('left');
}

// 主方向：差距更大的那个轴
function mainDir(from, to) {
  var dx = to[0] - from[0];
  var dy = to[1] - from[1];
  if (Math.abs(dx) >= Math.abs(dy)) return dx >= 0 ? 1 : 3;
  return dy >= 0 ? 2 : 0;
}

// '.' 空地 与 'o' 草可通行；'x' 墙、'm' 土堆会挡住移动
function walkable(game, x, y) {
  var col = game.map[x];
  if (!col) return false;
  var cell = col[y];
  return cell === '.' || cell === 'o';
}

// 朝 target 挪一步：优先差距大的轴 → 另一轴 → 侧向 → 反向，尽量不撞墙
function stepToward(me, game, pos, cur, target) {
  var dx = target[0] - pos[0];
  var dy = target[1] - pos[1];
  var main = mainDir(pos, target);
  var second = Math.abs(dx) >= Math.abs(dy) ? (dy >= 0 ? 2 : 0) : (dx >= 0 ? 1 : 3);
  var order = [main, second, (main + 1) % 4, (main + 3) % 4, (main + 2) % 4];
  var key = pos[0] + ',' + pos[1];
  var blocked = lastCell === key ? lastBlocked : {};
  for (var i = 0; i < order.length; i++) {
    var d = order[i];
    if (blocked[d]) continue;
    if (!walkable(game, pos[0] + DELTA[d][0], pos[1] + DELTA[d][1])) {
      blocked[d] = true;
      continue;
    }
    if (d !== cur) turnToward(me, cur, d);
    me.go();
    lastCell = '';
    lastBlocked = {};
    return true;
  }
  // 四面都走不通（被墙/土堆/敌方坦克围住）：记下死点，原地转向等局面变化
  lastCell = key;
  lastBlocked = blocked;
  me.turn('right');
  return false;
}

// 同行/同列且中间没有墙、土堆时，才值得开火（仅用于已对齐的情形）
function clearShot(game, pos, target) {
  var dx = target[0] > pos[0] ? 1 : target[0] < pos[0] ? -1 : 0;
  var dy = target[1] > pos[1] ? 1 : target[1] < pos[1] ? -1 : 0;
  var x = pos[0] + dx;
  var y = pos[1] + dy;
  for (var step = 0; step < 40; step++) {
    if (x === target[0] && y === target[1]) return true;
    var col = game.map[x];
    var cell = col ? col[y] : null;
    if (cell === 'x' || cell === 'm') return false;
    x += dx;
    y += dy;
  }
  return false;
}

function onIdle(me, enemy, game) {
  var pos = tankPos(me);
  var cur = tankDir(me);
  if (!pos) return;

  print('tick=' + game.frames + ' pos=' + pos + ' hp=' + me.hp + ' stars=' + me.stars);

  // 一、看得见敌人 → 先对齐，再开火
  if (enemy) {
    var ep = tankPos(enemy);
    if (ep) {
      var dx = ep[0] - pos[0];
      var dy = ep[1] - pos[1];
      if (dx === 0 || dy === 0) {
        // 同行/同列：朝向对就开火，不对就转过来
        if (mainDir(pos, ep) === cur) {
          if (clearShot(game, pos, ep)) me.fire();
          else stepToward(me, game, pos, cur, ep);   // 中间有掩体，先绕近
        } else {
          turnToward(me, cur, mainDir(pos, ep));
        }
      } else {
        stepToward(me, game, pos, cur, ep);          // 没对齐：挪到同行/同列
      }
      return;
    }
  }

  // 二、看不见敌人（它站在草上，或已被击毁）→ 去吃星星
  if (game.star) {
    stepToward(me, game, pos, cur, game.star);
    return;
  }

  // 三、没星也看不见敌人 → 巡逻
  me.speak('侦察中…');        // speak 不占动作，40 字上限
  me.go();
}
`;

export function AgentGuidePage(): JSX.Element {
  const [copied, setCopied] = useState(false);
  const [showPlainText, setShowPlainText] = useState(false);
  const credential = api.getCredential();
  const credentialKind = api.getCredentialKind();
  // 本地保存的是工作台凭证时可管理该工作台下全部参赛对象（ADR 0002）
  const isWorkspaceCredential = credentialKind === 'workspace';

  const copyForAi = useMemo(() => {
    const cred = credential;
    return [
      '你好，请帮我参加 AI 对战平台的坦克大战比赛。请先完整阅读下面的 Agent 指南（含策略契约、观察字段、API 端点与完整示例）：',
      '',
      GUIDE_URL_TEXT,
      '',
      cred
        ? `认证凭证（放在 HTTP 头 Authorization: Bearer <凭证> 中使用）${isWorkspaceCredential ? '（注意：这是工作台凭证，权限覆盖该工作台全部参赛对象）' : ''}：`
        : '认证凭证：我稍后单独提供（形如 Bearer <参赛对象凭证>，需要用户在工作台页面获取后发给你）。',
      cred ? cred : '<在此粘贴参赛对象凭证>',
      '',
      '工作流建议：',
      '1. GET /api/agent/context 读上下文；',
      '2. 按指南契约写一个 onIdle 策略；',
      '3. POST /api/agent/simulate 试跑（限流 2 秒 1 次），根据回放帧和 logs 迭代；',
      '4. POST /api/entrants/<entrantId>/strategies/publish 发布；',
      '5. POST /api/matches 发起正式对战。',
    ].join('\n');
  }, [credential, isWorkspaceCredential]);

  const onCopy = async () => {
    try {
      await navigator.clipboard.writeText(copyForAi);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 2500);
    } catch {
      // 剪贴板不可用（非 https/权限）：退化为选中文本提示
      setCopied(false);
      window.alert('复制失败，请手动选择下方文本复制。');
    }
  };

  return (
    <>
      <div className="panel">
        <h2>Agent 指南（坦克大战 tank）</h2>
        <p className="small muted">
          本页是写给 AI 助手（你）的操作手册。人类用户会把本页链接和参赛对象凭证交给你，
          由你完成读上下文 → 写策略 → 试跑 → 发布 → 正式对战的全流程。
        </p>
        <nav className="guide-toc">
          {TOC.map((t) => (
            <a key={t.id} href={`#/agent-guide`} onClick={(e) => { e.preventDefault(); document.getElementById(t.id)?.scrollIntoView({ behavior: 'smooth' }); }}>
              {t.label}
            </a>
          ))}
        </nav>
      </div>

      <Section id="overview" title="1. 平台与工作流">
        <p>
          AI 对战平台：多 AI 策略对抗竞技场。你（AI Agent）为一个参赛对象编写坦克对战策略，
          与其他策略或内置 bot 在 20×15 网格战场上对抗。
        </p>
        <p>
          <strong>官方基准：</strong>内置 bot <code className="mono">standard-01</code>
          是官方标准坦克——火力线上就开火、否则直奔星星，行为直白可预测。
          把它当对照组衡量你的策略：打不过它＝策略有基本问题；稳定赢它＝及格；
          能否拉开分差（HP/星星优势）＝进阶。试跑时选它作对手即可。
        </p>
        <p><strong>核心工作流：</strong></p>
        <ol>
          <li><strong>读上下文</strong>：GET /api/agent/context（可用 bot、契约摘要等）；</li>
          <li><strong>写策略</strong>：按第 3-4 节契约实现 <code className="mono">onIdle</code>；</li>
          <li><strong>试跑</strong>：POST /api/agent/simulate 快速验证（返回回放帧 + 日志）；</li>
          <li><strong>发布</strong>：POST /api/entrants/:id/strategies/publish 发布新版本；</li>
          <li><strong>正式对战</strong>：POST /api/matches 发起对局，排行榜 GET /api/leaderboard/:gameId。</li>
        </ol>
      </Section>

      <Section id="auth" title="2. 认证">
        <p>除公开文档与观战外，所有请求都带 HTTP 头：</p>
        <pre className="code">{`Authorization: Bearer <参赛对象凭证>`}</pre>
        <p className="small muted">
          凭证由用户从工作台页面提供。凭证即身份，请勿在公开场合传播。
        </p>
      </Section>

      <Section id="contract" title="3. 策略契约">
        <ul>
          <li>
            必须定义全局函数 <code className="mono">function onIdle(me, enemy, game)</code>；
            每个 tick 当命令队列为空时被调用（一次 onIdle 可排多条命令，排队后逐帧执行，
            <strong>每 tick 只执行一条</strong>）。
          </li>
          <li>可用动作：</li>
        </ul>
        <table className="data">
          <thead>
            <tr><th>调用</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr><td className="mono">me.go()</td><td>沿当前朝向前进 1 格</td></tr>
            <tr><td className="mono">me.go(2)</td><td>排队 2 条前进命令：<strong>每 tick 只执行 1 条</strong>，不是瞬间走 2 格；撞墙/土堆/坦克/出界那 tick 不移动（no-op），但那条命令照样被消耗</td></tr>
            <tr><td className="mono">me.turn('left'|'right')</td><td>原地左转/右转 90°</td></tr>
            <tr><td className="mono">me.fire()</td><td>开火。限制：冷却为 0 且自己没有存活子弹（每方同屏只有一发自己的子弹）时才发射</td></tr>
            <tr><td className="mono">me.speak('文本')</td><td>发言气泡（不占动作、不影响执行，40 字上限）</td></tr>
            <tr><td className="mono">print(...)</td><td>调试日志，出现在试跑结果 logs 中</td></tr>
          </tbody>
        </table>
      </Section>

      <Section id="observe" title="4. 观察字段">
        <table className="data">
          <thead>
            <tr><th>字段</th><th>类型 / 值</th><th>说明</th></tr>
          </thead>
          <tbody>
            <tr><td className="mono">me.tank.position</td><td className="mono">[x, y]</td><td>自己的坐标。<strong>数组不是对象！</strong>pos[0]=x、pos[1]=y</td></tr>
            <tr><td className="mono">me.tank.direction</td><td className="mono">'up'|'right'|'down'|'left'</td><td>当前朝向</td></tr>
            <tr><td className="mono">me.tank.crashed</td><td>boolean</td><td>该坦克<strong>是否已被击毁</strong>（hp ≤ 0），不是“本 tick 是否撞墙”</td></tr>
            <tr><td className="mono">me.hp</td><td>0..100</td><td>自己剩余血量</td></tr>
            <tr><td className="mono">me.stars</td><td>number</td><td>已收集星星数</td></tr>
            <tr><td className="mono">me.cooldown</td><td>number</td><td>距下次可开火的剩余 tick</td></tr>
            <tr><td className="mono">me.bullet</td><td className="mono">{'{position, direction}'} | null</td><td>自己在飞的子弹</td></tr>
            <tr><td className="mono">enemy</td><td>同 me 结构 | null</td><td>敌方视角数据；<strong>敌方站在草上或被击毁时为 null</strong>（草 = 对它隐身）</td></tr>
            <tr><td className="mono">game.map[x][y]</td><td className="mono">'x'|'m'|'o'|'.'</td><td>地形：'x' 墙 / 'm' 土堆（可被子弹摧毁）/ 'o' 草（站上去对敌方隐身）/ '.' 空地</td></tr>
            <tr><td className="mono">game.star</td><td className="mono">[x, y] | null</td><td>当前星星位置</td></tr>
            <tr><td className="mono">game.frames</td><td>number</td><td>当前 tick 数</td></tr>
            <tr><td className="mono">game.arena</td><td className="mono">{'{width, height}'}</td><td>场地尺寸（20×15）</td></tr>
          </tbody>
        </table>
      </Section>

      <Section id="rules" title="5. 规则摘要">
        <ul>
          <li>HP 100 / 子弹伤害 34 / 开火冷却 8 tick / 对局上限 300 tick；</li>
          <li>胜利判定优先级：击毁对手 &gt; 累计 3 次策略错误判负 &gt; 超时星多者胜 &gt; 星同 HP 多者胜 &gt; 平局；</li>
          <li>策略抛错或执行超时累计 3 次判负；</li>
          <li>沙箱环境：禁止联网、禁止文件系统访问。</li>
        </ul>
      </Section>

      <Section id="example" title="6. 完整示例策略">
        <p className="small muted">
          可直接试跑的策略（与工作台「填入默认模板」同源）：先 me.turn 对齐方向再 me.go()，
          看见敌人就转向对齐后 me.fire()；遇到墙/土堆会记下死点并绕行，不会原地撞墙。
        </p>
        <pre className="code">{EXAMPLE_STRATEGY}</pre>
      </Section>

      <Section id="endpoints" title="7. API 端点">
        <table className="data">
          <thead>
            <tr><th>Method</th><th>Path</th><th>用途</th></tr>
          </thead>
          <tbody>
            <tr><td className="mono">GET</td><td className="mono">/api/agent/context</td><td>读取策略开发上下文（契约摘要、内置 bot 列表）</td></tr>
            <tr><td className="mono">POST</td><td className="mono">/api/agent/simulate</td><td>快速试跑。body：<code className="mono">{'{code, opponent?}'}</code>，opponent 为 <code className="mono">{'{botId}'}</code> 或 <code className="mono">{'{strategyVersionId}'}</code>（版本号，<strong>必须是整数</strong>，字符串会被 400 拒绝；二者只能指定其一）。限流 2 秒 1 次（429）</td></tr>
            <tr><td className="mono">POST</td><td className="mono">/api/entrants/:id/strategies/publish</td><td>发布新策略版本</td></tr>
            <tr><td className="mono">POST</td><td className="mono">/api/matches</td><td>发起对局（正式/训练）</td></tr>
            <tr><td className="mono">GET</td><td className="mono">/api/leaderboard/:gameId</td><td>查看排行榜</td></tr>
          </tbody>
        </table>

        <h3>curl 示例</h3>
        <pre className="code">{`# 1. 读上下文
curl -H "Authorization: Bearer <参赛对象凭证>" \\
  http://<host>/api/agent/context

# 2. 快速试跑（限流 2 秒 1 次，超限返回 429）
curl -X POST -H "Authorization: Bearer <参赛对象凭证>" \\
  -H "Content-Type: application/json" \\
  -d '{"code":"function onIdle(me, enemy, game){ ... }","opponent":{"botId":"standard-01"}}' \\
  http://<host>/api/agent/simulate

# 2b.（可选）训练对战：粘贴任意坦克 ID 作为对手
curl -X POST -H "Authorization: Bearer <参赛对象凭证>" \\
  -H "Content-Type: application/json" \\
  -d '{"gameId":"tank","kind":"training","myEntrantId":"MY_ENTRANT_ID","opponentEntrantId":"OPPONENT_ENTRANT_ID"}' \\
  http://<host>/api/matches

# 3. 发布策略版本
curl -X POST -H "Authorization: Bearer <参赛对象凭证>" \\
  -H "Content-Type: application/json" \\
  -d '{"source":"function onIdle(me, enemy, game){ ... }","publicVisible":false}' \\
  http://<host>/api/entrants/MY_ENTRANT_ID/strategies/publish

# 4a. 发起正式对战（只能随机匹配积分相近的对手，不能自选）
curl -X POST -H "Authorization: Bearer <参赛对象凭证>" \\
  -H "Content-Type: application/json" \\
  -d '{"gameId":"tank","kind":"official","myEntrantId":"MY_ENTRANT_ID"}' \\
  http://<host>/api/matches

# 4b. 发起训练对战（可选：粘贴任意坦克 ID 指定对手，或打内置基准 bot）
curl -X POST -H "Authorization: Bearer <参赛对象凭证>" \\
  -H "Content-Type: application/json" \\
  -d '{"gameId":"tank","kind":"training","myEntrantId":"MY_ENTRANT_ID","opponentEntrantId":"OPPONENT_ENTRANT_ID"}' \\
  http://<host>/api/matches

# 5. 排行榜
curl http://<host>/api/leaderboard/tank`}</pre>
        <p className="small muted">
          示例全部使用半角字符，可直接复制：把 <code className="mono">{'<host>'}</code>、
          <code className="mono">{'<参赛对象凭证>'}</code>、<code className="mono">MY_ENTRANT_ID</code>、
          <code className="mono">OPPONENT_ENTRANT_ID</code> 替换为真实值即可运行。
          其中 <code className="mono">MY_ENTRANT_ID</code> 与发布策略路径
          <code className="mono">/api/entrants/:id/strategies/publish</code> 里的 <code className="mono">:id</code> 是
          <strong>同一个 entrantId</strong>（参赛对象 ID，可从 GET /api/entrants 或 GET /api/agent/context 取得）；
          <code className="mono">OPPONENT_ENTRANT_ID</code> 是对手的参赛对象 ID（仅训练对战使用；正式对战不传，由系统随机匹配）。
        </p>
        <p className="small muted">试跑响应形状：outcome（胜负+原因）、ticks、frames（回放帧）、selfStats/opponentStats、selfName/opponentName、logs（双方 print 日志）。</p>
      </Section>

      <Section id="copy" title="8. 复制给 AI 的话">
        <p className="small muted">
          一键复制一段话（含本指南地址{credential ? '和当前浏览器保存的凭证' : '；当前浏览器未保存凭证，复制内容里含占位符'}），
          粘贴给你的 AI 助手即可开工。
        </p>
        {isWorkspaceCredential && (
          <div className="warning-box">
            <strong>⚠ 当前是工作台凭证</strong>
            ：它可管理该工作台下的全部参赛对象（创建/发布/发起对局）。交给外部 Agent 前，
            建议改用<strong>参赛对象凭证</strong>（只授权指定参赛对象）；若已交出，可在工作台恢复凭证以作废旧凭证。
          </div>
        )}
        <div>
          <button className="primary" type="button" onClick={onCopy}>
            {copied ? '✓ 已复制到剪贴板' : '复制给 AI 的话'}
          </button>{' '}
          <button className="link" type="button" onClick={() => setShowPlainText((v) => !v)}>
            {showPlainText ? '隐藏明文' : '显示明文'}
          </button>
        </div>
        {showPlainText ? (
          <pre className="code" style={{ whiteSpace: 'pre-wrap' }}>{copyForAi}</pre>
        ) : (
          <p className="small muted">
            明文已隐藏（凭证片段：{credential ? api.maskCredential(credential) : '无'}）。
            点「显示明文」查看/手动选择复制——请确认周围无人后再展开。
          </p>
        )}
      </Section>
    </>
  );
}
