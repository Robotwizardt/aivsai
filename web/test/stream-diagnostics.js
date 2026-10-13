/** 终局诊断回归：固定 SSE 与摘要，测试真实客户端 API，不使用真实凭据。 */
async page => {
  const base = await page.evaluate(() => location.origin);
  await page.goto(base + '/');
  let mode = 'authorized';
  const requests = [];
  await page.route('**/api/matches/fixture-stream**', async route => {
    const req = route.request();
    requests.push({ url: req.url(), auth: req.headers().authorization });
    if (req.url().includes('/frames')) {
      await route.fulfill({ contentType: 'text/event-stream', body: 'event: end\ndata: {"outcome":{"kind":"draw","reason":"fixture"}}\n\n' });
    } else if (mode === 'slow') {
      await page.waitForTimeout(2300);
      await route.fulfill({ json: { result: null } }).catch(() => {});
    } else if (mode === 'failed') await route.fulfill({ status: 503, json: { error: 'fixture unavailable' } });
    else await route.fulfill({ json: { result: { outcome: { kind: 'draw', reason: 'fixture' }, ...(mode === 'authorized' ? { failures: [{ entrant: 0, message: 'fixture diagnostic' }] } : {}) } } });
  });
  try {
    for (const scenario of ['authorized', 'unrelated', 'guest', 'failed', 'slow']) {
      mode = scenario;
      const result = await page.evaluate(async scenario => {
        if (scenario === 'guest') localStorage.removeItem('aivsai.token');
        else localStorage.setItem('aivsai.token', 'fixture-session');
        const api = await import('/src/api.ts');
        return await new Promise((resolve, reject) => {
          const timeout = setTimeout(() => { handle.close(); reject(new Error('未收到终局')); }, 3000);
          const handle = api.openFramesStream('fixture-stream', 'official', () => {}, result => {
            clearTimeout(timeout); handle.close(); resolve(result);
          });
        });
      }, scenario);
      if (Boolean(result?.failures?.length) !== (scenario === 'authorized')) throw new Error('诊断授权或降级失败：' + scenario);
      if (result?.outcome?.reason !== 'fixture') throw new Error('公共终局丢失：' + scenario);
    }
    if (requests.some(r => r.url.includes('fixture-session'))) throw new Error('凭据进入 URL');
    if (!requests.some(r => !r.url.includes('/frames') && r.auth === 'Bearer fixture-session')) throw new Error('摘要未使用 Authorization');
    mode = 'slow';
    const callbacks = await page.evaluate(async () => {
      const api = await import('/src/api.ts');
      let calls = 0;
      const handle = api.openFramesStream('fixture-stream', 'official', () => {}, () => { calls++; });
      await new Promise(resolve => setTimeout(resolve, 150));
      handle.close();
      await new Promise(resolve => setTimeout(resolve, 2400));
      return calls;
    });
    if (callbacks !== 0) throw new Error('关闭后仍触发终局回调');
    return { passed: 8 };
  } finally {
    await page.unroute('**/api/matches/fixture-stream**');
    await page.evaluate(() => localStorage.removeItem('aivsai.token'));
  }
}
