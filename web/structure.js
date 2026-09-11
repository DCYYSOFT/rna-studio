/**
 * RNA Studio · 结构元素树与布局变换（纯函数模块）
 *
 * 一切结构关系都从配对表（pair table）推导，绝不看屏幕坐标。
 * app.js 通过 window.RNAStruct 使用；单元测试通过 module.exports 使用。
 *
 * 数据模型（StructureElement）：
 *   {
 *     id,        // 'stem:5-22'（外侧配对）| 'loop:23-27'（区域边界）| 'ext'
 *     type,      // 'stem' | 'hairpin' | 'internal_loop' | 'bulge' | 'junction' | 'exterior'
 *     residues,  // number[]：属于该元素的碱基（stem=两侧配对碱基；loop=环内未配对碱基）
 *     pairs,     // [[i,j],...]：仅 stem 有
 *     parent,    // 父元素 id（exterior 为 null）
 *     children,  // 子元素 id[]（stem 的子是下游 loop；loop 的子是下游 stem）
 *     label,     // 仅 stem：按 5′ 顺序自动编号 P1、P2…
 *     proximalPair, // 仅 stem：[i,j] 邻接 parent loop 的一对（pivot 用它算）
 *   }
 *
 * 布局变换：
 *   overrides = { [stemId]: { angle: 度, dx, dy } } —— 全部在“基点坐标系”里定义。
 *   有效坐标 = 基点坐标依次经过各层 stem 的局部运动（先绕 pivot 旋转、再平移），
 *   父级运动整体作用到子树 → 嵌套自然合成。旋转是纯函数，可反复重算、无累积误差。
 *
 * 假结（交叉配对）不进入主树：按「逐层提取」组织为 PK1、PK2… 子树
 * （只建 stem，按跨度嵌入最内层容器），可像普通 stem 一样选中/旋转；
 * 超出层级上限（默认 4）的配对仅作 overlay 画线。
 */
