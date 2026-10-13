/** 真实浏览器生命周期验收：仅对独立临时数据库运行，不输出凭据。
 * 先配置 window.__REVERSI_INVITE；用例注册一次账号并创建临时对局。
 * __REVERSI_AUDIT_REPORT_ONLY=true 时收集全部问题，否则最后遇到失败抛错。
 */
async page => {
  const base = await page.evaluate(() => location.origin);
  const checks = [];
  const check = (name, passed, detail = '') => checks.push({ name, passed: Boolean(passed), detail });
  const spectatorContext = await page.context().browser().newContext();
  const spectator = await spectatorContext.newPage();
  const errors = [];
  const onError = e => errors.push(e.message);
  page.on('pageerror', onError);
  spectator.on('pageerror', onError);
  const reportOnly = await page.evaluate(() => Boolean(window.__REVERSI_AUDIT_REPORT_ONLY));
  const api = (path, key, body) => page.evaluate(async ({ path, key, body }) => {
    const response = await fetch(path, { method: body === undefined ? 'GET' : 'POST',
      headers: { ...(key ? { authorization: `Bearer ${key}` } : {}), ...(body === undefined ? {} : { 'content-type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) });
    return { status: response.status, body: await response.json() };
  }, { path, key, body });
  try {
    await page.evaluate(async () => {
      const inviteCode = window.__REVERSI_INVITE;
      delete window.__REVERSI_INVITE;
      const username = `audit_${Date.now()}`, password = crypto.randomUUID();
      const register = await fetch('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password, inviteCode }) });
      if (register.status !== 201) throw new Error(`注册失败 ${register.status}`);
      const login = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
      if (!login.ok) throw new Error(`登录失败 ${login.status}`);
      const result = await login.json();
      if (typeof result.token !== 'string') throw new Error('登录响应缺少 token');
      localStorage.setItem('aivsai.token', result.token);
    });
    const token = await page.evaluate(() => localStorage.getItem('aivsai.token'));
    await page.goto(base + '/#/live');
    await page.reload();
    await page.getByLabel(/^游戏/).selectOption('reversi');
    await page.getByPlaceholder('如：Kimi vs 豆包').fill('黑白棋生命周期验收');
    const responsePromise = page.waitForResponse(r => r.url().endsWith('/api/exhibitions') && r.request().method() === 'POST');
    await page.getByRole('button', { name: '创建对局，生成座位链接' }).click();
    const created = await (await responsePromise).json();
    await page.getByRole('heading', { name: '表演赛已创建' }).waitFor();
    const keys = created.seatLinks.sort((a, b) => a.side - b.side).map(s => s.key);
    await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
    for (const side of [0, 1]) {
      await page.getByRole('button', { name: '复制链接', exact: true }).nth(side).click();
      const copied = await page.evaluate(() => navigator.clipboard.readText());
      check(`座位 ${side} 复制完整可访问链接`, copied === `${base}/#/seat/${encodeURIComponent(keys[side])}`);
    }
    await page.getByRole('button', { name: '复制', exact: true }).click();
    const shared = await page.evaluate(() => navigator.clipboard.readText());
    check('观战复制链接可直接分享', shared === `${base}/#/match/${created.matchId}`, shared.startsWith('#') ? '仅复制了 fragment，离开本站无法打开' : '');
    await spectator.goto(base + '/#/match/' + created.matchId);
    await spectator.getByRole('img', { name: /黑白棋棋盘/ }).waitFor();
    check('游客可观看开局', (await spectator.locator('.board-player-sub').allTextContents()).every(s => s.includes('2 子')));
    for (const side of [0, 1]) {
      const named = await api('/api/seat/set-name', keys[side], { name: side ? '白方测试 AI' : '黑方测试 AI' });
      check(`座位 ${side} 首手前命名`, named.status === 200);
    }
    check('非轮次提交被拒绝', (await api('/api/seat/act', keys[1], { action: { place: [3, 2] } })).status === 409);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    await page.getByRole('button', { name: '恢复', exact: true }).waitFor();
    check('暂停后座位不可提交', (await api('/api/seat/act', keys[0], { action: { place: [3, 2] } })).status === 409);
    check('暂停后座位状态正确', (await api('/api/seat/observe', keys[0])).body.status === 'paused');
    await spectator.waitForFunction(() => document.querySelector('.board-status')?.textContent?.includes('暂停'), null, { timeout: 8000 }).catch(() => {});
    const pausedStatus = await spectator.locator('.board-status').innerText();
    check('游客直播同步显示暂停', pausedStatus.includes('暂停'), `实际显示：${pausedStatus}`);
    check('暂停不提示轮到落子', await spectator.locator('.board-turn').count() === 0);
    await page.getByRole('button', { name: '恢复', exact: true }).click();
    await page.getByRole('button', { name: '暂停', exact: true }).waitFor();
    check('恢复后座位轮次正确', (await api('/api/seat/observe', keys[0])).body.status === 'your-turn');
    await spectator.waitForFunction(() => document.querySelector('.board-status')?.textContent?.includes('直播中'), null, { timeout: 8000 }).catch(() => {});
    check('游客同步恢复直播与轮次提示', (await spectator.locator('.board-status').innerText()).includes('直播中') && await spectator.locator('.board-turn').count() === 1);
    await api('/api/seat/act', keys[0], { action: { place: [3, 2] } });
    await spectator.waitForFunction(() => document.querySelector('.board-card-title')?.textContent?.includes('1 手'));
    check('真实 SSE 首手子数', (await spectator.locator('.board-player-sub').allTextContents()).some(s => s.includes('4 子')));
    check('首手后禁止重新命名', (await api('/api/seat/set-name', keys[0], { name: '不应接受' })).status === 409);
    await spectator.getByRole('button', { name: '开局', exact: true }).click();
    const next = (await api('/api/seat/observe', keys[1])).body.observation.legalMoves[0];
    await api('/api/seat/act', keys[1], { action: { place: next } });
    await spectator.waitForFunction(() => Number(document.querySelector('.replay-scrubber')?.getAttribute('max')) >= 2);
    check('直播回看不被新帧打断', (await spectator.locator('.board-player-sub').allTextContents()).every(s => s.includes('2 子')));
    await spectator.getByRole('button', { name: '最新局面', exact: true }).click();
    check('返回最新局面恢复跟随', (await spectator.locator('.board-card-title').innerText()).includes('2 手'));
    await spectator.reload();
    await spectator.waitForFunction(() => document.querySelector('.board-card-title')?.textContent?.includes('2 手'));
    check('刷新后棋谱不丢失不重复', await spectator.locator('.board-round').count() === 2);
    await page.getByRole('button', { name: '解散', exact: true }).click();
    await spectator.waitForFunction(() => document.querySelector('.board-status')?.textContent?.includes('结束'), null, { timeout: 8000 }).catch(() => {});
    check('解散后游客收到终局', (await spectator.locator('.board-status').innerText()).includes('结束'));
    check('作废座位仍可观察结束', (await api('/api/seat/observe', keys[0])).body.status === 'finished');
    check('结束后行动被拒绝', (await api('/api/seat/act', keys[0], { action: { place: [0, 0] } })).status === 409);
    const privateMatch = (await api('/api/exhibitions', token, { gameId: 'reversi', isPublic: false })).body;
    const listed = await api('/api/exhibitions');
    check('私密对局不进入公开大厅', !listed.body.exhibitions.some(e => e.matchId === privateMatch.matchId));
    await spectator.goto(base + '/#/match/' + privateMatch.matchId);
    await spectator.getByRole('img', { name: /黑白棋棋盘/ }).waitFor();
    check('私密对局凭链接可观战', await spectator.locator('.board-status').count() === 1);
    for (let n = 0; n < 3; n++) check(`特殊错误消息第 ${n + 1} 次返回 400`, (await api('/api/seat/act', privateMatch.seatLinks.find(s => s.side === 0).key, { action: { kind: 'error', message: { toString: null } } })).status === 400);
    await spectator.waitForFunction(() => document.querySelector('.board-win-badge') != null, null, { timeout: 8000 }).catch(() => {});
    check('累计三错后游客显示判负', (await spectator.locator('.board-status').innerText()).includes('结束') && (await spectator.locator('.board-win-badge').count()) === 1);
    check('没有浏览器未捕获异常', errors.length === 0, errors.join(';'));
    const failures = checks.filter(c => !c.passed);
    if (failures.length && !reportOnly) throw new Error(JSON.stringify(failures));
    return { passed: !failures.length, count: checks.length, failures };
  } finally {
    await spectatorContext.close();
    page.removeListener('pageerror', onError);
    await page.evaluate(() => localStorage.removeItem('aivsai.token'));
  }
}
