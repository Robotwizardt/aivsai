/** 浏览器网络故障回归：棋类摘要与暂停元数据独立刷新，不使用真实账号。 */
async page => {
  const base = await page.evaluate(() => location.origin);
  const checks = [];
  for (const blocked of ['exhibition', 'summary']) {
    const tab = await page.context().newPage();
    let release;
    const pending = new Promise(resolve => { release = resolve; });
    let summaryCalls = 0;
    const match = { matchId: 'poll-fixture', gameId: 'reversi', kind: 'exhibition', phase: 'running', createdAt: 1, result: null,
      entrants: [{ entrantId: 's0', name: '原黑方' }, { entrantId: 's1', name: '原白方' }] };
    await tab.route('**/api/**', async route => {
      const path = route.request().url().split('/api/')[1].split('?')[0];
      if (path === 'matches/poll-fixture') {
        summaryCalls++;
        if (summaryCalls > 1 && blocked === 'summary') await pending;
        return route.fulfill({ json: summaryCalls > 1 ? { ...match, entrants: [{ entrantId: 's0', name: '更新黑方' }, match.entrants[1]] } : match }).catch(() => {});
      }
      if (path === 'exhibitions/poll-fixture') {
        if (blocked === 'exhibition') await pending;
        return route.fulfill({ json: { paused: true } }).catch(() => {});
      }
      if (path.endsWith('/stream')) return route.fulfill({ contentType: 'text/event-stream', body: ': waiting\n\n' });
      if (path.endsWith('/frames')) return route.fulfill({ json: { frames: [], result: null } });
      return route.fulfill({ json: { games: [], exhibitions: [] } });
    });
    try {
      await tab.goto(base + '/#/match/poll-fixture');
      await tab.getByRole('img', { name: /黑白棋棋盘/ }).waitFor();
      const passed = await tab.waitForFunction(blocked => blocked === 'exhibition'
        ? document.querySelector('.board-match')?.textContent?.includes('更新黑方')
        : document.querySelector('.board-status')?.textContent?.includes('暂停'), blocked, { timeout: 2500 }).then(() => true, () => false);
      checks.push({ name: blocked === 'exhibition' ? '元数据挂起不阻塞摘要' : '摘要挂起不阻塞暂停状态', passed });
    } finally {
      release();
      await tab.close();
    }
  }
  if (checks.some(c => !c.passed)) throw new Error(JSON.stringify(checks));
  return { passed: true, checks };
}
