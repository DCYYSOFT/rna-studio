/* ─────────────────────────────────────────────────────────────────────────
   RNA Studio — 前端逻辑
   无构建步骤，纯 ES2020，直接由 FastAPI 静态托管。

   数据流：
     序列/约束 ──「折叠」──▶ /api/predict ──┐
                                          ├─▶ state ──▶ render() 画结构图
     画布上编辑配对 ─────▶ /api/evaluate ──┘
   编辑后只做「能量评估 + 重新排布」，不重跑折叠，所以是毫秒级反馈。
   ───────────────────────────────────────────────────────────────────────── */

'use strict';

/* ────────────────────────────── 状态 ────────────────────────────── */

const state = {
  mode: 'single',          // single | manual | cofold
  sequence: '',
  sequenceB: '',
  pairs: [],               // 当前展示结构的配对，0-based [[i,j], ...]
  breaks: [],              // 骨架断开处
  forbidden: new Set(),    // 禁止配对位点（0-based）
  selection: null,         // 当前选中的碱基索引
  engine: null,
  method: 'mfe',
  layout: 'naview',
  temperature: 37,
  colorMode: 'base',
  result: null,            // 最近一次 /api/predict 或 /api/evaluate 的返回
  probMap: new Map(),      // "i,j" -> p
  probingValues: null,     // 数组，用于按反应性着色
  varnaAlgo: 'naview',
  status: null,
  view: { x: 0, y: 0, w: 100, h: 100 },
  fitPending: true,
  // 编辑模式是画布交互的唯一开关，取代了早先「只读开关 + 排版开关」两个独立状态——
  // 那样会打架：排版模式下点两个碱基居然还会建立配对。
  editMode: 'pair',         // preview | pair | sequence | arrange
  domains: [],              // 结构域标注 [{name, start, end, color}]，0-based 闭区间
  locatedRange: null,       // 序列定位的高亮区间 [start, end]
  pdbGaps: [],              // PDB 未解析出的区域 [[start,end],...]，用灰带标出
  bindingSites: [],         // 配体结合位点 [{name, color, positions:[i,...]}]
  lastRenderedPoints: null, // 上一次真正画出来的坐标，用于折叠过渡动画
  lastRenderedPairs: [],
  invalidPairs: new Set(),  // 非经典配对（PDB 导入或改碱基所致），标紫提示但不自动解除
  manualPoints: null,       // 旧版手工坐标基线（兼容旧存档）；新版排版编辑只写 layoutOverrides
  layoutOverrides: {},      // 排版语义状态：{ stemId: {angle, dx, dy} }（基点坐标系，见 structure.js）
  pickedBase: null,         // 选中元素里的任一个碱基（索引），用于在结构变化后重新定位
  pickedUnit: null,         // 派生出来的选中元素 {kind:'stem'|'loop', id, bases, subtree?}
  detached: null,           // Set<helixId>：已断开为自由图形的螺旋
  snapGuides: [],           // 拖动时的对齐辅助线
  suppressAnim: false,      // 交互拖动/旋转期间关掉折叠过渡动画，否则动画会和手势打架
  stripNodes: [],           // 序列条的字符节点缓存，按索引取用
  stripHot: null,           // 序列条上当前高亮的字符
  canvasHot: null,          // 画布上因悬停序列条而高亮的碱基
  history: [],              // 结构编辑历史（快照栈）
  historyIndex: -1,         // 当前处在历史中的位置，-1 表示还没有记录
};

const BASE_COLORS = { A: '#4E9143', C: '#2F6FB5', G: '#D2912A', U: '#BE4A47' };

/* ── 结构树（由配对表推导；排版语义状态是 state.layoutOverrides） ── */

const RS = window.RNAStruct;

let treeCache = { key: null, tree: null };

/** 当前结构树（带缓存；配对变化时重建并清理失效的排版 override） */
function structureTree() {
  const key = `${state.sequence.length}|${state.pairs.map((p) => `${p[0]}-${p[1]}`).join(',')}`;
  if (treeCache.key !== key) {
    treeCache = { key, tree: RS.buildStructureTree(state.pairs, state.sequence.length) };
    const pr = RS.pruneOverrides(treeCache.tree, state.layoutOverrides);
    if (pr.dropped.length) state.layoutOverrides = pr.kept;
  }
  return treeCache.tree;
}

/** 基点坐标：旧存档的 manualPoints 优先，否则用后端自动布局 */
function basePoints() {
  if (state.manualPoints) return state.manualPoints;
  const L = state.result && state.result.layout;
  return L ? L.points : null;
}

/** 一组坐标的包围盒（排版后给取景 / 吸附 / 导出用） */
function boundsOf(pts) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const p of pts) {
    if (p.x < minX) minX = p.x;
    if (p.x > maxX) maxX = p.x;
    if (p.y < minY) minY = p.y;
    if (p.y > maxY) maxY = p.y;
  }
  const span = Math.max(maxX - minX, maxY - minY, 1e-6);
  return { minX, minY, maxX, maxY, span };
}

/** 当前应绘制的有效坐标 = 基点 + layoutOverrides */
function effectivePoints() {
  const base = basePoints();
  if (!base) return null;
  if (!RS.hasAnyOverride(state.layoutOverrides)) return base;
  return RS.effectivePoints(base, structureTree(), state.layoutOverrides);
}

/** 把角度规范到 (-180°, 180°] 并格式化 */
function fmtDeg(deg) {
  const d = ((deg % 360) + 540) % 360 - 180;
  return `${d.toFixed(1)}°`;
}

/** 环类型的中文显示名 */
const LOOP_NAMES = {
  hairpin: '发夹环', internal_loop: '内部环', bulge: '凸环', junction: '多重环', exterior: '外部环',
};
function loopName(u) {
  return LOOP_NAMES[(u.element && u.element.type) || ''] || '环';
}

/* ────────────────────────────── DOM ────────────────────────────── */

const $ = (id) => document.getElementById(id);
const el = {
  seq: $('seq'), seqB: $('seq-b'), cofoldBlock: $('cofold-block'),
  statLen: $('stat-len'), statGc: $('stat-gc'), statPairs: $('stat-pairs'),
  statModeWrap: $('stat-mode-wrap'),
  btnFold: $('btn-fold'), btnMfe: $('btn-mfe'), btnReset: $('btn-reset'),
  engine: $('engine'), engineHint: $('engine-hint'),
  method: $('method'), methodWrap: $('method-wrap'), methodHint: $('method-hint'),
  layout: $('layout'), temperature: $('temperature'),
  constraints: $('constraints'), statForced: $('stat-forced'),
  statForbidden: $('stat-forbidden'), btnClearCons: $('btn-clear-cons'),
  btnConsFromStruct: $('btn-cons-from-struct'),
  probingMethod: $('probing-method'), probingBlock: $('probing-block'),
  probingData: $('probing-data'), probingM: $('probing-m'), probingB: $('probing-b'),
  decomp: $('decomp'),
  varnaAlgo: $('varna-algo'), colorMode: $('color-mode'),
  bpstyleWrap: $('bpstyle-wrap'), bpstyle: $('bpstyle'), periodNum: $('period-num'),
  btnSvg: $('btn-svg'), svgScope: $('svg-scope'),
  btnUndo: $('btn-undo'), btnRedo: $('btn-redo'),
  editMode: $('edit-mode'), readonlyBanner: $('readonly-banner'),
  btnCompare: $('btn-compare'), compareOverlay: $('compare-overlay'),
  compareLeft: $('compare-left'), compareRight: $('compare-right'),
  compareLeftDg: $('compare-left-dg'), compareRightDg: $('compare-right-dg'),
  compareSummary: $('compare-summary'), compareDetail: $('compare-detail'),
  historyList: $('history-list'),
  locateInput: $('locate-input'), btnLocate: $('btn-locate'),
  bpStyleDraw: $('bp-style-draw'),
  btnPdbOpen: $('btn-pdb-open'), pdbDialog: $('pdb-dialog'),
  pdbStepFile: $('pdb-step-file'), pdbStepChain: $('pdb-step-chain'),
  pdbDrop: $('pdb-drop'), pdbFile: $('pdb-file'), pdbChoose: $('pdb-choose'),
  pdbText: $('pdb-text'), pdbRead: $('pdb-read'), pdbRestart: $('pdb-restart'),
  pdbFilename: $('pdb-filename'), pdbChain: $('pdb-chain'), pdbChainHint: $('pdb-chain-hint'),
  pdbReference: $('pdb-reference'), pdbRefHint: $('pdb-ref-hint'),
  pdbNoncanon: $('pdb-noncanon'), pdbNested: $('pdb-nested'), pdbSetseq: $('pdb-setseq'),
  pdbSummary: $('pdb-summary'), pdbError: $('pdb-error'),
  pdbCancel: $('pdb-cancel'), pdbImport: $('pdb-import'),
  bindingList: $('binding-list'),
  stripBody: $('seq-strip-body'), stripHint: $('seq-strip-hint'),
  btnStripToggle: $('btn-strip-toggle'), seqStrip: $('seq-strip'),
  arrangeBanner: $('arrange-banner'),
  arrangeSel: $('arrange-sel'),
  btnRestoreLayout: $('btn-restore-layout'),
  baseEditor: $('base-editor'), baseEditorPos: $('base-editor-pos'),
  baseEditorCur: $('base-editor-cur'), baseEditorBtns: $('base-editor-btns'),
  domainName: $('domain-name'), domainStart: $('domain-start'), domainEnd: $('domain-end'),
  domainList: $('domain-list'), btnDomainAdd: $('btn-domain-add'),
  btnDomainFromRange: $('btn-domain-from-range'), btnFoldDomains: $('btn-fold-domains'),
  statHistory: $('stat-history'), statHistoryPos: $('stat-history-pos'),
  exportDialog: $('export-dialog'), exportTitle: $('export-title'),
  exportSub: $('export-sub'), exportPreview: $('export-preview'),
  exportError: $('export-error'), exportSaveButtons: $('export-save-buttons'),
  varnaHint: $('varna-hint'),
  btnVarnaSvg: $('btn-varna-svg'),
  btnImport: $('btn-import'), importDialog: $('import-dialog'), importFmt: $('import-fmt'),
  importText: $('import-text'), importError: $('import-error'),
  mDg: $('m-dg'), mMfe: $('m-mfe'), mDd: $('m-dd'), mEngine: $('m-engine'), mLayout: $('m-layout'),
  canvas: $('canvas'), canvasScroll: $('canvas-scroll'), canvasEmpty: $('canvas-empty'),
  hoverReadout: $('hover-readout'), legend: $('legend'),
  messages: $('messages'), outStruct: $('out-struct'), outSeq: $('out-seq'),
  toast: $('toast'), busy: $('busy'), busyText: $('busy-text'),
  btnStatus: $('btn-status'), statusPanel: $('status-panel'),
  modeBtns: Array.from(document.querySelectorAll('.mode-btn')),
};

/* ────────────────────────────── 工具 ────────────────────────────── */

let busyCount = 0;
function setBusy(on, text) {
  busyCount += on ? 1 : -1;
  busyCount = Math.max(0, busyCount);
  el.busy.hidden = busyCount === 0;
  if (text) el.busyText.textContent = text;
}

let toastTimer = null;
function toast(msg, ms = 2600) {
  el.toast.textContent = msg;
  el.toast.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => { el.toast.hidden = true; }, ms);
}

async function api(path, body) {
  const res = await fetch(path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  });
  const text = await res.text();
  let data = null;
  try { data = text ? JSON.parse(text) : null; } catch { /* 非 JSON 响应 */ }
  if (!res.ok) {
    const detail = (data && data.detail) ? data.detail : text || `HTTP ${res.status}`;
    throw new Error(typeof detail === 'string' ? detail : JSON.stringify(detail));
  }
  return data;
}

function cleanSeq(s) {
  return (s || '')
    .split('\n')
    .filter((l) => !l.trim().startsWith('>'))
    .join('')
    .replace(/[^A-Za-z]/g, '')
    .toUpperCase()
    .replace(/T/g, 'U');
}

/* 点括号 ⇄ 配对表（与后端 dotbracket.py 的行为保持一致） */

const OPEN = '([{<', CLOSE = ')]}>';
const PAIR_OF = { ')': '(', ']': '[', '}': '{', '>': '<' };

function parseStructure(db) {
  const stacks = { '(': [], '[': [], '{': [], '<': [] };
  const pairs = [];
  const bracketOf = new Map();   // i -> 'open' | 'close'
  for (let i = 0; i < db.length; i++) {
    const c = db[i];
    if (OPEN.includes(c)) { stacks[c].push(i); bracketOf.set(i, 'open'); }
    else if (CLOSE.includes(c)) {
      const o = PAIR_OF[c];
      if (!stacks[o] || !stacks[o].length) continue;
      const j = stacks[o].pop();
      pairs.push([j, i]);
      bracketOf.set(j, 'open'); bracketOf.set(i, 'close');
    }
  }
  pairs.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
  return { pairs, bracketOf };
}

/** 配对表 → 点括号串。交叉配对自动换用不同括号类型（假结）。 */
function pairsToStructure(n, pairs) {
  const out = new Array(n).fill('.');
  const used = new Set();
  const sorted = [...pairs].sort((a, b) => (a[1] - a[0]) - (b[1] - b[0]));
  for (const [i, j] of sorted) {
    if (used.has(i) || used.has(j)) continue;
    for (let t = 0; t < OPEN.length; t++) {
      let conflict = false;
      const opens = [];
      for (let k = 0; k < n; k++) {
        if (out[k] === OPEN[t]) opens.push(k);
        else if (out[k] === CLOSE[t] && opens.length) {
          const a = opens.pop(), b = k;
          if (!(j < a || i > b || (i < a && j > b) || (a < i && b > j))) { conflict = true; break; }
        }
      }
      if (!conflict) { out[i] = OPEN[t]; out[j] = CLOSE[t]; used.add(i); used.add(j); break; }
    }
  }
  return out.join('');
}

function pairMap() {
  const m = new Map();
  for (const [i, j] of state.pairs) { m.set(i, j); m.set(j, i); }
  return m;
}

/* ────────────────────── 约束串 ⇄ 状态 ────────────────────── */

function resetConstraintString(n) {
  el.constraints.value = '.'.repeat(n);
}

