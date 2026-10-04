// 一次性校验脚本：对比 server PRESET_SOURCES 与 web/src/tank-maps.ts 的字符画是否一致，
// 并验证镜像展开逻辑输出一致。可随时删除。
const fs = require('fs');

function extractSources(path) {
  const src = fs.readFileSync(path, 'utf8');
  const start = src.indexOf('const PRESET_SOURCES');
  if (start < 0) throw new Error(`no PRESET_SOURCES in ${path}`);
  const end = src.indexOf('];', src.indexOf('] = [', start));
  const seg = src.slice(start, end);
  const presets = [];
  const blockRe = /id: '([^']+)',\s*\n\s*name: '([^']+)',[\s\S]*?rows: \[([\s\S]*?)\]/g;
  let m;
  while ((m = blockRe.exec(seg)) !== null) {
    const rows = [...m[3].matchAll(/'([xmo.]{10})'/g)].map((r) => r[1]);
    presets.push({ id: m[1], name: m[2], rows });
  }
  return presets;
}

function expand(rows, W) {
  const out = { walls: [], mounds: [], grass: [] };
  rows.forEach((row, y) => {
    for (let x = 0; x < row.length; x++) {
      const ch = row[x];
      if (ch === '.') continue;
      const t = ch === 'x' ? out.walls : ch === 'm' ? out.mounds : out.grass;
      t.push(`${x},${y}`);
      const mx = W - 1 - x;
      if (mx !== x) t.push(`${mx},${y}`);
    }
  });
  return out;
}

const srv = extractSources('server/src/games/tank/tank-game.ts');
const web = extractSources('web/src/tank-maps.ts');
console.log('server:', srv.map((p) => `${p.id}/${p.name}/${p.rows.length}rows`).join('  '));
console.log('web   :', web.map((p) => `${p.id}/${p.name}/${p.rows.length}rows`).join('  '));

let ok = srv.length === 4 && web.length === 4;
for (let i = 0; i < 4; i++) {
  const a = srv[i];
  const b = web[i];
  if (!a || !b || a.id !== b.id || a.name !== b.name || JSON.stringify(a.rows) !== JSON.stringify(b.rows)) {
    ok = false;
    console.log('MISMATCH at index', i, a && a.id);
    continue;
  }
  const ta = expand(a.rows, 20);
  const tb = expand(b.rows, 20);
  if (JSON.stringify(ta) !== JSON.stringify(tb)) {
    ok = false;
    console.log('EXPAND MISMATCH', a.id);
  }
  // sanity: 无重复、无越界、左右镜像对称
  for (const k of ['walls', 'mounds', 'grass']) {
    const set = new Set(tb[k]);
    if (set.size !== tb[k].length) { ok = false; console.log('DUP', b.id, k); }
    for (const c of tb[k]) {
      const [x, y] = c.split(',').map(Number);
      if (x < 0 || x >= 20 || y < 0 || y >= 15) { ok = false; console.log('OOB', b.id, k, c); }
      if (!set.has(`${19 - x},${y}`)) { ok = false; console.log('ASYMM', b.id, k, c); }
    }
  }
  console.log(`${b.id}: walls=${tb.walls.length} mounds=${tb.mounds.length} grass=${tb.grass.length}`);
}
console.log(ok ? 'PARITY OK: web 端字符画与镜像展开结果同服务端完全一致' : 'PARITY FAILED');
process.exit(ok ? 0 : 1);
