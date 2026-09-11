/**
 * 假结层级交互测试（Playwright）——运行：node tests/ui-pk.mjs
 *
 * 做法：先用 tRNA 折叠拿到布局，再把 state.pairs 替换成一组带假结的配对
 * （主茎 + 跨环的 PK 对），验证：
 *   · 配对表 → PK1 子树（pk1:stem:…），可被点击选中（横幅显示 PK1-1）
 *   · 拖旋转手柄：PK 子树刚体旋转；主茎与其余残基逐点不动
 *   · 旋转期间零 /api 调用；pairs 不变
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const req = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = req('playwright')); }
catch {
  const altDir = process.env.PLAYWRIGHT_DIR || '/tmp/uitest';
  ({ chromium } = createRequire(path.join(altDir, 'noop.js'))('playwright'));
}

const BASE = process.env.RNA_STUDIO_URL || 'http://127.0.0.1:8899';
const SEQ = 'GCGGAUUUAGCUCAGUUGGGAGAGCGCCAGACUGAAGAUCUGGAGGUCCUGUGUUCGAUCCACAGAAUUCGCACCA';
const PK_PAIRS = [[10, 30], [11, 29], [12, 28], [20, 40], [21, 39]];

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log(`PASS | ${label}`); }
  else { fail += 1; console.log(`FAIL | ${label}${extra !== undefined ? ' | ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

async function rotateStem(page, deg) {
  const h = await page.locator('.sel-handle').boundingBox();
  const p = await page.locator('.pivot-dot').boundingBox();
  if (!h || !p) throw new Error('找不到手柄或 pivot');
  const hc = { x: h.x + h.width / 2, y: h.y + h.height / 2 };
  const pc = { x: p.x + p.width / 2, y: p.y + p.height / 2 };
  const rad = (deg * Math.PI) / 180;
  const vx = hc.x - pc.x;
  const vy = hc.y - pc.y;
  const target = {
    x: pc.x + vx * Math.cos(rad) - vy * Math.sin(rad),
    y: pc.y + vx * Math.sin(rad) + vy * Math.cos(rad),
  };
  await page.mouse.move(hc.x, hc.y);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) {
    await page.mouse.move(hc.x + ((target.x - hc.x) * k) / 8, hc.y + ((target.y - hc.y) * k) / 8);
    await sleep(25);
  }
  await page.mouse.up();
  await sleep(300);
}

(async () => {
  const browser = await chromium.launch({
    args: ['--no-sandbox'],
    executablePath: process.env.CHROME_PATH || undefined,
  });
  const page = await browser.newPage({ viewport: { width: 1440, height: 900 } });
  const errors = [];
  page.on('pageerror', (e) => errors.push('pageerror: ' + e.message));
  page.on('console', (m) => { if (m.type() === 'error') errors.push('console: ' + m.text()); });
  let apiCalls = 0;
  page.on('request', (r) => { if (r.url().includes('/api/')) apiCalls += 1; });

  await page.goto(BASE, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('#engine option').length > 0, null, { timeout: 20000 });
  await page.evaluate(() => localStorage.clear());
  await page.fill('#seq', SEQ);
  await page.click('#btn-fold');
  await page.waitForFunction((n) => document.querySelectorAll('#canvas .nt[data-i]').length >= n, SEQ.length, { timeout: 40000 });
  await sleep(1200);
  ok(true, '启动 + 折叠（借布局）');

  // 注入带假结的配对表 + 一条拉开间距的「直线布局」
  // （旋转扫向空白区域，确保不与碰撞避让逻辑纠缠，纯验证 PK 编辑路径）
  await page.evaluate((prs) => {
    const n = state.sequence.length;
    const pts = Array.from({ length: n }, (_, i) => ({ x: i * 40, y: 0 }));
    state.result.layout = { ...state.result.layout, points: pts };
    state.pairs = prs.map((p) => [p[0], p[1]]);
    state.fitPending = true;
    render();
  }, PK_PAIRS);
  await sleep(300);
  const pairsSnapshot = await page.evaluate(() => JSON.stringify(state.pairs));

  // 模块层核对
  const info = await page.evaluate(() => {
    const t = window.RNAStruct.buildStructureTree(state.pairs, state.sequence.length);
    const pk = t.elements.get('pk1:stem:20-40');
    return {
      hasPk: !!pk,
      label: pk && pk.label,
      owner20: t.residueToElement[20],
      owner10: t.residueToElement[10],
      stems: t.stems.slice(),
    };
  });
  ok(info.hasPk && info.label === 'PK1-1', 'PK1 子树建立', JSON.stringify(info));
  ok(info.owner20 === 'pk1:stem:20-40' && info.owner10 === 'stem:10-30', '残基归属：PK 与主茎');

  await page.click('[data-edit="arrange"]');
  await sleep(250);

  const readPts = (idxs) => page.evaluate((arr) => {
    const out = {};
    for (const i of arr) {
      const c = document.querySelector(`.nt[data-i="${i}"] .nt-circle`);
      if (c) out[i] = { x: parseFloat(c.getAttribute('cx')), y: parseFloat(c.getAttribute('cy')) };
    }
    return out;
  }, idxs);

  const pkRes = [20, 21, 39, 40];
  const mainRes = [10, 12, 28, 30];
  const ctrl = 0;
  const before = await readPts([...pkRes, ...mainRes, ctrl]);

  /* 选中 PK 分支 */
  await page.click('.nt[data-i="20"] .nt-circle');
  await sleep(400);
  const bannerT = (await page.textContent('#arrange-sel')) || '';
  ok(bannerT.includes('PK1-1'), '横幅显示选中 PK1-1', bannerT.slice(0, 40));
  ok((await page.$$('.sel-handle')).length === 1, '旋转手柄出现');
  ok((await page.$$('.pivot-dot')).length === 1, 'pivot 标记出现');
  await page.screenshot({ path: '/tmp/uitest/shots5/01_pk_selected.png' });

  /* 旋转 50° */
  const api0 = apiCalls;
  await rotateStem(page, 50);
  ok(apiCalls - api0 === 0, '旋转期间零 /api 调用', String(apiCalls - api0));
  const ang = await page.evaluate(() => (state.layoutOverrides['pk1:stem:20-40'] || {}).angle || 0);
  ok(Math.abs(Math.abs(ang) - 50) < 3, 'PK 分支旋转 ≈ 50°', `${ang.toFixed(1)}°`);

  const after = await readPts([...pkRes, ...mainRes, ctrl]);
  const movedOk = pkRes.every((i) => dist(before[i], after[i]) > 1e-9);
  ok(movedOk, 'PK 残基全部移动');
  const othersOk = [...mainRes, ctrl].every((i) => dist(before[i], after[i]) < 1e-9);
  ok(othersOk, '主茎与其余残基逐点不动');
  let maxDelta = 0;
  for (let a = 0; a < pkRes.length; a++) {
    for (let b = a + 1; b < pkRes.length; b++) {
      const i = pkRes[a]; const j = pkRes[b];
      maxDelta = Math.max(maxDelta, Math.abs(dist(before[i], before[j]) - dist(after[i], after[j])));
    }
  }
  ok(maxDelta < 1e-6, 'PK 子树刚体（两两距离不变）', `maxΔ=${maxDelta.toExponential(1)}`);
  await page.screenshot({ path: '/tmp/uitest/shots5/02_pk_rotated.png' });

  const pairsAfter = await page.evaluate(() => JSON.stringify(state.pairs));
  ok(pairsAfter === pairsSnapshot, 'pairs 全程不变');
  ok(errors.length === 0, '无控制台错误', errors.slice(0, 4).join(' ;; ') || '(无)');

  await browser.close();
  console.log('----');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL: ' + e.message); process.exit(2); });
