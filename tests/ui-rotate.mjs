/**
 * 排版交互测试（Playwright）——运行：node tests/ui-rotate.mjs
 *
 * 前置：本地服务已起（默认 http://127.0.0.1:8899），并安装 playwright（见 tests/README.md）。
 *
 * 覆盖验收：
 *   Case 4  undo 逐步还原（转 A → 转 B → undo×3 逐步复原）
 *   Case 5  结构完整性（pairs / dot-bracket / ΔG 全程不变；旋转期间零 /api 调用）
 * 另含：分支选择（pivot/子树高亮/手柄）、子树刚体旋转、非子树逐点不动、
 *      Shift 15° 吸附、双击重置角度、右键重置分支、刚体平移、刷新后 overrides 恢复。
 */
import { createRequire } from 'node:module';
import path from 'node:path';

const req = createRequire(import.meta.url);
let chromium;
try { ({ chromium } = req('playwright')); }
catch {
  const altDir = process.env.PLAYWRIGHT_DIR || '/tmp/uitest';
  const alt = createRequire(path.join(altDir, 'noop.js'));
  ({ chromium } = alt('playwright'));
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

  /* ── 启动 + 折叠 ── */
  await page.goto(BASE, { waitUntil: 'load', timeout: 30000 });
  await page.waitForFunction(() => document.querySelectorAll('#engine option').length > 0, null, { timeout: 20000 });
  await page.evaluate(() => localStorage.clear());
  await page.fill('#seq', SEQ);
  await page.click('#btn-fold');
  await page.waitForFunction((n) => document.querySelectorAll('#canvas .nt[data-i]').length >= n, SEQ.length, { timeout: 40000 });
  await sleep(1200);                       // 让折叠后的评估请求落定
  ok(true, '启动 + 折叠');

  /* 结构基线（Case 5） */
  const baseline = await page.evaluate(() => ({
    pairs: JSON.stringify(state.pairs),
    db: document.getElementById('out-struct').textContent,
    dg: (document.getElementById('m-dg').textContent || '').trim(),
  }));

  /* 挑两个有子树的分支 */
  const info = await page.evaluate(() => {
    const t = window.RNAStruct.buildStructureTree(state.pairs, state.sequence.length);
    const list = t.stems.map((id) => {
      const e = t.elements.get(id);
      return { id, label: e.label, res: e.residues, subtree: window.RNAStruct.subtreeResidues(t, id) };
    });
    const branchy = list.filter((s) => s.subtree.length > s.res.length);
    // A、B 都取较小的分支（末端臂：子树小、好观察，手柄也不会压到其它条带）
    const arms = branchy.slice().sort((x, y) => x.subtree.length - y.subtree.length);
    const a = arms[0] || list[0];
    const b = arms.find((s) => !a.subtree.includes(s.res[0]))
      || list.find((s) => !a.subtree.includes(s.res[0]));
    return { a, b };
  });
  ok(!!info.a && !!info.b, '找到两个可旋转分支', `${info.a.label} / ${info.b ? info.b.label : '无'}`);
  const A = info.a;
  const B = info.b;
  const subSet = new Set(A.subtree);
  const ctrl = await page.evaluate((subArr) => {
    const s = new Set(subArr);
    for (let i = 0; i < state.sequence.length; i++) if (!s.has(i)) return i;
    return -1;
  }, A.subtree);
  ok(ctrl >= 0, '找到非子树的对照残基', '#' + (ctrl + 1));

  const readPts = (idxs) => page.evaluate((arr) => {
    const out = {};
    for (const i of arr) {
      const c = document.querySelector(`.nt[data-i="${i}"] .nt-circle`);
      if (c) out[i] = { x: parseFloat(c.getAttribute('cx')), y: parseFloat(c.getAttribute('cy')) };
    }
    return out;
  }, idxs);
  const d2 = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

  const before = await readPts([...A.subtree, ctrl]);

  /* ── 进入排版模式，选中 A 分支 ── */
  await page.click('[data-edit="arrange"]');
  await sleep(250);
  const selA = `.nt[data-i="${A.res[0]}"] .nt-circle`;
  await page.click(selA);
  await sleep(400);
  ok(await page.isVisible('#arrange-banner'), '排版横幅显示');
  const bannerText = (await page.textContent('#arrange-sel')) || '';
  ok(bannerText.includes(A.label), `横幅显示选中 ${A.label}`, bannerText.slice(0, 44));
  ok((await page.$$('.sel-handle')).length === 1, '旋转手柄出现');
  ok((await page.$$('.pivot-dot')).length === 1, 'pivot 标记出现');
  ok((await page.$$('.sel-ring-sub')).length > 0, '子树淡高亮出现');
  await page.screenshot({ path: '/tmp/uitest/shots2/01_selected.png' });

  /* ── 旋转 A（自由角度，目标 +40°）── */
  const api0 = apiCalls;
  await rotateStem(page, 40, false);
  const apiDuringRotate = apiCalls - api0;
  ok(apiDuringRotate === 0, 'Case5：旋转期间零 /api 调用', String(apiDuringRotate));
  const angA1 = await page.evaluate((id) => (state.layoutOverrides[id] || {}).angle || 0, A.id);
  ok(Math.abs(Math.abs(angA1) - 40) < 3, `旋转 ${A.label} ≈ 40°`, `${angA1.toFixed(1)}°`);

  /* 刚体 + 隔离（UI 侧 Case 1/2） */
  const after1 = await readPts([...A.subtree, ctrl]);
  let maxDelta = 0;
  for (let i = 0; i < A.subtree.length; i++) {
    for (let j = i + 1; j < A.subtree.length; j++) {
      const x = A.subtree[i]; const y = A.subtree[j];
      maxDelta = Math.max(maxDelta, Math.abs(d2(before[x], before[y]) - d2(after1[x], after1[y])));
    }
  }
  ok(maxDelta < 1e-6, '子树刚体（渲染坐标两两距离不变）', `maxΔ=${maxDelta.toExponential(1)}`);
  ok(d2(before[ctrl], after1[ctrl]) < 1e-6, '非子树对照残基逐点不动');
  await page.screenshot({ path: '/tmp/uitest/shots2/02_rotated.png' });

  /* ── Shift 吸附 ── */
  await rotateStem(page, 23, true);
  const angA2 = await page.evaluate((id) => (state.layoutOverrides[id] || {}).angle || 0, A.id);
  ok(Math.abs(angA2 % 15) < 0.001 || Math.abs(Math.abs(angA2 % 15) - 15) < 0.001,
    'Shift 拖动吸附到 15° 整数倍', `${angA2.toFixed(1)}°`);

  /* ── 旋转 B ── */
  await page.click(`.nt[data-i="${B.res[0]}"] .nt-circle`);
  await sleep(350);
  const pickedB = await page.evaluate(() => (state.pickedUnit ? state.pickedUnit.id : null));
  ok(pickedB === B.id, `点击后选中 ${B.label}`, String(pickedB));
  await rotateStem(page, 25, false);
  const ovB = await page.evaluate((id) => (state.layoutOverrides[id] || {}).angle || 0, B.id);
  ok(Math.abs(ovB) > 10, `旋转 ${B.label} 生效`, `${ovB.toFixed(1)}°`);

  /* ── Case 4：undo 逐步还原 ── */
  await page.click('#btn-undo');
  await sleep(700);
  const u1 = await page.evaluate((ids) => ({
    a: (state.layoutOverrides[ids.a] || {}).angle || 0,
    b: (state.layoutOverrides[ids.b] || {}).angle || 0,
  }), { a: A.id, b: B.id });
  ok(Math.abs(u1.b) < 0.001, 'undo①：B 已还原', JSON.stringify(u1));
  ok(Math.abs(Math.abs(u1.a) - Math.abs(angA2)) < 0.01, 'undo①：A 保持（B 之后的值）', `${u1.a.toFixed(1)}°`);

  await page.click('#btn-undo');
  await sleep(700);
  const u2 = await page.evaluate((id) => (state.layoutOverrides[id] || {}).angle || 0, A.id);
  ok(Math.abs(Math.abs(u2) - 40) < 0.01, 'undo②：A 回到第一次旋转的值（40°）', `${u2.toFixed(1)}°`);

  await page.click('#btn-undo');
  await sleep(700);
  const u3 = await page.evaluate((id) => (state.layoutOverrides[id] || {}).angle || 0, A.id);
  ok(Math.abs(u3) < 0.001, 'undo③：A 完全还原', `${u3.toFixed(1)}°`);
  const afterUndo = await readPts([...A.subtree, ctrl]);
  let backDelta = 0;
  for (const i of [...A.subtree, ctrl]) {
    backDelta = Math.max(backDelta, d2(before[i], afterUndo[i]));
  }
  ok(backDelta < 1e-6, 'undo 后渲染坐标与初始完全一致', `maxΔ=${backDelta.toExponential(1)}`);

  /* ── 双击重置角度 ── */
  await page.click(selA);
  await sleep(300);
  await rotateStem(page, 30, false);
  const dblAng0 = await page.evaluate((id) => (state.layoutOverrides[id] || {}).angle || 0, A.id);
  ok(Math.abs(dblAng0) > 5, '（准备）再次旋转', `${dblAng0.toFixed(1)}°`);
  await page.click(selA);
  await sleep(200);
  await page.dblclick(selA);
  await sleep(400);
  const dblAng1 = await page.evaluate((id) => (state.layoutOverrides[id] || {}).angle || 0, A.id);
  ok(Math.abs(dblAng1) < 0.001, '双击重置该 stem 角度', `${dblAng1.toFixed(1)}°`);

  /* ── 刚体平移 + 右键重置分支 ── */
  const stemBox = await page.locator(selA).boundingBox();
  await page.mouse.move(stemBox.x + stemBox.width / 2, stemBox.y + stemBox.height / 2);
  await page.mouse.down();
  for (let k = 1; k <= 6; k++) {
    await page.mouse.move(stemBox.x + stemBox.width / 2 + k * 12, stemBox.y + stemBox.height / 2 + k * 9);
    await sleep(30);
  }
  await page.mouse.up();
  await sleep(400);
  const tr = await page.evaluate((id) => {
    const o = state.layoutOverrides[id] || {};
    return { dx: o.dx || 0, dy: o.dy || 0 };
  }, A.id);
  ok(Math.abs(tr.dx) + Math.abs(tr.dy) > 1, '拖本体刚体平移（override.dx/dy）', JSON.stringify(tr));
  await page.screenshot({ path: '/tmp/uitest/shots2/03_translated.png' });

  await page.click(selA, { button: 'right' });
  await sleep(1000);                        // 等折叠过渡动画播完再读坐标
  const br = await page.evaluate((ids) => {
    const t = window.RNAStruct.buildStructureTree(state.pairs, state.sequence.length);
    const subIds = window.RNAStruct.subtreeIds(t, ids.id);
    const left = subIds.filter((sid) => state.layoutOverrides[sid]);
    return { left: left.length };
  }, { id: A.id });
  ok(br.left === 0, '右键重置分支（子树内 override 全部清除）', JSON.stringify(br));
  const afterReset = await readPts([...A.subtree, ctrl]);
  let resetDelta = 0;
  for (const i of [...A.subtree, ctrl]) {
    resetDelta = Math.max(resetDelta, d2(before[i], afterReset[i]));
  }
  ok(resetDelta < 1e-6, '重置后渲染坐标回到初始', `maxΔ=${resetDelta.toExponential(1)}`);

  /* ── Case 5：结构完整性 ── */
  const finalStruct = await page.evaluate(() => ({
    pairs: JSON.stringify(state.pairs),
    db: document.getElementById('out-struct').textContent,
    dg: (document.getElementById('m-dg').textContent || '').trim(),
  }));
  ok(finalStruct.pairs === baseline.pairs, 'Case5：pair table 全程不变');
  ok(finalStruct.db === baseline.db, 'Case5：dot-bracket 全程不变');
  ok(finalStruct.dg === baseline.dg, 'Case5：ΔG 读数全程不变', `${finalStruct.dg} vs ${baseline.dg}`);

  /* ── 会话持久化：刷新后 overrides 恢复 ── */
  await page.click(selA);
  await sleep(250);
  await rotateStem(page, 33, false);
  const ang33 = await page.evaluate((id) => (state.layoutOverrides[id] || {}).angle || 0, A.id);
  ok(Math.abs(Math.abs(ang33) - 33) < 3, '（准备）旋转 33°', `${ang33.toFixed(1)}°`);
  await sleep(600);                         // 等 saveSession 的防抖落盘
  await page.reload({ waitUntil: 'load' });
  await page.waitForFunction(() => document.querySelectorAll('#engine option').length > 0, null, { timeout: 20000 });
  await sleep(900);
  const bases = await page.$$eval('#canvas .nt[data-i]', (e) => e.length);
  if (bases < SEQ.length) {
    const btn = await page.$('#btn-fold');
    if (btn) { await page.click('#btn-fold'); }
    await page.waitForFunction((n) => document.querySelectorAll('#canvas .nt[data-i]').length >= n, SEQ.length, { timeout: 40000 });
    await sleep(800);
  }
  const angReload = await page.evaluate((id) => (state.layoutOverrides[id] || {}).angle || 0, A.id);
  ok(Math.abs(Math.abs(angReload) - Math.abs(ang33)) < 0.01, '刷新后 layoutOverrides 恢复', `${angReload.toFixed(1)}°`);
  await page.screenshot({ path: '/tmp/uitest/shots2/04_after_reload.png' });

  /* ── 控制台 ── */
  ok(errors.length === 0, '无控制台错误', errors.slice(0, 4).join(' ;; ') || '(无)');

  await browser.close();
  console.log('----');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL: ' + e.message); process.exit(2); });

/* 在选中 stem 后，拖旋转手柄绕 pivot 转 deg 度（屏幕坐标里等价变换） */
async function rotateStem(page, deg, shift) {
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
  if (shift) await page.keyboard.down('Shift');
  await page.mouse.move(hc.x, hc.y);
  await page.mouse.down();
  for (let k = 1; k <= 8; k++) {
    await page.mouse.move(hc.x + ((target.x - hc.x) * k) / 8, hc.y + ((target.y - hc.y) * k) / 8);
    await sleep(25);
  }
  await page.mouse.up();
  if (shift) await page.keyboard.up('Shift');
  await sleep(300);
}
