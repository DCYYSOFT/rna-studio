/**
 * 结构模块单元测试 —— 运行：node tests/structure.test.mjs
 *
 * 对应验收 Case：
 *   1 简单 hairpin（旋转 stem：stem+hairpin 整体刚体旋转，间距不变）
 *   2 three-way junction（旋转 branch 1：其余 branch 逐点不动）
 *   3 nested stem（转 P1 全动；转 P2 只动 P2+发夹；嵌套合成正确）
 *   5 结构完整性（模块只读取配对，绝不改动）
 * 另含：交叉（假结）剔除策略、子树/编号、pivot、override 清理、刚体平移。
 */
import S from '../web/structure.js';

let pass = 0;
let fail = 0;
function ok(cond, label, extra) {
  if (cond) { pass += 1; console.log(`PASS | ${label}`); }
  else { fail += 1; console.log(`FAIL | ${label}${extra !== undefined ? ' | ' + extra : ''}`); }
}
const near = (a, b, eps = 1e-9) => Math.abs(a - b) <= eps;
const nearPt = (p, q, eps = 1e-9) => near(p.x, q.x, eps) && near(p.y, q.y, eps);
const dist = (p, q) => Math.hypot(p.x - q.x, p.y - q.y);

/** 确定性基点坐标（与布局算法无关，只用于变换不变量检验） */
function makePts(n) {
  return Array.from({ length: n }, (_, i) => ({
    x: Math.cos(i * 0.9) * 20 + i * 0.3,
    y: Math.sin(i * 0.9) * 20 - i * 0.2,
  }));
}

/** 断言：residues 内所有残基两两距离在变换前后不变（刚体不变量） */
function rigidInvariant(base, eff, residues, label) {
  let good = true;
  for (let a = 0; a < residues.length && good; a++) {
    for (let b = a + 1; b < residues.length && good; b++) {
      const i = residues[a]; const j = residues[b];
      if (!near(dist(base[i], base[j]), dist(eff[i], eff[j]), 1e-6)) good = false;
    }
  }
  ok(good, label);
}

/** 独立实现：绕 pv 旋转 deg 度（不复用模块的矩阵工具） */
function rot(deg, p, pv) {
  const r = (deg * Math.PI) / 180;
  const c = Math.cos(r);
  const s = Math.sin(r);
  const dx = p.x - pv.x;
  const dy = p.y - pv.y;
  return { x: pv.x + c * dx - s * dy, y: pv.y + s * dx + c * dy };
}
const mid = (a, b) => ({ x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 });

/* ═══════════ Case 1：简单 hairpin ═══════════ */
{
  const n = 12;
  const pairs = [[1, 10], [2, 9]];
  const tree = S.buildStructureTree(pairs, n);
  const base = makePts(n);

  const stem = tree.elements.get('stem:1-10');
  ok(stem && stem.type === 'stem' && stem.label === 'P1', 'C1 stem 识别与编号', stem && stem.label);
  ok(stem.residues.join(',') === '1,2,9,10', 'C1 stem 残基', stem.residues.join(','));
  ok(stem.proximalPair.join(',') === '1,10', 'C1 proximalPair = 外侧配对');
  const hp = tree.elements.get('loop:3-8');
  ok(hp && hp.type === 'hairpin' && hp.residues.join(',') === '3,4,5,6,7,8', 'C1 hairpin 分类与残基');
  ok(tree.elements.get('ext').residues.join(',') === '0,11', 'C1 外部环残基');
  ok(tree.residueToElement.every((x) => x !== null), 'C1 残基全覆盖（每个碱基都归入某元素）');
  ok(S.subtreeResidues(tree, 'stem:1-10').sort((a, b) => a - b).join(',') === '1,2,3,4,5,6,7,8,9,10',
    'C1 子树 = stem + hairpin');
  ok(S.subtreeIds(tree, 'stem:1-10').join(' ').length > 0, 'C1 subtreeIds 可用');

  const pv = S.stemPivot(tree, 'stem:1-10', base);
  ok(nearPt(pv, mid(base[1], base[10])), 'C1 pivot = 外侧配对中点');

  // 旋转 90°：子树刚体、ext 不动
  const eff = S.effectivePoints(base, tree, { 'stem:1-10': { angle: 90 } });
  ok(nearPt(eff[0], base[0]) && nearPt(eff[11], base[11]), 'C1 旋转后 ext 不动');
  rigidInvariant(base, eff, [1, 2, 9, 10, 3, 4, 5, 6, 7, 8], 'C1 子树刚体（两两距离不变）');
  ok(nearPt(eff[4], rot(90, base[4], pv)), 'C1 旋转独立复算（残基 4）');

  // 刚体平移：子树整体位移，ext 不动
  const effT = S.effectivePoints(base, tree, { 'stem:1-10': { dx: 5, dy: -3 } });
  ok(nearPt(effT[4], { x: base[4].x + 5, y: base[4].y - 3 })
    && nearPt(effT[7], { x: base[7].x + 5, y: base[7].y - 3 })
    && nearPt(effT[0], base[0]), 'C1 刚体平移（子树整体 +dx,+dy，ext 不动）');

  // 无有效 override → 返回与基点一致
  const effN = S.effectivePoints(base, tree, { 'stem:1-10': { angle: 0, dx: 0, dy: 0 } });
  ok(nearPt(effN[5], base[5]), 'C1 全零 override 不产生位移');
}