(function (global) {
  'use strict';

  /* ── 配对归一化 / 交叉检测 ── */

  function normPairs(pairs) {
    return pairs
      .map(([i, j]) => (i < j ? [i, j] : [j, i]))
      .sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
  }

  /** 找出所有参与交叉（假结）的配对，返回 Set<'i,j'> */
  function crossingInvolved(pairs) {
    const norm = normPairs(pairs);
    const involved = new Set();
    for (let a = 0; a < norm.length; a++) {
      const [i, j] = norm[a];
      for (let b = a + 1; b < norm.length; b++) {
        const [k, l] = norm[b];
        if (k >= j) break;              // 后面的配对起点更靠右，不可能再交叉
        if (l > j) {
          involved.add(`${norm[a][0]},${norm[a][1]}`);
          involved.add(`${norm[b][0]},${norm[b][1]}`);
        }
      }
    }
    return involved;
  }

  /** 一对配对是否与另一对交叉 */
  function pairsCross([i, j], [k, l]) {
    return (i < k && k < j && j < l) || (k < i && i < l && l < j);
  }

  /**
   * 取非交叉子集（主结构），用于建树；其余配对留给假结 overlay 画线。
   * 策略：逐轮删掉「交叉数最多」的配对（并列时删更靠 3′ 的），直到无交叉。
   * 这样典型假结（发夹 + 跨环配对）会保留主茎环结构、把交叉的那几对剔出。
   */
  function nonCrossingSubset(pairs) {
    const kept = normPairs(pairs).map((p) => p.slice());
    const dropped = [];
    for (;;) {
      let bestIdx = -1;
      let bestCnt = 0;
      for (let a = 0; a < kept.length; a++) {
        let cnt = 0;
        for (let b = 0; b < kept.length; b++) {
          if (a !== b && pairsCross(kept[a], kept[b])) cnt += 1;
        }
        if (cnt > bestCnt
            || (cnt === bestCnt && cnt > 0 && bestIdx >= 0 && kept[a][0] > kept[bestIdx][0])) {
          bestCnt = cnt;
          bestIdx = a;
        }
      }
      if (bestCnt === 0) break;
      dropped.push(kept.splice(bestIdx, 1)[0]);
    }
    return { kept, dropped };
  }

  /* ── 建树 ── */

  /**
   * 由配对表构建结构元素树。
   * @param {Array<[number, number]>} pairs
   * @param {number} n 序列长度
   */
  function buildStructureTree(pairs, n, opts) {
    const maxPkLevels = (opts && opts.maxPkLevels) || 4;
    const norm = normPairs(pairs || []);

    // ① 分层：优先主结构（level 0），其余配对逐层提取（假结层级 PK1、PK2…）
    const layers = [];
    let rest = norm;
    for (let lv = 0; lv <= maxPkLevels && rest.length; lv++) {
      const { kept, dropped } = nonCrossingSubset(rest);
      layers.push(kept);
      rest = dropped;
    }
    const ignoredPkPairs = rest.slice().sort((a, b) => (a[0] - b[0]) || (a[1] - b[1]));
    const treePairs = layers[0] || [];

    // 连续堆叠切 stem：下一对恰为 (i+1, j-1) 则并入同一 stem
    const runs = [];
    let run = null;
    for (const [i, j] of treePairs) {
      const prev = run && run[run.length - 1];
      if (prev && i === prev[0] + 1 && j === prev[1] - 1) run.push([i, j]);
      else { run = [[i, j]]; runs.push(run); }
    }

    const stemList = runs.map((pairsRun) => {
      const [i0, j0] = pairsRun[0];               // 外侧配对（邻接 parent loop）
      const residues = [];
      for (const [i, j] of pairsRun) residues.push(i, j);
      residues.sort((a, b) => a - b);
      return {
        id: `stem:${i0}-${j0}`,
        type: 'stem',
        pairs: pairsRun.map((p) => [p[0], p[1]]),
        proximalPair: [i0, j0],
        residues,
        minI: i0,
        maxJ: j0,
        innerPair: pairsRun[pairsRun.length - 1],  // 内侧配对（朝下游）
        parent: null,
        children: [],
        label: '',
      };
    });

    // 包含关系：每个 stem 的最近外层 stem 即父 stem（其余为环元素，稍后建）
    const bySpan = stemList.slice().sort((s, t) => (s.minI - t.minI) || (t.maxJ - s.maxJ));
    for (const s of bySpan) {
      let parent = null;
      for (const t of bySpan) {
        if (t.minI < s.minI && s.maxJ < t.maxJ && (!parent || t.minI > parent.minI)) parent = t;
      }
      s.parent = parent;
    }

    // P1、P2…：按 5′ 侧出现顺序编号（仅用于显示）
    bySpan.forEach((s, idx) => { s.label = `P${idx + 1}`; });

    const elements = new Map();
    const residueToElement = new Array(n).fill(null);

    const addElement = (element) => {
      elements.set(element.id, element);
      for (const r of element.residues) residueToElement[r] = element.id;
      return element;
    };

    // 环：root + 每个 stem 的内侧区域 (innerPair[0]+1 .. innerPair[1]-1)
    const makeLoop = (id, lo, hi, childStems, parentId, typeHint) => {
      const covered = new Array(Math.max(hi - lo + 1, 0)).fill(false);
      for (const c of childStems) {
        for (let x = c.minI; x <= c.maxJ; x++) covered[x - lo] = true;
      }
      const residues = [];
      for (let x = lo; x <= hi; x++) {
        if (!covered[x - lo] && residueToElement[x] === null) residues.push(x);
      }

      let type = typeHint;
      if (typeHint === undefined) {
        if (childStems.length === 0) type = 'hairpin';
        else if (childStems.length >= 2) type = 'junction';
        else {
          const c = childStems[0];
          const left = c.minI - lo;
          const right = hi - c.maxJ;
          type = (left > 0 && right > 0) ? 'internal_loop' : 'bulge';
        }
      }

      const element = {
        id, type, residues, lo, hi, parent: parentId, children: childStems.map((c) => c.id),
      };
      return addElement(element);
    };

    // 先建所有 stem 元素的骨架（不带 residues 覆盖问题：stem 先注册，再建环）
    // 注意顺序：先把 stem 的残基登记进 residueToElement，再算环残基，保证互斥。
    const stemChildrenOf = new Map();       // parent stem id -> child stems
    const topStems = [];
    for (const s of bySpan) {
      const key = s.parent ? s.parent.id : 'ext';
      if (!stemChildrenOf.has(key)) stemChildrenOf.set(key, []);
      stemChildrenOf.get(key).push(s);
      if (!s.parent) topStems.push(s);
    }

    for (const s of bySpan) {
      addElement({
        id: s.id, type: 'stem', residues: s.residues, pairs: s.pairs,
        parent: null, children: [], label: s.label, proximalPair: s.proximalPair,
        minI: s.minI, maxJ: s.maxJ,
      });
    }

    // root 环
    const root = makeLoop('ext', 0, n - 1, topStems, null, 'exterior');
    // 各 stem 的下游环
    const stemLoops = new Map();            // stem id -> loop element
    for (const s of bySpan) {
      const children = stemChildrenOf.get(s.id) || [];
      const lo = s.innerPair[0] + 1;
      const hi = s.innerPair[1] - 1;
      const loop = makeLoop(`loop:${lo}-${hi}`, lo, hi, children, s.id);
      loop.anchors = [s.innerPair[0], s.innerPair[1]];   // 连接环的两端（父 stem 内侧配对）
      stemLoops.set(s.id, loop);
      // 接线：stem 的子是它的下游环（环的 parent 已在 makeLoop 里记录）
      elements.get(s.id).children = [loop.id];
    }
    // 环的子：下游 stem；stem.parent 补成环 id（因为父其实是“环”）
    for (const s of bySpan) {
      const owningLoopId = s.parent ? stemLoops.get(s.parent.id).id : 'ext';
      elements.get(s.id).parent = owningLoopId;
    }

    // ② 假结层级（PK1、PK2…）：只建 stem 元素，按跨度嵌入最内层容器
    const pkStemIds = [];
    const spanOf = (el) => {
      if (el.type === 'stem') return [el.minI, el.maxJ];
      if (el.type === 'exterior') return [0, n - 1];
      return [el.lo, el.hi];
    };
    for (let lv = 1; lv < layers.length; lv++) {
      const runs2 = [];
      let run2 = null;
      for (const [i, j] of layers[lv]) {
        const prev = run2 && run2[run2.length - 1];
        if (prev && i === prev[0] + 1 && j === prev[1] - 1) run2.push([i, j]);
        else { run2 = [[i, j]]; runs2.push(run2); }
      }
      runs2.forEach((pairsRun, idx) => {
        const [i0, j0] = pairsRun[0];
        const id = `pk${lv}:stem:${i0}-${j0}`;
        const residues = [];
        for (const [i, j] of pairsRun) residues.push(i, j);
        residues.sort((a, b) => a - b);
        // 从原属主（主树里的环）回收残基
        for (const r of residues) {
          const oldId = residueToElement[r];
          if (oldId && elements.has(oldId)) {
            const oe = elements.get(oldId);
            oe.residues = oe.residues.filter((x) => x !== r);
          }
          residueToElement[r] = id;
        }
        // 最内层容器：stem 用跨度、环用区域，取范围最小者
        let container = elements.get('ext');
        let bestSize = Infinity;
        for (const cand of elements.values()) {
          if (cand.type === 'exterior') continue;
          const [lo, hi] = spanOf(cand);
          if (lo <= i0 && j0 <= hi) {
            const size = hi - lo;
            if (size < bestSize) { bestSize = size; container = cand; }
          }
        }
        const el = {
          id, type: 'stem', pkLevel: lv, label: `PK${lv}-${idx + 1}`,
          residues, pairs: pairsRun.map((p) => [p[0], p[1]]),
          proximalPair: [i0, j0], minI: i0, maxJ: j0,
          parent: container.id, children: [],
        };
        elements.set(id, el);
        container.children.push(id);
        pkStemIds.push(id);
      });
    }

    return {
      n,
      elements,
      rootId: 'ext',
      residueToElement,
      ignoredPkPairs,
      stems: bySpan.map((s) => s.id).concat(pkStemIds),
      pkStems: pkStemIds,
    };
  }

  /* ── 查询辅助 ── */

  /** 元素的下游残基全集（含自身），即“以它为根的子树” */
  function subtreeResidues(tree, id) {
    const out = [];
    const rec = (el) => {
      for (const r of el.residues) out.push(r);
      for (const cid of el.children) rec(tree.elements.get(cid));
    };
    const el = tree.elements.get(id);
    if (el) rec(el);
    return out;
  }

  /** 子树内全部元素 id（含自身）——右键“重置分支布局”用 */
  function subtreeIds(tree, id) {
    const out = [];
    const rec = (el) => {
      out.push(el.id);
      for (const cid of el.children) rec(tree.elements.get(cid));
    };
    const el = tree.elements.get(id);
    if (el) rec(el);
    return out;
  }

  /** stem 的旋转中心：邻接 parent loop 的那对碱基的中点（基点坐标） */
  function stemPivot(tree, id, pts) {
    const s = tree.elements.get(id);
    const [i, j] = s.proximalPair;
    return { x: (pts[i].x + pts[j].x) / 2, y: (pts[i].y + pts[j].y) / 2 };
  }

  /* ── 2×3 仿射变换 ── */

  const IDENT = [1, 0, 0, 1, 0, 0];

  /** A∘B：先施加 B，再施加 A */
  function mulM(A, B) {
    return [
      A[0] * B[0] + A[2] * B[1], A[1] * B[0] + A[3] * B[1],
      A[0] * B[2] + A[2] * B[3], A[1] * B[2] + A[3] * B[3],
      A[0] * B[4] + A[2] * B[5] + A[4], A[1] * B[4] + A[3] * B[5] + A[5],
    ];
  }

  function applyM(M, p) {
    return { x: M[0] * p.x + M[2] * p.y + M[4], y: M[1] * p.x + M[3] * p.y + M[5] };
  }

  function rotationAbout(deg, pivot) {
    const r = (deg * Math.PI) / 180;
    const c = Math.cos(r);
    const s = Math.sin(r);
    return [c, s, -s, c,
      pivot.x - c * pivot.x + s * pivot.y,
      pivot.y - s * pivot.x - c * pivot.y];
  }

  function translationM(dx, dy) { return [1, 0, 0, 1, dx, dy]; }

  function hasAnyOverride(overrides) {
    if (!overrides) return false;
    for (const k of Object.keys(overrides)) {
      const o = overrides[k] || {};
      if (o.angle || o.dx || o.dy) return true;
      if (o.bulge != null && o.bulge !== 1) return true;
      if (o.tilt) return true;
    }
    return false;
  }

  /** 丢弃失效（元素不存在）或全零的 override；stem 与环分别归一化字段 */
  function pruneOverrides(tree, overrides) {
    const kept = {};
    const dropped = [];
    if (overrides) {
      for (const k of Object.keys(overrides)) {
        const o = overrides[k] || {};
        const el = tree.elements.get(k);
        if (el && el.type === 'stem') {
          const n = { angle: o.angle || 0, dx: o.dx || 0, dy: o.dy || 0 };
          if (n.angle || n.dx || n.dy) kept[k] = n; else dropped.push(k);
        } else if (el && el.type !== 'exterior') {
          const n = { bulge: o.bulge == null ? 1 : o.bulge, tilt: o.tilt || 0 };
          if (n.bulge !== 1 || n.tilt) kept[k] = n; else dropped.push(k);
        } else {
          dropped.push(k);
        }
      }
    }
    return { kept, dropped };
  }

  /** 单层 stem 的局部运动（先绕 pivot 旋转、再平移），叠加到继承矩阵 M 上 */
  function localMatrixOf(tree, stem, M, base, overrides) {
    const o = overrides && overrides[stem.id];
    if (!o || (!o.angle && !o.dx && !o.dy)) return M;
    let L = IDENT;
    if (o.angle) L = mulM(rotationAbout(o.angle, stemPivot(tree, stem.id, base)), L);
    if (o.dx || o.dy) L = mulM(translationM(o.dx || 0, o.dy || 0), L);
    return mulM(M, L);
  }

  /** 从根到该 stem 的祖先变换（不含自身）：渲染帧坐标 = M·(基点坐标) */
  function inheritedMatrix(tree, id, base, overrides) {
    const chain = [];
    let cur = tree.elements.get(id);
    while (cur && cur.type !== 'exterior') {
      if (cur.type === 'stem') chain.unshift(cur);
      cur = tree.elements.get(cur.parent);
    }
    let M = IDENT;
    for (const s of chain) {
      if (s.id === id) break;
      M = localMatrixOf(tree, s, M, base, overrides);
    }
    return M;
  }

  /** 把环的未配对残基按「锚点之间」切段（锚点 = 相邻的配对残基） */
  function loopStretches(tree, loop) {
    const out = [];
    if (!loop || !loop.anchors || loop.lo == null) return out;
    const inLoop = new Set(loop.residues);
    let s = null;
    for (let x = loop.lo; x <= loop.hi + 1; x++) {
      const inp = x <= loop.hi && inLoop.has(x);
      if (inp) {
        if (s === null) s = x;
      } else if (s !== null) {
        out.push({ start: s, end: x - 1, a: s - 1, b: x });
        s = null;
      }
    }
    return out;
  }

  /** 单段环的基准：弦中点 m、默认鼓出方向 n0（单位向量）、基准幅度 L0（渲染帧坐标） */
  function stretchBaseline(pts, st) {
    const A = pts[st.a]; const B = pts[st.b];
    const m = { x: (A.x + B.x) / 2, y: (A.y + B.y) / 2 };
    let cx = 0; let cy = 0;
    for (let r = st.start; r <= st.end; r++) { cx += pts[r].x; cy += pts[r].y; }
    const cnt = st.end - st.start + 1;
    cx /= cnt; cy /= cnt;
    let dx0 = cx - m.x; let dy0 = cy - m.y;
    let L0 = Math.hypot(dx0, dy0);
    const chord = Math.hypot(B.x - A.x, B.y - A.y) || 1e-9;
    if (L0 < chord * 0.08) {
      // 退化（残基几乎落在弦上）：默认取弦的垂线方向
      dx0 = -(B.y - A.y) / chord; dy0 = (B.x - A.x) / chord;
      L0 = chord * 0.35;
    } else {
      dx0 /= L0; dy0 /= L0;
    }
    return { A, B, m, n0: { x: dx0, y: dy0 }, L0, chord };
  }

  /**
   * 环的形变：在刚性坐标（pts，已是渲染帧）之上，把每一段未配对残基
   * 沿二次贝塞尔重新铺开——两端锚点不动（连接不破），幅度 = k×基准，
   * 方向 = 基准方向旋转 tilt（多段环忽略 tilt）。
   */
  function deformLoopTo(tree, loop, pts, o) {
    if (!o || !loop.anchors) return;
    const stretches = loopStretches(tree, loop);
    if (!stretches.length) return;
    const multi = stretches.length !== 1;
    const k = Math.max(0.05, o.bulge == null ? 1 : o.bulge);
    const tiltDeg = multi ? 0 : (o.tilt || 0);
    if (k === 1 && !tiltDeg) return;
    const th = (tiltDeg * Math.PI) / 180;
    const c2 = Math.cos(th); const s2 = Math.sin(th);
    for (const st of stretches) {
      const b = stretchBaseline(pts, st);
      const nx = c2 * b.n0.x - s2 * b.n0.y;
      const ny = s2 * b.n0.x + c2 * b.n0.y;
      const ctrl = { x: b.m.x + nx * 2 * k * b.L0, y: b.m.y + ny * 2 * k * b.L0 };
      const cnt = st.end - st.start + 1;
      for (let idx = 0; idx < cnt; idx++) {
        const t = (idx + 1) / (cnt + 1);
        const u = 1 - t;
        pts[st.start + idx] = {
          x: u * u * b.A.x + 2 * u * t * ctrl.x + t * t * b.B.x,
          y: u * u * b.A.y + 2 * u * t * ctrl.y + t * t * b.B.y,
        };
      }
    }
  }

  /**
   * 给 UI / 测试用：环的锚点、基准方向与当前 apex（渲染帧坐标）。
   * 基准取自「剔除本环 override」的推算结果；apex = m + R(tilt)·n0 × k×L0。
   */
  function loopShape(tree, loopId, base, overrides) {
    const loop = tree.elements.get(loopId);
    if (!loop || !loop.anchors) return null;
    const ovAll = overrides || {};
    const ovRigid = { ...ovAll };
    delete ovRigid[loopId];
    const rigid = effectivePoints(base, tree, ovRigid);
    const stretches = loopStretches(tree, loop);
    if (!stretches.length) return null;
    let best = null;
    for (const st of stretches) {
      const b = stretchBaseline(rigid, st);
      if (!best || b.L0 > best.L0) best = { ...b, stretch: st };
    }
    const o = ovAll[loopId] || {};
    const k = Math.max(0.05, o.bulge == null ? 1 : o.bulge);
    const tiltDeg = stretches.length === 1 ? (o.tilt || 0) : 0;
    const th = (tiltDeg * Math.PI) / 180;
    const c2 = Math.cos(th); const s2 = Math.sin(th);
    const nx = c2 * best.n0.x - s2 * best.n0.y;
    const ny = s2 * best.n0.x + c2 * best.n0.y;
    const apex = { x: best.m.x + nx * k * best.L0, y: best.m.y + ny * k * best.L0 };
    return {
      anchors: loop.anchors.slice(),
      m: best.m, n0: best.n0, L0: best.L0, chord: best.chord,
      k, tiltDeg, apex, stretchCount: stretches.length,
    };
  }

  /* ── 碰撞检测与自动避让 ── */

  /** 坐标集的空间尺度（max(width, height)） */
  function ptsSpan(pts) {
    let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
    for (const p of pts) {
      if (p.x < minX) minX = p.x;
      if (p.x > maxX) maxX = p.x;
      if (p.y < minY) minY = p.y;
      if (p.y > maxY) maxY = p.y;
    }
    return Math.max(maxX - minX, maxY - minY, 1e-6);
  }

  /** 相邻碱基间距的中位数（图内坐标的“一格”有多大） */
  function medianSpacing(pts) {
    const gaps = [];
    for (let i = 0; i < pts.length - 1; i++) {
      gaps.push(Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y));
    }
    gaps.sort((a, b) => a - b);
    return gaps.length ? gaps[Math.floor(gaps.length / 2)] : 1;
  }

  /**
   * 找「移动组 vs 其余残基」的过近对（d < dMin）。
   * 排除：骨架相邻残基（|a-b|==1）与已有配对（含假结）。
   * @returns [{a, b, d}]，其中 a ∈ movedSet
   */
  function findCollisions(pts, movedSet, pairs, dMin) {
    const excluded = new Set();
    for (const [i, j] of normPairs(pairs || [])) excluded.add(`${i},${j}`);
    const cell = Math.max(dMin, 1e-9);
    const grid = new Map();
    const key = (gx, gy) => `${gx}:${gy}`;
    for (let b = 0; b < pts.length; b++) {
      if (movedSet.has(b)) continue;
      const k = key(Math.floor(pts[b].x / cell), Math.floor(pts[b].y / cell));
      if (!grid.has(k)) grid.set(k, []);
      grid.get(k).push(b);
    }
    const out = [];
    for (const a of movedSet) {
      const pa = pts[a];
      if (!pa) continue;
      const gx = Math.floor(pa.x / cell);
      const gy = Math.floor(pa.y / cell);
      for (let ox = -1; ox <= 1; ox++) {
        for (let oy = -1; oy <= 1; oy++) {
          const bucket = grid.get(key(gx + ox, gy + oy));
          if (!bucket) continue;
          for (const b of bucket) {
            if (Math.abs(a - b) === 1) continue;
            if (excluded.has(`${Math.min(a, b)},${Math.max(a, b)}`)) continue;
            const d = Math.hypot(pa.x - pts[b].x, pa.y - pts[b].y);
            if (d < dMin) out.push({ a, b, d });
          }
        }
      }
    }
    return out;
  }

  /**
   * 自动避让：只对被移动的 stem 做「最小刚体平移」迭代推开——
   * 推力 = 碰撞对沿 (moved − static) 方向之和；直到无碰撞、或到迭代/位移上限。
   * 位移以语义 override（dx/dy）写回，分支保持刚体。
   * @returns { overrides（新对象）, shifted, before, after }
   */
  function autoAvoid(tree, base, overrides, stemId, opts) {
    const o = opts || {};
    const maxIter = o.maxIter == null ? 20 : o.maxIter;
    const capRatio = o.capRatio == null ? 0.25 : o.capRatio;
    const stem = tree.elements.get(stemId);
    if (!stem || stem.type !== 'stem') {
      return { overrides: overrides || {}, shifted: false, before: 0, after: 0 };
    }
    const ov = { ...(overrides || {}) };
    const movedSet = new Set(subtreeResidues(tree, stemId));
    const span = o.span || ptsSpan(base);
    const dMin = o.dMin || medianSpacing(base) * 0.6;
    let pts = effectivePoints(base, tree, ov);
    let hits = findCollisions(pts, movedSet, o.pairs, dMin);
    const before = hits.length;
    if (!before) return { overrides: ov, shifted: false, before, after: 0 };

    const M = inheritedMatrix(tree, stemId, base, ov);
    const la = M[0]; const lb = M[1]; const lc = M[2]; const ld = M[3];
    const cur = ov[stemId] || { angle: 0, dx: 0, dy: 0 };
    let dx = cur.dx || 0;
    let dy = cur.dy || 0;
    const cap = span * capRatio;
    let shiftX = 0; let shiftY = 0;
    const prev = o.prev;                 // 拖拽前的 override：避不开时兜底回退

    for (let iter = 0; iter < maxIter && hits.length; iter++) {
      let px = 0; let py = 0;
      let maxPen = 0;
      for (const h of hits) {
        const pa = pts[h.a]; const pb = pts[h.b];
        let vx = pa.x - pb.x; let vy = pa.y - pb.y;
        const l = Math.hypot(vx, vy);
        if (l < 1e-9) { vx = 1; vy = 0; } else { vx /= l; vy /= l; }
        px += vx; py += vy;
        maxPen = Math.max(maxPen, dMin - h.d);
      }
      // 步长随最深穿透自适应（略过冲，避免长尾收敛慢）
      const step = Math.min(Math.max(maxPen * 1.1, dMin * 0.3), dMin * 1.5);
      const pl = Math.hypot(px, py);
      let wx; let wy;
      if (pl < 1e-9) {
        // 推力和相互抵消（被夹在中间）：沿第一对碰撞的垂直方向挪一挪，打破平衡
        let ux = pts[hits[0].a].x - pts[hits[0].b].x;
        let uy = pts[hits[0].a].y - pts[hits[0].b].y;
        const ul = Math.hypot(ux, uy) || 1;
        ux /= ul; uy /= ul;
        wx = -uy * step; wy = ux * step;
      } else {
        wx = (px / pl) * step; wy = (py / pl) * step;
      }
      // 渲染帧位移 → 基点帧（刚体矩阵线性部分可转置求逆）
      dx += la * wx + lb * wy;
      dy += lc * wx + ld * wy;
      shiftX += wx; shiftY += wy;
      ov[stemId] = { angle: cur.angle || 0, dx, dy };
      pts = effectivePoints(base, tree, ov);
      hits = findCollisions(pts, movedSet, o.pairs, dMin);
      if (Math.hypot(shiftX, shiftY) > cap) break;
    }

    let reverted = false;
    if (hits.length && prev !== undefined) {
      // 兜底：避不开就放回拖拽前的位置（保证不把重叠留在画面上）
      const pv = prev || {};
      if (pv.angle || pv.dx || pv.dy) {
        ov[stemId] = { angle: pv.angle || 0, dx: pv.dx || 0, dy: pv.dy || 0 };
      } else {
        delete ov[stemId];
      }
      reverted = true;
      const ptsR = effectivePoints(base, tree, ov);
      hits = findCollisions(ptsR, movedSet, o.pairs, dMin);
    }

    return {
      overrides: ov,
      shifted: dx !== (cur.dx || 0) || dy !== (cur.dy || 0),
      reverted,
      before,
      after: hits.length,
    };
  }

  /**
   * 计算有效坐标：基点 → 叠加全部 overrides（stem 刚体变换 + 环形变）。
   * @param {Array<{x:number,y:number}>} base 基点坐标（自动布局或旧 manualPoints）
   * @param {object} tree buildStructureTree 的返回
   * @param {object} overrides { [stemId]: {angle, dx, dy}, [loopId]: {bulge, tilt} }
   */
  function effectivePoints(base, tree, overrides) {
    if (!hasAnyOverride(overrides)) return base.map((p) => ({ ...p }));
    const ov = overrides;
    const out = new Array(base.length);

    // 通用遍历：stem 叠局部运动；环在锚点就绪后做形变（PK 元素与主树同一套遍历）
    const walk = (el, M) => {
      if (!el) return;
      const M2 = el.type === 'stem' ? localMatrixOf(tree, el, M, base, ov) : M;
      for (const i of el.residues) out[i] = applyM(M2, base[i]);
      for (const cid of el.children) walk(tree.elements.get(cid), M2);
      if (el.type !== 'stem' && el.anchors) deformLoopTo(tree, el, out, ov[el.id]);
    };

    walk(tree.elements.get(tree.rootId), IDENT);
    return out;
  }

  const api = {
    normPairs,
    pairsCross,
    crossingInvolved,
    nonCrossingSubset,
    buildStructureTree,
    subtreeResidues,
    subtreeIds,
    stemPivot,
    localMatrixOf,
    inheritedMatrix,
    loopStretches,
    loopShape,
    ptsSpan,
    medianSpacing,
    findCollisions,
    autoAvoid,
    mulM,
    applyM,
    rotationAbout,
    translationM,
    hasAnyOverride,
    pruneOverrides,
    effectivePoints,
  };

  global.RNAStruct = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})(typeof window !== 'undefined' ? window : globalThis);
