/**
 * 环形变交互测试（Playwright）——运行：node tests/ui-loops.mjs
 *
 * 前置：本地服务已起（默认 http://127.0.0.1:8899），playwright 见 tests/README.md。
 *
 * 覆盖：
 *   · 发夹环：选中（绿点手柄）→ 拖 apex 调鼓出（bulge）→ 拖出朝向（tilt）
 *   · 锚点（closing pair）逐点不动、环内重铺、非环残基不动
 *   · 多重环（多段）：bulge 生效、tilt 被忽略
 *   · 双击 / 右键重置形状；刷新后 overrides 恢复
 *   · 全程 pairs / dot-bracket / ΔG 不变；形变期间零 /api 调用
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

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log(`PASS | ${label}`); }
  else { fail += 1; console.log(`FAIL | ${label}${extra !== undefined ? ' | ' + extra : ''}`); }
}
const sleep = (ms) => new Promise((r) => { setTimeout(r, ms); });

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
  ok(true, '启动 + 折叠');

  const baseline = await page.evaluate(() => ({
    pairs: JSON.stringify(state.pairs),
    db: document.getElementById('out-struct').textContent,
    dg: (document.getElementById('m-dg').textContent || '').trim(),
  }));

  const loops = await page.evaluate(() => {
    const t = window.RNAStruct.buildStructureTree(state.pairs, state.sequence.length);
    const out = [];
    for (const [id, el] of t.elements) {
      if (['hairpin', 'internal_loop', 'bulge', 'junction'].includes(el.type)) {
        out.push({ id, type: el.type, res: el.residues });
      }
    }
    return out;
  });
  const HP = loops.filter((l) => l.type === 'hairpin').sort((a, b) => b.res.length - a.res.length)[0];
  const L2 = loops.filter((l) => l.type !== 'hairpin').sort((a, b) => b.res.length - a.res.length)[0];
  ok(!!HP, '找到发夹环', HP && `${HP.id}（${HP.res.length} 残基）`);
  ok(!!L2, '找到多重/内部环', L2 && `${L2.id}（${L2.type}）`);

  const readPts = (idxs) => page.evaluate((arr) => {
    const out = {};
    for (const i of arr) {
      const c = document.querySelector(`.nt[data-i="${i}"] .nt-circle`);
      if (c) out[i] = { x: parseFloat(c.getAttribute('cx')), y: parseFloat(c.getAttribute('cy')) };
    }
    return out;
  }, idxs);
  const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);
  const shapeOf = (lid) => page.evaluate((id) => {
    const t = window.RNAStruct.buildStructureTree(state.pairs, state.sequence.length);
    const ls = window.RNAStruct.loopShape(t, id, state.result.layout.points, state.layoutOverrides);
    return ls ? {
      m: ls.m, anchors: ls.anchors, k: ls.k, tiltDeg: ls.tiltDeg,
      stretchCount: ls.stretchCount, L0: ls.L0, chord: ls.chord,
    } : null;
  }, lid);

  async function dragLoopHandle(kTarget, rotDeg, kNow) {
    const dot = await page.locator('.loop-dot').boundingBox();
    const hd = await page.locator('.loop-handle').boundingBox();
    if (!dot || !hd) throw new Error('找不到 loop-dot / loop-handle');
    const d = { x: dot.x + dot.width / 2, y: dot.y + dot.height / 2 };
    const h = { x: hd.x + hd.width / 2, y: hd.y + hd.height / 2 };
    let vx = h.x - d.x; let vy = h.y - d.y;
    const L = Math.hypot(vx, vy) || 1;
    vx /= L; vy /= L;
    const rad = (rotDeg * Math.PI) / 180;
    const rx = vx * Math.cos(rad) - vy * Math.sin(rad);
    const ry = vx * Math.sin(rad) + vy * Math.cos(rad);
    const S = L * (kTarget / Math.max(kNow, 1e-6));
    const target = { x: d.x + rx * S, y: d.y + ry * S };
    await page.mouse.move(h.x, h.y);
    await page.mouse.down();
    for (let k = 1; k <= 6; k++) {
      await page.mouse.move(h.x + ((target.x - h.x) * k) / 6, h.y + ((target.y - h.y) * k) / 6);
      await sleep(30);
    }
    await page.mouse.up();
    await sleep(300);
  }

  const ctrl = await page.evaluate((resArr) => {
    const s = new Set(resArr);
    for (let i = 0; i < state.sequence.length; i++) if (!s.has(i)) return i;
    return -1;
  }, HP.res);

  await page.click('[data-edit="arrange"]');
  await sleep(250);

  /* ── 发夹环：选中 ── */
  const selHP = `.nt[data-i="${HP.res[0]}"] .nt-circle`;
  await page.click(selHP);
  await sleep(350);
  const bannerT = (await page.textContent('#arrange-sel')) || '';
  ok(bannerT.includes('发夹环'), '横幅显示选中发夹环', bannerT.slice(0, 42));
  ok((await page.$$('.loop-handle')).length === 1, '绿色形变手柄出现');
  ok((await page.$$('.loop-dot')).length === 1, '中点标记出现');
  await page.screenshot({ path: '/tmp/uitest/shots3/01_loop_selected.png' });

  const sh0 = await shapeOf(HP.id);
  ok(!!sh0 && sh0.stretchCount === 1, '发夹环单段', sh0 && String(sh0.stretchCount));
  const beforeAll = await readPts([...sh0.anchors, ...HP.res, ctrl]);

  /* ── 拖鼓出 1.8× ── */
  const api0 = apiCalls;
  await dragLoopHandle(1.8, 0, sh0.k);
  ok(apiCalls - api0 === 0, '形变期间零 /api 调用', String(apiCalls - api0));
  const sh1 = await shapeOf(HP.id);
  ok(Math.abs(sh1.k - 1.8) < 0.25, 'bulge ≈ 1.8×', sh1.k.toFixed(2));
  const after1 = await readPts([...sh0.anchors, ...HP.res, ctrl]);
  ok(sh0.anchors.every((i) => dist(beforeAll[i], after1[i]) < 1e-9), '锚点（闭合配对）逐点不动');
  const movedCnt = HP.res.filter((i) => dist(beforeAll[i], after1[i]) > 1e-9).length;
  ok(movedCnt >= HP.res.length - 1, '环内残基重铺', `${movedCnt}/${HP.res.length}`);
  ok(dist(beforeAll[ctrl], after1[ctrl]) < 1e-9, '非环残基不动');
  await page.screenshot({ path: '/tmp/uitest/shots3/02_loop_bulged.png' });

  /* ── 拖朝向 60° ── */
  await dragLoopHandle(1.0, 60, sh1.k);
  const sh2 = await shapeOf(HP.id);
  ok(Math.abs(Math.abs(sh2.tiltDeg) - 60) < 12, 'tilt ≈ 60°', sh2.tiltDeg.toFixed(1));
  const after2 = await readPts([...sh0.anchors, ctrl]);
  ok(sh0.anchors.every((i) => dist(beforeAll[i], after2[i]) < 1e-9), 'tilt 后锚点仍不动');
  await page.screenshot({ path: '/tmp/uitest/shots3/03_loop_tilted.png' });

  /* ── 双击重置 ── */
  // tilt 之后环可能与邻近碱基视觉重叠，真实点击会被 Playwright 的可点性检查挡住；
  // 这里直接向目标派发 dblclick 事件（handler 与真实双击走同一条路径）。
  await page.locator(selHP).dispatchEvent('dblclick');
  await sleep(900);                          // 等过渡动画
  const sh3 = await shapeOf(HP.id);
  ok(Math.abs(sh3.k - 1) < 0.001 && Math.abs(sh3.tiltDeg) < 0.001, '双击重置形状', `k=${sh3.k}`);
  const back = await readPts([...HP.res, ctrl]);
  ok(HP.res.every((i) => dist(beforeAll[i], back[i]) < 1e-6)
    && dist(beforeAll[ctrl], back[ctrl]) < 1e-6, '重置后坐标回到初始');

  /* ── 多段环（junction 等）：bulge 生效、tilt 忽略 ── */
  const selL2 = `.nt[data-i="${L2.res[0]}"] .nt-circle`;
  await page.click(selL2);
  await sleep(350);
  const shL0 = await shapeOf(L2.id);
  ok(!!shL0, '多段环可取得 loopShape', L2.type);
  const beforeL = await readPts([...shL0.anchors, ...L2.res]);
  await dragLoopHandle(1.6, 0, shL0.k);
  const shL1 = await shapeOf(L2.id);
  ok(Math.abs(shL1.k - 1.6) < 0.3, '多段环 bulge ≈ 1.6×', shL1.k.toFixed(2));
  const afterL = await readPts([...shL0.anchors, ...L2.res]);
  ok(shL0.anchors.every((i) => dist(beforeL[i], afterL[i]) < 1e-9), '多段环锚点不动');
  const movedL = L2.res.filter((i) => dist(beforeL[i], afterL[i]) > 1e-9).length;
  ok(movedL > 0, '多段环有残基重铺', `${movedL}/${L2.res.length}`);
  await page.screenshot({ path: '/tmp/uitest/shots3/04_multiloop.png' });

  /* ── 右键重置（环） ── */
  await page.click(selL2);
  await sleep(200);
  await page.click(selL2, { button: 'right' });
  await sleep(900);
  const shL2 = await shapeOf(L2.id);
  ok(Math.abs(shL2.k - 1) < 0.001, '右键重置环形变', `k=${shL2.k}`);

  /* ── 结构完整性 ── */
  const finalStruct = await page.evaluate(() => ({
    pairs: JSON.stringify(state.pairs),
    db: document.getElementById('out-struct').textContent,
    dg: (document.getElementById('m-dg').textContent || '').trim(),
  }));
  ok(finalStruct.pairs === baseline.pairs, 'pair table 全程不变');
  ok(finalStruct.db === baseline.db, 'dot-bracket 全程不变');
  ok(finalStruct.dg === baseline.dg, 'ΔG 读数全程不变');

  /* ── 持久化：拖一个形变，刷新后恢复 ── */
  await page.click(selHP);
  await sleep(250);
  await dragLoopHandle(1.5, 0, 1);
  const shP = await shapeOf(HP.id);
  ok(Math.abs(shP.k - 1.5) < 0.2, '（准备）形变 1.5×', shP.k.toFixed(2));
  await sleep(600);
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#engine option').length > 0, null, { timeout: 20000 });
  await sleep(900);
  const bases = await page.$$eval('#canvas .nt[data-i]', (e) => e.length);
  if (bases < SEQ.length) {
    await page.click('#btn-fold');
    await page.waitForFunction((n) => document.querySelectorAll('#canvas .nt[data-i]').length >= n, SEQ.length, { timeout: 40000 });
    await sleep(800);
  }
  const shReload = await shapeOf(HP.id);
  ok(shReload && Math.abs(shReload.k - shP.k) < 0.01, '刷新后环形变恢复', shReload && shReload.k.toFixed(2));

  ok(errors.length === 0, '无控制台错误', errors.slice(0, 4).join(' ;; ') || '(无)');

  await browser.close();
  console.log('----');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL: ' + e.message); process.exit(2); });