/* ═══════════ Case 2：three-way junction ═══════════ */
{
  const n = 40;
  const pairs = [[0, 39], [1, 38], [4, 10], [5, 9], [14, 20], [15, 19], [26, 32], [27, 31]];
  const tree = S.buildStructureTree(pairs, n);
  const base = makePts(n);

  ok(tree.elements.get('stem:0-39').label === 'P1'
    && tree.elements.get('stem:4-10').label === 'P2'
    && tree.elements.get('stem:14-20').label === 'P3'
    && tree.elements.get('stem:26-32').label === 'P4', 'C2 编号 P1–P4 按 5′ 顺序');

  const junc = tree.elements.get('loop:2-37');
  ok(junc && junc.type === 'junction', 'C2 junction 分类');
  ok(junc.residues.join(',') === '2,3,11,12,13,21,22,23,24,25,33,34,35,36,37',
    'C2 junction 残基', junc.residues.join(','));
  ok(tree.elements.get('stem:4-10').parent === 'loop:2-37'
    && tree.elements.get('stem:0-39').parent === 'ext', 'C2 父子关系（branch → junction → ext）');

  // 旋转 branch 1（stem:4-10）120°：只有它的子树移动
  const eff = S.effectivePoints(base, tree, { 'stem:4-10': { angle: 120 } });
  const subB = new Set([4, 5, 6, 7, 8, 9, 10]);
  let othersSame = true;
  for (let i = 0; i < n; i++) {
    if (!subB.has(i) && !nearPt(eff[i], base[i], 1e-9)) othersSame = false;
  }
  ok(othersSame, 'C2 只有 branch 1 子树移动（其余逐点不动）');
  rigidInvariant(base, eff, [4, 5, 9, 10, 6, 7, 8], 'C2 branch 1 刚体');
  ok([14, 20, 26, 32].every((i) => nearPt(eff[i], base[i])), 'C2 branch 2 / 3 点名不动');
  ok(nearPt(eff[2], base[2]) && nearPt(eff[22], base[22]), 'C2 junction 锚点不参与转动');

  const pvB = S.stemPivot(tree, 'stem:4-10', base);
  ok(nearPt(eff[6], rot(120, base[6], pvB)), 'C2 旋转独立复算（hairpin 残基 6）');
}

/* ═══════════ Case 3：nested stem（junction → P1 → internal loop → P2 → hairpin）═══════════ */
{
  const n = 28;
  const pairs = [[2, 25], [3, 24], [8, 21], [9, 20]];
  const tree = S.buildStructureTree(pairs, n);
  const base = makePts(n);

  ok(tree.elements.get('stem:2-25').label === 'P1'
    && tree.elements.get('stem:8-21').label === 'P2', 'C3 编号 P1/P2');
  const il = tree.elements.get('loop:4-23');
  ok(il && il.type === 'internal_loop' && il.children.join(',') === 'stem:8-21',
    'C3 internal loop 分类与子支');
  ok(tree.elements.get('loop:10-19').type === 'hairpin', 'C3 hairpin 分类');
  ok(tree.elements.get('ext').residues.join(',') === '0,1,26,27', 'C3 ext 残基');

  // 转 P1：P1 + internal loop + P2 + hairpin 全动；ext 不动
  const eff1 = S.effectivePoints(base, tree, { 'stem:2-25': { angle: 30 } });
  ok([0, 1, 26, 27].every((i) => nearPt(eff1[i], base[i])), 'C3 转 P1：ext 不动');
  let allMoved = true;
  for (let i = 2; i <= 25; i++) {
    if (nearPt(eff1[i], base[i], 1e-9)) allMoved = false;
  }
  ok(allMoved, 'C3 转 P1：P1+internal loop+P2+hairpin 全部移动');
  rigidInvariant(base, eff1, [2, 3, 8, 9, 20, 21, 10, 14, 19, 24, 25], 'C3 转 P1 全子树刚体');
  const pv1 = mid(base[2], base[25]);
  ok(nearPt(eff1[10], rot(30, base[10], pv1)), 'C3 转 P1 独立复算（残基 10）');

  // 转 P2：只有 P2 + hairpin 移动；P1 本体与 internal loop 逐点不动
  const eff2 = S.effectivePoints(base, tree, { 'stem:8-21': { angle: 45 } });
  let others2 = true;
  for (let i = 0; i < n; i++) {
    if (!(i >= 8 && i <= 21) && !nearPt(eff2[i], base[i], 1e-9)) others2 = false;
  }
  ok(others2, 'C3 转 P2：仅 P2+hairpin 移动');
  ok([2, 3, 24, 25, 4, 5, 6, 7, 22, 23].every((i) => nearPt(eff2[i], base[i])),
    'C3 P1 本体与 internal loop 逐点不动');

  // 嵌套合成（P1=30°，P2=-45°）：独立复算残基 10
  const eff3 = S.effectivePoints(base, tree, {
    'stem:2-25': { angle: 30 },
    'stem:8-21': { angle: -45 },
  });
  const pv2base = mid(base[8], base[21]);
  // 管线 = M_P1 ∘ L_P2：先绕（基点坐标里的）P2 pivot 转 -45°，再整体绕 P1 pivot 转 30°
  const expected10 = rot(30, rot(-45, base[10], pv2base), pv1);
  ok(nearPt(eff3[10], expected10), 'C3 嵌套合成独立复算（残基 10）');
  rigidInvariant(base, eff3, [2, 3, 24, 25, 4, 5, 6, 7, 22, 23], 'C3 合成后：P1 组内部刚体');
  rigidInvariant(base, eff3, [8, 9, 20, 21, 10, 11, 12, 18, 19], 'C3 合成后：P2 组内部刚体');
  ok(!near(dist(base[4], base[10]), dist(eff3[4], eff3[10]), 1e-6),
    'C3 合成后：P2 相对 P1 确实转了（跨组距离改变）');
  // 合成后 P1 子树整体依然与 ext 分离（ext 不动）
  ok([0, 1, 26, 27].every((i) => nearPt(eff3[i], base[i])), 'C3 合成后 ext 仍不动');
}

