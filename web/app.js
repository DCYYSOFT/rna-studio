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
};

const BASE_COLORS = { A: '#4E9143', C: '#2F6FB5', G: '#D2912A', U: '#BE4A47' };

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
  btnSvg: $('btn-svg'), btnPng: $('btn-png'), svgScope: $('svg-scope'),
  varnaHint: $('varna-hint'),
  btnVarnaSvg: $('btn-varna-svg'), btnVarnaPng: $('btn-varna-png'), btnVarnaEps: $('btn-varna-eps'),
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
  syncConstraintReadouts();
  el.statModeWrap.hidden = state.mode === 'cofold';
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

function render() {
  const svg = el.canvas;
  const n = state.sequence.length;
  svg.innerHTML = '';

  if (!n || !state.result || !state.result.layout || !state.result.layout.points.length) {
    el.canvasEmpty.hidden = false;
    el.legend.innerHTML = '';
    return;
  }
  el.canvasEmpty.hidden = true;
  renderLegend();

  const layout = state.result.layout;
  const pts = layout.points;
  const b = layout.bounds;

  /* 所有尺寸都从「相邻碱基间距的中位数」推导。
     不同布局的坐标尺度差了几个数量级（naview 约 15/碱基，环形约 0.08，
     线性恒为 1），用绝对尺寸会导致某些布局整个塌掉，必须相对化。 */
  const gapList = [];
  const breakSet0 = new Set(state.breaks);
  for (let i = 0; i < n - 1; i++) {
    if (breakSet0.has(i)) continue;
    gapList.push(Math.hypot(pts[i + 1].x - pts[i].x, pts[i + 1].y - pts[i].y));
  }
  gapList.sort((p, q) => p - q);
  const gap = gapList.length
    ? gapList[Math.floor(gapList.length / 2)]
    : Math.max(1e-9, b.span / Math.max(n, 1));

  const r = gap * 0.40;          // 碱基圆半径
  const fs = r * 1.15;           // 碱基字母字号（略小于圆直径，避免字母顶到圈线）
  const pad = r * 4.2;

  const vb = {
    x: b.minX - pad, y: b.minY - pad,
    w: (b.maxX - b.minX) + pad * 2, h: (b.maxY - b.minY) + pad * 2,
  };
  if (state.fitPending) { state.view = { ...vb }; state.fitPending = false; }
  state.fitView = { ...vb };   // 供「整幅结构」出图取景使用
  applyViewBox();

  // 编号字号：几何上跟 r 走，但保证换算到屏幕像素后至少约 10px，
  // 否则在「线性」这类间距很小的布局里数字小到看不清。
  const cw = el.canvas.clientWidth || 1000;
  const chh = el.canvas.clientHeight || 700;
  const pxScale = Math.min(cw / vb.w, chh / vb.h) || 1;
  const numFs = Math.max(r * 0.95, 10 / pxScale);

  const cmap = colorValues();
  const pm = pairMap();
  const sel = state.selection;
  const selPartner = sel != null ? pm.get(sel) : undefined;
  const pkPairs = new Set();
  if (state.result.has_pseudoknot && state.result.crossing_pairs) {
    for (const [a, b2] of state.result.crossing_pairs) {
      pkPairs.add(`${a[0]},${a[1]}`); pkPairs.add(`${b2[0]},${b2[1]}`);
    }
  }

  const NS = 'http://www.w3.org/2000/svg';
  const mk = (tag, attrs) => {
    const e = document.createElementNS(NS, tag);
    for (const k in attrs) if (attrs[k] != null) e.setAttribute(k, attrs[k]);
    return e;
  };

  const breakSet = new Set(state.breaks);
  const isLinear = layout.layout === 'linear';

  // 把坐标尺度暴露给 CSS：所有线宽/虚线间隔都写成 --u 的倍数，
  // 这样在 naview / 环形 / 线性三种尺度下都不会失控。
  el.canvas.style.setProperty('--u', String(r));

  /* 1. 骨架 */
  const gBack = mk('g', { class: 'backbone-group' });
  for (let i = 0; i < n - 1; i++) {
    if (breakSet.has(i)) continue;
    gBack.appendChild(mk('line', {
      class: 'backbone',
      x1: pts[i].x, y1: pts[i].y, x2: pts[i + 1].x, y2: pts[i + 1].y,
    }));
  }
  svg.appendChild(gBack);

  /* 2. 配对 */
  const gPairs = mk('g', {});
  for (const [i, j] of state.pairs) {
    if (i >= pts.length || j >= pts.length) continue;
    const isPk = pkPairs.has(`${i},${j}`) || pkPairs.has(`${j},${i}`);
    const inSel = sel != null && (i === sel || j === sel);
    const cls = 'bp-line' + (isPk ? ' is-pk' : '') + (inSel ? ' is-sel' : '');
    if (isLinear) {
      // 线性布局：配对画成上方的半圆弧（sweep=1 在屏幕坐标系里向上鼓），
      // 否则会与骨架线和碱基重叠。
      const rad = Math.abs(pts[j].x - pts[i].x) / 2;
      if (rad < 1e-9) continue;
      gPairs.appendChild(mk('path', {
        d: `M ${pts[i].x} ${pts[i].y} A ${rad} ${rad} 0 0 1 ${pts[j].x} ${pts[j].y}`,
        fill: 'none', class: cls, opacity: inSel ? 1 : 0.85,
      }));
    } else {
      gPairs.appendChild(mk('line', {
        class: cls,
        x1: pts[i].x, y1: pts[i].y, x2: pts[j].x, y2: pts[j].y,
        opacity: inSel ? 1 : 0.85,
      }));
    }
  }
  svg.appendChild(gPairs);

  /* 3. 碱基 */
  const gNt = mk('g', {});

  for (let i = 0; i < n; i++) {
    const p = pts[i];
    const base = state.sequence[i] || 'N';
    const g = mk('g', { class: 'nt' });
    if (i === sel) g.classList.add('is-selected');
    else if (selPartner === i) g.classList.add('is-partnered');
    if (state.forbidden.has(i)) g.classList.add('is-forbidden');

    const isColored = !!cmap;
    const rgb = isColored ? colorForValue(cmap[i]) : null;

    g.appendChild(mk('circle', {
      class: 'nt-circle',
      cx: p.x, cy: p.y, r,
      fill: rgb ? rgbCss(rgb) : '#FFFFFF',
      stroke: isColored ? '#5A6675' : (BASE_COLORS[base] || '#8A93A0'),
      'stroke-width': r * 0.28,
      'data-i': i,
    }));
    const t = mk('text', {
      class: 'nt-text',
      x: p.x, y: p.y,
      'text-anchor': 'middle',
      'dominant-baseline': 'central',
      'font-size': fs,
      fill: rgb ? textColorOn(rgb) : (BASE_COLORS[base] || '#4A5563'),
    });
    t.textContent = base;
    g.appendChild(t);
    gNt.appendChild(g);
  }
  svg.appendChild(gNt);

  /* 4. 编号（每 period 个） */
  const period = parseInt(el.periodNum.value, 10) || 0;
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
        class: 'nt-num',
        x: p.x + nx * off,
        y: p.y + ny * off,
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
    svg.appendChild(gNum);
  }
}

