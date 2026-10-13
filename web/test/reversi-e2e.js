/** 真实 HTTP + 浏览器端到端验收。仅允许对专用临时数据库运行；邀请码通过页面全局配置传入。
 * 在已打开的专用 web 会话中设置 window.__REVERSI_INVITE，再执行本文件。
 * 创建临时账号与一场完整表演赛，不打印密码、session 或座位密钥。
 */
async page => {
  const base = await page.evaluate(() => location.origin);
  const errors = [];
  const onError = error => errors.push(error.message);
  page.on('pageerror', onError);
  const check = (ok, message) => { if (!ok) throw new Error(message); };
  let created;
  try {
    await page.evaluate(async () => {
      const inviteCode = window.__REVERSI_INVITE;
      if (!inviteCode) throw new Error('请配置专用测试邀请码');
      delete window.__REVERSI_INVITE;
      const username = `reversi_${Date.now()}`;
      const password = crypto.randomUUID();
      const register = await fetch('/api/auth/register', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password, inviteCode }) });
      if (register.status !== 201) throw new Error(`测试账号注册失败 ${register.status}`);
      const login = await fetch('/api/auth/login', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ username, password }) });
      if (!login.ok) throw new Error('测试账号登录失败');
      localStorage.setItem('aivsai.token', (await login.json()).token);
    });
    await page.goto(base + '/#/live');
    await page.reload();
    await page.getByLabel(/^游戏/).selectOption('reversi');
    await page.getByPlaceholder('如：Kimi vs 豆包').fill('黑白棋端到端回归');
    const creation = page.waitForResponse(response => response.url().endsWith('/api/exhibitions') && response.request().method() === 'POST');
    await page.getByRole('button', { name: '创建对局，生成座位链接' }).click();
    const response = await creation;
    check(response.status() === 201, '表演赛创建失败');
    created = await response.json();
    await page.getByRole('heading', { name: '表演赛已创建' }).waitFor();
    check((await page.locator('.seat-link-row .tag').allTextContents()).join('|') === '黑方座位|白方座位', '创建后的座位颜色不正确');
    const keys = created.seatLinks.sort((a, b) => a.side - b.side).map(link => link.key);
    await page.goto(base + '/#/seat/' + keys[0]);
    await page.getByRole('img', { name: /黑白棋棋盘/ }).waitFor();
    check(await page.locator('main .tag').first().innerText() === '黑方（先手）', '座位先手身份错误');
    await page.goto(base + '/#/match/' + created.matchId);
    await page.getByRole('img', { name: /黑白棋棋盘/ }).waitFor();
    const duel = await page.evaluate(async ({ keys, matchId }) => {
      const call = async (path, key, body) => {
        const res = await fetch(path, { method: body ? 'POST' : 'GET', headers: { authorization: `Bearer ${key}`, ...(body ? { 'content-type': 'application/json' } : {}) }, ...(body ? { body: JSON.stringify(body) } : {}) });
        if (!res.ok) throw new Error(`座位接口异常 ${res.status}`);
        return res.json();
      };
      // 独立规则 oracle：通过真实 API 返回的局面验证合法点及每步夹翻，不调用生产规则函数。
      const board = Array.from({ length: 8 }, () => Array(8).fill(null));
      board[3][3] = board[4][4] = 1; board[3][4] = board[4][3] = 0;
      const flips = (side, x, y) => {
        if (board[y][x] !== null) return [];
        const result = [];
        for (let dx = -1; dx <= 1; dx++) for (let dy = -1; dy <= 1; dy++) {
          if (!dx && !dy) continue;
          const line = [];
          let nx = x + dx, ny = y + dy;
          while (nx >= 0 && nx < 8 && ny >= 0 && ny < 8 && board[ny][nx] === 1 - side) { line.push([nx, ny]); nx += dx; ny += dy; }
          if (line.length && nx >= 0 && nx < 8 && ny >= 0 && ny < 8 && board[ny][nx] === side) result.push(...line);
        }
        return result;
      };
      const legal = side => {
        const result = [];
        for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) if (flips(side, x, y).length) result.push([x, y]);
        return result;
      };
      let side = 0, count = 0, skips = 0;
      while (count < 60) {
        const moves = legal(side);
        if (!moves.length) throw new Error('oracle 轮次错误');
        const observe = await call('/api/seat/observe', keys[side]);
        if (observe.status !== 'your-turn' || observe.moveCount !== count) throw new Error('行动方或真实手数错误');
        const obs = observe.observation;
        if (JSON.stringify(obs.board) !== JSON.stringify(board)) throw new Error('棋盘与独立规则不一致');
        const sorted = values => values.map(v => v.join(',')).sort().join('|');
        if (sorted(obs.legalMoves) !== sorted(moves)) throw new Error('合法落点与独立规则不一致');
        const [x, y] = moves[0];
        for (const [fx, fy] of flips(side, x, y)) board[fy][fx] = side;
        board[y][x] = side;
        await call('/api/seat/act', keys[side], { action: { place: [x, y] } });
        count++;
        if (legal(1 - side).length) side = 1 - side;
        else if (legal(side).length) skips++;
        else break;
      }
      for (const key of keys) {
        const end = await call('/api/seat/observe', key);
        if (end.status !== 'finished' || end.moveCount !== count) throw new Error('终局座位观察错误');
      }
      const summary = await (await fetch(`/api/matches/${matchId}`)).json();
      const counts = [0, 1].map(s => board.flat().filter(c => c === s).length);
      const outcome = summary.result.outcome;
      if (counts[0] === counts[1] ? outcome.kind !== 'draw' : outcome.kind !== 'win' || outcome.winner !== (counts[0] > counts[1] ? 0 : 1)) throw new Error('终局胜负与独立计数不一致');
      return { count, skips, counts, phase: summary.phase };
    }, { keys, matchId: created.matchId });
    check(duel.skips > 0, '未覆盖自动跳过，需要更换走法序列');
    await page.waitForTimeout(500);
    check(await page.locator('.board-status').innerText() === '已结束', '直播未收到终局');
    check(await page.locator('.board-moves').innerText().then(text => text.includes('跳过')), '直播棋谱缺少跳过');
    await page.reload();
    await page.getByRole('img', { name: /黑白棋棋盘/ }).waitFor();
    await page.waitForTimeout(500);
    check(await page.locator('.board-moves').innerText().then(text => text.includes('跳过')), '重新打开后的回放丢失跳过');
    await page.getByRole('button', { name: '开局', exact: true }).click();
    check((await page.locator('.board-player-sub').allTextContents()).every(text => text.includes('2 子')), '回放开局子数错误');
    check(await page.locator('.board-moves').innerText().then(text => text.includes('尚无落子记录')), '回放开局不应显示未来棋谱');
    await page.getByRole('button', { name: '下一帧', exact: true }).click();
    check((await page.locator('.board-player-sub').allTextContents()).some(text => text.includes('4 子')), '逐帧回放未还原首手翻转');
    await page.getByRole('button', { name: '播放', exact: true }).click();
    await page.waitForTimeout(1200);
    await page.getByRole('button', { name: '暂停', exact: true }).click();
    check(Number(await page.getByRole('slider', { name: '回放进度' }).inputValue()) >= 2, '自动播放未前进');
    await page.getByRole('button', { name: '终局', exact: true }).click();
    check((await page.locator('.board-player-sub').allTextContents()).every(text => duel.counts.some(count => text.includes(`${count} 子`))), '回放终局子数错误');
    // 在有完整棋谱和回放控件的真实终局检查布局，而不只检查无帧占位。
    for (const theme of ['light', 'dark', 'paper', 'forest']) {
      await page.getByLabel('切换主题').selectOption(theme);
      for (const width of [375, 900, 901]) {
        await page.setViewportSize({ width, height: 900 });
        check(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth), `终局整页横向溢出 ${theme}/${width}`);
      }
    }
    check(errors.length === 0, `浏览器未捕获异常 ${errors.join('; ')}`);
    return { passed: true, ...duel, matchId: created.matchId };
  } finally {
    page.removeListener('pageerror', onError);
    await page.evaluate(() => localStorage.removeItem('aivsai.token'));
  }
}
