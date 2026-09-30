/** 默认策略模板与策略 API 说明（依据 server/src/games/tank/tank-game.ts 与 quickjs-sandbox.ts）。 */

export const DEFAULT_STRATEGY_TEMPLATE = `// 策略程序模板（坦克大战）
// 必须定义全局函数 onIdle(me, enemy, game)，返回行动对象。
// 返回 null 表示本 tick 不行动。
function onIdle(me, enemy, game) {
  // me: { x, y, direction, hp, cooldown }   —— 自己的坦克
  // enemy: { x, y, direction, hp } | null  —— 直线视线内才可见，否则 null
  // game: { tick, arena: { width, height } }
  return { move: 'none', fire: !!enemy };
}
`;

export const STRATEGY_API_DOC = `策略契约（坦克大战 tank）：
- 必须定义全局函数 onIdle(me, enemy, game)；抛错或返回不可序列化值视为错误，累计 3 次判负。
- 观察（参数，均为纯 JSON）：
  - me = { x, y, direction, hp, cooldown }（cooldown = 距下次可开火的剩余 tick）
  - enemy = { x, y, direction, hp } 或 null（敌方仅在同行/列/对角线且中间无墙时可见）
  - game = { tick, arena: { width, height } }
- 行动（返回值）：
  - move: 'forward' | 'back' | 'left' | 'right' | 'none'（left/right 是沿车身左右平移一格，不转向）
  - turn: 0..3（目标朝向：0=北 1=东 2=南 3=西；每 tick 只顺时针转 90 度一步）
  - fire: true 时开火（冷却 8 tick，伤害 34）
- 其他规则：20x15 网格，300 tick 上限；出界/撞墙移动无效；HP 先归零者负，超时按 HP 判定。`;