function constraintCounts() {
  const s = (el.constraints.value || '').replace(/\s/g, '');
  const forced = (s.match(/[([]/g) || []).length
    + (s.match(/[<{]/g) || []).length;
  const forbidden = (s.match(/[xX]/g) || []).length;
  return { forced, forbidden, len: s.length };
}

function syncConstraintReadouts() {
  const c = constraintCounts();
  el.statForced.textContent = c.forced;
  el.statForbidden.textContent = c.forbidden;
  const n = state.sequence.length;
  if (c.len && n && c.len !== n) {
    el.constraints.setCustomValidity?.('');
    el.constraints.classList.add('is-invalid');
  } else {
    el.constraints.classList.remove('is-invalid');
  }
}

/** 用当前画布上的结构 + 已有的 x 标记，重写约束串 */
function constraintFromStructure() {
  const n = state.sequence.length;
  const buf = new Array(n).fill('.');
  const old = (el.constraints.value || '').replace(/\s/g, '');
  for (let i = 0; i < n; i++) if (old[i] === 'x' || old[i] === 'X') buf[i] = 'x';
  for (const [i, j] of state.pairs) { buf[i] = '('; buf[j] = ')'; }
  el.constraints.value = buf.join('');
  syncConstraintReadouts();
}

/* ────────────────────────────── 序列同步 ────────────────────────────── */

function syncSequence() {
  const raw = el.seq.value;
  const seq = cleanSeq(raw);
  const changed = seq !== state.sequence;
  state.sequence = seq;

  const n = seq.length;
  el.statLen.textContent = n;
  const gc = n ? Math.round(((seq.match(/[GC]/g) || []).length / n) * 100) : 0;
  el.statGc.textContent = n ? gc + '%' : '–';

  if (changed) {
    state.pairs = [];
    state.breaks = [];
    state.forbidden.clear();
    state.selection = null;
    state.result = null;
    state.probMap.clear();
    state.lastRenderedPoints = null;   // 换了序列，谈不上「过渡」
    state.domains = [];
    state.locatedRange = null;
    state.pdbGaps = [];
    state.history = [];          // 换了序列，旧的历史没有意义
    state.historyIndex = -1;
    renderHistory();
    updateHistoryButtons();
    resetConstraintString(n);
    el.statPairs.textContent = 0;
    state.fitPending = true;
    el.canvasEmpty.hidden = false;
    el.canvas.innerHTML = '';
    renderMeter(null);
    el.outStruct.textContent = '';
    el.outSeq.textContent = '';
    el.decomp.innerHTML = '<p class="empty">折叠或评估后显示逐环能量。</p>';
    clearMessages();
  }
  // 注意：这一行必须在 if (changed) 里面。放到外面的话，每次 doEvaluate 调
  // syncSequence 都会把非经典配对的标注清掉——导入 PDB 时刚标好的紫色就没了。
  if (changed) state.invalidPairs = new Set();

  syncConstraintReadouts();
  el.statModeWrap.hidden = state.mode === 'cofold';
  renderSeqStrip();
}

/* ────────────────────────────── 渲染 ────────────────────────────── */

function colorForValue(v) {
  // 白 → 中蓝 → 深蓝，与 .legend-ramp 保持一致
  const stops = [[255, 255, 255], [78, 147, 207], [20, 58, 99]];
  const t = Math.max(0, Math.min(1, v));
  const seg = t < 0.5 ? 0 : 1;
  const local = t < 0.5 ? t / 0.5 : (t - 0.5) / 0.5;
  const a = stops[seg], b = stops[seg + 1];
  return a.map((x, k) => Math.round(x + (b[k] - x) * local));
}

function rgbCss(rgb) {
  return `rgb(${rgb[0]},${rgb[1]},${rgb[2]})`;
}

/** 深底用白字、浅底用深字，否则热图上的字母会看不清 */
function textColorOn(rgb) {
  const lum = (0.299 * rgb[0] + 0.587 * rgb[1] + 0.114 * rgb[2]) / 255;
  return lum < 0.55 ? '#FFFFFF' : '#1A2432';
}

/** 每个碱基一个着色数值；返回 null 表示用碱基种类配色 */
function colorValues() {
  const n = state.sequence.length;
  if (state.colorMode === 'rainbow') {
    // 0 → 1 沿序列均匀分布，交给彩虹渐变映射
    return Array.from({ length: n }, (_, i) => (n > 1 ? i / (n - 1) : 0));
  }
  if (state.colorMode === 'probing') {
    if (!state.probingValues || state.probingValues.length !== n) return null;
    const vals = state.probingValues.map((v) => (v == null || v < 0 ? 0 : v));
    const max = Math.max(1e-6, ...vals);
    return vals.map((v) => v / max);
  }
  if (state.colorMode === 'pairprob') {
    const out = new Array(n).fill(0);
    const pm = pairMap();
    for (const [i, j] of state.pairs) {
      const p = state.probMap.get(`${i},${j}`) ?? state.probMap.get(`${j},${i}`) ?? 0;
      out[i] = p; out[j] = p;
    }
    void pm;
    return out;
  }
  return null;
}

function renderLegend() {
  if (state.colorMode === 'rainbow') {
    el.legend.innerHTML = '<span class="legend-item">5′</span>'
      + '<span class="legend-item"><span class="legend-rainbow"></span></span>'
      + '<span class="legend-item">3′</span>'
      + '<span class="legend-item" style="color:var(--muted-solid)">按位置渐变着色，便于追踪链的走向</span>';
    return;
  }
  if (state.colorMode === 'base') {
    el.legend.innerHTML = ['A', 'C', 'G', 'U']
      .map((b) => `<span class="legend-item"><span class="legend-swatch" style="background:${BASE_COLORS[b]}"></span>${b}</span>`)
      .join('') + '<span class="legend-item" style="color:var(--muted-solid)">点击两个碱基建立配对 · 右键解除 · Alt+点击标记禁配</span>';
  } else if (state.colorMode === 'pairprob') {
    el.legend.innerHTML = '<span class="legend-item">配对概率</span>'
      + '<span class="legend-item">0<span class="legend-ramp"></span>1</span>'
      + '<span class="legend-item" style="color:var(--muted-solid)">按所画配对的概率着色</span>';
  } else {
    el.legend.innerHTML = '<span class="legend-item">探测反应性</span>'
      + '<span class="legend-item">低<span class="legend-ramp"></span>高</span>'
      + '<span class="legend-item" style="color:var(--muted-solid)">高反应性 = 更可能处于单链</span>';
  }
}

/* ────────────────────── 通用绘制（主画布与对照视图共用） ────────────────────── */

const SVG_NS = 'http://www.w3.org/2000/svg';

function mk(tag, attrs) {
  const e = document.createElementNS(SVG_NS, tag);
  for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
  return e;
}

/**
 * 计算绘制所需的几何量。
 *
 * 所有尺寸都从「相邻碱基间距的中位数」推导：三种布局的坐标尺度相差几个
 * 数量级（naview 约 15/碱基，环形约 0.08，线性恒为 1），用绝对尺寸会让
 * 某种布局整个塌掉。
 */
function computeGeometry(layout, breaks, n) {
  const pts = layout.points;
  const b = layout.bounds;
  const breakSet = new Set(breaks || []);

  const gaps = [];
  for (let i = 0; i < n - 1; i++) {
    if (breakSet.has(i)) continue;
    gaps.push(Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y));
  }
  gaps.sort((p, q) => p - q);
  const gap = gaps.length
    ? gaps[Math.floor(gaps.length / 2)]
    : Math.max(1e-9, b.span / Math.max(n, 1));

  const r = gap * 0.40;         // 碱基圆半径
  const pad = r * 4.2;
  return {
    pts, bounds: b, breakSet,
    r,
    fs: r * 1.15,               // 碱基字母字号（略小于圆直径）
    pad,
    vb: {
      x: b.minX - pad, y: b.minY - pad,
      w: (b.maxX - b.minX) + pad * 2, h: (b.maxY - b.minY) + pad * 2,
    },
  };
}

/**
 * 把一个结构画进指定的 <svg>。
 *
 * 主画布和对照视图的两个面板都走这个函数，避免两套绘制逻辑各写一遍后走偏。
 *
 * ctx:
 *   sequence     序列字符串
 *   layout       /api/layout 或预测返回的 layout 对象
 *   pairs        [[i, j], ...]
 *   breaks       骨架断开处
 *   forbidden    Set<number> 禁配位点
 *   selected     当前选中碱基索引或 null
 *   colorMap     每碱基着色数值数组，null 表示按碱基种类配色
 *   period       编号周期，0 表示不画编号
 *   diffPairs    Set<'i,j'>，其中的配对会高亮（对照视图用来标出「只在一边出现」的配对）
 *   bands        [{start, end, color, label}] 区段标注；结构域和序列定位都用它，
 *                画成沿骨架的粗色带（像荧光笔划过），可带名字
 *   interactive  是否响应鼠标（只读模式或对照视图里关掉）
 */
function drawStructure(svgEl, ctx) {
  const {
    sequence, layout, pairs = [], breaks = [], forbidden = new Set(),
    selected = null, colorMap = null, period = 0, diffPairs = null,
    bands = [], interactive = true, colorRamp = null, bpStyle = '',
    invalidPairs = null, pkPairs = null, bindingSites = null,
  } = ctx;

  const n = sequence.length;
  svgEl.innerHTML = '';
  if (!n || !layout || !layout.points || !layout.points.length) return null;

  const { pts, r, fs, vb, breakSet } = computeGeometry(layout, breaks, n);

  // 把坐标尺度暴露给 CSS：所有线宽/虚线间隔都写成 --u 的倍数，
  // 这样在 naview / 环形 / 线性三种尺度下都不会失控。
  svgEl.style.setProperty('--u', String(r));
  svgEl.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  svgEl.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // 编号字号：几何上跟 r 走，但保证换算到屏幕像素后至少约 10px，
  // 否则在「线性」这类间距很小的布局里数字会小到看不清。
  const cw = svgEl.clientWidth || 1000;
  const chh = svgEl.clientHeight || 700;
  const pxScale = Math.min(cw / vb.w, chh / vb.h) || 1;
  const numFs = Math.max(r * 0.95, 10 / pxScale);

  const pm = new Map();
  for (const [i, j] of pairs) { pm.set(i, j); pm.set(j, i); }
  const selPartner = selected != null ? pm.get(selected) : undefined;
  const isLinear = layout.layout === 'linear';

  /* 1. 骨架 */
  const gBack = mk('g', { class: 'backbone-group' });
  for (let i = 0; i < n - 1; i++) {
    if (breakSet.has(i)) continue;
    gBack.appendChild(mk('line', {
      class: 'backbone', 'data-i': i,
      x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y,
    }));
  }
  svgEl.appendChild(gBack);

  /* 1.5 区段标注：沿骨架铺一条粗色带，像荧光笔划过。
     画在碱基之下，所以不会挡住字母；半透明让骨架仍可见。 */
  if (bands.length) {
    const gBand = mk('g', {});
    for (const bd of bands) {
      const bs = Math.max(0, bd.start | 0);
      const be = Math.min(n - 1, bd.end | 0);
      if (be <= bs) continue;
      const poly = [];
      for (let i = bs; i <= be; i++) poly.push(`${pts[i].x},${pts[i].y}`);
      gBand.appendChild(mk('polyline', {
        class: 'domain-band',
        points: poly.join(' '),
        stroke: bd.color || '#2F6FB5',
        'stroke-width': r * 1.25,
        'stroke-linecap': 'round',
        'stroke-linejoin': 'round',
        fill: 'none',
        opacity: 0.5,
      }));
    }
    svgEl.appendChild(gBand);
  }

  /* 2. 配对 */
  const gPairs = mk('g', {});

  // 「色带」画法：把连续堆叠的螺旋合并成一条粗带，看起来就像螺旋本身。
  let ribbonRuns = null;
  if (bpStyle === 'ribbon') {
    const sorted = [...pairs].filter(([i, j]) => i < pts.length && j < pts.length)
      .map(([i, j]) => (i < j ? [i, j] : [j, i])).sort((a, b) => a[0] - b[0]);
    ribbonRuns = [];
    let run = null;
    for (const [i, j] of sorted) {
      if (run && i === run[run.length - 1][0] + 1 && j === run[run.length - 1][1] - 1) {
        run.push([i, j]);
      } else { run = [[i, j]]; ribbonRuns.push(run); }
    }
  }
  const inRibbon = new Set();
  if (ribbonRuns) {
    for (const run of ribbonRuns) {
      for (const [i, j] of run) inRibbon.add(`${i},${j}`);
      if (run.length < 2) continue;
      const mids = run.map(([i, j]) => `${(pts[i].x + pts[j].x) / 2},${(pts[i].y + pts[j].y) / 2}`);
      gPairs.appendChild(mk('polyline', {
        class: 'bp-ribbon', points: mids.join(' '),
        'stroke-width': r * 1.9, stroke: '#2F6FB5',
        'stroke-linecap': 'round', 'stroke-linejoin': 'round',
        fill: 'none', opacity: 0.5,
      }));
    }
  }

  for (const [i, j] of pairs) {
    if (i >= pts.length || j >= pts.length) continue;
    const inSel = selected != null && (i === selected || j === selected);
    const isDiff = diffPairs ? diffPairs.has(`${i},${j}`) : false;
    // 非经典配对：既包括从 PDB 导入的天然非经典配对，也包括改碱基后
    // 变得不合法的配对。只做标注，不自动解除。
    const isBad = invalidPairs ? invalidPairs.has(`${i},${j}`) || invalidPairs.has(`${j},${i}`) : false;
    // 假结（交叉配对）用红虚线单独标出。这一段在早先重构 drawStructure 时被漏掉了，
    // 结果假结在图上和普通配对长得一样、看不出来，属于回归。
    const isPk = pkPairs ? pkPairs.has(`${i},${j}`) || pkPairs.has(`${j},${i}`) : false;
    const cls = 'bp-line' + (isDiff ? ' is-diff' : '') + (isPk ? ' is-pk' : '')
      + (isBad ? ' is-noncanon' : '') + (inSel ? ' is-sel' : '');

    // 梯形画法：每对画成一小段横杠，视觉上像螺旋的梯级
    if (bpStyle === 'ladder') {
      const mx = (pts[i].x + pts[j].x) / 2;
      const my = (pts[i].y + pts[j].y) / 2;
      const dx = pts[j].x - pts[i].x, dy = pts[j].y - pts[i].y;
      const len = Math.hypot(dx, dy) || 1;
      const hw = Math.min(len * 0.24, r * 0.9);
      gPairs.appendChild(mk('line', {
        class: cls + ' is-rung',
        x1: mx - (dx / len) * hw, y1: my - (dy / len) * hw,
        x2: mx + (dx / len) * hw, y2: my + (dy / len) * hw,
        opacity: inSel ? 1 : 0.95,
        'data-a': Math.min(i, j), 'data-b': Math.max(i, j),
      }));
      continue;
    }
    if (bpStyle === 'ribbon' && inRibbon.has(`${i},${j}`)) continue;
    if (isLinear) {
      // 线性布局：配对画成上方的半圆弧（sweep=1 在屏幕坐标系里向上鼓），
      // 否则会与骨架线和碱基重叠。
      const rad = Math.abs(pts[j].x - pts[i].x) / 2;
      if (rad < 1e-9) continue;
      gPairs.appendChild(mk('path', {
        d: `M ${pts[i].x} ${pts[i].y} A ${rad} ${rad} 0 0 1 ${pts[j].x} ${pts[j].y}`,
        fill: 'none', class: cls, opacity: inSel ? 1 : 0.85,
        'data-a': Math.min(i, j), 'data-b': Math.max(i, j),
      }));
    } else {
      gPairs.appendChild(mk('line', {
        class: cls,
        x1: pts[i].x, y1: pts[i].y, x2: pts[j].x, y2: pts[j].y,
        opacity: inSel ? 1 : 0.85,
        'data-a': Math.min(i, j), 'data-b': Math.max(i, j),
      }));
    }
  }
  svgEl.appendChild(gPairs);

  /* 3. 碱基 */
  const gNt = mk('g', {});
  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const base = sequence[i] || 'N';
    const g = mk('g', { class: 'nt', 'data-i': i });
    if (i === selected) g.classList.add('is-selected');
    else if (selPartner === i) g.classList.add('is-partnered');
    if (forbidden.has(i)) g.classList.add('is-forbidden');
    if (!interactive) g.classList.add('is-static');

    // 配体结合位点：在碱基外面再套一圈，表示「这个碱基和配体有接触」
    const siteColor = bindingSites ? bindingSites.get(i) : null;
    if (siteColor) {
      g.appendChild(mk('circle', {
        class: 'nt-ring', cx: p.x, cy: p.y, r: r * 1.42,
        fill: 'none', stroke: siteColor,
        'stroke-width': r * 0.30, opacity: 0.75,
      }));
    }

    const rgb = colorMap ? (colorRamp || colorForValue)(colorMap[i]) : null;
    g.appendChild(mk('circle', {
      class: 'nt-circle',
      cx: p.x, cy: p.y, r,
      fill: rgb ? rgbCss(rgb) : '#FFFFFF',
      stroke: colorMap ? '#5A6675' : (BASE_COLORS[base] || '#8A93A0'),
      'stroke-width': r * 0.28,
      'data-i': i,
    }));
    const t = mk('text', {
      class: 'nt-text',
      x: p.x, y: p.y,
      'text-anchor': 'middle', 'dominant-baseline': 'central',
      'font-size': fs,
      fill: rgb ? textColorOn(rgb) : (BASE_COLORS[base] || '#4A5563'),
    });
    t.textContent = base;
    g.appendChild(t);
    gNt.appendChild(g);
  }
  svgEl.appendChild(gNt);

  /* 3.5 区段名字：沿背离结构中心方向偏移，与编号同一套逻辑 */
  if (bands.length) {
    const gLabel = mk('g', {});
    const cx0 = pts.reduce((t, q) => t + q.x, 0) / n;
    const cy0 = pts.reduce((t, q) => t + q.y, 0) / n;
    for (const bd of bands) {
      if (!bd.label) continue;
      const bs = Math.max(0, bd.start | 0);
      const be = Math.min(n - 1, bd.end | 0);
      if (be <= bs) continue;
      const mid = (bs + be) >> 1;
      const pm = pts[mid];
      const prev = pts[Math.max(0, mid - 1)];
      let dx = pm.x - prev.x, dy = pm.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      let nx = -dy, ny = dx;
      if ((pm.x - cx0) * nx + (pm.y - cy0) * ny < 0) { nx = -nx; ny = -ny; }
      const off = r * 3.4;
      const t = mk('text', {
        class: 'domain-label',
        x: pm.x + nx * off, y: pm.y + ny * off,
        'text-anchor': 'middle', 'dominant-baseline': 'middle',
        'font-size': r * 1.35,
        fill: bd.color || '#2F6FB5',
      });
      t.textContent = bd.label;
      gLabel.appendChild(t);
    }
    svgEl.appendChild(gLabel);
  }

  /* 4. 编号 */
  if (period > 0 && n > 0) {
    const gNum = mk('g', {});
    const cx0 = pts.reduce((s, q) => s + q.x, 0) / n;
    const cy0 = pts.reduce((s, q) => s + q.y, 0) / n;

    /**
     * 编号沿「垂直于骨架」方向偏移，但取背离结构中心的那一侧。
     * 只按垂直方向取符号的话，在螺旋区会把编号正好压到配对链的碱基上；
     * 以结构中心定符号后，螺旋区往螺旋外侧、环区往环外侧，都不会压到碱基。
     */
    const labelAt = (idx, out = 1.75) => {
      const p = pts[idx];
      const prev = pts[Math.max(0, idx - 1)];
      let dx = p.x - prev.x, dy = p.y - prev.y;
      const len = Math.hypot(dx, dy) || 1;
      dx /= len; dy /= len;
      let nx = -dy, ny = dx;
      if ((p.x - cx0) * nx + (p.y - cy0) * ny < 0) { nx = -nx; ny = -ny; }
      const off = r * out;
      const t = mk('text', {
        class: 'nt-num', 'data-i': idx,
        // 记录偏移量，动画时按同样的方向跟着碱基走
        'data-ox': nx * off, 'data-oy': ny * off,
        x: p.x + nx * off, y: p.y + ny * off,
        'text-anchor': 'middle', 'dominant-baseline': 'middle',
        'font-size': numFs,
      });
      t.textContent = String(idx + 1);
      return t;
    };
    let lastLabeled = -1;
    for (let i = period - 1; i < n; i += period) {
      gNum.appendChild(labelAt(i));
      lastLabeled = i;
    }
    // 末端编号：与上一个周期标号离得太近就跳过，避免叠字
    if (lastLabeled !== n - 1) {
      const dist = Math.hypot(
        pts[n - 1].x - pts[lastLabeled].x,
        pts[n - 1].y - pts[lastLabeled].y,
      );
      if (lastLabeled < 0 || dist > r * 3.2) gNum.appendChild(labelAt(n - 1, 2.1));
    }
    svgEl.appendChild(gNum);
  }

  return { vb, r };
}

/** 碱基索引 → 结合位点颜色，供绘图时套外圈 */
function bindingSiteMap() {
  const m = new Map();
  for (const s of state.bindingSites) {
    for (const i of s.positions) m.set(i, s.color);
  }
  return m;
}

/** 把交叉配对展开成 'i,j' 集合，供绘图时标红 */
function pseudoKnotPairSet() {
  const s = new Set();
  const cp = state.result && state.result.crossing_pairs;
  if (!cp) return s;
  for (const [a, b] of cp) {
    s.add(`${a[0]},${a[1]}`); s.add(`${b[0]},${b[1]}`);
    s.add(`${a[1]},${a[0]}`); s.add(`${b[1]},${b[0]}`);
  }
  return s;
}

/** 主画布渲染 */
function render() {
  const n = state.sequence.length;

  // 点阵图是完全不同的呈现方式，不走结构布局那套
  if (el.layout.value === 'dotplot') {
    if (n) void drawDotPlot();
    else { el.canvas.innerHTML = ''; el.canvasEmpty.hidden = false; }
    return;
  }

  if (!n || !state.result || !state.result.layout || !state.result.layout.points.length) {
    el.canvasEmpty.hidden = false;
    el.legend.innerHTML = '';
    el.canvas.innerHTML = '';
    return;
  }
  el.canvasEmpty.hidden = true;
  renderLegend();

  // 基点坐标之上叠加语义排版（layoutOverrides）得到本次要画的坐标
  const ptsEff = effectivePoints();
  if (!ptsEff) return;
  const layoutForDraw = { ...state.result.layout, points: ptsEff, bounds: boundsOf(ptsEff) };

  if (state.suppressAnim) state.lastRenderedPoints = null;
  const geo = drawStructure(el.canvas, {
    sequence: state.sequence,
    layout: layoutForDraw,
    pairs: state.pairs,
    breaks: allBreaks(),
    forbidden: state.forbidden,
    selected: state.selection,
    colorMap: colorValues(),
    period: parseInt(el.periodNum.value, 10) || 0,
    bands: activeBands(),
    interactive: !isReadOnly(),
    colorRamp: state.colorMode === 'rainbow' ? rainbowColor : null,
    bpStyle: el.bpStyleDraw ? el.bpStyleDraw.value : '',
    invalidPairs: state.invalidPairs,
    pkPairs: pseudoKnotPairSet(),
    bindingSites: bindingSiteMap(),
  });

  if (!geo) return;
  if (state.fitPending) { state.view = { ...geo.vb }; state.fitPending = false; }
  state.fitView = { ...geo.vb };   // 供「整幅结构」出图取景使用
  applyViewBox();

  // 折叠过渡动画：让碱基从上一帧的位置弹性地滑到新位置。
  // 若位置没有实质变化（如只是切换配色）就跳过，免得白跑一遍。
  // 排版模式下叠加选择框与对齐辅助线（画在结构之上）
  if (isArrange() && !isReadOnly()) {
    if (state.pickedBase != null) state.pickedUnit = pickElement(state.pickedBase);
    drawSelectionOverlay(el.canvas, layoutForDraw.points, geo.r);
    drawSnapGuides(el.canvas, geo.r, layoutForDraw.bounds.span);
  }

  const newPts = layoutForDraw.points;
  const prevPts = state.lastRenderedPoints;
  let moved = false;
  if (prevPts && prevPts.length === newPts.length) {
    for (let i = 0; i < newPts.length; i++) {
      if (Math.hypot(newPts[i].x - prevPts[i].x, newPts[i].y - prevPts[i].y) > 1e-6) {
        moved = true; break;
      }
    }
  }
  if (moved && !state.suppressAnim) {
    animateFold(el.canvas, prevPts, newPts, state.lastRenderedPairs, state.pairs);
  }
  state.lastRenderedPoints = newPts.map((q) => ({ x: q.x, y: q.y }));
  state.lastRenderedPairs = state.pairs.map((q) => [q[0], q[1]]);
}

function applyViewBox() {
  const v = state.view;
  el.canvas.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
  el.canvas.setAttribute('preserveAspectRatio', 'xMidYMid meet');
}

/* ───────────────────────── 悬停 / 点击 ───────────────────────── */

/**
 * 只更新选中的高亮类，不重建 SVG。
 *
 * 为什么不能直接 render()：重建会把碱基元素全部换掉，双击的第二次点击
 * 落到已经被移除的旧节点上，浏览器就不再派发 dblclick —— 表现为「双击没反应」。
 */
function applySelectionClasses() {
  const svg = el.canvas;
  const pm = pairMap();
  const sel = state.selection;
  const partner = sel != null ? pm.get(sel) : undefined;
  svg.querySelectorAll('.nt').forEach((g) => {
    const i = Number(g.dataset.i);
    g.classList.toggle('is-selected', i === sel);
    g.classList.toggle('is-partnered', partner != null && i === partner);
  });
}

function baseFromEvent(ev) {
  const t = ev.target;
  if (!t || !t.classList || !t.classList.contains('nt-circle')) return null;
  const i = parseInt(t.getAttribute('data-i'), 10);
  return Number.isNaN(i) ? null : i;
}

function showHover(i, ev) {
  setStripHighlight(i);          // 悬停结构 → 高亮序列条对应位置
  if (i == null) { el.hoverReadout.classList.remove('is-on'); return; }
  const pm = pairMap();
  const partner = pm.get(i);
  const bits = [`#${i + 1} ${state.sequence[i] || ''}`];
  if (partner != null) {
    const p = state.probMap.get(`${Math.min(i, partner)},${Math.max(i, partner)}`);
    bits.push(`配对 #${partner + 1}${p != null ? ` · P=${p.toFixed(2)}` : ''}`);
  } else {
    bits.push('未配对');
  }
  if (state.forbidden.has(i)) bits.push('已标记禁配');
  if (state.probingValues && state.probingValues[i] != null && state.probingValues[i] >= 0) {
    bits.push(`反应性 ${state.probingValues[i].toFixed(2)}`);
  }
  el.hoverReadout.textContent = bits.join('  ·  ');
  el.hoverReadout.classList.add('is-on');
}

let editTimer = null;

function onCanvasClick(ev) {
  const i = baseFromEvent(ev);
  if (i == null) return;
  if (isReadOnly()) { toast('仅预览模式下画布已锁定，先切换编辑模式'); return; }
  if (isArrange()) return;      // 排版模式的选中在 pointerdown 里处理，这里不参与配对
  if (state.editMode === 'sequence') {
    // 改序列模式：单击只做高亮定位，不建立配对（避免误操作）
    state.selection = i;
    applySelectionClasses();
    return;
  }

  if (ev.altKey || ev.shiftKey) {
    if (state.forbidden.has(i)) state.forbidden.delete(i);
    else state.forbidden.add(i);
    // 同步到约束串
    const s = (el.constraints.value || '').replace(/\s/g, '').padEnd(state.sequence.length, '.');
    const arr = s.split('');
    arr[i] = state.forbidden.has(i) ? 'x' : '.';
    el.constraints.value = arr.join('');
    syncConstraintReadouts();
    pushHistory(state.forbidden.has(i) ? `标记 #${i + 1} 禁止配对` : `取消 #${i + 1} 的禁配标记`);
    render();
    return;
  }

  if (state.selection == null) {
    state.selection = i;
    applySelectionClasses();
    return;
  }
  if (state.selection === i) {
    state.selection = null;
    applySelectionClasses();
    return;
  }

  const a = Math.min(state.selection, i);
  const b = Math.max(state.selection, i);
  state.selection = null;

  // 建立新配对：先移除两端原有的配对
  state.pairs = state.pairs.filter(([x, y]) => x !== a && y !== a && x !== b && y !== b);
  state.pairs.push([a, b]);
  state.pairs.sort((p, q) => p[0] - q[0]);
  state.forbidden.delete(a); state.forbidden.delete(b);

  pushHistory(`建立配对 #${a + 1}–#${b + 1}`);
  render();
  scheduleEvaluate();
}

function onCanvasContext(ev) {
  const i = baseFromEvent(ev);
  if (i == null) return;
  ev.preventDefault();
  if (isReadOnly()) { toast('仅预览模式下画布已锁定，先切换编辑模式'); return; }
  if (isArrange()) {
    // 排版模式：右键 stem = 重置整个分支；右键环 = 重置该环形变
    const u = pickElement(i);
    if (u && u.kind === 'stem') resetBranch(u);
    else if (u && u.kind === 'loop') resetLoopShape(u);
    return;
  }
  if (state.editMode === 'sequence') return;   // 其余只在改配对模式生效

  const partner = pairMap().get(i);
  const before = state.pairs.length;
  state.pairs = state.pairs.filter(([x, y]) => x !== i && y !== i);
  if (state.pairs.length !== before) {
    pushHistory(partner != null
      ? `解除配对 #${Math.min(i, partner) + 1}–#${Math.max(i, partner) + 1}`
      : `移除 #${i + 1} 的配对`);
    render();
    scheduleEvaluate();
  }
}

/* ─────────────────────────── 缩放 / 平移 ─────────────────────────── */

function zoomBy(factor, cx, cy) {
  const v = state.view;
  const ncx = cx ?? (v.x + v.w / 2);
  const ncy = cy ?? (v.y + v.h / 2);
  const nw = v.w / factor, nh = v.h / factor;
  state.view = { x: ncx - (ncx - v.x) * (nw / v.w), y: ncy - (ncy - v.y) * (nh / v.h), w: nw, h: nh };
  applyViewBox();
}

function fitView() {
  const pts = effectivePoints();
  if (!pts || !pts.length) return;
  const b = boundsOf(pts);
  const pad = Math.max(24, b.span * 0.06);
  state.view = {
    x: b.minX - pad, y: b.minY - pad,
    w: (b.maxX - b.minX) + pad * 2, h: (b.maxY - b.minY) + pad * 2,
  };
  applyViewBox();
}

function setupCanvasInteraction() {
  el.canvas.addEventListener('click', onCanvasClick);
  el.canvas.addEventListener('contextmenu', onCanvasContext);
  el.canvas.addEventListener('mousemove', (ev) => {
    const i = baseFromEvent(ev);
    showHover(i, ev);
  });
  el.canvas.addEventListener('mouseleave', () => showHover(null));

  el.canvasScroll.addEventListener('wheel', (ev) => {
    ev.preventDefault();
    const rect = el.canvas.getBoundingClientRect();
    const v = state.view;
    // 屏幕坐标 → 模型坐标（保持宽高比 xMidYMid meet，取较小缩放）
    const scale = Math.min(rect.width / v.w, rect.height / v.h);
    const offX = (rect.width - v.w * scale) / 2;
    const offY = (rect.height - v.h * scale) / 2;
    const cx = v.x + (ev.clientX - rect.left - offX) / scale;
    const cy = v.y + (ev.clientY - rect.top - offY) / scale;
    zoomBy(ev.deltaY < 0 ? 1.15 : 1 / 1.15, cx, cy);
  }, { passive: false });

  let panning = null;
  let arrangeTranslate = null;

  let rotateDrag = null;
  let loopDrag = null;

  el.canvasScroll.addEventListener('pointerdown', (ev) => {
    // 旋转手柄优先于一切：它画在碱基之上，不拦的话会被当成拖动
    if (isArrange() && !isReadOnly()
        && ev.target && ev.target.dataset && ev.target.dataset.role === 'rotate') {
      const u = state.pickedUnit;
      const base = basePoints();
      if (u && u.kind === 'stem' && base) {
        const tree = structureTree();
        const m = screenToModel(ev.clientX, ev.clientY);
        // pivot 以「祖先变换之后的当前位置」为准；旋转写语义角度，无需坐标快照
        const pv = RS.applyM(
          RS.inheritedMatrix(tree, u.id, base, state.layoutOverrides),
          RS.stemPivot(tree, u.id, base),
        );
        const ov0 = state.layoutOverrides[u.id] || {};
        rotateDrag = {
          unit: u, pv, prevOv: { ...ov0 },
          startAng: Math.atan2(m.y - pv.y, m.x - pv.x),
          angle0: ov0.angle || 0, deg: ov0.angle || 0, snapped: false, moved: false,
        };
        state.suppressAnim = true;
        el.canvasScroll.setPointerCapture(ev.pointerId);
        ev.preventDefault();
        return;
      }
    }

    // 环形变手柄（绿色）：拖 apex = 同时调鼓出（径向）与朝向（角向）
    if (isArrange() && !isReadOnly()
        && ev.target && ev.target.dataset && ev.target.dataset.role === 'loop') {
      const u = state.pickedUnit;
      const base = basePoints();
      if (u && u.kind === 'loop' && base) {
        const ls = RS.loopShape(structureTree(), u.id, base, state.layoutOverrides);
        if (ls) {
          loopDrag = {
            unit: u, m: ls.m, n0: ls.n0,
            L0Ref: Math.max(ls.L0, ls.chord * 0.12),
            single: ls.stretchCount === 1, moved: false,
          };
          state.suppressAnim = true;
          el.canvasScroll.setPointerCapture(ev.pointerId);
          ev.preventDefault();
          return;
        }
      }
    }

    // 排版模式：单击选中结构元素（stem = 整个分支）；拖 stem 本体 = 刚体平移
    if (isArrange() && !isReadOnly()) {
      const hit = baseFromEvent(ev);
      if (hit != null) {
        const rect = el.canvas.getBoundingClientRect();
        const v = state.view;
        const scale = Math.min(rect.width / v.w, rect.height / v.h) || 1;
        const u = pickElement(hit);
        const sameSel = !!u && !!state.pickedUnit && u.id === state.pickedUnit.id;
        state.pickedBase = hit;
        state.pickedUnit = u;
        state.snapGuides = [];
        // 同一元素重复点击不再重建 SVG——否则双击的第二次点击会落到新节点上，
        // dblclick 收不到（「双击重置角度」依赖这一点）
        if (!sameSel) { updateArrangeBanner(); render(); }
        if (u && u.kind === 'stem' && basePoints()) {
          const base = basePoints();
          const tree = structureTree();
          const ov0 = state.layoutOverrides[u.id] || {};
          // 以「其它 stem 的当前中心」为对齐参考；拖动期间它们不动，先缓存
          const pts = effectivePoints() || base;
          const subIds = new Set(RS.subtreeIds(tree, u.id));
          const others = [];
          for (const sid of tree.stems) {
            if (subIds.has(sid)) continue;
            const se = tree.elements.get(sid);
            let x = 0; let y = 0;
            for (const b of se.residues) { x += pts[b].x; y += pts[b].y; }
            others.push({ x: x / se.residues.length, y: y / se.residues.length });
          }
          arrangeTranslate = {
            unit: u, moved: false, captured: false, prevOv: { ...ov0 },
            x0: ev.clientX, y0: ev.clientY, scale,
            dx0: ov0.dx || 0, dy0: ov0.dy || 0, angle0: ov0.angle || 0,
            invM: RS.inheritedMatrix(tree, u.id, base, state.layoutOverrides),
            others,
          };
        }
        // 这里不 setPointerCapture、也不 preventDefault：指针捕获会把
        // click / dblclick / contextmenu 重定向到容器上（双击重置角度、
        // 右键重置分支都依赖它们）。等真正开始拖动（第一次 pointermove）再捕获。
        return;
      }
    }
    if (baseFromEvent(ev)) return;
    // 排版模式下点空白处 = 取消选中
    if (isArrange() && state.pickedBase != null) {
      state.pickedBase = null; state.pickedUnit = null; state.snapGuides = [];
      updateArrangeBanner(); render();
    }
    const rect = el.canvas.getBoundingClientRect();
    const v = state.view;
    const scale = Math.min(rect.width / v.w, rect.height / v.h);
    panning = { x: ev.clientX, y: ev.clientY, vx: v.x, vy: v.y, scale };
    el.canvasScroll.classList.add('is-panning');
    el.canvasScroll.setPointerCapture(ev.pointerId);
  });
  el.canvasScroll.addEventListener('pointermove', (ev) => {
    if (loopDrag) {
      const m = screenToModel(ev.clientX, ev.clientY);
      const vx = m.x - loopDrag.m.x;
      const vy = m.y - loopDrag.m.y;
      const dist = Math.hypot(vx, vy);
      let k = dist / loopDrag.L0Ref;
      k = Math.min(2.5, Math.max(0.3, k));
      let tilt = 0;
      if (loopDrag.single && dist > 1e-9) {
        const a0 = Math.atan2(loopDrag.n0.y, loopDrag.n0.x);
        const a1 = Math.atan2(vy, vx);
        tilt = ((((a1 - a0) * 180) / Math.PI) % 360 + 540) % 360 - 180;
      }
      state.layoutOverrides[loopDrag.unit.id] = { bulge: k, tilt };
      loopDrag.moved = true;
      state.suppressAnim = true;
      state.fitPending = false;
      render();
      el.hoverReadout.textContent = `${loopName(loopDrag.unit)} · 鼓出 ${k.toFixed(2)}×`
        + (loopDrag.single ? `（朝向 ${tilt.toFixed(0)}°）` : '');
      el.hoverReadout.classList.add('is-on');
      return;
    }
    if (rotateDrag) {
      const m = screenToModel(ev.clientX, ev.clientY);
      const raw = Math.atan2(m.y - rotateDrag.pv.y, m.x - rotateDrag.pv.x) - rotateDrag.startAng;
      let deg = rotateDrag.angle0 + (raw * 180) / Math.PI;
      // Shift = 吸附到 15° 整数倍；默认自由角度
      rotateDrag.snapped = false;
      if (ev.shiftKey) {
        deg = Math.round(deg / 15) * 15;
        rotateDrag.snapped = true;
      }
      rotateDrag.deg = deg;
      rotateDrag.moved = true;
      const id = rotateDrag.unit.id;
      const prev = state.layoutOverrides[id] || {};
      state.layoutOverrides[id] = { angle: deg, dx: prev.dx || 0, dy: prev.dy || 0 };
      state.fitPending = false;
      render();

      el.hoverReadout.textContent =
        `${rotateDrag.unit.label} · ${fmtDeg(deg)}` + (rotateDrag.snapped ? '　已吸附 15°' : '');
      el.hoverReadout.classList.add('is-on');
      return;
    }
    if (arrangeTranslate) {
      const t = arrangeTranslate;
      const sdx = (ev.clientX - t.x0) / t.scale;
      const sdy = (ev.clientY - t.y0) / t.scale;
      if (!sdx && !sdy) return;
      if (!t.captured) {
        try { el.canvasScroll.setPointerCapture(ev.pointerId); t.captured = true; } catch { /* noop */ }
      }
      // 屏幕帧位移 → 基点坐标系（刚体矩阵的线性部分可转置求逆）
      const [a, b, c, d] = t.invM;
      let dx = t.dx0 + (a * sdx + b * sdy);
      let dy = t.dy0 + (c * sdx + d * sdy);

      // 对齐吸附：与其它 stem 的当前中心比较（两侧都用 stem 自身残基的中心）
      const base = basePoints();
      const tree = structureTree();
      const span = (state.result && state.result.layout) ? state.result.layout.bounds.span : 100;
      const thr = span * 0.015;
      const candOv = { ...state.layoutOverrides, [t.unit.id]: { angle: t.angle0, dx, dy } };
      const candPts = RS.effectivePoints(base, tree, candOv);
      let cx = 0; let cy = 0;
      for (const bidx of t.unit.bases) { cx += candPts[bidx].x; cy += candPts[bidx].y; }
      cx /= t.unit.bases.size; cy /= t.unit.bases.size;
      let bestX = thr; let gx = null;
      let bestY = thr; let gy = null;
      for (const o of t.others) {
        const ddx = Math.abs(cx - o.x);
        if (ddx < bestX) { bestX = ddx; gx = o.x; }
        const ddy = Math.abs(cy - o.y);
        if (ddy < bestY) { bestY = ddy; gy = o.y; }
      }
      const guides = [];
      if (gx != null || gy != null) {
        const corrX = gx != null ? gx - cx : 0;
        const corrY = gy != null ? gy - cy : 0;
        dx += a * corrX + b * corrY;
        dy += c * corrX + d * corrY;
        if (gx != null) guides.push({ axis: 'x', at: gx, from: -1e5, to: 1e5 });
        if (gy != null) guides.push({ axis: 'y', at: gy, from: -1e5, to: 1e5 });
      }
      state.snapGuides = guides;
      state.layoutOverrides[t.unit.id] = { angle: t.angle0, dx, dy };
      t.moved = true;
      state.suppressAnim = true;
      state.fitPending = false;
      render();
      return;
    }
    if (!panning) return;
    state.view.x = panning.vx - (ev.clientX - panning.x) / panning.scale;
    state.view.y = panning.vy - (ev.clientY - panning.y) / panning.scale;
    applyViewBox();
  });
  const endPan = (ev) => {
    if (loopDrag) {
      const l = loopDrag;
      loopDrag = null;
      state.suppressAnim = false;
      el.hoverReadout.classList.remove('is-on');
      try { el.canvasScroll.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
      if (l.moved) {
        pushHistory(`调整 ${loopName(l.unit)} 形变`);
        saveSession();
        updateArrangeBanner();   // 横幅里的鼓出/朝向读数刷新
      }
      return;
    }
    if (rotateDrag) {
      const r = rotateDrag;
      rotateDrag = null;
      state.suppressAnim = false;
      el.hoverReadout.classList.remove('is-on');
      try { el.canvasScroll.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
      if (r.moved) {
        avoidAfterMove(r.unit, r.prevOv);
        pushHistory(`旋转 ${r.unit.label}（${fmtDeg(r.angle0)} → ${fmtDeg(r.deg)}）`);
        saveSession();
      }
      return;
    }
    if (arrangeTranslate) {
      const t = arrangeTranslate;
      arrangeTranslate = null;
      state.suppressAnim = false;
      state.snapGuides = [];
      try { el.canvasScroll.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
      if (t.moved) {
        avoidAfterMove(t.unit, t.prevOv);
        pushHistory(`平移 ${t.unit.label}`);
        saveSession();
      }
      return;
    }
    if (!panning) return;
    panning = null;
    el.canvasScroll.classList.remove('is-panning');
    try { el.canvasScroll.releasePointerCapture(ev.pointerId); } catch { /* noop */ }
  };
  el.canvasScroll.addEventListener('pointerup', endPan);
  el.canvasScroll.addEventListener('pointercancel', endPan);

  $('zoom-in').addEventListener('click', () => zoomBy(1.25));
  $('zoom-out').addEventListener('click', () => zoomBy(1 / 1.25));
  $('zoom-fit').addEventListener('click', fitView);
}

/* ─────────────────────────── 消息 / 仪表 ─────────────────────────── */

function clearMessages() { el.messages.innerHTML = ''; }

function addMessage(kind, text) {
  const d = document.createElement('div');
  d.className = `msg msg-${kind}`;
  d.textContent = text;
  el.messages.appendChild(d);
}

function renderMeter(result) {
  const e = result ? result.energy : null;
  if (!result) {
    el.mDg.textContent = '—'; el.mDg.className = 'meter-value is-na';
    el.mMfe.textContent = '—'; el.mDd.textContent = '—';
    el.mEngine.textContent = '—'; el.mLayout.textContent = '—';
    return;
  }
  if (result.has_pseudoknot) {
    el.mDg.textContent = '含假结'; el.mDg.className = 'meter-value is-na';
  } else if (result.infeasible) {
    el.mDg.textContent = '不可行'; el.mDg.className = 'meter-value is-infeasible';
  } else if (e == null) {
    el.mDg.textContent = '未计算'; el.mDg.className = 'meter-value is-na';
  } else {
    el.mDg.textContent = e.toFixed(2); el.mDg.className = 'meter-value';
  }

  el.mMfe.textContent = (result.mfe_energy != null) ? result.mfe_energy.toFixed(2) : '—';
  // 结构不可行或含假结时 ΔΔG 没有意义，直接不显示
  if (result.delta_from_mfe != null && !result.infeasible
      && !result.has_pseudoknot && e != null) {
    const d = result.delta_from_mfe;
    el.mDd.textContent = (d > 0 ? '+' : '') + d.toFixed(2);
    el.mDd.style.color = d > 0.05 ? '#E08C82' : (Math.abs(d) <= 0.05 ? '#A9D9BC' : '#DCE3EC');
  } else {
    el.mDd.textContent = '—'; el.mDd.style.color = '';
  }
  el.mEngine.textContent = (state.status?.engines || []).find((x) => x.id === result.engine)?.name || result.engine || '—';
  el.mLayout.textContent = result.layout ? result.layout.layout : '—';
}

function renderDecomposition(result) {
  const rows = (result && result.decomposition) || [];
  if (!rows.length) {
    el.decomp.innerHTML = '<p class="empty">折叠或评估后显示逐环能量。</p>';
    return;
  }
  const total = rows.reduce((s, r) => s + r.energy, 0);
  const head = `<div class="decomp-total"><span>合计</span><span class="v">${total.toFixed(2)} kcal/mol</span></div>`;
  const body = rows.map((r) => {
    const cls = r.energy < 0 ? 'neg' : 'pos';
    const sign = r.energy > 0 ? '+' : '';
    return `<div class="decomp-row"><span class="k" title="${escapeHtml(r.label)}">${escapeHtml(r.label)}</span>`
      + `<span class="v ${cls}">${sign}${r.energy.toFixed(2)}</span></div>`;
  }).join('');
  el.decomp.innerHTML = head + `<div class="decomp-list">${body}</div>`;
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (c) => (
    { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]
  ));
}

/* ─────────────────────────── 结果落盘到状态 ─────────────────────────── */

function adoptResult(data, { keepSelection = false } = {}) {
  const prevSelection = state.selection;
  state.result = data;
  state.layout = data.layout ? data.layout.layout : state.layout;
  if (data.layout && data.layout.fallback_reason) {
    addMessage('warn', data.layout.fallback_reason);
    el.layout.value = 'circular';
  }

  if (data.sequence && data.sequence !== state.sequence) {
    state.sequence = data.sequence;
    el.seq.value = data.sequence;
    el.statLen.textContent = state.sequence.length;
    const n = state.sequence.length;
    const gc = n ? Math.round(((state.sequence.match(/[GC]/g) || []).length / n) * 100) : 0;
    el.statGc.textContent = n ? gc + '%' : '–';
    if ((el.constraints.value || '').replace(/\s/g, '').length !== n) resetConstraintString(n);
  }

  // 重新折叠/评估后回到自动布局，并重算哪些配对不合法
  state.manualPoints = null;
  const parsed = parseStructure(data.structure);
  state.pairs = parsed.pairs.map((p) => [p[0], p[1]]);
  // 非经典配对由谁判定：从 PDB 导入时用后端基于**氢键几何**的结果
  // （能识别 Hoogsteen 边之类「字母看着经典、几何其实不是」的配对）；
  // 其余情况用前端的字母判定。这里用一个只生效一次的开关来区分。
  if (preserveNonCanonOnce) {
    preserveNonCanonOnce = false;
  } else {
    state.invalidPairs = computeInvalidPairs();
  }
  state.breaks = data.layout ? (data.layout.breaks || []) : [];

  state.probMap.clear();
  for (const [i, j, p] of (data.probabilities || [])) {
    state.probMap.set(`${i},${j}`, p);
    state.probMap.set(`${j},${i}`, p);
  }

  state.selection = keepSelection ? prevSelection : null;
  el.statPairs.textContent = state.pairs.length;
  el.outStruct.textContent = data.structure;
  el.outSeq.textContent = state.sequence;
  saveSession();

  renderMeter(data);
  renderDecomposition(data);
  render();
}

function reportNotes(data) {
  clearMessages();
  for (const w of data.warnings || []) addMessage('warn', w);
  for (const n of data.notes || []) addMessage('note', n);
  // 不可行的提示由后端 warnings 给出，这里不再重复
}

/* ─────────────────────────── 后端调用 ─────────────────────────── */

function currentProbing() {
  const method = el.probingMethod.value;
  if (!method) return null;
  const n = state.sequence.length;
  const raw = (el.probingData.value || '').trim();
  const values = new Array(n).fill(null);
  if (raw) {
    const lines = raw.split(/[\n;]+/).map((s) => s.trim()).filter(Boolean);
    let filled = false;
    for (const line of lines) {
      const nums = line.split(/[\s,\t]+/).map(Number).filter((x) => !Number.isNaN(x));
      if (nums.length >= 2 && Number.isInteger(nums[0]) && nums[0] >= 1 && nums[0] <= n) {
        values[nums[0] - 1] = nums[1] < -500 ? null : nums[1];
        filled = true;
      } else if (nums.length === 1) {
        // 单列数值：按顺序补齐
        filled = true;
      }
    }
    if (!filled) {
      const flat = raw.split(/[\s,\t\n]+/).map(Number).filter((x) => !Number.isNaN(x));
      if (flat.length === n) flat.forEach((v, i) => { values[i] = v < -500 ? null : v; });
    }
  }
  state.probingValues = values;
  return {
    method,
    values,
    m: parseFloat(el.probingM.value) || 1.8,
    b: parseFloat(el.probingB.value) || -0.6,
  };
}

async function doFold() {
  syncSequence();
  if (!state.sequence) { toast('先粘贴一条序列'); return; }

  const engine = el.engine.value;
  const cons = (el.constraints.value || '').replace(/\s/g, '');
  if (cons && cons.length !== state.sequence.length) {
    toast(`约束串长度 ${cons.length} 与序列长度 ${state.sequence.length} 不一致`);
    return;
  }

  setBusy(true, '折叠中…');
  clearMessages();
  try {
    const body = {
      sequence: state.sequence,
      engine,
      method: el.method.value,
      constraints: cons || null,
      probing: currentProbing(),
      temperature: parseFloat(el.temperature.value) || 37,
      layout: el.layout.value,
      with_probabilities: true,
    };
    if (state.mode === 'cofold') {
      if (!cleanSeq(el.seqB.value)) { toast('共折叠需要第二条链'); return; }
      const data = await api('/api/cofold', {
        sequence_a: state.sequence,
        sequence_b: cleanSeq(el.seqB.value),
        engine,
        temperature: parseFloat(el.temperature.value) || 37,
        layout: el.layout.value,
      });
      state.fitPending = true;
      adoptResult(data);
      pushHistory(`共折叠（链间配对 ${data.interstrand_pairs.length} 个）`);
      reportNotes(data);
      toast(`共折叠完成 · 链间配对 ${data.interstrand_pairs.length} 个`);
    } else {
      const data = await api('/api/predict', body);
      state.fitPending = true;
      adoptResult(data);
      pushHistory(data.engine === 'rnastructure'
        ? `折叠（${el.method.value}）`
        : '折叠（MFE）');
      reportNotes(data);
      toast(data.infeasible ? '完成（结构不可行）' : `完成 · ΔG ${data.energy?.toFixed(2)} kcal/mol`);
    }
  } catch (e) {
    addMessage('error', e.message);
    toast('折叠失败，见下方提示');
  } finally {
    setBusy(false);
  }
}

let evalAbort = null;

function scheduleEvaluate(delay = 120) {
  clearTimeout(editTimer);
  editTimer = setTimeout(() => { void doEvaluate(); }, delay);
}

async function doEvaluate() {
  syncSequence();
  if (!state.sequence || !state.pairs.length && state.mode !== 'manual') {
    // 没有配对也允许评估（全单链 ΔG=0）
  }
  if (!state.sequence) return;

  const structure = pairsToStructure(state.sequence.length, state.pairs);
  el.outStruct.textContent = structure;

  // 假结：后端会返回 400，这里先本地识别，改成有解释的提示
  const crossings = findCrossings(state.pairs);
  if (crossings.length) {
    await showPseudoknot(crossings, structure);
    return;
  }

  if (evalAbort) evalAbort.abort?.();
  const ctrl = new AbortController();
  evalAbort = ctrl;

  try {
    const data = await api('/api/evaluate', {
      sequence: state.sequence,
      structure,
      engine: el.engine.value,
      temperature: parseFloat(el.temperature.value) || 37,
      layout: el.layout.value,
      with_probabilities: false,
      compare_mfe: true,
    });
    if (ctrl.signal.aborted) return;
    const sel = state.selection;
    adoptResult(data, { keepSelection: true });
    state.selection = sel;
    reportNotes(data);
  } catch (e) {
    if (ctrl.signal.aborted) return;
    addMessage('error', e.message);
  }
}

/* ─────────────────────────── 引擎 / 方法联动 ─────────────────────────── */

function refreshEngineOptions() {
  const engines = (state.status && state.status.engines) || [];
  el.engine.innerHTML = engines.map((e) => {
    const dis = e.available ? '' : ' disabled';
    const ver = e.version ? ` ${e.version}` : '';
    const mark = e.available ? '' : '（未安装）';
    return `<option value="${e.id}"${dis}>${e.name}${ver}${mark}</option>`;
  }).join('');
  const firstOk = engines.find((e) => e.available);
  if (firstOk) el.engine.value = state.status.default_engine || firstOk.id;
  refreshMethodOptions();
}

function refreshMethodOptions() {
  const engines = (state.status && state.status.engines) || [];
  const cur = engines.find((e) => e.id === el.engine.value);
  el.engineHint.textContent = cur ? cur.detail : '';

  if (el.engine.value === 'rnastructure') {
    el.methodWrap.hidden = false;
    el.method.innerHTML = `
      <option value="mfe">MFE — 最小自由能 Fold</option>
      <option value="maxexpect">MaxExpect — 最大期望准确度</option>
      <option value="probknot">ProbKnot — 允许假结</option>`;
    el.methodHint.textContent = 'ProbKnot 可以给出含假结的结构；含假结时能量无法用近邻模型计算。';
  } else {
    el.methodWrap.hidden = true;
    el.method.innerHTML = '<option value="mfe">MFE — 最小自由能</option>';
    el.methodHint.textContent = '';
  }
  if (state.mode === 'manual') el.methodWrap.hidden = true;
}

function setMode(mode) {
  state.mode = mode;
  el.modeBtns.forEach((b) => {
    const on = b.dataset.mode === mode;
    b.classList.toggle('is-on', on);
    b.setAttribute('aria-selected', String(on));
  });
  el.cofoldBlock.hidden = mode !== 'cofold';
  el.statModeWrap.hidden = mode === 'cofold';
  refreshMethodOptions();
  clearMessages();   // 上一个模式的提示不应残留

  if (mode === 'manual') {
    // 手动建模：从全单链开始。用线性布局把碱基铺开，逐个点选建立配对最顺手。
    state.pairs = [];
    state.selection = null;
    state.breaks = [];
    state.fitPending = true;
    el.layout.value = 'linear';
    state.layout = 'linear';
    renderMeter(null);
    renderDecomposition(null);
    el.statPairs.textContent = 0;
    el.outStruct.textContent = pairsToStructure(state.sequence.length, []);
    el.canvas.innerHTML = '';
    el.canvasEmpty.hidden = false;
    state.history = [];        // 从零开始搭，历史也从头记
    state.historyIndex = -1;
    renderHistory();
    updateHistoryButtons();
    if (state.sequence) void bootManualLayout();
  } else if (el.layout.value === 'linear') {
    // 从手动建模切回来时恢复经典布局
    el.layout.value = 'naview';
    state.layout = 'naview';
    state.fitPending = true;
  }
}

/** 手动建模的初始铺排：一排碱基，便于点击建立配对 */
async function bootManualLayout() {
  if (!state.sequence) return;
  const mode = el.layout.value || 'linear';
  try {
    const data = await api('/api/layout', {
      sequence: state.sequence,
      structure: '.'.repeat(state.sequence.length),
      layout: mode,
    });
    state.result = {
      layout: data, energy: null, engine: el.engine.value,
      structure: '.'.repeat(state.sequence.length), decomposition: [],
      probabilities: [], warnings: [], notes: [], infeasible: false,
    };
    state.pairs = [];
    state.fitPending = true;
    renderMeter(null);
    render();
    el.canvasEmpty.hidden = true;
  } catch (e) {
    addMessage('error', e.message);
  }
}

/* ─────────────────────────── 导出 ─────────────────────────── */

function downloadBlob(blob, filename) {
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url; a.download = filename;
  document.body.appendChild(a); a.click(); a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}

/* ─────────────────── 内置出图（不依赖 Java） ─────────────────── */


/** 当前渲染用的 --u（碱基圆半径），CSS 里的线宽都是它的倍数 */
function unitScale() {
  return parseFloat(el.canvas.style.getPropertyValue('--u')) || 1;
}

/**
 * 把画布序列化成可独立打开的 SVG。
 *
 * 关键点：导出的文件不会加载页面的 style.css，所有靠 CSS 渲染的
 * 骨架线、配对线样式必须内联进 <style>，否则导出的图只剩黑色细线。
 */
function buildExportSvg(scope) {
  const layout = state.result && state.result.layout;
  if (!layout || !layout.points || !layout.points.length) return null;

  const u = unitScale();
  const vb = (scope === 'view' && state.view) ? { ...state.view } : { ...(state.fitView || state.view) };

  const clone = el.canvas.cloneNode(true);
  clone.removeAttribute('style');
  clone.setAttribute('xmlns', SVG_NS);
  clone.setAttribute('xmlns:xlink', 'http://www.w3.org/1999/xlink');
  clone.setAttribute('width', String(Math.round(vb.w)));
  clone.setAttribute('height', String(Math.round(vb.h)));
  clone.setAttribute('viewBox', `${vb.x} ${vb.y} ${vb.w} ${vb.h}`);
  clone.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  // 出图时去掉交互态的选中/悬停样式，避免把编辑状态带进插图
  clone.querySelectorAll('.is-sel, .is-selected, .is-partnered').forEach((n) => {
    n.classList.remove('is-sel', 'is-selected', 'is-partnered');
  });
  // 排版选择层（选择框 / pivot / 旋转手柄 / 对齐辅助线）不进插图
  clone.querySelectorAll('.sel-layer, .snap-layer').forEach((n) => n.remove());
  // 画布上配对线是半透明的（方便看交叉的弦），插图里用实色更清晰
  clone.querySelectorAll('.bp-line').forEach((n) => n.removeAttribute('opacity'));

  const bg = document.createElementNS(SVG_NS, 'rect');
  bg.setAttribute('x', vb.x); bg.setAttribute('y', vb.y);
  bg.setAttribute('width', vb.w); bg.setAttribute('height', vb.h);
  bg.setAttribute('fill', '#ffffff');

  const style = document.createElementNS(SVG_NS, 'style');
  const f = (n) => n.toFixed(4);
  style.textContent = [
    `.backbone{stroke:#AEB8C4;stroke-width:${f(u * 0.38)};fill:none;}`,
    `.bp-line{stroke:#2F6FB5;stroke-width:${f(u * 0.42)};fill:none;}`,
    `.bp-line.is-pk{stroke:#C0504D;stroke-dasharray:${f(u * 1.15)} ${f(u * 0.85)};}`,
    `.nt-text,.nt-num{font-family:ui-monospace,Menlo,Consolas,"DejaVu Sans Mono",monospace;}`,
    `.nt-text{font-weight:500;}`,
    `.nt-num{fill:#647183;}`,
  ].join('');

  clone.insertBefore(style, clone.firstChild);
  clone.insertBefore(bg, style.nextSibling);

  return '<?xml version="1.0" encoding="UTF-8"?>\n'
    + new XMLSerializer().serializeToString(clone) + '\n';
}

async function exportStructure(fmt) {
  if (!state.sequence) { toast('还没有序列'); return; }
  const structure = pairsToStructure(state.sequence.length, state.pairs);
  try {
    const res = await fetch('/api/export', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ sequence: state.sequence, structure, fmt }),
    });
    if (!res.ok) throw new Error(await res.text());
    const blob = await res.blob();
    const ext = fmt === 'dotbracket' ? 'dbn' : (fmt === 'fasta' ? 'fa' : 'ct');
    downloadBlob(blob, `rna.${ext}`);
    toast(`已导出 ${ext.toUpperCase()}`);
  } catch (e) { toast('导出失败：' + e.message); }
}

