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

function centroidOf(pts, idxs) {
  let x = 0; let y = 0;
  for (const i of idxs) { x += pts[i].x; y += pts[i].y; }
  return { x: x / idxs.length, y: y / idxs.length };
}
function distToLine(p, a, b) {
  const dx = b.x - a.x; const dy = b.y - a.y;
  const L = Math.hypot(dx, dy) || 1e-9;
  return Math.abs((p.x - a.x) * dy - (p.y - a.y) * dx) / L;
}

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
  ok(tree.elements.has('stem:0-10') && !tree.elements.has('stem:4-14')
    && tree.elements.has('pk1:stem:4-14'), 'X 交叉配对不入主树、进入 PK1');
  ok(tree.ignoredPkPairs.length === 0, 'X PK1 提取后无超限配对');
  ok(tree.elements.get('pk1:stem:4-14').label === 'PK1-1'
    && tree.residueToElement[4] === 'pk1:stem:4-14'
    && tree.residueToElement[14] === 'pk1:stem:4-14', 'X PK1 元素与残基归属');
  ok(tree.elements.get('loop:3-7').residues.join(',') === '3,5,6,7', 'X PK 残基从环中回收');
  ok(tree.elements.get('ext').residues.join(',') === '11,12,13,15', 'X ext 残基（14 归 PK1）');
  ok(tree.residueToElement.every((x) => x !== null), 'X 残基仍全覆盖');
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

/* ═══════════ 环形变（bulge / tilt）═══════════ */
{
  // 单发夹：锚点不动、内部残基重铺、bulge 单调外扩、tilt 旋转偏移方向
  const n = 12;
  const tree = S.buildStructureTree([[1, 10], [2, 9]], n);
  const base = makePts(n);
  const loopId = 'loop:3-8';
  ok(tree.elements.get(loopId).anchors
    && tree.elements.get(loopId).anchors.join(',') === '2,9', 'L hairpin 锚点 = 父 stem 内侧配对');

  const m = mid(base[2], base[9]);
  const c0 = centroidOf(base, [3, 4, 5, 6, 7, 8]);
  const d0 = distToLine(c0, base[2], base[9]);

  const eff2 = S.effectivePoints(base, tree, { [loopId]: { bulge: 2 } });
  ok(nearPt(eff2[2], base[2]) && nearPt(eff2[9], base[9]), 'L 锚点（closing pair）不动');
  let moved = true;
  for (let i = 3; i <= 8; i++) if (nearPt(eff2[i], base[i], 1e-9)) moved = false;
  ok(moved, 'L 环内残基全部重新铺设');
  const d2 = distToLine(centroidOf(eff2, [3, 4, 5, 6, 7, 8]), eff2[2], eff2[9]);
  ok(d2 > d0 * 1.3, 'L bulge=2 明显外扩', `${(d2 / d0).toFixed(2)}×`);

  const eff15 = S.effectivePoints(base, tree, { [loopId]: { bulge: 1.5 } });
  const d15 = distToLine(centroidOf(eff15, [3, 4, 5, 6, 7, 8]), eff15[2], eff15[9]);
  ok(d15 > d0 && d15 < d2, 'L bulge 越大鼓出越大（单调）',
    `${d0.toFixed(2)} < ${d15.toFixed(2)} < ${d2.toFixed(2)}`);

  // tilt=90°：偏移方向相对基准旋转约 90°（垂距方向正交 → cos ≈ 0）
  const effT = S.effectivePoints(base, tree, { [loopId]: { bulge: 1, tilt: 90 } });
  const cT = centroidOf(effT, [3, 4, 5, 6, 7, 8]);
  const v0 = { x: c0.x - m.x, y: c0.y - m.y };
  const vT = { x: cT.x - m.x, y: cT.y - m.y };
  const cosang = (v0.x * vT.x + v0.y * vT.y) / (Math.hypot(v0.x, v0.y) * Math.hypot(vT.x, vT.y));
  ok(Math.abs(cosang) < 0.06, 'L tilt=90° 偏移方向旋转 90°', `cos=${cosang.toFixed(3)}`);

  // 独立复算（残基 4，bulge=2）：与渲染公式一致
  {
    const A = base[2]; const B = base[9];
    const mm = mid(A, B);
    let dx0 = c0.x - mm.x; let dy0 = c0.y - mm.y;
    const L0 = Math.hypot(dx0, dy0);
    dx0 /= L0; dy0 /= L0;
    const ctrl = { x: mm.x + dx0 * 2 * 2 * L0, y: mm.y + dy0 * 2 * 2 * L0 };
    const t = (4 - 3 + 1) / (6 + 1);
    const u = 1 - t;
    const exp4 = {
      x: u * u * A.x + 2 * u * t * ctrl.x + t * t * B.x,
      y: u * u * A.y + 2 * u * t * ctrl.y + t * t * B.y,
    };
    ok(nearPt(eff2[4], exp4), 'L 独立复算（残基 4 落在预期贝塞尔上）');
  }

  // loopShape（供 UI 的绿色手柄使用）
  const shape = S.loopShape(tree, loopId, base, { [loopId]: { bulge: 2, tilt: 0 } });
  ok(shape && near(Math.hypot(shape.apex.x - shape.m.x, shape.apex.y - shape.m.y), 2 * shape.L0, 1e-9),
    'L loopShape.apex 幅度 = k×L0');
  ok(shape.anchors.join(',') === '2,9' && shape.stretchCount === 1, 'L loopShape 基本信息');

  // 内部环：两段分别形变；锚点含子 stem 两端；多段时 tilt 被忽略（零位移）
  const tree3 = S.buildStructureTree([[2, 25], [3, 24], [8, 21], [9, 20]], 28);
  const base3 = makePts(28);
  const il = 'loop:4-23';
  const stretches = S.loopStretches(tree3, tree3.elements.get(il));
  ok(stretches.length === 2
    && stretches[0].start === 4 && stretches[0].end === 7
    && stretches[0].a === 3 && stretches[0].b === 8
    && stretches[1].start === 22 && stretches[1].end === 23
    && stretches[1].a === 21 && stretches[1].b === 24,
    'L internal loop 切两段、锚点正确', JSON.stringify(stretches));
  const effI = S.effectivePoints(base3, tree3, { [il]: { bulge: 1.6 } });
  ok([3, 8, 21, 24].every((i) => nearPt(effI[i], base3[i])), 'L 内部环锚点（含子 stem 两端）不动');
  ok(!nearPt(effI[5], base3[5], 1e-9) && !nearPt(effI[22], base3[22], 1e-9), 'L 两段都发生形变');
  const effNo = S.effectivePoints(base3, tree3, { [il]: { tilt: 90 } });
  let same = true;
  for (let i = 0; i < 28; i++) if (!nearPt(effNo[i], base3[i], 1e-9)) same = false;
  ok(same, 'L 多段环 tilt 不生效（bulge=1 时零位移）');

  // prune：环条目支持、外部环/全零丢弃
  const prL = S.pruneOverrides(tree, {
    [loopId]: { bulge: 1, tilt: 0 },
    ext: { bulge: 2 },
    'stem:1-10': { angle: 5 },
  });
  ok(Object.keys(prL.kept).length === 1 && prL.kept['stem:1-10'].angle === 5
    && prL.dropped.includes(loopId) && prL.dropped.includes('ext'),
    'L prune：环条目归一化（全零/外部环丢弃）', JSON.stringify(prL));
  const prL2 = S.pruneOverrides(tree, { [loopId]: { bulge: 1.5, tilt: 20 } });
  ok(prL2.kept[loopId].bulge === 1.5 && prL2.kept[loopId].tilt === 20, 'L prune：环条目保留');
}

