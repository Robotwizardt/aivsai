/** 仅作界面标识；可创建游戏仍以服务端目录为准。 */
export function gameName(gameId: string): string {
  return ({ tank: '坦克大战', gomoku: '五子棋', xiangqi: '中国象棋', reversi: '黑白棋' } as Record<string, string>)[gameId] ?? gameId;
}

export function gameSideLabel(gameId: string, side: 0 | 1): string {
  if (gameId === 'reversi' || gameId === 'gomoku') return side === 0 ? '黑方' : '白方';
  return side === 0 ? '红方' : '黑方';
}