/* ─────────────────────────── 环境状态 ─────────────────────────── */

async function loadStatus() {
  try {
    const res = await fetch('/api/status');
    state.status = await res.json();
  } catch (e) {
    el.btnStatus.textContent = '后端未响应';
    el.btnStatus.dataset.state = 'warn';
    throw e;
  }
  const eng = state.status.engines || [];
  const anyOk = eng.some((e) => e.available);
  const varnaOk = state.status.varna?.available;
  el.btnStatus.dataset.state = (anyOk && varnaOk) ? 'ok' : 'warn';
  el.btnStatus.textContent = (anyOk && varnaOk)
    ? '环境就绪'
    : (anyOk ? 'VARNA 不可用' : '预测引擎不可用');
  renderStatusPanel();
  refreshEngineOptions();
  renderVarnaHint();

  const missing = eng.filter((e) => !e.available);
  if (missing.length) {
    for (const m of missing) addMessage('warn', `${m.name} 不可用：${m.detail} ${m.install_hint || ''}`);
  }
  if (!varnaOk && state.status.varna) {
    for (const p of state.status.varna.problems) addMessage('warn', p);
  }
}

/** VARNA 区块下方的可用性提示：有没有 Java、用的是随包 JRE 还是系统 Java */
function renderVarnaHint() {
  if (!el.varnaHint) return;
  const v = state.status && state.status.varna;
  if (!v) { el.varnaHint.textContent = ''; return; }
  if (!v.available) {
    el.varnaHint.textContent = v.problems && v.problems.length ? v.problems[0] : 'VARNA 不可用';
    return;
  }
  const src = v.java_source === 'bundled' ? '随包 JRE' : '系统 Java';
  el.varnaHint.textContent = `可用 · Java ${v.java_version || '?'}（${src}）`;
}