/* ═══════════ 碰撞检测与自动避让 ═══════════ */
{
  const n = 40;
  const pairsC = [[0, 39], [1, 38], [4, 10], [5, 9], [14, 20], [15, 19], [26, 32], [27, 31]];
  const tree = S.buildStructureTree(pairsC, n);
  // 为碰撞测试单独造一个「梯子」布局：两行等距点，基线无过近对
  const base = Array.from({ length: n }, (_, i) => ({
    x: Math.floor(i / 2) * 10,
    y: (i % 2) * 8,
  }));
  const dMin = S.medianSpacing(base) * 0.6;
  const bSub = S.subtreeResidues(tree, 'stem:4-10');
  const cSub = S.subtreeResidues(tree, 'stem:14-20');
  const movedB = new Set(bSub);

  // 基线：正常布局没有「过近对」（骨架相邻与配对均已排除，不会误报）
  const eff0 = S.effectivePoints(base, tree, {});
  ok(S.findCollisions(eff0, movedB, pairsC, dMin).length === 0, 'C 基线布局零碰撞');

  // 把 B 分支整体移到 C 分支上 → 必然检出
  const cen = (idxs, pts) => {
    let x = 0; let y = 0;
    for (const i of idxs) { x += pts[i].x; y += pts[i].y; }
    return { x: x / idxs.length, y: y / idxs.length };
  };
  const bC = cen(bSub, base);
  const cC = cen(cSub, base);
  // 故意错开 2.7 个单位：完全对齐会让对称推力互相抵消
  const ov0 = { 'stem:4-10': { angle: 0, dx: cC.x - bC.x + 2.7, dy: cC.y - bC.y } };
  const eff1 = S.effectivePoints(base, tree, ov0);
  const hits1 = S.findCollisions(eff1, movedB, pairsC, dMin);
  ok(hits1.length > 0, 'C 叠放后被检出', `${hits1.length} 对`);

  // 自动避让：收敛、只动本分支、保持刚体、位移有上限
  const res = S.autoAvoid(tree, base, ov0, 'stem:4-10', { pairs: pairsC });
  ok(res.shifted && res.before > 0, 'C 避让发生', JSON.stringify({ before: res.before, after: res.after }));
  ok(res.after === 0, 'C 重叠全部消除', `after=${res.after}`);
  const eff2 = S.effectivePoints(base, tree, res.overrides);
  let onlyB = true;
  for (let i = 0; i < n; i++) {
    if (!movedB.has(i) && !nearPt(eff2[i], base[i], 1e-9)) onlyB = false;
  }
  ok(onlyB, 'C 只移动了该分支（其余逐点不动）');
  rigidInvariant(base, eff2, bSub, 'C 避让后分支仍为刚体');
  const o1 = res.overrides['stem:4-10'];
  const shift = Math.hypot(o1.dx - ov0['stem:4-10'].dx, o1.dy - ov0['stem:4-10'].dy);
  ok(shift <= S.ptsSpan(base) * 0.25 + 1e-6, 'C 位移在上限内', shift.toFixed(2));

  // 无碰撞时 autoAvoid 不动
  const res0 = S.autoAvoid(tree, base, {}, 'stem:4-10', { pairs: pairsC });
  ok(res0.shifted === false && res0.after === 0, 'C 无碰撞时不产生位移');
}

