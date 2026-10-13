/** 浏览器回归：真实页面 + 固定 API 数据，不连接业务数据库、不使用真实密钥。
 * 先启动 web，然后执行：playwright-cli -s=regression run-code --filename=web/test/browser-regressions.js
 * 浏览器须已打开本地 web 地址；运行说明见同目录 README.md。
 */
async page => {
  const base = await page.evaluate(() => location.origin);
  const failures = [];
  const results = [];
  const check = (name, ok, detail) => {
    results.push({ name, pass: ok, detail });
    if (!ok) failures.push(name);
  };
  const entrants = ['A', 'B'].map(name => ({
    id: name, name: `回归坦克${name}`, gameId: 'tank', createdAt: 1,
    appearance: { name, preset: 'classic', color: '#2563eb' },
  }));
  await page.route('**/api/**', async route => {
    const path = route.request().url().split('/api/')[1].split('?')[0];
    const apiPath = '/api/' + path;
    let json = {};
    let status = 200;
    if (apiPath === '/api/entrants') json = { entrants };
    else if (apiPath === '/api/games') json = { games: [{ id: 'tank', name: '坦克', pacing: 'instant' }] };
    else if (apiPath === '/api/users/me') json = { userId: 'fixture', username: 'fixture', role: 'user', nickname: null };
    else if (path.endsWith('/strategies')) json = { versions: [] };
    else if (apiPath === '/api/seat/observe') {
      const key = route.request().headers().authorization;
      if (key === 'Bearer fixture-invalid') { status = 401; json = { error: '座位密钥无效' }; }
      else json = { status: 'finished', gameId: key.endsWith('xiangqi') ? 'xiangqi' : 'gomoku', side: key.endsWith('white') ? 1 : 0, moveCount: 9 };
    }
    await route.fulfill({ status, json });
  });
  try {
    await page.setViewportSize({ width: 1440, height: 1000 });
    await page.evaluate(() => localStorage.setItem('aivsai.token', 'fixture-session'));
    await page.goto(base + '/#/workspace');
    await page.getByRole('button', { name: /回归坦克A/ }).click();
    await page.getByRole('tab', { name: '策略', exact: true }).click();
    await page.locator('textarea').fill('// 只属于 A 的草稿');
    await page.getByRole('button', { name: /回归坦克B/ }).click();
    await page.getByRole('heading', { name: '回归坦克B', exact: true }).waitFor();
    await page.getByRole('tab', { name: '策略', exact: true }).click();
    const draft = await page.locator('textarea').inputValue();
    check('切换对象不携带其他对象草稿', draft === '', { editor: draft });

    await page.goto(base + '/#/seat/fixture-black');
    await page.getByRole('heading', { name: '你的座位' }).waitFor();
    const black = await page.locator('main .tag').innerText();
    check('五子棋先手为黑方', black === '黑方（先手）', black);
    await page.evaluate(() => { location.hash = '#/seat/fixture-invalid'; });
    await page.locator('.message.error').waitFor();
    check('无效座位不保留旧身份', await page.getByRole('heading', { name: '你的座位' }).count() === 0);
    await page.goto(base + '/#/seat/fixture-white');
    await page.getByRole('heading', { name: '你的座位' }).waitFor();
    const white = await page.locator('main .tag').innerText();
    check('五子棋后手为白方', white === '白方（后手）', white);
    await page.goto(base + '/#/seat/fixture-xiangqi');
    await page.getByRole('heading', { name: '你的座位' }).waitFor();
    check('象棋先手仍为红方', await page.locator('main .tag').innerText() === '红方（先手）');

    await page.goto(base + '/#/agent-guide');
    for (const theme of ['light', 'dark', 'paper', 'forest']) {
      await page.getByLabel('切换主题').selectOption(theme);
      for (const width of [375, 900, 901]) {
        await page.setViewportSize({ width, height: 812 });
        const sizes = await page.evaluate(() => ({ width: innerWidth, scroll: document.documentElement.scrollWidth }));
        check(`指南无整页溢出 ${theme}/${width}`, sizes.scroll <= sizes.width, sizes);
      }
    }
    console.log(JSON.stringify(results));
    if (failures.length) throw new Error(`回归失败 ${failures.length} 项：${failures.join('；')}`);
    return { passed: results.length };
  } finally {
    await page.unroute('**/api/**');
    await page.evaluate(() => localStorage.removeItem('aivsai.token'));
  }
}