function renderStatusPanel() {
  const s = state.status;
  if (!s) return;
  const rows = [];
  for (const e of s.engines || []) {
    rows.push(`<div class="status-item">
      <span class="dot ${e.available ? 'ok' : 'bad'}"></span>
      <span><b>${escapeHtml(e.name)}</b> ${e.available ? escapeHtml(e.version || '可用') : '未安装'}</span>
      <code>${escapeHtml(e.detail || '')}</code></div>`);
  }
  const v = s.varna || {};
  rows.push(`<div class="status-item">
    <span class="dot ${v.available ? 'ok' : 'bad'}"></span>
    <span><b>VARNA</b> ${v.available ? '可用' : '不可用'}</span>
    <code>Java ${escapeHtml(v.java_version || '—')} · ${escapeHtml(v.jar || '')}</code></div>`);
  el.statusPanel.innerHTML = `<h3>运行环境</h3><div class="status-grid">${rows.join('')}</div>`;
}

/* ─────────────────────────── 事件绑定 ─────────────────────────── */

function bindEvents() {
  el.seq.addEventListener('input', () => { syncSequence(); });
  el.seqB.addEventListener('input', () => { state.sequenceB = cleanSeq(el.seqB.value); });
  el.constraints.addEventListener('input', syncConstraintReadouts);

  el.btnFold.addEventListener('click', doFold);
  el.btnMfe.addEventListener('click', async () => {
    // 用当前序列重新折叠一次（不带约束）
    el.constraints.value = '.'.repeat(state.sequence.length);
    syncConstraintReadouts();
    await doFold();
  });
  el.btnReset.addEventListener('click', () => {
    clearSession();
    el.seq.value = ''; el.seqB.value = '';
    syncSequence();
    state.result = null; state.pairs = [];
    renderMeter(null); renderDecomposition(null);
    el.canvas.innerHTML = ''; el.canvasEmpty.hidden = false;
    el.outStruct.textContent = ''; el.outSeq.textContent = '';
    state.domains = [];
    state.locatedRange = null;
    renderDomains();
    clearMessages();
  });

  el.btnConsFromStruct.addEventListener('click', () => {
    if (!state.pairs.length) { toast('当前还没有配对'); return; }
    constraintFromStructure();
    toast(`已写入 ${state.pairs.length} 个强制配对`);
  });
  el.btnClearCons.addEventListener('click', () => {
    resetConstraintString(state.sequence.length);
    state.forbidden.clear();
    syncConstraintReadouts();
    render();
  });

  el.modeBtns.forEach((b) => b.addEventListener('click', () => setMode(b.dataset.mode)));

  el.engine.addEventListener('change', () => { refreshMethodOptions(); saveSession(); });
  el.method.addEventListener('change', saveSession);
  el.temperature.addEventListener('change', saveSession);
  el.probingMethod.addEventListener('change', saveSession);
  el.layout.addEventListener('change', () => {
    state.layout = el.layout.value;
    state.fitPending = true;
    saveSession();
    if (el.layout.value === 'dotplot') { void drawDotPlot(); return; }
    if (state.result) { void rerender(); } else { render(); }
  });
  if (el.bpStyleDraw) el.bpStyleDraw.addEventListener('change', () => { render(); saveSession(); });
  el.colorMode.addEventListener('change', () => {
    state.colorMode = el.colorMode.value;
    el.bpstyleWrap.hidden = state.colorMode === 'base';
    render();
  });
  el.periodNum.addEventListener('input', render);
  el.probingMethod.addEventListener('change', () => {
    el.probingBlock.hidden = !el.probingMethod.value;
  });

  document.querySelectorAll('[data-export]').forEach((b) => {
    b.addEventListener('click', () => exportStructure(b.dataset.export));
  });

  el.btnSvg.addEventListener('click', () => { void openBuiltinExportPreview(); });
  el.btnVarnaSvg.addEventListener('click', () => { void openVarnaExportPreview(); });

  el.btnImport.addEventListener('click', () => {
    el.importError.hidden = true;
    el.importDialog.showModal();
  });
  el.importDialog.addEventListener('close', async () => {
    if (el.importDialog.returnValue !== 'ok') return;
    try {
      const data = await api('/api/import', { text: el.importText.value, fmt: el.importFmt.value });
      el.seq.value = data.sequence;
      state.sequence = data.sequence;
      resetConstraintString(data.sequence.length);
      await doEvaluateWithStructure(data.structure);
      toast('已导入结构');
    } catch (e) {
      el.importError.textContent = e.message;
      el.importError.hidden = false;
      el.importDialog.showModal();   // 重新打开以便修改
    }
  });

  // ── 序列条的悬停联动与碱基编辑 ──
  el.baseEditorBtns.innerHTML = ['A', 'U', 'G', 'C']
    .map((b) => `<button class="base-btn" data-base="${b}" type="button">${b}</button>`).join('');
  el.baseEditorBtns.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-base]');
    if (btn && baseEditorFor != null) setBase(baseEditorFor, btn.dataset.base);
  });
  document.addEventListener('click', (ev) => {
    if (el.baseEditor.hidden) return;
    if (ev.target.closest('#base-editor')) return;
    closeBaseEditor();
  }, true);
  window.addEventListener('resize', closeBaseEditor);

  el.stripBody.addEventListener('mousemove', (ev) => {
    const ch = ev.target.closest('.ss-char');
    setCanvasHighlight(ch ? +ch.dataset.i : null);
  });
  el.stripBody.addEventListener('mouseleave', () => setCanvasHighlight(null));
  el.stripBody.addEventListener('click', (ev) => {
    const ch = ev.target.closest('.ss-char');
    if (!ch) return;
    state.selection = +ch.dataset.i;
    render();
  });
  el.stripBody.addEventListener('dblclick', (ev) => {
    const ch = ev.target.closest('.ss-char');
    if (!ch) return;
    if (state.editMode !== 'sequence') { toast('双击改序列需先切到「改序列」模式'); return; }
    ev.preventDefault();
    state.selection = +ch.dataset.i;
    render();
    openBaseEditor(+ch.dataset.i, ch);
  });
  el.btnStripToggle.addEventListener('click', () => {
    const collapsed = el.seqStrip.classList.toggle('is-collapsed');
    el.btnStripToggle.textContent = collapsed ? '展开' : '收起';
  });

  // 结构图上双击：排版模式 = 重置 stem 角度；改序列模式 = 打开碱基弹窗
  el.canvas.addEventListener('dblclick', (ev) => {
    if (isArrange() && !isReadOnly()) {
      const hit = baseFromEvent(ev);
      if (hit != null) {
        const u = pickElement(hit);
        if (u && u.kind === 'stem') { resetStemAngle(u); ev.preventDefault(); }
        else if (u && u.kind === 'loop') { resetLoopShape(u); ev.preventDefault(); }
      }
      return;
    }
    const i = baseFromEvent(ev);
    if (i == null || isReadOnly()) return;
    if (state.editMode !== 'sequence') return;   // 只在改序列模式生效
    ev.preventDefault();
    state.selection = i;
    applySelectionClasses();                     // 不能 render()，否则元素被换掉
    openBaseEditor(i, ev.target);
  });

  // ── 调整排版 ──
  el.btnRestoreLayout.addEventListener('click', restoreAutoLayout);

  // ── 从 PDB 导入 ──
  el.btnPdbOpen.addEventListener('click', openPdbDialog);
  el.pdbChoose.addEventListener('click', () => el.pdbFile.click());
  el.pdbFile.addEventListener('change', () => {
    if (el.pdbFile.files && el.pdbFile.files[0]) void pdbReadFile(el.pdbFile.files[0]);
  });
  el.pdbRead.addEventListener('click', () => { void pdbLoadChains(); });
  el.pdbRestart.addEventListener('click', () => {
    pdbText = '';
    el.pdbFile.value = '';
    el.pdbFilename.textContent = '';
    el.pdbStepFile.hidden = false;
    el.pdbStepChain.hidden = true;
    el.pdbSummary.hidden = true;
    el.pdbImport.disabled = true;
  });
  el.pdbChain.addEventListener('change', () => { void pdbRefreshPreview(); });
  el.pdbReference.addEventListener('change', () => { void pdbRefreshPreview(); });
  el.pdbNoncanon.addEventListener('change', () => { void pdbRefreshPreview(); });
  el.pdbNested.addEventListener('change', () => { void pdbRefreshPreview(); });
  el.pdbImport.addEventListener('click', () => { void pdbDoImport(); });
  el.pdbCancel.addEventListener('click', () => el.pdbDialog.close());

  // 拖放
  ['dragenter', 'dragover'].forEach((ev) => el.pdbDrop.addEventListener(ev, (e) => {
    e.preventDefault();
    el.pdbDrop.classList.add('is-over');
  }));
  ['dragleave', 'drop'].forEach((ev) => el.pdbDrop.addEventListener(ev, (e) => {
    e.preventDefault();
    el.pdbDrop.classList.remove('is-over');
  }));
  el.pdbDrop.addEventListener('drop', (e) => {
    const f = e.dataTransfer && e.dataTransfer.files && e.dataTransfer.files[0];
    if (f) void pdbReadFile(f);
  });

  // ── 结构域标注 ──
  el.btnDomainAdd.addEventListener('click', addDomain);
  el.btnDomainFromRange.addEventListener('click', fillRangeFromLocated);
  el.btnFoldDomains.addEventListener('click', () => { void foldByDomains(); });
  el.domainName.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); addDomain(); }
  });
  el.domainList.addEventListener('click', (ev) => {
    const del = ev.target.closest('[data-del]');
    if (del) { removeDomain(parseInt(del.dataset.del, 10)); return; }
    const row = ev.target.closest('.domain-row');
    if (!row) return;
    const d = state.domains[parseInt(row.dataset.idx, 10)];
    if (!d) return;
    state.locatedRange = [d.start, d.end];
    state.fitPending = false;
    render();
    centerOn(d.start);
  });

  // ── 序列定位 ──
  el.btnLocate.addEventListener('click', locateInSequence);
  el.locateInput.addEventListener('keydown', (ev) => {
    if (ev.key === 'Enter') { ev.preventDefault(); locateInSequence(); }
  });

  // ── 撤销 / 重做 ──
  el.btnUndo.addEventListener('click', undo);
  el.btnRedo.addEventListener('click', redo);

  // ── 只读预览 / 对照预览 ──
  el.editMode.querySelectorAll('button').forEach((b) => {
    b.addEventListener('click', () => setEditMode(b.dataset.edit));
  });
  el.btnCompare.addEventListener('click', () => {
    if (el.compareOverlay.hidden) void openCompare();
    else closeCompare();
  });
  $('compare-close').addEventListener('click', closeCompare);

  // ── 历史面板：点任意一步跳过去（用事件委托，行是动态生成的）──
  el.historyList.addEventListener('click', (ev) => {
    const row = ev.target.closest('.history-row');
    if (!row) return;
    const idx = parseInt(row.dataset.idx, 10);
    if (!Number.isNaN(idx) && idx !== state.historyIndex) applyHistory(idx);
  });

  // ── 出图预览对话框 ──
  el.exportCancel = $('export-cancel');
  el.exportCancel.addEventListener('click', () => el.exportDialog.close());
  el.exportSaveButtons.addEventListener('click', (ev) => {
    const btn = ev.target.closest('[data-export-fmt]');
    if (btn) void saveExport(btn.dataset.exportFmt);
  });

  el.btnStatus.addEventListener('click', () => {
    el.statusPanel.hidden = !el.statusPanel.hidden;
    el.btnStatus.setAttribute('aria-expanded', String(!el.statusPanel.hidden));
  });

  document.addEventListener('keydown', (ev) => {
    const typing = /^(INPUT|TEXTAREA|SELECT)$/.test((ev.target.tagName || '').toUpperCase());
    const mod = ev.metaKey || ev.ctrlKey;

    if (ev.key === 'Escape') {
      if (!el.baseEditor.hidden) { closeBaseEditor(); return; }
      if (!el.compareOverlay.hidden) { closeCompare(); return; }
      if (isArrange() && (state.pickedBase != null || state.snapGuides.length)) {
        state.pickedBase = null; state.pickedUnit = null; state.snapGuides = [];
        updateArrangeBanner(); render(); return;
      }
      if (!el.exportDialog.open && state.selection != null) { state.selection = null; render(); }
      return;
    }
    if (mod && ev.key === 'Enter') { ev.preventDefault(); void doFold(); return; }

    if (typing) return;   // 在输入框里打字时不抢快捷键

    // 撤销 / 重做：加上 shift 才是重做
    if (mod && (ev.key === 'z' || ev.key === 'Z')) {
      ev.preventDefault();
      if (ev.shiftKey) redo(); else undo();
      return;
    }
    if (mod && (ev.key === 'y' || ev.key === 'Y')) { ev.preventDefault(); redo(); return; }

    // Delete / Backspace：解除当前选中碱基的配对
    if ((ev.key === 'Delete' || ev.key === 'Backspace') && state.selection != null) {
      ev.preventDefault();
      const i = state.selection;
      const partner = pairMap().get(i);
      if (partner == null) { toast(`#${i + 1} 没有配对`); return; }
      const before = state.pairs.length;
      state.pairs = state.pairs.filter(([x, y]) => x !== i && y !== i);
      if (state.pairs.length !== before) {
        pushHistory(`解除配对 #${Math.min(i, partner) + 1}–#${Math.max(i, partner) + 1}`);
        state.selection = null;
        render();
        scheduleEvaluate();
      }
      return;
    }

    // 方向键：在当前选中上左右移动
    if (state.selection != null && (ev.key === 'ArrowLeft' || ev.key === 'ArrowRight')) {
      ev.preventDefault();
      const n = state.sequence.length;
      const step = ev.key === 'ArrowRight' ? 1 : -1;
      state.selection = (state.selection + step + n) % n;
      render();
      return;
    }
  });

  el.canvasScroll.addEventListener('dblclick', fitView);
}