/* ═══════════ 假结层级（PK1 / PK2…）═══════════ */
{
  // 经典假结 + 二级交叉：主茎 (10,20)；PK1 = (15,40)(16,39)；(35,55) 只与 PK1 交叉 → PK2
  const n = 60;
  const pairs = [[10, 20], [11, 19], [15, 40], [16, 39], [30, 50], [35, 55]];
  const tree = S.buildStructureTree(pairs, n);
  ok(tree.elements.has('stem:10-20') && tree.elements.has('stem:30-50'), 'K 主层保留两个茎');
  const p1 = tree.elements.get('pk1:stem:15-40');
  const p2 = tree.elements.get('pk2:stem:35-55');
  ok(!!p1 && p1.pkLevel === 1 && p1.label === 'PK1-1', 'K (15,40)(16,39) 组成 PK1');
  ok(!!p2 && p2.pkLevel === 2 && p2.label === 'PK2-1', 'K (35,55) 进入 PK2');
  ok(tree.ignoredPkPairs.length === 0, 'K 无超限配对');
  ok(tree.residueToElement[15] === 'pk1:stem:15-40'
    && tree.residueToElement[35] === 'pk2:stem:35-55', 'K 残基归属正确');
  ok(tree.residueToElement.every((x) => x !== null), 'K 残基全覆盖');

  const base = makePts(n);
  const eff = S.effectivePoints(base, tree, { 'pk1:stem:15-40': { angle: 90 } });
  let pk1Moved = true;
  let othersSame = true;
  for (let i = 0; i < n; i++) {
    const moved = !nearPt(eff[i], base[i], 1e-9);
    if ([15, 16, 39, 40].includes(i)) { if (!moved) pk1Moved = false; }
    else if (moved) othersSame = false;
  }
  ok(pk1Moved && othersSame, 'K 旋转 PK1：只动 PK1 残基');
  rigidInvariant(base, eff, [15, 16, 39, 40], 'K PK1 刚体');
  const eff2 = S.effectivePoints(base, tree, { 'pk2:stem:35-55': { angle: 45 } });
  ok(!nearPt(eff2[35], base[35], 1e-9) && nearPt(eff2[15], base[15], 1e-9), 'K 旋转 PK2 不影响 PK1');
  const eff3 = S.effectivePoints(base, tree, { 'stem:10-20': { angle: 30 } });
  ok(nearPt(eff3[15], base[15], 1e-9) && nearPt(eff3[35], base[35], 1e-9), 'K 主茎与 PK 互相独立（同级）');
}

{
  // 挂接进主树：外套茎 (0,40) 的内环里坐着内茎 (5,30)，PK (20,35) 跨内茎 → 挂外套环，随父级旋转
  const n = 41;
  const pairs = [[0, 40], [1, 39], [5, 30], [6, 29], [20, 35]];
  const tree = S.buildStructureTree(pairs, n);
  const pk = tree.elements.get('pk1:stem:20-35');
  ok(!!pk, 'K2 PK1 提取');
  ok(pk.parent === 'loop:2-38', 'K2 挂到最内层容器（外套环）', pk.parent);
  ok(tree.elements.get('loop:2-38').children.includes('pk1:stem:20-35'), 'K2 在容器 children 中');
  ok(!tree.elements.get('loop:7-28').residues.includes(20), 'K2 残基从内发夹环回收');
  const base = makePts(n);
  const eff = S.effectivePoints(base, tree, { 'stem:0-40': { angle: 30 } });
  const pv1 = mid(base[0], base[40]);
  ok(nearPt(eff[20], rot(30, base[20], pv1), 1e-9), 'K2 转外套茎：PK 随父级旋转（独立复算）');
  const eff2 = S.effectivePoints(base, tree, { 'pk1:stem:20-35': { angle: 90 } });
  ok(!nearPt(eff2[20], base[20], 1e-9) && nearPt(eff2[5], base[5], 1e-9), 'K2 单独转 PK 不影响主茎');
}

/* ═══════════ 汇总 ═══════════ */
console.log('----');
console.log(`通过 ${pass} 项，失败 ${fail} 项`);
process.exit(fail > 0 ? 1 : 0);