function applyViewBox() {
  const v = state.view;
  el.canvas.setAttribute('viewBox', `${v.x} ${v.y} ${v.w} ${v.h}`);
  el.canvas.setAttribute('preserveAspectRatio', 'xMidYMid meet');
}

/* ───────────────────────── 悬停 / 点击 ───────────────────────── */

function baseFromEvent(ev) {
  const t = ev.target;
  if (!t || !t.classList || !t.classList.contains('nt-circle')) return null;
  const i = parseInt(t.getAttribute('data-i'), 10);
  return Number.isNaN(i) ? null : i;
}

function showHover(i, ev) {
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

  if (ev.altKey || ev.shiftKey) {
    if (state.forbidden.has(i)) state.forbidden.delete(i);
    else state.forbidden.add(i);
    // 同步到约束串
    const s = (el.constraints.value || '').replace(/\s/g, '').padEnd(state.sequence.length, '.');
    const arr = s.split('');
    arr[i] = state.forbidden.has(i) ? 'x' : '.';
    el.constraints.value = arr.join('');
    syncConstraintReadouts();
    render();
    return;
  }

  if (state.selection == null) {
    state.selection = i;
    render();
    return;
  }
  if (state.selection === i) {
    state.selection = null;
    render();
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

  render();
  scheduleEvaluate();
}

function onCanvasContext(ev) {
  const i = baseFromEvent(ev);
  if (i == null) return;
  ev.preventDefault();
  const before = state.pairs.length;
  state.pairs = state.pairs.filter(([x, y]) => x !== i && y !== i);
  if (state.pairs.length !== before) {
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
  const layout = state.result && state.result.layout;
  if (!layout || !layout.points.length) return;
  const b = layout.bounds;
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
  el.canvasScroll.addEventListener('pointerdown', (ev) => {
    if (baseFromEvent(ev)) return;
    const rect = el.canvas.getBoundingClientRect();
    const v = state.view;
    const scale = Math.min(rect.width / v.w, rect.height / v.h);
    panning = { x: ev.clientX, y: ev.clientY, vx: v.x, vy: v.y, scale };
    el.canvasScroll.classList.add('is-panning');
    el.canvasScroll.setPointerCapture(ev.pointerId);
  });
  el.canvasScroll.addEventListener('pointermove', (ev) => {
    if (!panning) return;
    state.view.x = panning.vx - (ev.clientX - panning.x) / panning.scale;
    state.view.y = panning.vy - (ev.clientY - panning.y) / panning.scale;
    applyViewBox();
  });
  const endPan = (ev) => {
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
  if (result.infeasible) {
    el.mDg.textContent = '不可行'; el.mDg.className = 'meter-value is-infeasible';
  } else if (e == null) {
    el.mDg.textContent = '未计算'; el.mDg.className = 'meter-value is-na';
  } else {
    el.mDg.textContent = e.toFixed(2); el.mDg.className = 'meter-value';
  }

  el.mMfe.textContent = (result.mfe_energy != null) ? result.mfe_energy.toFixed(2) : '—';
  // 结构不可行时 ΔΔG 是 +99998 这种无意义的数，直接不显示
  if (result.delta_from_mfe != null && !result.infeasible && e != null) {
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

  const parsed = parseStructure(data.structure);
  state.pairs = parsed.pairs.map((p) => [p[0], p[1]]);
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
      reportNotes(data);
      toast(`共折叠完成 · 链间配对 ${data.interstrand_pairs.length} 个`);
    } else {
      const data = await api('/api/predict', body);
      state.fitPending = true;
      adoptResult(data);
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

const SVG_NS = 'http://www.w3.org/2000/svg';

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

function exportSvg() {
  const scope = el.svgScope ? el.svgScope.value : 'full';
  const svg = buildExportSvg(scope);
  if (!svg) { toast('还没有结构可以导出'); return; }
  downloadBlob(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }), 'rna_structure.svg');
  toast('已导出 SVG（矢量，可直接插入论文）');
}

async function exportPng() {
  const scope = el.svgScope ? el.svgScope.value : 'full';
  const svg = buildExportSvg(scope);
  if (!svg) { toast('还没有结构可以导出'); return; }

  const url = URL.createObjectURL(new Blob([svg], { type: 'image/svg+xml;charset=utf-8' }));
  try {
    const img = new Image();
    await new Promise((resolve, reject) => {
      img.onload = resolve;
      img.onerror = () => reject(new Error('SVG 光栅化失败'));
      img.src = url;
    });
    const scale = 3;   // 3 倍超采样，出图为高清
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
    toast(`已导出 PNG（${w}×${h}）`);
  } catch (e) {
    // 少数浏览器会把 SVG 画布标记为污染而拒绝导出，这时退化为 SVG
    addMessage('warn', `PNG 导出失败（${e.message}），请改用「导出 SVG」。`);
    toast('PNG 导出失败，已提示改用 SVG');
  } finally {
    URL.revokeObjectURL(url);
  }
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

async function varnaRender(fmt) {
  if (!state.sequence) { toast('还没有序列'); return; }
  const structure = pairsToStructure(state.sequence.length, state.pairs);
  const cmap = colorValues();
  setBusy(true, 'VARNA 出图中…');
  try {
    const body = {
      sequence: state.sequence,
      structure,
      algorithm: el.varnaAlgo.value,
      period_num: parseInt(el.periodNum.value, 10) || 10,
      bp_style: el.bpstyle.value || null,
      color_values: cmap,
      color_style: '0:#FFFFFF;0.5:#4E93CF;1:#143A63',
      color_min: 0, color_max: 1,
    };
    const res = await fetch(`/api/render/varna?fmt=${fmt}`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    if (!res.ok) {
      const t = await res.text();
      let msg = t;
      try { msg = JSON.parse(t).detail || t; } catch { /* keep */ }
      throw new Error(msg);
    }
    const blob = await res.blob();
    if (fmt === 'svg') {
      // 同时下载并把 SVG 展示到画布，方便直接核对
      downloadBlob(blob, 'rna_varna.svg');
    } else {
      downloadBlob(blob, `rna_varna.${fmt}`);
    }
    toast(`VARNA 已导出 ${fmt.toUpperCase()}`);
  } catch (e) {
    addMessage('error', 'VARNA 出图失败：' + e.message);
    toast('VARNA 出图失败');
  } finally { setBusy(false); }
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
    el.seq.value = ''; el.seqB.value = '';
    syncSequence();
    state.result = null; state.pairs = [];
    renderMeter(null); renderDecomposition(null);
    el.canvas.innerHTML = ''; el.canvasEmpty.hidden = false;
    el.outStruct.textContent = ''; el.outSeq.textContent = '';
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

  el.engine.addEventListener('change', () => { refreshMethodOptions(); });
  el.layout.addEventListener('change', () => {
    state.layout = el.layout.value;
    state.fitPending = true;
    if (state.result) { void rerender(); }
  });
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

  el.btnSvg.addEventListener('click', exportSvg);
  el.btnPng.addEventListener('click', () => { void exportPng(); });
  el.btnVarnaSvg.addEventListener('click', () => varnaRender('svg'));
  el.btnVarnaPng.addEventListener('click', () => varnaRender('png'));
  el.btnVarnaEps.addEventListener('click', () => varnaRender('eps'));

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

  el.btnStatus.addEventListener('click', () => {
    el.statusPanel.hidden = !el.statusPanel.hidden;
    el.btnStatus.setAttribute('aria-expanded', String(!el.statusPanel.hidden));
  });

  document.addEventListener('keydown', (ev) => {
    if (ev.key === 'Escape' && state.selection != null) {
      state.selection = null;
      render();
    }
    if ((ev.metaKey || ev.ctrlKey) && ev.key === 'Enter') { ev.preventDefault(); void doFold(); }
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
  reportNotes(data);
}

/* ─────────────────────────── 启动 ─────────────────────────── */

async function init() {
  setupCanvasInteraction();
  bindEvents();
  const demo = 'GCGGAUUUAGCUCAGUUGGGAGAGCGCCAGACUGAAGAUCUGGAGGUCCUGUGUUCGAUCCACAGAAUUCGCACCA';
  el.seq.value = demo;
  syncSequence();

  try {
    await loadStatus();
  } catch {
    addMessage('error', '无法连接后端。/api/status 没有响应。');
    return;
  }
  state.colorMode = el.colorMode.value;
  await doFold();
}

document.addEventListener('DOMContentLoaded', () => { void init(); });