async function rerender() {
  if (!state.sequence || !state.pairs.length) return;
  const structure = pairsToStructure(state.sequence.length, state.pairs);
  try {
    const data = await api('/api/layout', {
      sequence: state.sequence, structure, layout: el.layout.value,
    });
    if (state.result) {
      state.result.layout = data;
      state.pairs = data.pairs.map((p) => [p[0], p[1]]);
      if (data.fallback_reason) addMessage('warn', data.fallback_reason);
      renderMeter(state.result);
    }
    state.fitPending = true;
    render();
  } catch (e) { addMessage('error', e.message); }
}

async function doEvaluateWithStructure(structure) {
  const data = await api('/api/evaluate', {
    sequence: state.sequence, structure,
    engine: el.engine.value,
    temperature: parseFloat(el.temperature.value) || 37,
    layout: el.layout.value,
    compare_mfe: true,
  });
  state.fitPending = true;
  adoptResult(data);
  pushHistory('导入结构');
  reportNotes(data);
}

/* ═══════════════════════ 编辑历史（撤销 / 重做） ═══════════════════════ */

/**
 * 历史栈记录的是「结构快照」：配对表 + 禁配标记。
 * 用指针（historyIndex）而不是双栈，因为历史面板还需要能跳回任意一步。
 */
const HISTORY_LIMIT = 300;

function snapshot(label) {
  return {
    pairs: state.pairs.map((p) => [p[0], p[1]]),
    forbidden: new Set(state.forbidden),
    // 排版语义状态随结构一起入栈，undo/redo 才能真实还原布局
    layoutOverrides: JSON.parse(JSON.stringify(state.layoutOverrides || {})),
    label,
  };
}

function pushHistory(label) {
  // 在历史中途做了新编辑 → 丢弃后面那条 redo 分支
  state.history = state.history.slice(0, state.historyIndex + 1);
  state.history.push(snapshot(label));
  if (state.history.length > HISTORY_LIMIT) state.history.shift();
  state.historyIndex = state.history.length - 1;
  renderHistory();
  updateHistoryButtons();
  saveSession();
}

function applyHistory(idx) {
  if (idx < 0 || idx >= state.history.length) return;
  state.historyIndex = idx;
  const h = state.history[idx];
  state.pairs = h.pairs.map((p) => [p[0], p[1]]);
  state.forbidden = new Set(h.forbidden);
  state.layoutOverrides = JSON.parse(JSON.stringify(h.layoutOverrides || {}));
  state.selection = null;
  render();
  renderHistory();
  updateHistoryButtons();
  scheduleEvaluate();
}

function undo() {
  if (state.historyIndex > 0) applyHistory(state.historyIndex - 1);
}

function redo() {
  if (state.historyIndex < state.history.length - 1) applyHistory(state.historyIndex + 1);
}

function updateHistoryButtons() {
  el.btnUndo.disabled = state.historyIndex <= 0;
  el.btnRedo.disabled = state.historyIndex >= state.history.length - 1;
}

function renderHistory() {
  const list = el.historyList;
  const n = state.history.length;
  el.statHistory.textContent = n;
  el.statHistoryPos.textContent = n ? state.historyIndex + 1 : 0;

  if (!n) {
    list.innerHTML = '<p class="empty">还没有编辑记录。折叠或改动配对后会出现在这里。</p>';
    return;
  }
  // 倒序显示，最新的一步在最上面（符合直觉）
  const rows = [];
  for (let i = n - 1; i >= 0; i--) {
    const h = state.history[i];
    const cur = i === state.historyIndex;
    const future = i > state.historyIndex;
    rows.push(
      `<button class="history-row${cur ? ' is-current' : ''}${future ? ' is-future' : ''}" `
      + `data-idx="${i}" type="button">`
      + `<span class="history-step">${i + 1}</span>`
      + `<span class="history-label">${escapeHtml(h.label)}</span>`
      + `<span class="history-meta">${h.pairs.length} 对</span>`
      + `</button>`,
    );
  }
  list.innerHTML = rows.join('');
}

/* ═══════════════════════════ 只读预览 ═══════════════════════════ */


/* ═══════════════════════ 出图预览对话框 ═══════════════════════ */

let exportState = { source: null, svg: null, title: '' };

/** 把一个 SVG 字符串填进预览框。用 innerHTML 而不是 img：矢量图随窗口缩放不糊。 */
function showExportPreview(svgText, { source, title, sub }) {
  exportState = { source, svg: svgText, title };
  el.exportTitle.textContent = title;
  el.exportSub.textContent = sub || '';
  el.exportError.hidden = true;
  el.exportPreview.innerHTML = svgText;

  // 让预览里的 SVG 自适应容器
  const svg = el.exportPreview.querySelector('svg');
  if (svg) {
    svg.removeAttribute('width');
    svg.removeAttribute('height');
    svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');
    svg.style.width = '100%';
    svg.style.height = '100%';
  }

  // 按来源决定可保存的格式
  const formats = source === 'varna'
    ? [['svg', '保存 SVG'], ['png', '保存 PNG'], ['eps', '保存 EPS']]
    : [['svg', '保存 SVG'], ['png', '保存 PNG']];
  el.exportSaveButtons.innerHTML = formats.map(([f, label], i) => (
    `<button class="btn${i === 0 ? ' btn-primary' : ''}" type="button" `
    + `data-export-fmt="${f}">${label}</button>`
  )).join('');

  el.exportDialog.showModal();
}

async function openBuiltinExportPreview() {
  const svg = buildExportSvg(el.svgScope ? el.svgScope.value : 'full');
  if (!svg) { toast('还没有结构可以导出'); return; }
  showExportPreview(svg, {
    source: 'builtin',
    title: '出图预览 — 内置渲染器',
    sub: '矢量图，可直接插入论文或用 Illustrator / Inkscape 继续编辑。',
  });
}

async function openVarnaExportPreview() {
  if (!state.sequence) { toast('还没有序列'); return; }
  const v = state.status && state.status.varna;
  if (v && !v.available) {
    addMessage('error', 'VARNA 不可用：' + (v.problems || []).join('；'));
    toast('VARNA 不可用，请改用内置出图');
    return;
  }
  const structure = pairsToStructure(state.sequence.length, state.pairs);
  setBusy(true, 'VARNA 出图中…');
  try {
    const res = await fetch('/api/render/varna?fmt=svg', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        sequence: state.sequence,
        structure,
        algorithm: el.varnaAlgo.value,
        period_num: parseInt(el.periodNum.value, 10) || 10,
        bp_style: el.bpstyle.value || null,
        color_values: colorValues(),
        color_style: '0:#FFFFFF;0.5:#4E93CF;1:#143A63',
        color_min: 0, color_max: 1,
      }),
    });
    if (!res.ok) {
      const t = await res.text();
      let msg = t;
      try { msg = JSON.parse(t).detail || t; } catch { /* 原样 */ }
      throw new Error(msg);
    }
    const svg = await res.text();
    const javaSrc = v && v.java_source === 'bundled' ? '随包 JRE' : '系统 Java';
    showExportPreview(svg, {
      source: 'varna',
      title: '出图预览 — VARNA',
      sub: `算法 ${el.varnaAlgo.value} · Java 来源：${javaSrc}。SVG / EPS 为矢量格式。`,
    });
  } catch (e) {
    addMessage('error', 'VARNA 出图失败：' + e.message);
    toast('VARNA 出图失败');
  } finally {
    setBusy(false);
  }
}

/**
 * 保存预览里的图。内置出图的 PNG 由浏览器把 SVG 光栅化；
 * VARNA 的 PNG/EPS 需要后端重新出图（浏览器的光栅化结果不代表 VARNA 的原始输出）。
 */