/* ═══════════ 交叉（假结）剔除策略 ═══════════ */
{
  // 例 1：简单交叉——主茎环保留，跨环配对剔出
  const pairs1 = [[0, 10], [1, 9], [2, 8], [4, 14]];
  const involved = S.crossingInvolved(pairs1);
  ok(involved.has('4,14') && involved.has('2,8'), 'X crossingInvolved 报告交叉双方');
  const sub1 = S.nonCrossingSubset(pairs1);
  ok(sub1.kept.map((p) => p.join('-')).join(' ') === '0-10 1-9 2-8'
    && sub1.dropped.length === 1 && sub1.dropped[0].join('-') === '4-14',
    'X 例 1：主茎环保留、跨环配对剔出', JSON.stringify(sub1));

  // 例 2：典型假结（发夹 + 跨环配对）——发夹结构优先保留
  const pairs2 = [[10, 20], [11, 19], [15, 40], [16, 39]];
  const sub2 = S.nonCrossingSubset(pairs2);
  ok(sub2.kept.map((p) => p.join('-')).join(' ') === '10-20 11-19',
    'X 例 2：主发夹保留、假结配对剔出', JSON.stringify(sub2.kept));

  // pairsCross 基础判据
  ok(S.pairsCross([10, 20], [15, 40]) === true
    && S.pairsCross([1, 9], [2, 8]) === false
    && S.pairsCross([10, 20], [25, 30]) === false, 'X pairsCross 判据');

  // 建树端到端：剔除后按未配对归环
  const tree = S.buildStructureTree(pairs1, 16);
  ok(tree.elements.has('stem:0-10') && !tree.elements.has('stem:4-14'), 'X 交叉配对不入树');
  ok(tree.ignoredPkPairs.length === 1 && tree.ignoredPkPairs[0].join('-') === '4-14',
    'X ignoredPkPairs 清单');
  ok(tree.elements.get('loop:3-7').residues.join(',') === '3,4,5,6,7', 'X 剔除后残基按未配对归环');
  ok(tree.elements.get('ext').residues.join(',') === '11,12,13,14,15', 'X ext 残基');
  ok(tree.residueToElement.every((x) => x !== null), 'X 剔除后残基仍全覆盖');
}

/* ═══════════ override 清理 ═══════════ */
{
  const tree = S.buildStructureTree([[1, 10], [2, 9]], 12);
  const pr = S.pruneOverrides(tree, {
    'stem:1-10': { angle: 0, dx: 0, dy: 0 },   // 全零 → 丢
    'stem:99-100': { angle: 5 },                // 不存在 → 丢
  });
  ok(Object.keys(pr.kept).length === 0
    && pr.dropped.includes('stem:1-10') && pr.dropped.includes('stem:99-100'),
    'P pruneOverrides 丢弃全零与失效项', JSON.stringify(pr));
  const pr2 = S.pruneOverrides(tree, { 'stem:1-10': { angle: 30 } });
  ok(pr2.kept['stem:1-10'].angle === 30 && pr2.dropped.length === 0, 'P pruneOverrides 保留有效项');
  ok(S.hasAnyOverride({}) === false && S.hasAnyOverride({ 'stem:1-10': { angle: 1 } }) === true,
    'P hasAnyOverride');
}

/* ═══════════ 汇总 ═══════════ */
console.log('----');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
