/** 黑白棋包自带的外部 AI 说明（ADR 0001 / 0019）；HTTP 路由只负责传入访问 origin。 */
export function reversiAiGuide(origin: string): string {
  return `黑白棋 Reversi v1 — 外部 AI 座位指南（ADR 0019）

范围：仅支持表演赛，不开放参赛对象、策略发布、训练、正式对局或排行榜。

规则与坐标
- 标准 8×8 棋盘，中央四子，黑先手。board[y][x]，0=黑、1=白、null=空。
- 坐标 [x,y] 为 0 基整数，范围 0..7；左上角 [0,0]，x 向右、y 向下。
- 初始白子 [3,3]、[4,4]，黑子 [4,3]、[3,4]；黑方合法首手 [3,2]、[2,3]、[5,4]、[4,5]。
- 只能落在空格，且必须在水平、垂直、斜线共八个方向中的至少一个方向，以新子和已有己方子夹住连续的对方棋子（中间不可有空格）。所有满足条件的方向都必须翻转。
- 无合法落点时自动跳过，不提交 pass，不等待被跳过方，也不启动被跳过方的计时。对手仍有合法落点时可同一方连续行动；每次开始新的完整每步计时。不要按手数奇偶推断行动方。
- 双方都无合法落点即终局，即使棋盘未满也不再请求行动。按现有黑白子数判胜负，同数平局，空位不额外计分。
- moveCount 只计成功落子；初始摆子、翻转、自动跳过和非法尝试均不计入。

观察协议
GET ${origin}/api/seat/observe，HTTP 头 Authorization: Bearer <座位密钥>（不是用户会话或 API 令牌）。
响应含 gameId、side（0 黑/1 白）、status、moveCount。
your-turn 时含 remainingMs 和 observation：
  board: (0|1|null)[][] — 完整棋盘，board[y][x]
  me.side: 0|1 — 当前座位颜色
  currentSide: 0|1 — 真实行动方
  legalMoves: [number,number][] — 当前行动方的全部合法落点；服务端仍独立校验提交
  counts: [number,number] — [黑子数,白子数]
  lastMove: [number,number]|null — 最近成功落子，开局为 null
  lastFlipped: [number,number][] — 最近成功落子翻转的全部坐标，开局为空
  passedSide: 0|1|null — 最近成功落子后被跳过的一方，无跳过为 null；非法重试保留
  moveCount: number — 成功落子数，开局为 0
waiting：等待对手；paused：暂停，稍后轮询；finished：结束，停止提交。
结束后有效密钥仍可 observe 到 finished（作废时附 hint），不保证提供 observation 棋盘；回放从对局帧流读取。

行动与错误
POST ${origin}/api/seat/act，使用同一 Authorization 头与 Content-Type: application/json。
黑方首手完整请求体示例（仅 your-turn 时提交）：
\`\`\`json
{"action":{"place":[3,2]}}
\`\`\`
成功返回 {"ok":true}；随后重新 observe，不假设轮到对手。
非法行动 HTTP 400 + {error:具体原因}；每方整局累计 3 次非法行动判负，合法落子不清零，双方分别计数。未达上限原方可重试，每次重试重新获得完整每步时限。
HTTP 409 表示未轮到、暂停或对局已结束；重新 observe，finished 后不再行动。HTTP 401 仅表示座位密钥无效或缺失。
每步时限由创建者设置，超时判负；暂停冻结计时，恢复继续剩余时限。创建后 1 小时无人成功落子自动作废。
POST ${origin}/api/seat/set-name 请求体 {"name":"你的 AI 名称"}，仅该方首手前可设置。
GET ${origin}/api/matches/:matchId 查询结果；GET ${origin}/api/matches/:matchId/frames 为 SSE 直播/回放帧流。
将 :matchId 替换为 encodeURIComponent(matchId)，不要直接拼接未经 URL 编码的标识符。座位密钥仅放在 Authorization 头中。
`;
}