async function saveExport(fmt) {
  const structure = pairsToStructure(state.sequence.length, state.pairs);

  if (fmt === 'svg') {
    if (exportState.source === 'varna' && exportState.svg) {
      downloadBlob(new Blob([exportState.svg], { type: 'image/svg+xml;charset=utf-8' }),
        'rna_varna.svg');
    } else {
      downloadBlob(new Blob([exportState.svg], { type: 'image/svg+xml;charset=utf-8' }),
        'rna_structure.svg');
    }
    toast('已保存 SVG');
    el.exportDialog.close();
    return;
  }

  if (exportState.source === 'varna') {
    // 让后端按 VARNA 自己的渲染器出图，保证与预览一致且分辨率可控
    setBusy(true, '导出中…');
    try {
      const res = await fetch(`/api/render/varna?fmt=${fmt}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          sequence: state.sequence, structure,
          algorithm: el.varnaAlgo.value,
          period_num: parseInt(el.periodNum.value, 10) || 10,
          bp_style: el.bpstyle.value || null,
          color_values: colorValues(),
          color_style: '0:#FFFFFF;0.5:#4E93CF;1:#143A63',
          color_min: 0, color_max: 1,
        }),
      });
      if (!res.ok) throw new Error(await res.text());
      downloadBlob(await res.blob(), `rna_varna.${fmt}`);
      toast(`已保存 ${fmt.toUpperCase()}`);
      el.exportDialog.close();
    } catch (e) {
      el.exportError.textContent = '导出失败：' + e.message;
      el.exportError.hidden = false;
    } finally {
      setBusy(false);
    }
    return;
  }

  // 内置出图的 PNG
  const url = URL.createObjectURL(new Blob([exportState.svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('SVG 光栅化失败'));
      img.src = url;
    });
    const scale = 3;
    const w = Math.max(1, Math.round((img.naturalWidth || 1000) * scale));
    const h = Math.max(1, Math.round((img.naturalHeight || 1000) * scale));
    const cv = document.createElement('canvas');
    cv.width = w; cv.height = h;
    const ctx = cv.getContext('2d');
    ctx.fillStyle = '#ffffff';
    ctx.fillRect(0, 0, w, h);
    ctx.drawImage(img, 0, 0, w, h);
    const blob = await new Promise((resolve) => cv.toBlob(resolve, 'image/png'));
    if (!blob) throw new Error('浏览器未能生成 PNG');
    downloadBlob(blob, 'rna_structure.png');
    toast(`已保存 PNG（${w}×${h}）`);
    el.exportDialog.close();
  } catch (e) {
    el.exportError.textContent = `PNG 导出失败（${e.message}），可以改存 SVG。`;
    el.exportError.hidden = false;
  } finally {
    URL.revokeObjectURL(url);
  }
}

/* ═══════════════════════ 对照预览（当前 vs MFE） ═══════════════════════ */

function pairKeySet(pairs) {
  const s = new Set();
  for (const [i, j] of pairs) s.add(`${Math.min(i, j)},${Math.max(i, j)}`);
  return s;
}

async function openCompare() {
  const r = state.result;
  if (!r || !r.mfe_structure) {
    toast('还没有可对照的 MFE 结构，先折叠一次');
    return;
  }
  if (!state.sequence) return;

  const curPairs = state.pairs;
  const mfeParsed = parseStructure(r.mfe_structure);
  const mfePairs = mfeParsed.pairs;

  setBusy(true, '准备对照视图…');
  try {
    // 当前结构用现有布局；MFE 结构需要单独排一次版
    let leftLayout = r.layout;
    let rightLayout;
    if (r.mfe_structure === r.structure && r.layout) {
      rightLayout = r.layout;              // 两者相同，直接复用
    } else {
      rightLayout = await api('/api/layout', {
        sequence: state.sequence,
        structure: r.mfe_structure,
        layout: el.layout.value,
      });
    }
    if (!leftLayout) {
      leftLayout = await api('/api/layout', {
        sequence: state.sequence,
        structure: pairsToStructure(state.sequence.length, curPairs),
        layout: el.layout.value,
      });
    }

    // 只在一边出现的配对 → 高亮
    const curSet = pairKeySet(curPairs);
    const mfeSet = pairKeySet(mfePairs);
    const diffLeft = new Set([...curSet].filter((k) => !mfeSet.has(k)));
    const diffRight = new Set([...mfeSet].filter((k) => !curSet.has(k)));

    const period = parseInt(el.periodNum.value, 10) || 0;
    drawStructure(el.compareLeft, {
      sequence: state.sequence,
      layout: leftLayout,
      pairs: curPairs,
      breaks: r.layout ? (r.layout.breaks || []) : [],
      forbidden: state.forbidden,
      selected: null,
      colorMap: null,
      period,
      diffPairs: diffLeft,
      interactive: false,
    });
    drawStructure(el.compareRight, {
      sequence: state.sequence,
      layout: rightLayout,
      pairs: mfePairs,
      breaks: r.layout ? (r.layout.breaks || []) : [],
      forbidden: new Set(),
      selected: null,
      colorMap: null,
      period,
      diffPairs: diffRight,
      interactive: false,
    });

    el.compareLeftDg.textContent = r.infeasible || r.energy == null
      ? 'ΔG 不可用'
      : `ΔG ${r.energy.toFixed(2)} kcal/mol`;
    el.compareRightDg.textContent = r.mfe_energy == null
      ? 'ΔG 不可用'
      : `ΔG ${r.mfe_energy.toFixed(2)} kcal/mol`;

    const d = r.delta_from_mfe;
    const common = [...curSet].filter((k) => mfeSet.has(k)).length;
    el.compareSummary.textContent = d == null
      ? ''
      : (Math.abs(d) < 0.05
        ? '两者完全一致'
        : `当前结构比 MFE 高 ${d.toFixed(2)} kcal/mol`);
    el.compareDetail.textContent =
      `共有配对 ${common} 对 · 当前独有 ${diffLeft.size} 对 · MFE 独有 ${diffRight.size} 对`;

    el.compareOverlay.hidden = false;
    el.btnCompare.classList.add('is-on');
    el.btnCompare.setAttribute('aria-pressed', 'true');
  } catch (e) {
    addMessage('error', '对照视图生成失败：' + e.message);
    toast('对照视图生成失败');
  } finally {
    setBusy(false);
  }
}

function closeCompare() {
  el.compareOverlay.hidden = true;
  el.btnCompare.classList.remove('is-on');
  el.btnCompare.setAttribute('aria-pressed', 'false');
}

/**
 * 本地先检查新配对是否与已有配对交叉。
 * 交叉 = 假结，ViennaRNA 的近邻模型算不了 ΔG，后端会返回 400。
 * 与其让用户看到一条报错，不如在这里就给出解释。
 */
function crossesExisting(pairs, i, j) {
  for (const [a, b] of pairs) {
    if (a === i || a === j || b === i || b === j) continue;
    const [lo, hi] = a < b ? [a, b] : [b, a];
    const [ni, nj] = i < j ? [i, j] : [j, i];
    if ((ni < lo && lo < nj && nj < hi) || (lo < ni && ni < hi && hi < nj)) return true;
  }
  return false;
}

/* ═══════════════════ 区段标注（结构域 / 定位高亮） ═══════════════════ */

/**
 * 算出当前该在画布上显示哪些色带。
 * 结构域标注和「序列定位」的高亮走同一套渲染，只是来源不同。
 */
function activeBands() {
  const bands = [];
  for (const d of state.domains) {
    bands.push({ start: d.start, end: d.end, color: d.color, label: d.name });
  }
  if (state.locatedRange) {
    bands.push({
      start: state.locatedRange[0],
      end: state.locatedRange[1],
      color: '#8A93A0',
      label: null,
    });
  }
  // PDB 里没解析出来的残基：它们在结构上是自由单链，但要让人一眼看出
  // 「这段是缺口、不是实验测定到的单链」。
  for (const [s, e] of state.pdbGaps) {
    bands.push({ start: s, end: e, color: '#B8C0CC', label: '未解析' });
  }
  return bands;
}

/* ═══════════════════ 假结：本地检测，不出 400 ═══════════════════ */

/**
 * 找出所有互相交叉的配对（也就是假结）。
 * ViennaRNA 的近邻模型算不了假结，后端会返回 400 —— 与其把报错甩给用户，
 * 不如在前端就识别出来，给出解释，并且把坐标照常重排好。
 */
function findCrossings(pairs) {
  const norm = pairs.map(([i, j]) => (i < j ? [i, j] : [j, i])).sort((a, b) => a[0] - b[0]);
  const out = [];
  for (let a = 0; a < norm.length; a++) {
    const [i, j] = norm[a];
    for (let b = a + 1; b < norm.length; b++) {
      const [k, l] = norm[b];
      if (k >= j) break;          // 后面的配对起点更靠右，不可能再交叉
      if (l > j) out.push([norm[a], norm[b]]);
    }
  }
  return out;
}

function fmtPair(p) {
  return `#${Math.min(p[0], p[1]) + 1}–#${Math.max(p[0], p[1]) + 1}`;
}

/**
 * 假结状态下不走 /api/evaluate（那会 400），但仍要重排坐标，
 * 否则画布会停在旧状态。环形布局本身能显示假结，所以图依然可用。
 */
async function showPseudoknot(crossings, structure) {
  clearMessages();
  const [a, b] = crossings[0];
  addMessage('warn',
    `当前结构含假结：${fmtPair(a)} 与 ${fmtPair(b)} 互相交叉。`
    + '假结在图上用红色虚线画出，排版与编辑都不受影响；'
    + '算不出 ΔG 是因为近邻热力学模型本身不支持假结，属于模型的固有限制。');
  addMessage('note', '要让 ΔG 恢复，解除交叉的其中一对即可。');

  try {
    const data = await api('/api/layout', {
      sequence: state.sequence, structure, layout: el.layout.value,
    });
    if (state.result) {
      state.result.layout = data;
      state.result.structure = structure;
      state.result.energy = null;
      state.result.infeasible = false;
      state.result.has_pseudoknot = true;
      // 假结这一支走的是 /api/layout，拿不到后端算的 crossing_pairs，
      // 必须用本地检出的结果补上，否则图上画不出假结的红虚线。
      state.result.crossing_pairs = crossings.map(([a, b]) => [a, b]);
      state.result.mfe_energy = state.result.mfe_energy ?? null;
    }
    state.fitPending = false;    // 保留用户当前视角，避免每次编辑都跳回适应窗口
    renderMeter(state.result);
    render();
  } catch (e) {
    addMessage('error', e.message);
  }
}

/* ═══════════════════ 序列定位 ═══════════════════ */

function reverseComplement(s) {
  const map = { A: 'U', U: 'A', G: 'C', C: 'G', N: 'N' };
  return s.split('').reverse().map((c) => map[c] || c).join('');
}

/** 把视角挪到某个碱基上（保持当前缩放倍数）。 */
function centerOn(idx) {
  const pts = effectivePoints()
    || (state.result && state.result.layout && state.result.layout.points);
  if (!pts || !pts[idx]) return;
  const p = pts[idx];
  const v = state.view;
  state.view = { x: p.x - v.w / 2, y: p.y - v.h / 2, w: v.w, h: v.h };
  applyViewBox();
}

/**
 * 定位框支持两种输入：
 *   · 纯数字      → 跳到该位置
 *   · 序列片段    → 在序列里查找（找不到就试反向互补，RNA 研究里很常用）
 */
function locateInSequence() {
  const raw = (el.locateInput.value || '').trim();
  if (!state.sequence) { toast('还没有序列'); return; }
  if (!raw) { toast('输入位置编号或序列片段'); return; }
  const n = state.sequence.length;

  if (/^\d+$/.test(raw)) {
    const pos = parseInt(raw, 10);
    if (pos < 1 || pos > n) { toast(`位置超出范围（1–${n}）`); return; }
    state.locatedRange = [pos - 1, pos - 1];
    state.selection = pos - 1;
    state.fitPending = false;
    render();
    centerOn(pos - 1);
    toast(`已定位到 #${pos}`);
    return;
  }

  const q = raw.replace(/[^A-Za-z]/g, '').toUpperCase().replace(/T/g, 'U');
  if (!q) { toast('没识别出有效的序列片段'); return; }

  const hit = state.sequence.indexOf(q);
  if (hit >= 0) {
    state.locatedRange = [hit, hit + q.length - 1];
    state.selection = hit;
    state.fitPending = false;
    render();
    centerOn(hit);
    toast(`在 #${hit + 1}–#${hit + q.length} 找到（${q.length} nt）`);
    return;
  }

  const rc = reverseComplement(q);
  const hit2 = state.sequence.indexOf(rc);
  if (hit2 >= 0) {
    state.locatedRange = [hit2, hit2 + rc.length - 1];
    state.selection = hit2;
    state.fitPending = false;
    render();
    centerOn(hit2);
    toast(`未找到原序列，但在 #${hit2 + 1} 找到它的反向互补`);
    return;
  }

  state.locatedRange = null;
  render();
  toast('序列中没有找到这段片段');
}

function clearLocatedRange() {
  if (!state.locatedRange) return;
  state.locatedRange = null;
}

/* ═══════════════════ 折叠过渡动画（VARNA 风格） ═══════════════════ */

/**
 * 结构变化时让碱基从旧坐标平滑滑到新坐标，而不是瞬间跳变。
 * 手工建模时特别有用：能看清「加这一对之后整条链是怎么重新排布的」。
 *
 * 做法是先把所有元素画到新位置，再整体倒推回旧位置，然后逐帧插值。
 * 这样只改属性、不重建 DOM，帧率稳定。
 */
let foldAnimHandle = null;

function prefersReducedMotion() {
  return window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;
}

function animateFold(svgEl, fromPts, toPts, fromPairs, toPairs, duration = 380) {
  if (foldAnimHandle) { cancelAnimationFrame(foldAnimHandle); foldAnimHandle = null; }
  if (prefersReducedMotion()) return;
  if (!fromPts || !toPts || fromPts.length !== toPts.length || fromPts.length === 0) return;

  const lerp = (a, b, t) => a + (b - a) * t;

  /**
   * 欠阻尼弹簧的阶跃响应：会先冲过头一点再回落，看起来「有弹性」。
   * zeta 越小越弹（1 表示临界阻尼、完全不弹），omega 控制抖动频率。
   */
  const spring = (t, zeta = 0.42, omega = 15) => {
    if (t <= 0) return 0;
    if (t >= 1) return 1;
    const wd = omega * Math.sqrt(1 - zeta * zeta);
    return 1 - Math.exp(-zeta * omega * t)
      * (Math.cos(wd * t) + (zeta * omega / wd) * Math.sin(wd * t));
  };

  // 位移越大的碱基弹得越明显：弹幅小的时候看不出弹性会显得很假
  const dist = toPts.map((q, i) => (fromPts[i] ? Math.hypot(q.x - fromPts[i].x, q.y - fromPts[i].y) : 0));
  const maxDist = Math.max(...dist, 1e-6);
  const ampOf = (i) => Math.min(1, 0.35 + 0.65 * (dist[i] / maxDist));

  // 收集需要跟着动的元素
  const nodes = [];
  svgEl.querySelectorAll('.nt[data-i]').forEach((g) => {
    const i = +g.dataset.i;
    if (fromPts[i]) nodes.push({ g, i });
  });

  const pairsNow = new Map();
  for (const [i, j] of toPairs) pairsNow.set(`${i},${j}`, { i, j });
  const pairsOld = new Set(fromPairs.map(([i, j]) => `${i},${j}`));

  const lines = [];
  svgEl.querySelectorAll('.bp-line[data-a]').forEach((el2) => {
    const a = +el2.dataset.a, b = +el2.dataset.b;
    lines.push({ el: el2, a, b, isNew: !pairsOld.has(`${a},${b}`) });
  });

  const backs = [];
  svgEl.querySelectorAll('.backbone[data-i]').forEach((el2) => {
    backs.push({ el: el2, i: +el2.dataset.i });
  });

  const nums = [];
  svgEl.querySelectorAll('.nt-num[data-i]').forEach((el2) => {
    nums.push({ el: el2, i: +el2.dataset.i, ox: +el2.dataset.ox, oy: +el2.dataset.oy });
  });

  const t0 = performance.now();
  // 每个碱基一个进度；沿链加一点延迟，像一道波从 5' 传到 3'
  const spread = 70;
  const tOf = (i, elapsed) => {
    const delay = (i / Math.max(1, toPts.length - 1)) * spread;
    const local = (elapsed - delay) / duration;
    if (local <= 0) return 0;
    const e = spring(local) * ampOf(i) + (1 - ampOf(i)) * Math.min(1, local * 3);
    return e;
  };

  const step = (now) => {
    const elapsed = now - t0;
    const raw = Math.min(1, elapsed / (duration + spread));
    const t = 1;   // 线条端点各自用自己的进度，见下

    for (const { g, i } of nodes) {
      const ti = tOf(i, elapsed);
      const x = lerp(fromPts[i].x, toPts[i].x, ti);
      const y = lerp(fromPts[i].y, toPts[i].y, ti);
      const c = g.querySelector('.nt-circle');
      const tx = g.querySelector('.nt-text');
      if (c) { c.setAttribute('cx', x); c.setAttribute('cy', y); }
      if (tx) { tx.setAttribute('x', x); tx.setAttribute('y', y); }
    }
    for (const { el: l, i } of backs) {
      const ta = tOf(i, elapsed), tb = tOf(i + 1, elapsed);
      const x1 = lerp(fromPts[i].x, toPts[i].x, ta);
      const y1 = lerp(fromPts[i].y, toPts[i].y, ta);
      const x2 = lerp(fromPts[i + 1].x, toPts[i + 1].x, tb);
      const y2 = lerp(fromPts[i + 1].y, toPts[i + 1].y, tb);
      l.setAttribute('x1', x1); l.setAttribute('y1', y1);
      l.setAttribute('x2', x2); l.setAttribute('y2', y2);
    }
    for (const { el: l, a, b, isNew } of lines) {
      const ta = tOf(a, elapsed), tb = tOf(b, elapsed);
      const x1 = lerp(fromPts[a] ? fromPts[a].x : toPts[a].x, toPts[a].x, ta);
      const y1 = lerp(fromPts[a] ? fromPts[a].y : toPts[a].y, toPts[a].y, ta);
      const x2 = lerp(fromPts[b] ? fromPts[b].x : toPts[b].x, toPts[b].x, tb);
      const y2 = lerp(fromPts[b] ? fromPts[b].y : toPts[b].y, toPts[b].y, tb);
      if (l.tagName === 'line') {
        l.setAttribute('x1', x1); l.setAttribute('y1', y1);
        l.setAttribute('x2', x2); l.setAttribute('y2', y2);
      } else {
        // 线性布局下的弧线：半径随两端距离变化
        const rad = Math.abs(x2 - x1) / 2;
        l.setAttribute('d', `M ${x1} ${y1} A ${rad} ${rad} 0 0 1 ${x2} ${y2}`);
      }
      if (isNew) l.setAttribute('opacity', String(0.85 * Math.min(1, ta * 2)));  // 新配对淡入
    }
    for (const { el: t2, i, ox, oy } of nums) {
      if (!fromPts[i]) continue;
      const ti = tOf(i, elapsed);
      const dx = toPts[i].x - fromPts[i].x;
      const dy = toPts[i].y - fromPts[i].y;
      t2.setAttribute('x', toPts[i].x + ox - dx * (1 - ti));
      t2.setAttribute('y', toPts[i].y + oy - dy * (1 - ti));
    }

    if (raw < 1) {
      foldAnimHandle = requestAnimationFrame(step);
    } else {
      foldAnimHandle = null;
    }
  };
  foldAnimHandle = requestAnimationFrame(step);
}

/* ═══════════════════ 结构域标注 ═══════════════════ */

/** 预设配色：都经过挑选，彼此可区分，在白底和印刷下都能看清 */
const DOMAIN_COLORS = ['#2F6FB5', '#D2912A', '#4E9143', '#BE4A47', '#7B5EA7', '#3E8E9E'];

function nextDomainColor() {
  const used = new Set(state.domains.map((d) => d.color));
  return DOMAIN_COLORS.find((c) => !used.has(c)) || DOMAIN_COLORS[state.domains.length % DOMAIN_COLORS.length];
}

function addDomain() {
  const n = state.sequence.length;
  if (!n) { toast('先粘贴一条序列'); return; }

  const name = (el.domainName.value || '').trim();
  const start = parseInt(el.domainStart.value, 10);
  const end = parseInt(el.domainEnd.value, 10);

  if (!name) { toast('给结构域起个名字'); el.domainName.focus(); return; }
  if (!Number.isFinite(start) || !Number.isFinite(end)) {
    toast('填写起止位置，或先用「定位」选中区间再点「用高亮区间」');
    return;
  }
  if (start < 1 || end > n || start > end) {
    toast(`位置要在 1–${n} 之间，且起点不大于终点`);
    return;
  }

  const s0 = start - 1, e0 = end - 1;
  const overlap = state.domains.find((d) => !(e0 < d.start || s0 > d.end));
  if (overlap) {
    toast(`与已有结构域「${overlap.name}」重叠，请调整范围`);
    return;
  }

  state.domains.push({ name, start: s0, end: e0, color: nextDomainColor() });
  state.domains.sort((a, b) => a.start - b.start);

  el.domainName.value = '';
  el.domainStart.value = '';
  el.domainEnd.value = '';
  state.locatedRange = null;
  renderDomains();
  render();
  saveSession();
  toast(`已添加结构域「${name}」（#${start}–#${end}）`);
}

function removeDomain(idx) {
  const d = state.domains[idx];
  if (!d) return;
  state.domains.splice(idx, 1);
  renderDomains();
  render();
  saveSession();
  toast(`已删除「${d.name}」`);
}

function fillRangeFromLocated() {
  const n = state.sequence.length;
  if (!state.locatedRange) { toast('先用「定位」选中一段区间'); return; }
  el.domainStart.value = String(state.locatedRange[0] + 1);
  el.domainEnd.value = String(state.locatedRange[1] + 1);
  if (!el.domainName.value) el.domainName.focus();
  void n;
}

function renderDomains() {
  const list = el.domainList;
  if (!state.domains.length) {
    list.innerHTML = '<p class="empty">还没有标注结构域。</p>';
    return;
  }
  list.innerHTML = state.domains.map((d, i) => (
    `<div class="domain-row" data-idx="${i}">`
    + `<span class="domain-swatch" style="background:${d.color}"></span>`
    + `<span class="domain-row-name">${escapeHtml(d.name)}</span>`
    + `<span class="domain-row-range">#${d.start + 1}–#${d.end + 1}</span>`
    + `<span class="domain-row-len">${d.end - d.start + 1} nt</span>`
    + `<button class="domain-del" data-del="${i}" type="button" title="删除">×</button>`
    + `</div>`
  )).join('');
}

/* ═══════════════════ 分段折叠 ═══════════════════ */

/**
 * 按结构域切开，每段独立折叠，再把结果拼回整体坐标并统一评估。
 *
 * 用处：判断结构域是否**独立折叠**。如果各段单独折叠的能量之和与整体折叠
 * 差不多，说明域间耦合弱；差很多则说明域间存在相互作用。
 */
async function foldByDomains() {
  if (!state.sequence) { toast('先粘贴一条序列'); return; }
  if (state.domains.length < 1) { toast('先添加至少一个结构域'); return; }

  const n = state.sequence.length;
  const doms = [...state.domains].sort((a, b) => a.start - b.start);
  const temp = parseFloat(el.temperature.value) || 37;
  const engine = el.engine.value;

  setBusy(true, `分段折叠中（共 ${doms.length} 段）…`);
  clearMessages();
  try {
    const perDomain = [];
    const allPairs = [];
    const uncovered = [];
    let cursor = 0;
    for (const d of doms) {
      if (d.start > cursor) uncovered.push([cursor, d.start - 1]);
      cursor = Math.max(cursor, d.end + 1);
    }
    if (cursor < n) uncovered.push([cursor, n - 1]);

    for (const d of doms) {
      const sub = state.sequence.slice(d.start, d.end + 1);
      const r = await api('/api/predict', {
        sequence: sub,
        engine,
        method: el.method.value,
        temperature: temp,
        layout: el.layout.value,
        with_probabilities: false,
      });
      const parsed = parseStructure(r.structure);
      for (const [i, j] of parsed.pairs) allPairs.push([d.start + i, d.start + j]);
      perDomain.push({
        name: d.name,
        range: `#${d.start + 1}–#${d.end + 1}`,
        len: sub.length,
        dg: r.energy,
        pairs: parsed.pairs.length,
      });
    }

    const structure = pairsToStructure(n, allPairs);
    const data = await api('/api/evaluate', {
      sequence: state.sequence,
      structure,
      engine,
      temperature: temp,
      layout: el.layout.value,
      compare_mfe: true,
    });

    state.pairs = allPairs;
    state.fitPending = false;
    adoptResult(data);
    pushHistory(`分段折叠（${doms.length} 段）`);
    reportNotes(data);

    // 各段结果与整体对比
    const sumDg = perDomain.reduce((t, d) => t + (d.dg || 0), 0);
    for (const d of perDomain) {
      addMessage('note',
        `${d.name}（${d.range}，${d.len} nt）：ΔG ${d.dg == null ? '不可用' : d.dg.toFixed(2)}，${d.pairs} 个配对`);
    }
    if (uncovered.length) {
      addMessage('note',
        `未标注为结构域的区域（${uncovered.map(([a, b]) => `#${a + 1}–#${b + 1}`).join('、')}）`
        + '按单链处理，没有参与折叠。');
    }
    if (data.energy != null) {
      const vsMfe = data.mfe_energy != null ? data.energy - data.mfe_energy : null;
      addMessage('note',
        `各段 ΔG 之和 ${sumDg.toFixed(2)}，拼回整体后 ΔG ${data.energy.toFixed(2)}`
        + (vsMfe != null
          ? `；整条序列的 MFE 是 ${data.mfe_energy.toFixed(2)}，相差 ${vsMfe > 0 ? '+' : ''}${vsMfe.toFixed(2)} kcal/mol。`
            + (Math.abs(vsMfe) < 2
              ? '差距很小，说明各结构域基本是独立折叠的。'
              : '差距较大，提示结构域之间可能存在相互作用，或整体折叠另有更优解。')
          : '。'));
    }
    toast(`分段折叠完成（${doms.length} 段）`);
  } catch (e) {
    addMessage('error', '分段折叠失败：' + e.message);
    toast('分段折叠失败');
  } finally {
    setBusy(false);
  }
}

/* ═══════════════════ 会话自动保存 ═══════════════════ */

/**
 * 把当前工作状态存到浏览器本地，下次打开自动恢复。
 * 手工搭结构容易一坐就是半小时，刷新一下全丢太伤了。
 *
 * 用 localStorage 而不是后端存盘：应用本来就在本机跑，localStorage 足够，
 * 也免去「用户的文件被写到哪里去了」这类问题。
 */
const SESSION_KEY = 'rna-studio.session.v1';
const SESSION_VERSION = 1;

function collectSession() {
  return {
    v: SESSION_VERSION,
    savedAt: Date.now(),
    sequence: state.sequence,
    sequenceB: el.seqB.value,
    mode: state.mode,
    engine: el.engine.value,
    method: el.method.value,
    layout: el.layout.value,
    temperature: el.temperature.value,
    colorMode: el.colorMode.value,
    editMode: state.editMode,
    period: el.periodNum.value,
    svgScope: el.svgScope.value,
    bpStyleDraw: el.bpStyleDraw ? el.bpStyleDraw.value : '',
    varnaAlgo: el.varnaAlgo.value,
    constraints: el.constraints.value,
    probingMethod: el.probingMethod.value,
    probingData: el.probingData.value,
    probingM: el.probingM.value,
    probingB: el.probingB.value,
    pairs: state.pairs,
    forbidden: [...state.forbidden],
    domains: state.domains.map((d) => ({ ...d })),
    manualPoints: state.manualPoints ? state.manualPoints.map((p) => ({ x: p.x, y: p.y })) : null,
    layoutOverrides: JSON.parse(JSON.stringify(state.layoutOverrides || {})),
  };
}

let saveTimer = null;
function saveSession() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(collectSession()));
    } catch (e) {
      // 隐私模式 / 配额满：静默失败，不影响使用
    }
  }, 400);
}

function clearSession() {
  try { localStorage.removeItem(SESSION_KEY); } catch (e) { /* 忽略 */ }
}

/** 返回是否成功恢复了内容 */
function restoreSession() {
  let raw = null;
  try { raw = localStorage.getItem(SESSION_KEY); } catch (e) { return false; }
  if (!raw) return false;

  let d = null;
  try { d = JSON.parse(raw); } catch (e) { return false; }
  if (!d || d.v !== SESSION_VERSION || !d.sequence) return false;

  // 序列与各类参数
  el.seq.value = d.sequence;
  el.seqB.value = d.sequenceB || '';
  if (d.engine) el.engine.value = d.engine;
  if (d.method) refreshMethodOptions();     // 选项依赖引擎，先刷再设
  if (d.method) el.method.value = d.method;
  if (d.layout) { el.layout.value = d.layout; state.layout = d.layout; }
  if (d.temperature != null) el.temperature.value = d.temperature;
  if (d.colorMode) el.colorMode.value = d.colorMode;
  if (d.editMode) state.editMode = d.editMode;
  if (d.period != null) el.periodNum.value = d.period;
  if (d.svgScope) el.svgScope.value = d.svgScope;
  if (d.bpStyleDraw && el.bpStyleDraw) el.bpStyleDraw.value = d.bpStyleDraw;
  if (d.varnaAlgo) el.varnaAlgo.value = d.varnaAlgo;
  if (d.probingMethod) {
    el.probingMethod.value = d.probingMethod;
    el.probingBlock.hidden = !d.probingMethod;
  }
  if (d.probingData != null) el.probingData.value = d.probingData;
  if (d.probingM != null) el.probingM.value = d.probingM;
  if (d.probingB != null) el.probingB.value = d.probingB;

  // 结构状态
  state.sequence = d.sequence;
  state.pairs = Array.isArray(d.pairs) ? d.pairs.map((p) => [p[0], p[1]]) : [];
  state.forbidden = new Set(d.forbidden || []);
  state.domains = Array.isArray(d.domains) ? d.domains : [];
  state.manualPoints = Array.isArray(d.manualPoints) && d.manualPoints.length === d.sequence.length
    ? d.manualPoints.map((p) => ({ x: p.x, y: p.y })) : null;
  state.layoutOverrides = (d.layoutOverrides && typeof d.layoutOverrides === 'object'
    && !Array.isArray(d.layoutOverrides))
    ? JSON.parse(JSON.stringify(d.layoutOverrides)) : {};
  state.colorMode = el.colorMode.value;

  el.constraints.value = d.constraints && d.constraints.length === d.sequence.length
    ? d.constraints
    : '.'.repeat(d.sequence.length);
  el.statLen.textContent = d.sequence.length;
  const gc = d.sequence.length
    ? Math.round(((d.sequence.match(/[GC]/g) || []).length / d.sequence.length) * 100) : 0;
  el.statGc.textContent = d.sequence.length ? gc + '%' : '–';
  el.statPairs.textContent = state.pairs.length;
  syncConstraintReadouts();

  // 模式：手动建模要保留结构，所以绕过 setMode 的清空逻辑
  if (d.mode === 'cofold' || d.mode === 'manual') {
    state.mode = d.mode;
    el.modeBtns.forEach((bt) => {
      const on = bt.dataset.mode === d.mode;
      bt.classList.toggle('is-on', on);
      bt.setAttribute('aria-selected', String(on));
    });
    el.cofoldBlock.hidden = d.mode !== 'cofold';
    el.statModeWrap.hidden = d.mode === 'cofold';
    refreshMethodOptions();
  }
  return true;
}


/* ═══════════════════ 点阵图（dot plot） ═══════════════════ */

/**
 * 点阵图是 RNA 领域最标准的「第二种视角」：把 n×n 的配对概率画成一个矩阵，
 * 一眼能看出哪些螺旋是确定的、哪些区域在系综里摇摆不定。
 *
 * 约定参考 ViennaRNA 的实现（PS_dot_plot 的文档）：
 *   · 横轴 j、纵轴 i，只画 i<j 的上三角
 *   · **方块面积**与配对概率成正比（不是颜色深浅）
 *   · 下三角叠当前结构，便于对照「预测的结构落在概率高的地方吗」
 *
 * 矩阵可能有 n²/2 个格子，直接建 DOM 会爆；所以先把概率画进 canvas，
 * 再以 data URL 塞进 SVG 的 <image>，坐标轴和结构点仍用 SVG 画（保证可导出）。
 */
const DOT_PLOT_PX = 900;
const DOT_PLOT_MIN_P = 0.005;   // 低于这个概率不画，否则整片糊成灰色

async function ensureProbabilities() {
  if (state.probMap.size) return true;
  if (!state.sequence) return false;
  try {
    const d = await api('/api/probabilities', {
      sequence: state.sequence,
      engine: el.engine.value,
      temperature: parseFloat(el.temperature.value) || 37,
    });
    state.probMap.clear();
    for (const [i, j, p] of d.probabilities) {
      state.probMap.set(`${i},${j}`, p);
      state.probMap.set(`${j},${i}`, p);
    }
    return true;
  } catch (e) {
    addMessage('warn', '配对概率计算失败，点阵图只能显示当前结构：' + e.message);
    return false;
  }
}

