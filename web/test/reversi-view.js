/** 黑白棋页面回归：固定协议帧覆盖无帧开局、同方连续落子和四主题布局；不使用真实凭据。 */
async page => {
  const base = await page.evaluate(() => location.origin);
  const results = [];
  const check = (name, pass) => { results.push({ name, pass }); if (!pass) throw new Error(name); };
  const match = { matchId: 'reversi-fixture', gameId: 'reversi', kind: 'exhibition', phase: 'running', createdAt: 1, result: null, entrants: [{ entrantId: 's0', name: null }, { entrantId: 's1', name: null }] };
  await page.route('**/api/**', async route => {
    const path = route.request().url().split('/api/')[1].split('?')[0];
    if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: ': waiting\n\n' });
    if (path === 'users/me') return route.fulfill({ status: 401, json: { error: '未登录' } });
    if (path === 'matches/reversi-fixture') return route.fulfill({ json: match });
    if (path.endsWith('/frames')) return route.fulfill({ json: { frames: [], result: null } });
    return route.fulfill({ json: { games: [], exhibitions: [] } });
  });
  try {
    await page.goto(base + '/#/match/reversi-fixture');
    await page.waitForTimeout(500);
    check('黑白棋使用专用棋盘而非原始 JSON', await page.getByRole('img', { name: /黑白棋棋盘/ }).count() === 1);
    check('首帧前显示双方各两子', (await page.locator('.board-player-sub').allTextContents()).every(text => text.includes('2 子')));
    // 通过真实 UI 模块的公开记谱边界检查，不依赖私有组件状态；局面来自协议夹具。
    const record = await page.evaluate(async () => {
      const { deriveMoves, emptyState } = await import('/src/pages/board-match/model.tsx');
      const first = emptyState('reversi');
      first.board[2][3] = 0; first.board[3][3] = 0;
      Object.assign(first, { moveCount: 1, lastMove: [3, 2], lastFlipped: [[3, 3]], counts: [4, 1], passedSide: 1, currentSide: 0 });
      const second = structuredClone(first);
      Object.assign(second, { moveCount: 2, lastMove: [5, 4], lastFlipped: [[4, 4]], counts: [6, 0], passedSide: null, currentSide: 1 });
      second.board[4][5] = 0; second.board[4][4] = 0;
      return deriveMoves('reversi', [first, structuredClone(first), second]);
    });
    check('同方两次落子保留顺序且重复帧不重复记谱', record.length === 2 && record[0].side === 0 && record[1].side === 0 && record[1].no === 2);
    for (const theme of ['light', 'dark', 'paper', 'forest']) {
      await page.getByLabel('切换主题').selectOption(theme);
      for (const width of [375, 900, 901]) {
        await page.setViewportSize({ width, height: 900 });
        check(`棋盘无整页溢出 ${theme}/${width}`, await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth));
      }
    }
    return { passed: results.length, results };
  } finally { await page.unroute('**/api/**'); }
}
