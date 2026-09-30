/**
 * 默认策略模板与策略 API 说明（依据 server/src/games/tank/tank-game.ts、
 * server/src/engine/quickjs-sandbox.ts 的 v2 命令队列契约）。
 *
 * v1 契约（返回 {move, fire}、me.x/me.y、直线视野）已被引擎移除：
 * 非信封返回值一律当作 no-op，旧模板会白白挨打，请勿再使用。
 */

export const DEFAULT_STRATEGY_TEMPLATE = `// 坦克大战策略模板（v2 契约：命令队列）
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

export const STRATEGY_API_DOC = `策略契约（坦克大战 tank，v2 命令队列）：
- 必须定义全局函数 onIdle(me, enemy, game)；命令队列为空时每 tick 调用一次。抛错或执行超时累计 3 次判负。
- 动作（在函数体内调用 me.* 即"排队"，引擎每 tick 只从队列执行一条）：
  - me.go() / me.go(n)：排队 n 条前进命令，逐 tick 执行（不是瞬间走 n 格）；撞墙/土堆/坦克/出界那 tick 是 no-op，但仍会消耗一条队列。
  - me.turn('left') / me.turn('right')：相对当前朝向原地转 90°。
  - me.fire()：开火。仅当冷却为 0 且自己没有存活子弹时生效（每方同屏只有一发自己的子弹）。
  - me.speak('文本')：发言气泡，不占动作、不影响执行，40 字上限。print(...)：调试日志，出现在试跑结果 logs 中。
- 观察（纯 JSON，全图可见；可见性只由草丛决定）：
  - me.tank.position = [x, y]（数组！）、me.tank.direction = 'up'|'right'|'down'|'left'、me.tank.crashed = 是否已被击毁（hp <= 0）
  - me.hp（0..100）、me.stars（已收集星数）、me.cooldown（距下次可开火剩余 tick）、me.bullet（{position, direction} | null）
  - enemy：与 me 同构；敌方站在草上或已被击毁时为 null（敌方子弹始终可见）
  - game.map[x][y] = 'x' 墙（不可摧毁）/ 'm' 土堆（被子弹命中后摧毁变空地）/ 'o' 草（可通行，站上去对敌方不可见）/ '.' 空地
  - game.star = [x, y] | null、game.frames（当前 tick）、game.arena = { width, height }
- 规则：20×15 网格，HP 100、子弹伤害 34、开火冷却 8 tick、300 tick 上限；胜负判定 击毁 > 累计 3 次策略错误判负 > 超时星多 > 星同 HP 多 > 平局；沙箱禁止联网与文件系统访问。`;