function drawDotPlot() {
  const n = state.sequence.length;
  const svg = el.canvas;
  svg.innerHTML = '';
  if (!n) { el.canvasEmpty.hidden = false; return; }
  el.canvasEmpty.hidden = true;
  el.legend.innerHTML =
    '<span class="legend-item"><span class="legend-swatch" style="background:rgba(70,130,190,.55)"></span>方块面积 ∝ 配对概率（上三角）</span>'
    + '<span class="legend-item"><span class="legend-swatch" style="background:#8C2F2A;border-radius:50%"></span>当前结构（下三角，与上三角镜像）</span>'
    + '<span class="legend-item" style="color:var(--muted-solid)">螺旋呈现为垂直于主对角线的短串</span>';

  // ── 1. 用 canvas 画概率方块 ──
  const S = DOT_PLOT_PX;
  const cv = document.createElement('canvas');
  cv.width = S; cv.height = S;
  const ctx = cv.getContext('2d');
  ctx.fillStyle = '#ffffff';
  ctx.fillRect(0, 0, S, S);

  const cell = S / n;              // 每个格子占多少像素
  // 半透明浅蓝：重叠处自然加深，能看出概率的层次
  ctx.fillStyle = 'rgba(70, 130, 190, 0.55)';
  let drawn = 0;
  state.probMap.forEach((p, key) => {
    const [i, j] = key.split(',').map(Number);
    if (i >= j) return;            // 只画上三角
    if (p < DOT_PLOT_MIN_P) return;
    // 面积正比于 p → 边长正比于 sqrt(p)
    const side = cell * Math.sqrt(Math.min(1, p)) * 0.95;
    if (side < 0.6) return;
    // 屏幕坐标：x 向右为 j，y 向下为 i（所以小 i 在上方 = 上三角）
    const cx = (j + 0.5) * cell;
    const cy = (i + 0.5) * cell;
    ctx.fillRect(cx - side / 2, cy - side / 2, side, side);
    drawn++;
  });

  // 主对角线画一条淡线，作为参照
  ctx.strokeStyle = '#D3DAE3';
  ctx.lineWidth = 1;
  ctx.beginPath();
  ctx.moveTo(0, 0); ctx.lineTo(S, S);
  ctx.stroke();

  // ── 2. 组装 SVG：底图 + 坐标轴 + 当前结构点 ──
  const pad = S * 0.07;
  const total = S + pad * 2;
  svg.setAttribute('viewBox', `0 0 ${total} ${total}`);
  svg.setAttribute('preserveAspectRatio', 'xMidYMid meet');

  const img = mk('image', {
    x: pad, y: pad, width: S, height: S,
    href: cv.toDataURL('image/png'),
    preserveAspectRatio: 'none',
  });
  img.setAttributeNS('http://www.w3.org/1999/xlink', 'xlink:href', cv.toDataURL('image/png'));
  svg.appendChild(img);

  // 轴框
  svg.appendChild(mk('rect', {
    x: pad, y: pad, width: S, height: S,
    fill: 'none', stroke: '#D3DAE3', 'stroke-width': 1,
  }));

  // 刻度：每 step 个位置标一个
  const step = n <= 80 ? 10 : (n <= 300 ? 50 : 100);
  const tickFs = Math.max(10, S * 0.018);
  for (let k = step; k <= n; k += step) {
    const px = pad + k * cell;
    const py = pad + k * cell;
    svg.appendChild(mk('line', {
      x1: px, y1: pad, x2: px, y2: pad + S, stroke: '#E4E9EF', 'stroke-width': 1,
    }));
    svg.appendChild(mk('line', {
      x1: pad, y1: py, x2: pad + S, y2: py, stroke: '#E4E9EF', 'stroke-width': 1,
    }));
    const tx = mk('text', {
      x: px, y: pad + S + tickFs * 1.4, 'text-anchor': 'middle',
      'font-size': tickFs, fill: '#647183', 'font-family': 'ui-monospace, monospace',
    });
    tx.textContent = String(k);
    svg.appendChild(tx);
    const ty = mk('text', {
      x: pad - tickFs * 0.5, y: py, 'text-anchor': 'end', 'dominant-baseline': 'middle',
      'font-size': tickFs, fill: '#647183', 'font-family': 'ui-monospace, monospace',
    });
    ty.textContent = String(k);
    svg.appendChild(ty);
  }
  const axisLabel = (x, y, text, rotate) => {
    const t = mk('text', {
      x, y, 'text-anchor': 'middle', 'font-size': tickFs * 1.1,
      fill: '#3B4757', 'font-family': 'ui-sans-serif, sans-serif',
      transform: rotate ? `rotate(-90 ${x} ${y})` : null,
    });
    t.textContent = text;
    svg.appendChild(t);
  };
  axisLabel(pad + S / 2, pad + S + tickFs * 3.4, '位置 j —— 配对的 3′ 端', false);
  axisLabel(pad - tickFs * 3.8, pad + S / 2, '位置 i —— 配对的 5′ 端', true);

  // ── 3. 下三角叠当前结构 ──
  // 上三角是配对概率，下三角是「当前画出来的结构」，两者关于主对角线镜像。
  // 看的时候把下三角的点和上三角的方块对着比：点落在方块大的地方，
  // 说明这个配对在系综里站得住脚；点在空白处则要多留个心眼。
  const rd = Math.max(1.4, cell * 0.46);
  for (const [i, j] of state.pairs) {
    const cx = pad + (i + 0.5) * cell;
    const cy = pad + (j + 0.5) * cell;
    svg.appendChild(mk('circle', {
      cx, cy, r: rd * 1.7, fill: '#ffffff', opacity: 0.9,   // 白描边让点从方块里跳出来
    }));
    svg.appendChild(mk('circle', { cx, cy, r: rd, fill: '#8C2F2A' }));
  }

  // 结构域色带在点阵图里没有意义，这里不画
  state.fitView = { x: 0, y: 0, w: total, h: total };
  state.view = { ...state.fitView };
  applyViewBox();
}

/* ═══════════════════ 彩虹渐变着色（5′ → 3′） ═══════════════════ */

/**
 * 按位置做彩虹渐变是最常见的「表达方向性」的方式（R2DT 等工具默认就这么配）。
 * 它能一眼看出哪段是 5′、哪段是 3′，也能让读者顺着颜色追踪链的走向。
 */
const RAINBOW_STOPS = [
  [0.00, [ 26,  76, 140]],
  [0.22, [ 46, 139, 168]],
  [0.42, [ 78, 168,  96]],
  [0.60, [208, 176,  52]],
  [0.80, [206, 108,  52]],
  [1.00, [158,  48,  74]],
];

function rainbowColor(t) {
  const v = Math.max(0, Math.min(1, t));
  for (let k = 0; k < RAINBOW_STOPS.length - 1; k++) {
    const [t0, c0] = RAINBOW_STOPS[k];
    const [t1, c1] = RAINBOW_STOPS[k + 1];
    if (v <= t1) {
      const u = (v - t0) / (t1 - t0 || 1);
      return c0.map((x, m) => Math.round(x + (c1[m] - x) * u));
    }
  }
  return RAINBOW_STOPS[RAINBOW_STOPS.length - 1][1];
}


/* ═══════════════════ 序列条（与结构双向联动） ═══════════════════ */

const STRIP_PER_LINE = 60;

/**
 * 把序列渲染成一条可交互的线性条。
 * 悬停结构上的碱基会高亮这里的对应字符，反之亦然——长链上靠这个定位最快。
 */
function renderSeqStrip() {
  const seq = state.sequence;
  const body = el.stripBody;
  if (!body) return;

  if (!seq) {
    body.innerHTML = '<span class="strip-empty">还没有序列</span>';
    state.stripNodes = [];
    state.stripHot = null;
    return;
  }

  const parts = [];
  for (let start = 0; start < seq.length; start += STRIP_PER_LINE) {
    const chunk = seq.slice(start, start + STRIP_PER_LINE);
    const chars = [];
    for (let k = 0; k < chunk.length; k++) {
      const i = start + k;
      // 每 10 个加一点间隔，方便数位置
      const cls = 'ss-char' + ((i + 1) % 10 === 0 ? ' ss-tick' : '');
      chars.push(`<span class="${cls}" data-i="${i}">${chunk[k]}</span>`);
    }
    parts.push(
      `<div class="seq-line"><span class="seq-pos">${start + 1}</span>`
      + `<span class="seq-chars">${chars.join('')}</span></div>`,
    );
  }
  body.innerHTML = parts.join('');
  state.stripNodes = Array.from(body.querySelectorAll('.ss-char'));
  state.stripHot = null;
  applyInvalidToStrip();
}

/** 把「配对不合法」的碱基在序列条上也标出来 */
function applyInvalidToStrip() {
  if (!state.stripNodes) return;
  const bad = new Set();
  for (const key of state.invalidPairs) {
    const [i, j] = key.split(',').map(Number);
    bad.add(i); bad.add(j);
  }
  for (const node of state.stripNodes) {
    node.classList.toggle('is-bad', bad.has(+node.dataset.i));
  }
}

/** 高亮序列条上的某个位置，必要时把它滚进可见区域 */
function setStripHighlight(i) {
  if (state.stripHot === i) return;
  const nodes = state.stripNodes || [];
  if (state.stripHot != null && nodes[state.stripHot]) {
    nodes[state.stripHot].classList.remove('is-hot');
  }
  state.stripHot = i;
  if (i == null || !nodes[i]) return;
  const node = nodes[i];
  node.classList.add('is-hot');

  // 只在看不见的时候滚动，且只滚序列条自己，避免整页跳动
  const body = el.stripBody;
  const nr = node.getBoundingClientRect();
  const br = body.getBoundingClientRect();
  if (nr.top < br.top || nr.bottom > br.bottom) {
    body.scrollTop += (nr.top - br.top) - br.height / 2 + nr.height / 2;
  }
}

/** 反向：高亮画布上的某个碱基（鼠标在序列条上移动时用） */
function setCanvasHighlight(i) {
  if (state.canvasHot === i) return;
  const svg = el.canvas;
  if (state.canvasHot != null) {
    const prev = svg.querySelector(`.nt[data-i="${state.canvasHot}"]`);
    if (prev) prev.classList.remove('is-hot');
  }
  state.canvasHot = i;
  if (i == null) return;
  const node = svg.querySelector(`.nt[data-i="${i}"]`);
  if (node) node.classList.add('is-hot');
  state.selection = i;
}

/* ═══════════════════ 在结构上直接改序列 ═══════════════════ */

// 合法的 Watson-Crick 配对 + G·U 摆动配对
const CANONICAL_PAIRS = new Set(['AU', 'UA', 'GC', 'CG', 'GU', 'UG']);

/**
 * 找出因为改碱基而变得不合法的配对。
 * 不改动结构本身——用户可能是故意造一个错配来试探，标红只是提醒。
 */
function computeInvalidPairs() {
  const bad = new Set();
  for (const [i, j] of state.pairs) {
    const a = state.sequence[i], b = state.sequence[j];
    if (!a || !b) continue;
    if (!CANONICAL_PAIRS.has(a + b)) bad.add(`${i},${j}`);
  }
  return bad;
}

let baseEditorFor = null;

function openBaseEditor(idx, anchorEl) {
  baseEditorFor = idx;
  el.baseEditorPos.textContent = `#${idx + 1}`;
  el.baseEditorCur.textContent = state.sequence[idx] || '?';
  el.baseEditor.querySelectorAll('[data-base]').forEach((b) => {
    b.classList.toggle('is-cur', b.dataset.base === state.sequence[idx]);
  });

  // 定位到被点的那个碱基旁边
  const r = anchorEl.getBoundingClientRect();
  const box = el.baseEditor;
  box.hidden = false;
  const bw = box.offsetWidth, bh = box.offsetHeight;
  let left = r.left + r.width / 2 - bw / 2;
  let top = r.top - bh - 10;
  if (top < 8) top = r.bottom + 10;                        // 上方放不下就放下方
  left = Math.max(8, Math.min(left, window.innerWidth - bw - 8));
  top = Math.max(8, Math.min(top, window.innerHeight - bh - 8));
  box.style.left = `${left}px`;
  box.style.top = `${top}px`;
}

function closeBaseEditor() {
  baseEditorFor = null;
  el.baseEditor.hidden = true;
}

/**
 * 替换某个位置的碱基。
 *
 * 刻意不走 syncSequence()：那个函数在发现序列变化时会清空配对和结构，
 * 而这里要的恰恰是「保留结构，只把不再合法的配对标出来」。
 */
function setBase(idx, ch) {
  const old = state.sequence[idx];
  if (!old || old === ch) { closeBaseEditor(); return; }

  const arr = state.sequence.split('');
  arr[idx] = ch;
  state.sequence = arr.join('');

  el.seq.value = state.sequence;          // 与左侧输入框保持同步
  el.outSeq.textContent = state.sequence;
  state.invalidPairs = computeInvalidPairs();

  closeBaseEditor();
  renderSeqStrip();
  render();
  scheduleEvaluate();                      // 序列变了，ΔG 要重算
  pushHistory(`#${idx + 1} ${old}→${ch}`);

  const n = state.invalidPairs.size;
  toast(n
    ? `#${idx + 1} ${old}→${ch}；有 ${n} 对配对因此变得不合法（已标红）`
    : `#${idx + 1} ${old}→${ch}`);
}

/* ═══════════════════ 配体结合位点 ═══════════════════ */

function renderBindingSites() {
  const box = el.bindingList;
  if (!box) return;
  if (!state.bindingSites.length) {
    box.innerHTML = '<p class="empty">从 PDB 导入后，这里会列出配体及其接触的碱基。</p>';
    return;
  }
  box.innerHTML = state.bindingSites.map((s, k) => {
    const ranges = toRanges(s.positions);
    return `<div class="bind-row" data-idx="${k}">`
      + `<span class="bind-swatch" style="background:${s.color}"></span>`
      + `<span class="bind-name">${escapeHtml(s.name)}`
      + `<span class="bind-kind">${s.isIon ? '离子' : '配体'}</span></span>`
      + `<span class="bind-range">${ranges}</span>`
      + `<span class="bind-count">${s.positions.length} nt</span>`
      + `</div>`;
  }).join('');
}

/** 把零散的位置压成 #12–#15 这样的区间串，太长就省略 */
function toRanges(sorted) {
  if (!sorted.length) return '—';
  const ps = [...sorted].sort((a, b) => a - b);
  const out = [];
  let s = ps[0], p = ps[0];
  for (const q of ps.slice(1)) {
    if (q === p + 1) p = q;
    else { out.push(s === p ? `#${s + 1}` : `#${s + 1}–#${p + 1}`); s = p = q; }
  }
  out.push(s === p ? `#${s + 1}` : `#${s + 1}–#${p + 1}`);
  return out.slice(0, 4).join('、') + (out.length > 4 ? ` 等 ${out.length} 段` : '');
}

/* ═══════════ 排版：结构树语义编辑（建树与变换见 web/structure.js） ═══════════ */


/** 切换编辑模式：画布上的一切交互都由它决定 */
function setEditMode(mode) {
  const MODES = ['preview', 'pair', 'sequence', 'arrange'];
  if (!MODES.includes(mode)) return;
  state.editMode = mode;

  el.editMode.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('is-on', b.dataset.edit === mode);
  });
  el.readonlyBanner.hidden = mode !== 'preview';
  el.arrangeBanner.hidden = mode !== 'arrange';
  el.canvasScroll.classList.toggle('is-readonly', mode === 'preview');
  el.canvasScroll.classList.toggle('is-arranging', mode === 'arrange');

  if (mode !== 'arrange') {
    state.pickedBase = null; state.pickedUnit = null; state.snapGuides = [];
  }
  updateArrangeBanner();
  render();

  const hint = {
    preview: '仅预览：画布已锁定，切换模式才能编辑',
    pair: '改配对：点两个碱基建立配对，右键解除',
    sequence: '改序列：双击碱基替换字母',
    arrange: '排版：单击 stem 选中整个分支；拖本体平移、拖圆点旋转（Shift 15° 吸附）',
  }[mode];
  if (hint) toast(hint);
}

function restoreAutoLayout() {
  const hasOverride = RS.hasAnyOverride(state.layoutOverrides);
  if (!state.manualPoints && !hasOverride) { toast('当前就是自动布局'); return; }
  state.manualPoints = null;
  state.layoutOverrides = {};
  state.pickedBase = null;
  state.pickedUnit = null;
  state.snapGuides = [];
  state.fitPending = true;
  void rerender();
  pushHistory('恢复自动布局');
  toast('已恢复自动布局');
}

/* ═══════════════════ 从 PDB / mmCIF 导入 ═══════════════════ */

// 从 PDB 导入时置位，让 adoptResult 跳过基于字母的重新判定（见 adoptResult 里的说明）
let preserveNonCanonOnce = false;

let pdbText = '';
let pdbChains = [];
let pdbPreview = null;      // 当前选项下的预览结果

function openPdbDialog() {
  pdbText = '';
  pdbChains = [];
  pdbPreview = null;
  el.pdbText.value = '';
  el.pdbFile.value = '';
  el.pdbError.hidden = true;
  el.pdbSummary.hidden = true;
  el.pdbStepFile.hidden = false;
  el.pdbStepChain.hidden = true;
  el.pdbImport.disabled = true;
  // 参考序列默认留空。早先版本会自动填入「当前界面的序列」，但那条序列
  // 常常和 PDB 里的完全无关（比如界面还停在上一次的 tRNA，导入的却是 ydaO），
  // 一比对就是几十处错配、结构全乱。留空反而安全：不填就直接用 PDB 抽出的序列。
  el.pdbDialog.showModal();
}

async function pdbReadFile(file) {
  const name = (file.name || '').toLowerCase();
  if (!/\.(pdb|ent|cif|mmcif|txt)$/.test(name)) {
    el.pdbError.textContent = '请选择 .pdb / .ent / .cif / .mmcif 文件';
    el.pdbError.hidden = false;
    return;
  }
  pdbText = await file.text();
  el.pdbFilename.textContent = `${file.name}（${(file.size / 1024).toFixed(0)} KB）`;
  el.pdbText.value = '';
  await pdbLoadChains();
}

async function pdbLoadChains() {
  el.pdbError.hidden = true;
  el.pdbSummary.hidden = true;
  const text = pdbText || el.pdbText.value;
  if (!text || !text.trim()) {
    el.pdbError.textContent = '先选择文件或粘贴 PDB / mmCIF 内容';
    el.pdbError.hidden = false;
    return;
  }
  if (!pdbText) {
    pdbText = text;
    el.pdbFilename.textContent = '（粘贴的内容）';
  }

  setBusy(true, '解析结构…');
  try {
    const d = await api('/api/pdb/chains', { text: pdbText });
    pdbChains = d.chains;
    if (!pdbChains.length) throw new Error('文件里没有 RNA 链');

    el.pdbChain.innerHTML = pdbChains.map((c, i) => (
      `<option value="${c.chain_id}">链 ${c.chain_id} — ${c.length} nt`
      + (c.modified_residues.length ? `（含 ${c.modified_residues.length} 种修饰）` : '')
      + '</option>'
    )).join('');
    // 把链的序列显示出来，用户好判断该不该填参考序列
    pdbUpdateChainHint();
    el.pdbChain.addEventListener('change', pdbUpdateChainHint);
    el.pdbStepFile.hidden = true;
    el.pdbStepChain.hidden = false;
    el.pdbImport.disabled = false;
    await pdbRefreshPreview();
  } catch (e) {
    el.pdbError.textContent = e.message;
    el.pdbError.hidden = false;
  } finally {
    setBusy(false);
  }
}

/** 链选中后更新提示：显示这条链的序列，并给一个「用界面序列」的快捷入口 */
function pdbUpdateChainHint() {
  const c = pdbChains.find((x) => x.chain_id === el.pdbChain.value);
  if (!c) { el.pdbChainHint.textContent = ''; return; }
  const extra = pdbChains.length > 1 ? `文件里共 ${pdbChains.length} 条 RNA 链。` : '';
  el.pdbChainHint.textContent =
    `${extra}PDB 里抽出的序列（${c.length} nt）：${c.sequence_preview}`;

  // 只有当界面序列和这条链长度接近时才提示可直接采用，避免张冠李戴
  const cur = state.sequence || '';
  if (cur && Math.abs(cur.length - c.length) <= Math.max(10, c.length * 0.15)) {
    el.pdbRefHint.innerHTML =
      `晶体结构常有残基没解析出来，填上完整序列可以把配对映射回去。`
      + ` <button class="link-btn" id="pdb-ref-use-cur" type="button">用当前界面的序列（${cur.length} nt）</button>`;
    const btn = document.getElementById('pdb-ref-use-cur');
    if (btn) btn.onclick = () => { el.pdbReference.value = cur; void pdbRefreshPreview(); };
  } else {
    el.pdbRefHint.textContent =
      '晶体结构常有残基没解析出来，填上完整序列可以把配对映射回去。'
      + (cur ? '（当前界面的序列与这条链长度差得多，多半不是同一条，未提供快捷填入）' : '');
  }
}

async function pdbRefreshPreview() {
  if (!pdbChains.length) return;
  const chainId = el.pdbChain.value;
  setBusy(true, '判定配对…');
  try {
    const d = await api('/api/pdb/structure', {
      text: pdbText,
      chain_id: chainId,
      reference: el.pdbReference.value.trim() || null,
      include_noncanonical: el.pdbNoncanon.checked,
      nested_only: el.pdbNested.checked,
    });
    pdbPreview = d;

    const rows = [];
    rows.push(`<div><span class="k">序列</span> <b>${d.length}</b> nt`
      + (d.reference ? `　<span class="k">（与参考序列比对后）</span>` : '') + '</div>');
    rows.push(`<div><span class="k">配对</span> <b>${d.n_pairs}</b> 对`
      + `　经典 <b>${d.n_canonical}</b>　非经典 <b>${d.n_noncanonical}</b></div>`);
    if (d.n_pseudoknot_pairs_dropped) {
      rows.push(`<div><span class="k">为去假结丢弃</span> <b>${d.n_pseudoknot_pairs_dropped}</b> 对</div>`);
    }
    if (d.modified_residues.length) {
      rows.push(`<div><span class="k">修饰核苷酸</span> <b>${d.modified_residues.join('、')}</b>`
        + '　<span class="k">（已按其母体处理）</span></div>');
    }
    if (d.reference) {
      const r = d.reference;
      rows.push(`<div><span class="k">比对</span> 对齐 <b>${r.matched}</b>/${r.ref_length}`
        + (r.missing_in_pdb.length
          ? `　<span class="warn">PDB 缺失 ${r.missing_in_pdb.length} 个残基</span>` : '')
        + (r.mismatches.length
          ? `　<span class="warn">${r.mismatches.length} 处碱基不同</span>` : '')
        + '</div>');
    }
    rows.push(`<div><span class="k">链</span> <b>${d.chain_id}</b></div>`);
    el.pdbSummary.innerHTML = rows.join('');
    el.pdbSummary.hidden = false;
  } catch (e) {
    el.pdbError.textContent = e.message;
    el.pdbError.hidden = false;
    pdbPreview = null;
    el.pdbImport.disabled = true;
  } finally {
    setBusy(false);
  }
}

