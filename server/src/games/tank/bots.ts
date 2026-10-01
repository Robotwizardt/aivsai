/**
 * 内置训练 bot（Agent 工作流 API 用，见 /api/agent/simulate）。
 *
 * bot 是普通策略源码（onIdle 契约 + 命令队列：在函数内调用
 * me.go()/me.turn('left'|'right')/me.fire()，由沙箱排队、引擎逐 tick 消费）。
 *
 * 观察形状兼容 tank v1（me.x/me.y/me.direction 数字 0-3）与
 * v2（me.tank.position=[x,y]、me.tank.direction='up'|'right'|'down'|'left'、
 * game.map/game.star/game.frames）；bot 代码保持防御式，任何观察异常都不抛错。
 */

export interface TankBot {
  id: string;
  name: string;
  description: string;
  code: string;
}

/** 公共运行时助手（每个 bot 独立沙箱，源码各自内联一份）。 */
const RUNTIME_HELPERS = `
var DIR_NAMES = ['up', 'right', 'down', 'left'];
function botPos(t) {
  if (!t) return null;
  if (t.tank && t.tank.position && t.tank.position.length >= 2) {
    var p = t.tank.position;
    if (typeof p[0] === 'number' && typeof p[1] === 'number') return [p[0], p[1]];
  }
  if (typeof t.x === 'number' && typeof t.y === 'number') return [t.x, t.y];
  return null;
}
function botDir(t) {
  if (t && t.tank && typeof t.tank.direction === 'string') {
    var i = DIR_NAMES.indexOf(t.tank.direction);
    if (i >= 0) return i;
  }
  var d = t && t.direction;
  if (typeof d === 'number' && d >= 0 && d < 4) return Math.floor(d) % 4;
  return 0;
}
function botDirToward(from, to) {
  var dx = to[0] - from[0];
  var dy = to[1] - from[1];
  if (Math.abs(dx) >= Math.abs(dy)) return dx > 0 ? 1 : 3;
  return dy > 0 ? 2 : 0;
}
function botTurnToward(me, cur, want) {
  var diff = (want - cur + 4) % 4;
  if (diff === 1 || diff === 2) me.turn('right');
  else if (diff === 3) me.turn('left');
}
`;

const NOVA_SCOUT_CODE = `${RUNTIME_HELPERS}
// nova-scout：侦察机动型——看不到敌人时朝星星机动，看到敌人就对齐开火。
function onIdle(me, enemy, game) {
  if (!me) return;
  var my = botPos(me);
  if (!my) return;
  var cur = botDir(me);

  if (enemy) {
    var ep = botPos(enemy);
    if (ep) {
      var want = botDirToward(my, ep);
      if (want === cur) {
        if (!me.cooldown) me.fire();
      } else {
        botTurnToward(me, cur, want);
      }
      return;
    }
  }

  var star = game && game.star;
  if (star && star.length >= 2 && typeof star[0] === 'number' && typeof star[1] === 'number') {
    var w2 = botDirToward(my, star);
    if (w2 === cur) me.go();
    else botTurnToward(me, cur, w2);
  }
}
`;

const CRIMSON_BASTION_CODE = `${RUNTIME_HELPERS}
var bastionHome = null;
// crimson-bastion：堡垒防守型——守在出生区域，敌人接近（曼哈顿距离<=6）就对齐开火。
function onIdle(me, enemy, game) {
  if (!me) return;
  var my = botPos(me);
  if (!my) return;
  if (bastionHome === null) bastionHome = [my[0], my[1]];
  var cur = botDir(me);

  if (enemy) {
    var ep = botPos(enemy);
    if (ep && Math.abs(ep[0] - my[0]) + Math.abs(ep[1] - my[1]) <= 6) {
      var want = botDirToward(my, ep);
      if (want === cur) {
        if (!me.cooldown) me.fire();
      } else {
        botTurnToward(me, cur, want);
      }
      return;
    }
  }

  var distHome = Math.abs(my[0] - bastionHome[0]) + Math.abs(my[1] - bastionHome[1]);
  if (distHome > 2) {
    var w2 = botDirToward(my, bastionHome);
    if (w2 === cur) me.go();
    else botTurnToward(me, cur, w2);
    return;
  }

  // 原地小幅游走：偶尔前进一格
  var f = 0;
  if (game) {
    if (typeof game.frames === 'number') f = game.frames;
    else if (typeof game.tick === 'number') f = game.tick;
  }
  if (f % 12 === 0) me.go();
}
`;

/**
 * standard-01：官方标准基准坦克。
 *
 * 定位（用户需求）：任何人都能拿它测试的"标准默认坦克"——
 * 不是一个讨巧的对手，而是一条有公开胜负预期的基线：
 *   - 它写法直白、无技巧、无随机，行为可预测，适合当对照组；
 *   - 策略的胜负应该按"对它的净胜率"来读：打不过它=还没入门，
 *     稳定赢它=及格，能不能拉开分差=进阶。
 *
 * 行为（按优先级）：
 *   1. 有敌人火力线（同行/同列且朝向可打）→ 开火；
 *   2. 敌人出现在同行/同列 → 转向对齐（下一步进入 1）；
 *   3. 否则朝星星走（先对齐再前进）——满 HP 抢星即可赢下多数消耗战。
 * 没有任何躲弹、卡位、绕后逻辑——那是"超越基线"的部分，留给玩家。
 */
const STANDARD_01_CODE = `${RUNTIME_HELPERS}
// standard-01：官方标准基准坦克——直白、可预测、可作对照。
// 打不过它说明策略还有基本问题；稳定赢它才算及格。
function onIdle(me, enemy, game) {
  if (!me) return;
  var my = botPos(me);
  if (!my) return;
  var cur = botDir(me);

  // 1) 敌人在火力线上（同行或同列）且我朝向正确 → 开火
  if (enemy) {
    var ep = botPos(enemy);
    if (ep) {
      var alignedX = ep[0] === my[0];
      var alignedY = ep[1] === my[1];
      if (alignedX || alignedY) {
        var want = botDirToward(my, ep);
        if (want === cur) {
          if (!me.cooldown) me.fire();
        } else {
          botTurnToward(me, cur, want);
        }
        return;
      }
    }
  }

  // 2) 没有可打的敌人 → 朝星星机动
  var star = game && game.star;
  if (star && star.length >= 2 && typeof star[0] === 'number' && typeof star[1] === 'number') {
    var w2 = botDirToward(my, star);
    if (w2 === cur) me.go();
    else botTurnToward(me, cur, w2);
  }
}
`;

export const tankBots: TankBot[] = [
  {
    id: 'standard-01',
    name: 'Standard-01（官方基准）',
    description:
      '官方标准基准坦克：火力线上就开火，否则直奔星星。行为直白可预测，用作所有策略的对照组——打不过它说明策略有基本问题，稳定赢它才算及格。',
    code: STANDARD_01_CODE,
  },
  {
    id: 'nova-scout',
    name: 'Nova Scout（侦察机动型）',
    description:
      '找不到敌人时朝星星机动（先转向对齐再前进），看到敌人就转向敌人方向并在对齐后开火。',
    code: NOVA_SCOUT_CODE,
  },
  {
    id: 'crimson-bastion',
    name: 'Crimson Bastion（堡垒防守型）',
    description:
      '大致守在出生区域小幅游走；敌人接近（曼哈顿距离≤6）时转向敌人并对齐后开火。',
    code: CRIMSON_BASTION_CODE,
  },
];
