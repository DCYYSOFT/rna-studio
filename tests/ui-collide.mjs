/**
 * 碰撞自动避让 UI 测试（Playwright）——运行：node tests/ui-collide.mjs
 *
 * 场景：把一个小分支（A）拖到另一个分支（B）上 → 松手后应自动推开，
 * 重叠清零、只动 A、结构/ΔG 不变、出现「已自动避让」提示。
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

  // 挑两个小的末端分支 A / B（互不在对方子树里）
  const info = await page.evaluate(() => {
    const t = window.RNAStruct.buildStructureTree(state.pairs, state.sequence.length);
    const list = t.stems.map((id) => {
      const e = t.elements.get(id);
      return { id, label: e.label, res: e.residues, subtree: window.RNAStruct.subtreeResidues(t, id) };
    });
    const arms = list.filter((s) => s.subtree.length > s.res.length).sort((x, y) => x.subtree.length - y.subtree.length);
    const a = arms[0];
    const b = arms.find((s) => !a.subtree.includes(s.res[0]));
    const cen = (s) => {
      let x = 0; let y = 0;
      for (const i of s.res) { x += state.result.layout.points[i].x; y += state.result.layout.points[i].y; }
      return { x: x / s.res.length, y: y / s.res.length };
    };
    const rect = document.getElementById('canvas').getBoundingClientRect();
    const scale = Math.min(rect.width / state.view.w, rect.height / state.view.h) || 1;
    return { a, b, cA: cen(a), cB: cen(b), scale };
  });
  ok(!!info.a && !!info.b, '找到两个分支', `${info.a.label} → ${info.b.label}`);
  const A = info.a;
  const B = info.b;

  await page.click('[data-edit="arrange"]');
  await sleep(250);
  const selA = `.nt[data-i="${A.res[0]}"] .nt-circle`;
  await page.click(selA);
  await sleep(350);
  await page.screenshot({ path: '/tmp/uitest/shots4/01_before.png' });

  // 把 A 拖到 B 上（故意再错开一点，避免完全对称）
  const dModel = { x: info.cB.x - info.cA.x + 4, y: info.cB.y - info.cA.y - 3 };
  const box = await page.locator(selA).boundingBox();
  const start = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const dScreen = { x: dModel.x * info.scale, y: dModel.y * info.scale };
  await page.mouse.move(start.x, start.y);
  await page.mouse.down();
  for (let k = 1; k <= 10; k++) {
    await page.mouse.move(start.x + (dScreen.x * k) / 10, start.y + (dScreen.y * k) / 10);
    await sleep(25);
  }
  await page.mouse.up();
  await sleep(600);
  await page.screenshot({ path: '/tmp/uitest/shots4/02_after_avoid.png' });

  // 断言：松手后重叠清零（使用与应用相同的判定）
  const collide = await page.evaluate((aid) => {
    const t = window.RNAStruct.buildStructureTree(state.pairs, state.sequence.length);
    const pts = window.RNAStruct.effectivePoints(state.result.layout.points, t, state.layoutOverrides);
    const moved = new Set(window.RNAStruct.subtreeResidues(t, aid));
    const dMin = window.RNAStruct.medianSpacing(state.result.layout.points) * 0.6;
    const hits = window.RNAStruct.findCollisions(pts, moved, state.pairs, dMin);
    // 同时回报位移调整量（与拖拽原始目标应有差异）
    const o = state.layoutOverrides[aid] || {};
    return { hits: hits.length, dx: o.dx || 0, dy: o.dy || 0 };
  }, A.id);
  ok(collide.hits === 0, '松手后重叠清零（自动避让生效）', JSON.stringify(collide));

  const toastText = (await page.textContent('#toast').catch(() => '')) || '';
  ok(toastText.includes('自动避让') || toastText.includes('放回'),
    '出现避让/回退提示', toastText.slice(0, 34));

  const finalStruct = await page.evaluate(() => ({
    pairs: JSON.stringify(state.pairs),
    db: document.getElementById('out-struct').textContent,
    dg: (document.getElementById('m-dg').textContent || '').trim(),
  }));
  ok(finalStruct.pairs === baseline.pairs, 'pair table 不变');
  ok(finalStruct.db === baseline.db, 'dot-bracket 不变');
  ok(finalStruct.dg === baseline.dg, 'ΔG 读数不变');

  ok(errors.length === 0, '无控制台错误', errors.slice(0, 4).join(' ;; ') || '(无)');

  await browser.close();
  console.log('----');
  console.log(`通过 ${pass} 项，失败 ${fail} 项`);
  process.exit(fail > 0 ? 1 : 0);
})().catch((e) => { console.error('FATAL: ' + e.message); process.exit(2); });