async function pdbDoImport() {
  if (!pdbPreview) return;
  const d = pdbPreview;
  el.pdbDialog.close();

  if (el.pdbSetseq.checked) {
    // 连同序列一起载入：直接写进输入框和状态，不走 syncSequence（那会清空结构）
    state.sequence = d.sequence;
    el.seq.value = d.sequence;
    el.statLen.textContent = d.sequence.length;
    const gc = d.sequence.length
      ? Math.round(((d.sequence.match(/[GC]/g) || []).length / d.sequence.length) * 100) : 0;
    el.statGc.textContent = d.sequence.length ? gc + '%' : '–';
    resetConstraintString(d.sequence.length);
    state.lastRenderedPoints = null;
    state.domains = [];
    state.locatedRange = null;
    renderDomains();
    renderSeqStrip();
  } else if (d.sequence !== state.sequence) {
    // 不载入序列，但结构与当前序列对不上就没法画
    addMessage('error',
      `PDB 里的序列（${d.sequence.length} nt）与当前界面的序列（${state.sequence.length} nt）不一致，`
      + '无法直接套用。请勾选「同时把序列载入主界面」再导入。');
    return;
  }

  state.pairs = d.pairs.map((p) => [p.i, p.j]);
  state.manualPoints = null;
  state.fitPending = true;
  state.pdbGaps = d.missing_regions || [];
  // 把配体接触转成可标注的结合位点。金属离子单独一色，有机配体各用一色。
  const LIG_COLORS = ['#C2410C', '#7B5EA7', '#0F766E', '#B45309'];
  state.bindingSites = (d.ligands || []).map((L, k) => ({
    name: L.name,
    nAtoms: L.n_atoms,
    isIon: L.n_atoms <= 2,
    color: LIG_COLORS[k % LIG_COLORS.length],
    positions: L.positions.map((x) => x.index),
  }));
  renderBindingSites();
  // 用后端基于几何的判定结果，并让紧随其后的 evaluate 不要覆盖它
  state.invalidPairs = new Set(
    d.pairs.filter((p) => !p.canonical).map((p) => `${Math.min(p.i, p.j)},${Math.max(p.i, p.j)}`),
  );
  preserveNonCanonOnce = true;

  clearMessages();
  addMessage('note', `已从 PDB 链 ${d.chain_id} 导入：${d.length} nt，${d.n_pairs} 个配对`
    + `（经典 ${d.n_canonical}，非经典 ${d.n_noncanonical}）`);
  if (d.modified_residues.length) {
    addMessage('note', `修饰核苷酸 ${d.modified_residues.join('、')} 已按其母体处理`);
  }
  for (const n of d.notes || []) addMessage('note', n);

  await doEvaluate();
  pushHistory(`从 PDB 导入（链 ${d.chain_id}）`);
  toast(`已导入 ${d.n_pairs} 个配对`);
}

/* ═══════════════ 对象选中 / 旋转 / 对齐吸附（BioRender 式交互） ═══════════════
   与 VARNA 那种「逐碱基编辑」不同，这里是按**对象**操作：单击选中一个螺旋或环，
   出现选择框与旋转手柄，拖动旋转、拖动平移，并带对齐辅助线。
   对象是真实配对算出来的，所以旋转不会破坏碱基配对。 */

/** 把画布屏幕坐标换算成模型坐标（与缩放/平移保持一致） */
function screenToModel(clientX, clientY) {
  const rect = el.canvas.getBoundingClientRect();
  const v = state.view;
  const scale = Math.min(rect.width / v.w, rect.height / v.h) || 1;
  const offX = (rect.width - v.w * scale) / 2;
  const offY = (rect.height - v.h * scale) / 2;
  return {
    x: v.x + (clientX - rect.left - offX) / scale,
    y: v.y + (clientY - rect.top - offY) / scale,
    scale,
  };
}

const isReadOnly = () => state.editMode === 'preview';
const isArrange = () => state.editMode === 'arrange';

/** 取某个碱基所属的结构元素；stem 返回整个分支（含下游子树） */
function pickElement(baseIdx) {
  const tree = structureTree();
  const id = tree.residueToElement[baseIdx];
  if (id == null) return null;
  const el = tree.elements.get(id);
  if (!el) return null;
  if (el.type === 'stem') {
    return {
      kind: 'stem', id: el.id, label: el.label, element: el,
      bases: new Set(el.residues),
      subtree: new Set(RS.subtreeResidues(tree, el.id)),
    };
  }
  return { kind: 'loop', id: el.id, label: el.type, element: el, bases: new Set(el.residues) };
}

/** 一组碱基（Set）的包围盒 */
function setBounds(bases, pts) {
  let minX = Infinity; let minY = Infinity; let maxX = -Infinity; let maxY = -Infinity;
  for (const b of bases) {
    if (!pts[b]) continue;
    minX = Math.min(minX, pts[b].x); maxX = Math.max(maxX, pts[b].x);
    minY = Math.min(minY, pts[b].y); maxY = Math.max(maxY, pts[b].y);
  }
  return { minX, minY, maxX, maxY };
}

/** 断开后不再被相邻环牵引的螺旋集合 */
function detachedSet() {
  if (!state.detached) state.detached = new Set();
  return state.detached;
}

/** 断开产生的骨架断点：被断开元素与相邻残基相接的每一处 */
function detachedBreaks() {
  const out = [];
  const det = detachedSet();
  if (!det.size) return out;
  const tree = structureTree();
  const n = state.sequence.length;
  const inSet = new Array(n).fill(false);
  for (const sid of det) {
    const e = tree.elements.get(sid);
    if (!e) continue;
    for (const b of e.residues) inSet[b] = true;
  }
  for (let b = 0; b < n - 1; b++) {
    if (inSet[b] !== inSet[b + 1]) out.push(b);   // 一端在断开段内、一端在外
  }
  return out;
}

/** 显示用的全部断点 = 后端给的（如共折叠的链间断点）+ 手动断开 */
function allBreaks() {
  const s = new Set(state.breaks || []);
  for (const b of detachedBreaks()) s.add(b);
  return [...s];
}

/* ── 选择框与旋转手柄 ── */

function drawSelectionOverlay(svg, pts, r) {
  const u = state.pickedUnit;
  if (!u || !pts) { state.selBox = null; return; }
  const g = mk('g', { class: 'sel-layer' });

  const stemSet = u.bases;
  const subSet = u.subtree || u.bases;

  // 下游子树（不含 stem 本体）：淡色环，示意「会跟着一起转」
  if (u.kind === 'stem') {
    for (const b of subSet) {
      if (stemSet.has(b) || !pts[b]) continue;
      g.appendChild(mk('circle', {
        class: 'sel-ring-sub', cx: pts[b].x, cy: pts[b].y, r: r * 1.32,
        fill: 'none', stroke: '#7B9BD1', 'stroke-width': r * 0.11,
        'stroke-dasharray': `${r * 0.35} ${r * 0.5}`, opacity: '0.8',
      }));
    }
  }

  // 选中的元素本体：强环
  for (const b of stemSet) {
    if (!pts[b]) continue;
    g.appendChild(mk('circle', {
      class: 'sel-ring', cx: pts[b].x, cy: pts[b].y, r: r * 1.5,
      fill: 'none', stroke: '#2F6FB5', 'stroke-width': r * 0.20,
      'stroke-dasharray': `${r * 0.45} ${r * 0.32}`,
    }));
  }

  // 选择框：覆盖整棵子树的范围
  const bb = setBounds(subSet, pts);
  const pad = r * 2.0;
  const bx = bb.minX - pad; const by = bb.minY - pad;
  const bw = (bb.maxX - bb.minX) + pad * 2; const bh = (bb.maxY - bb.minY) + pad * 2;
  g.appendChild(mk('rect', {
    class: 'sel-box', x: bx, y: by, width: bw, height: bh,
    fill: 'none', stroke: '#2F6FB5', 'stroke-width': r * 0.15,
    'stroke-dasharray': `${r * 0.9} ${r * 0.55}`,
  }));

  // 旋转手柄：默认在框上方；若位置落到当前视口之外（结构贴边或压在顶部条带下），
  // 会被裁剪到点不到——收进视口内，保证可交互。
  let hx = bx + bw / 2;
  let hy = by - r * 3.4;
  const v = state.view;
  const m = r * 2.5;
  if (hy < v.y + m) hy = v.y + m;
  if (hx < v.x + m) hx = v.x + m;
  if (hx > v.x + v.w - m) hx = v.x + v.w - m;

  // pivot（旋转中心 = 与 parent loop 的连接点）+ 旋转轨迹
  if (u.kind === 'stem') {
    const tree = structureTree();
    const base = basePoints();
    const pv = RS.applyM(
      RS.inheritedMatrix(tree, u.id, base, state.layoutOverrides),
      RS.stemPivot(tree, u.id, base),
    );
    const rad = Math.hypot(hx - pv.x, hy - pv.y);
    g.appendChild(mk('circle', {
      class: 'rot-arc', cx: pv.x, cy: pv.y, r: rad,
      fill: 'none', stroke: '#2F6FB5', 'stroke-width': r * 0.10,
      'stroke-dasharray': `${r * 0.28} ${r * 0.55}`, opacity: '0.45',
      'pointer-events': 'none',
    }));
    g.appendChild(mk('line', {
      class: 'rot-axis', x1: pv.x, y1: pv.y, x2: hx, y2: hy,
      stroke: '#2F6FB5', 'stroke-width': r * 0.10,
      'stroke-dasharray': `${r * 0.35} ${r * 0.4}`, opacity: '0.6',
      'pointer-events': 'none',
    }));
    g.appendChild(mk('circle', {
      class: 'pivot-dot', cx: pv.x, cy: pv.y, r: r * 0.55,
      fill: '#D2912A', stroke: '#ffffff', 'stroke-width': r * 0.16,
      'pointer-events': 'none',
    }));
    g.appendChild(mk('line', {
      class: 'pivot-cross', x1: pv.x - r * 0.95, y1: pv.y, x2: pv.x + r * 0.95, y2: pv.y,
      stroke: '#D2912A', 'stroke-width': r * 0.12, 'pointer-events': 'none',
    }));
    g.appendChild(mk('line', {
      class: 'pivot-cross', x1: pv.x, y1: pv.y - r * 0.95, x2: pv.x, y2: pv.y + r * 0.95,
      stroke: '#D2912A', 'stroke-width': r * 0.12, 'pointer-events': 'none',
    }));
  }

  if (u.kind === 'stem') {
    g.appendChild(mk('line', {
      class: 'sel-stem', x1: hx, y1: by, x2: hx, y2: hy,
      stroke: '#2F6FB5', 'stroke-width': r * 0.15,
    }));
    g.appendChild(mk('circle', {
      class: 'sel-handle', 'data-role': 'rotate',
      cx: hx, cy: hy, r: r * 1.15,
      fill: '#ffffff', stroke: '#2F6FB5', 'stroke-width': r * 0.22,
    }));
    g.appendChild(mk('path', {
      d: `M ${hx - r * 0.5} ${hy} a ${r * 0.5} ${r * 0.5} 0 1 1 ${r * 0.7} ${r * 0.35}`,
      fill: 'none', stroke: '#2F6FB5', 'stroke-width': r * 0.18, 'pointer-events': 'none',
    }));
    state.selBox = { bx, by, bw, bh, hx, hy };
  } else {
    // 环：绿色形变手柄（apex）——拖它 = 鼓出 / 朝向
    const ls = RS.loopShape(structureTree(), u.id, basePoints(), state.layoutOverrides);
    if (ls && ls.apex) {
      // 手柄收进视口，避免被裁掉点不到（轴线也画到收拢后的位置）
      let ax = ls.apex.x;
      let ay = ls.apex.y;
      const vv = state.view;
      const mm = r * 2.5;
      if (ay < vv.y + mm) ay = vv.y + mm;
      if (ay > vv.y + vv.h - mm) ay = vv.y + vv.h - mm;
      if (ax < vv.x + mm) ax = vv.x + mm;
      if (ax > vv.x + vv.w - mm) ax = vv.x + vv.w - mm;
      g.appendChild(mk('line', {
        class: 'loop-axis', x1: ls.m.x, y1: ls.m.y, x2: ax, y2: ay,
        stroke: '#3E8E5A', 'stroke-width': r * 0.10,
        'stroke-dasharray': `${r * 0.35} ${r * 0.4}`, opacity: '0.6', 'pointer-events': 'none',
      }));
      g.appendChild(mk('circle', {
        class: 'loop-dot', cx: ls.m.x, cy: ls.m.y, r: r * 0.4,
        fill: '#3E8E5A', stroke: '#ffffff', 'stroke-width': r * 0.12, 'pointer-events': 'none',
      }));
      g.appendChild(mk('circle', {
        class: 'loop-handle', 'data-role': 'loop',
        cx: ax, cy: ay, r: r * 1.05,
        fill: '#ffffff', stroke: '#3E8E5A', 'stroke-width': r * 0.22,
      }));
      g.appendChild(mk('path', {
        d: `M ${ax - r * 0.45} ${ay} a ${r * 0.45} ${r * 0.45} 0 1 1 ${r * 0.62} ${r * 0.3}`,
        fill: 'none', stroke: '#3E8E5A', 'stroke-width': r * 0.16, 'pointer-events': 'none',
      }));
      state.selBox = { bx, by, bw, bh, hx: ax, hy: ay };
    }
  }
  svg.appendChild(g);
}

/** 对齐辅助线 */
function drawSnapGuides(svg, r, span) {
  const gd = state.snapGuides;
  if (!gd || (!gd.length)) return;
  const g = mk('g', { class: 'snap-layer' });
  for (const item of gd) {
    if (item.axis === 'x') {
      g.appendChild(mk('line', {
        class: 'snap-line', x1: item.at, y1: item.from, x2: item.at, y2: item.to,
        stroke: '#D2912A', 'stroke-width': r * 0.16, 'stroke-dasharray': `${r * 0.7} ${r * 0.5}`,
      }));
    } else {
      g.appendChild(mk('line', {
        class: 'snap-line', x1: item.from, y1: item.at, x2: item.to, y2: item.at,
        stroke: '#D2912A', 'stroke-width': r * 0.16, 'stroke-dasharray': `${r * 0.7} ${r * 0.5}`,
      }));
    }
  }
  svg.appendChild(g);
  void span;
}

/* ── 重置：单 stem 角度 / 整个分支 ── */

/** 双击：把该 stem 的角度恢复为原始朝向（平移保留） */
function resetStemAngle(u) {
  const ov = state.layoutOverrides[u.id];
  if (!ov || !ov.angle) { toast(`${u.label} 当前就是原始角度`); return; }
  const before = ov.angle;
  if (ov.dx || ov.dy) state.layoutOverrides[u.id] = { angle: 0, dx: ov.dx, dy: ov.dy };
  else delete state.layoutOverrides[u.id];
  pushHistory(`重置 ${u.label} 角度（${fmtDeg(before)}→0°）`);
  render();
  saveSession();
  toast(`${u.label} 已恢复原始角度`);
}

/** 右键：把整个分支（子树内全部 stem）的排版恢复为自动布局 */
function resetBranch(u) {
  const tree = structureTree();
  const ids = RS.subtreeIds(tree, u.id);
  let cleared = 0;
  for (const id of ids) {
    if (state.layoutOverrides[id]) { delete state.layoutOverrides[id]; cleared += 1; }
  }
  if (!cleared) { toast(`${u.label} 分支当前就是自动布局`); return; }
  pushHistory(`重置 ${u.label} 分支布局`);
  render();
  saveSession();
  toast(`已重置 ${u.label} 分支（${cleared} 处调整）`);
}

/** 双击/右键：重置该环的形变（恢复默认鼓出/朝向） */
function resetLoopShape(u) {
  if (!state.layoutOverrides[u.id]) { toast(`${loopName(u)}当前就是默认形状`); return; }
  delete state.layoutOverrides[u.id];
  pushHistory(`重置 ${loopName(u)} 形变`);
  render();
  saveSession();
  toast(`${loopName(u)}已恢复默认形状`);
}

/** 旋转/平移结束后：重叠检测 + 对分支做最小位移自动避让（只动该分支） */
function avoidAfterMove(stemUnit, prevOv) {
  const base = basePoints();
  if (!base) return false;
  const tree = structureTree();
  const res = RS.autoAvoid(tree, base, state.layoutOverrides, stemUnit.id, {
    pairs: state.pairs,
    prev: prevOv || {},
  });
  if (!res.shifted && !res.reverted) return false;
  state.layoutOverrides = res.overrides;
  render();
  if (res.reverted) toast('此位置会与其它结构重叠，已放回原处');
  else if (res.after) toast(`已自动避让（仍有 ${res.after} 处偏近，可手动微调）`);
  else toast('已自动避让重叠部分');
  return true;
}

/** 选中态变化时更新横幅提示 */
function updateArrangeBanner() {
  const u = state.pickedUnit;
  const box = el.arrangeSel;
  if (!box) return;
  if (!u) {
    box.innerHTML = '<span class="arrange-dim">单击一个 stem 选中整个分支；单击环只做高亮</span>';
    return;
  }
  const sep = '<span class="arrange-sep">·</span>';
  if (u.kind === 'stem') {
    const isDet = detachedSet().has(u.id);
    box.innerHTML =
      `<b>已选中 ${u.label}</b>（${u.element.pairs.length} 对 · 子树 ${u.subtree.size} 个残基）`
      + sep + '拖本体平移'
      + sep + '拖圆点绕连接点旋转（Shift 吸附 15°）'
      + sep + '双击重置角度'
      + sep + '右键重置分支'
      + sep + '<button class="link-btn" id="btn-detach" type="button">'
      + (isDet ? '重新连接' : '断开为自由图形') + '</button>'
      + sep + '<button class="link-btn" id="btn-unpick" type="button">取消选中</button>';
  } else {
    const ls = RS.loopShape(structureTree(), u.id, basePoints(), state.layoutOverrides);
    const cur = ls
      ? ` · 鼓出 ${ls.k.toFixed(2)}×${ls.stretchCount === 1 && ls.tiltDeg ? ` · 朝向 ${ls.tiltDeg.toFixed(0)}°` : ''}`
      : '';
    box.innerHTML =
      `<b>已选中 ${loopName(u)}</b>（${u.bases.size} 个残基${cur}）`
      + sep + '拖绿点调鼓出' + (ls && ls.stretchCount === 1 ? ' / 朝向' : '')
      + sep + '双击或右键重置形状'
      + sep + '<button class="link-btn" id="btn-unpick" type="button">取消选中</button>';
  }

  const det = document.getElementById('btn-detach');
  if (det) det.onclick = toggleDetach;
  const unp = document.getElementById('btn-unpick');
  if (unp) unp.onclick = () => { state.pickedUnit = null; state.snapGuides = []; render(); updateArrangeBanner(); };
}

/** 断开 / 重新连接选中螺旋 */
function toggleDetach() {
  const u = state.pickedUnit;
  if (!u || u.kind !== 'stem') return;
  const det = detachedSet();
  if (det.has(u.id)) {
    det.delete(u.id);
    toast('已重新连接，相邻的环会重新贴上来');
  } else {
    det.add(u.id);
    toast('已断开为自由图形：移动旋转不再牵引相邻的环。碱基配对保持不变。');
  }
  render();
  updateArrangeBanner();
  pushHistory(det.has(u.id) ? '断开螺旋' : '重新连接螺旋');
}

/* ─────────────────────────── 启动 ─────────────────────────── */

async function init() {
  // 自检：el 里为 null 的引用说明 HTML 的 id 对不上，这类错误只会在用到时才炸，
  // 提前报出来能省掉很多排查时间。
  const missing = Object.entries(el).filter(([, v]) => v == null).map(([k]) => k);
  if (missing.length) console.warn('[RNA Studio] 以下 DOM 引用没找到对应元素：', missing);

  setupCanvasInteraction();
  bindEvents();

  // 先看看有没有上次没做完的工作
  let resumed = false;
  try { resumed = restoreSession(); } catch (e) { resumed = false; }

  if (!resumed) {
    const demo = 'GCGGAUUUAGCUCAGUUGGGAGAGCGCCAGACUGAAGAUCUGGAGGUCCUGUGUUCGAUCCACAGAAUUCGCACCA';
    el.seq.value = demo;
    syncSequence();
  }

  try {
    await loadStatus();
  } catch {
    addMessage('error', '无法连接后端。/api/status 没有响应。');
    return;
  }
  state.colorMode = el.colorMode.value;
  renderHistory();
  updateHistoryButtons();
  renderDomains();
  renderSeqStrip();
  renderBindingSites();
  setEditMode(state.editMode);   // 同步模式按钮的选中态

  // 关闭/刷新前补存一次，免得最后一步改动没落盘
  window.addEventListener('beforeunload', () => {
    try {
      localStorage.setItem(SESSION_KEY, JSON.stringify(collectSession()));
    } catch (e) { /* 忽略 */ }
  });

  if (resumed && state.sequence && state.pairs.length) {
    addMessage('note', '已恢复上次的工作进度。');
    state.fitPending = true;
    await doEvaluate();
  } else if (state.sequence) {
    await doFold();
  }
}

document.addEventListener('DOMContentLoaded', () => { void init(); });
