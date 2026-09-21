'use strict';
/* ==========================================================================
   OpenCVS — smoke test for the metrology core (js/metrology.js).

   DOM-free: exercises the engine the same way apply_metrology_model does —
   synthetic gray images in, fitted shape parameters out.

   Run:  tools/node/node tools/test-metrology.js
   ========================================================================== */
const assert = require('node:assert/strict');
const { MetrologyCore } = require('../js/metrology.js');

let passed = 0;
function check(name, cond, detail) {
  assert.ok(cond, `${name}${detail ? ' — ' + detail : ''}`);
  passed++;
  console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ---- synthetic image helpers (gray = Uint8Array, x = column, y = row) ---- */
function blankImage(W, H, v) {
  const g = new Uint8Array(W * H);
  g.fill(v);
  return { gray: g, W, H };
}
function drawCircle(img, cx, cy, r, val) {
  for (let y = Math.max(0, Math.floor(cy - r - 1)); y <= Math.min(img.H - 1, Math.ceil(cy + r + 1)); y++)
    for (let x = Math.max(0, Math.floor(cx - r - 1)); x <= Math.min(img.W - 1, Math.ceil(cx + r + 1)); x++) {
      const dx = x - cx + 0.5, dy = y - cy + 0.5;      // pixel-center convention
      if (dx * dx + dy * dy <= r * r) img.gray[y * img.W + x] = val;
    }
}
function drawEllipse(img, cx, cy, a, b, phi, val) {
  const cp = Math.cos(phi), sp = Math.sin(phi);
  const R = Math.max(a, b) + 1;
  for (let y = Math.max(0, Math.floor(cy - R)); y <= Math.min(img.H - 1, Math.ceil(cy + R)); y++)
    for (let x = Math.max(0, Math.floor(cx - R)); x <= Math.min(img.W - 1, Math.ceil(cx + R)); x++) {
      const dx = x - cx + 0.5, dy = y - cy + 0.5;
      const u = dx * cp + dy * sp, v = -dx * sp + dy * cp;
      if ((u * u) / (a * a) + (v * v) / (b * b) <= 1) img.gray[y * img.W + x] = val;
    }
}
function drawRect(img, x0, y0, x1, y1, val) {
  for (let y = Math.max(0, y0); y < Math.min(img.H, y1); y++)
    for (let x = Math.max(0, x0); x < Math.min(img.W, x1); x++) img.gray[y * img.W + x] = val;
}
function applyCircle(img, geom, extra) {
  const m = MetrologyCore.createModel();
  const idx = MetrologyCore.addObject(m, 'circle', geom, Object.assign({
    measure_length1: 15, measure_length2: 10, measure_sigma: 1.2,
    measure_threshold: 20, measure_transition: 'all', min_score: 0.6,
  }, extra || {}));
  MetrologyCore.applyModel(m, img.gray, img.W, img.H);
  return { m, idx, obj: m.objects.get(idx) };
}

/* ---------------- circle ---------------- */
{
  const img = blankImage(240, 240, 40);
  drawCircle(img, 130, 110, 40, 220);
  const { obj } = applyCircle(img, { row: 111, column: 128, radius: 38 });
  assert.equal(obj.instances.length, 1, 'circle: one instance expected');
  const inst = obj.instances[0];
  check('circle: row', near(inst.row, 110, 1.5), `fitted ${inst.row.toFixed(2)} vs 110`);
  check('circle: column', near(inst.column, 130, 1.5), `fitted ${inst.column.toFixed(2)} vs 130`);
  check('circle: radius', near(inst.radius, 40, 1.5), `fitted ${inst.radius.toFixed(2)} vs 40`);
  check('circle: score', inst.score >= 0.85, `score ${inst.score.toFixed(2)}`);
  const all = MetrologyCore.resultValue(obj, inst, 'all_param');
  assert.deepEqual(all, [inst.row, inst.column, inst.radius]);
  check('circle: all_param', true);
  const sc = MetrologyCore.resultValue(obj, inst, 'score');
  assert.equal(sc[0], inst.score);
  const mm = MetrologyCore.measuresOf(obj, 'all');
  check('circle: num_measures', mm.rows.length === obj.measures.length && obj.measures.length >= 10,
    `${obj.measures.length} measures`);
}

/* ---------------- line (caliper on a vertical bar edge) ----------------
   Profile direction is the right-hand normal of begin->end in image
   coordinates (x=column, y=row, y down): for this vertical line the profile
   scans right-to-left, so 'positive' (dark->bright) finds the bar's right
   edge at x=111.5 and 'negative' its left edge at x=100. */
{
  const img = blankImage(240, 240, 40);
  drawRect(img, 100, 40, 112, 200, 220);                    // bright bar x in [100, 112)
  const run = transition => {
    const m = MetrologyCore.createModel();
    const idx = MetrologyCore.addObject(m, 'line', {
      rowBegin: 50, columnBegin: 106, rowEnd: 190, columnEnd: 106,
    }, {
      measure_length1: 12, measure_length2: 10, measure_sigma: 1.2,
      measure_threshold: 20, measure_transition: transition, min_score: 0.6,
    });
    MetrologyCore.applyModel(m, img.gray, img.W, img.H);
    return m.objects.get(idx);
  };
  const pos = run('positive');
  assert.equal(pos.instances.length, 1, 'line: one instance expected');
  const inst = pos.instances[0];
  check('line: right edge on positive', near(inst.columnBegin, 111.5, 1.2), `fitted ${inst.columnBegin.toFixed(2)} vs 111.5`);
  check('line: vertical', near(inst.columnBegin, inst.columnEnd, 0.5));
  check('line: span', near(inst.rowEnd - inst.rowBegin, 140, 12),
    `span ${(inst.rowEnd - inst.rowBegin).toFixed(1)} vs 140`);
  check('line: score', inst.score >= 0.85, `score ${inst.score.toFixed(2)}`);
  const neg = run('negative');
  check('line: left edge on negative', neg.instances.length === 1 && near(neg.instances[0].columnBegin, 100, 1.2),
    neg.instances.length ? `fitted ${neg.instances[0].columnBegin.toFixed(2)} vs 100` : 'no instance');

  /* get_metrology_object_measures' Transition argument selects the measure
     regions by the direction of the edge found there */
  const pt = MetrologyCore.measuresOf(pos, 'positive').rows.length;
  const nt = MetrologyCore.measuresOf(pos, 'negative').rows.length;
  const nn = MetrologyCore.measuresOf(neg, 'negative').rows.length;
  const pn = MetrologyCore.measuresOf(neg, 'positive').rows.length;
  check('measures: transition filter',
    pt === pos.measures.length && nt === 0 && nn === neg.measures.length && pn === 0,
    `positive obj: ${pt}/${pos.measures.length} pos, ${nt} neg; negative obj: ${nn}/${neg.measures.length} neg, ${pn} pos`);
}

/* ---------------- rectangle2 ---------------- */
{
  const img = blankImage(260, 240, 40);
  drawRect(img, 60, 80, 180, 160, 220);                     // half sizes 60 x 40
  const m = MetrologyCore.createModel();
  const idx = MetrologyCore.addObject(m, 'rectangle2', {
    row: 121, column: 119, phi: 0, length1: 62, length2: 42,
  }, {
    measure_length1: 15, measure_length2: 8, measure_sigma: 1.2,
    measure_threshold: 20, measure_transition: 'all', min_score: 0.4,
  });
  MetrologyCore.applyModel(m, img.gray, img.W, img.H);
  const obj = m.objects.get(idx);
  assert.equal(obj.instances.length, 1, 'rectangle2: one instance expected');
  const inst = obj.instances[0];
  check('rectangle2: row', near(inst.row, 120, 2), `fitted ${inst.row.toFixed(2)} vs 120`);
  check('rectangle2: column', near(inst.column, 120, 2), `fitted ${inst.column.toFixed(2)} vs 120`);
  check('rectangle2: length1', near(inst.length1, 60, 2.5), `fitted ${inst.length1.toFixed(2)} vs 60`);
  check('rectangle2: length2', near(inst.length2, 40, 2.5), `fitted ${inst.length2.toFixed(2)} vs 40`);
  check('rectangle2: phi', near(inst.phi, 0, 0.05), `fitted ${inst.phi.toFixed(3)}`);
  check('rectangle2: score', inst.score >= 0.65, `score ${inst.score.toFixed(2)} (corner measures without edge lower it)`);
}

/* ---------------- ellipse ---------------- */
{
  const img = blankImage(300, 260, 40);
  drawEllipse(img, 150, 120, 50, 30, 0.3, 220);
  const m = MetrologyCore.createModel();
  const idx = MetrologyCore.addObject(m, 'ellipse', {
    row: 122, column: 148, phi: 0.3, ra: 48, rb: 28,
  }, {
    measure_length1: 15, measure_length2: 10, measure_sigma: 1.2,
    measure_threshold: 20, measure_transition: 'all', min_score: 0.5,
  });
  MetrologyCore.applyModel(m, img.gray, img.W, img.H);
  const obj = m.objects.get(idx);
  assert.equal(obj.instances.length, 1, 'ellipse: one instance expected');
  const inst = obj.instances[0];
  check('ellipse: row', near(inst.row, 120, 2.5), `fitted ${inst.row.toFixed(2)} vs 120`);
  check('ellipse: column', near(inst.column, 150, 2.5), `fitted ${inst.column.toFixed(2)} vs 150`);
  check('ellipse: ra', near(inst.ra, 50, 2.5), `fitted ${inst.ra.toFixed(2)} vs 50`);
  check('ellipse: rb', near(inst.rb, 30, 2.5), `fitted ${inst.rb.toFixed(2)} vs 30`);
  check('ellipse: phi', near(inst.phi, 0.3, 0.05), `fitted ${inst.phi.toFixed(3)}`);
}

/* ---------------- two instances: concentric edges of one object ---------------- */
{
  const img = blankImage(240, 240, 40);
  drawCircle(img, 120, 110, 32, 220);                       // bright ring
  drawCircle(img, 120, 110, 20, 40);                        // dark interior -> edges at r=20 and r=32
  const { obj } = applyCircle(img, { row: 110, column: 120, radius: 26 }, {
    num_instances: 2, measure_select: 'all', min_score: 0.5,
  });
  assert.equal(obj.instances.length, 2, 'multi-instance: two instances expected');
  const radii = obj.instances.map(i => i.radius).sort((a, b) => a - b);
  check('multi-instance: inner circle', near(radii[0], 20, 1.5), `r=${radii[0].toFixed(2)}`);
  check('multi-instance: outer circle', near(radii[1], 32, 1.5), `r=${radii[1].toFixed(2)}`);
  const cents = obj.instances.map(i => [i.column, i.row]);
  check('multi-instance: common center',
    cents.every(([c, r]) => near(c, 120, 1.5) && near(r, 110, 1.5)),
    cents.map(([c, r]) => `${c.toFixed(1)}/${r.toFixed(1)}`).join(' '));
}

/* ---------------- model lifecycle: params, copy, clear ---------------- */
{
  const m = MetrologyCore.createModel();
  const i1 = MetrologyCore.addObject(m, 'circle', { row: 100, column: 100, radius: 30 },
    { measure_threshold: 22 });
  const i2 = MetrologyCore.addObject(m, 'line', { rowBegin: 10, columnBegin: 10, rowEnd: 50, columnEnd: 10 }, {});
  assert.equal(MetrologyCore.getParam(m.objects.get(i1), 'measure_threshold'), 22);
  MetrologyCore.setParam(m.objects.get(i1), 'min_score', 0.4);
  assert.equal(MetrologyCore.getParam(m.objects.get(i1), 'min_score'), 0.4);
  MetrologyCore.resetParams(m.objects.get(i1));
  assert.equal(MetrologyCore.getParam(m.objects.get(i1), 'min_score'), 0.7, 'reset restores defaults');
  assert.equal(MetrologyCore.getParam(m.objects.get(i1), 'measure_threshold'), 30,
    'reset restores the HALCON parameter default, not the value used at creation');
  MetrologyCore.setParam(m.objects.get(i1), 'measure_threshold', 22);
  check('params: set/get/reset', true);

  const m2 = MetrologyCore.copyModel(m, 'all');
  assert.equal(m2.objects.size, 2, 'copy: all objects');
  const copied = [...m2.objects.values()];
  assert.equal(MetrologyCore.getParam(copied[0], 'measure_threshold'), 22, 'copy keeps parameters');
  assert.deepEqual([...m2.objects.keys()].sort((a, b) => a - b), [0, 1],
    'copy: the objects of a copied model are numbered from 0');
  assert.equal(MetrologyCore.addObject(m2, 'circle', { row: 10, column: 10, radius: 5 }, {}), 2,
    'copy: the copy carries its own object counter');
  const m3 = MetrologyCore.copyModel(m, i2);
  assert.deepEqual([...m3.objects.keys()], [0],
    'copy: copying a single object numbers it 0 in the new model');
  assert.equal(m3.objects.get(0).shape, 'line', 'copy: the selected object keeps its shape');
  MetrologyCore.removeObjects(m, i1);
  assert.equal(m.objects.size, 1, 'clear one object');
  MetrologyCore.removeObjects(m, 'all');
  assert.equal(m.objects.size, 0, 'clear all objects');
  check('model lifecycle: copy / clear', true);

  assert.throws(() => MetrologyCore.getModel(9999), /invalid metrology handle/);
  assert.throws(() => MetrologyCore.setParam(copied[1], 'min_score', 1.5), /min_score/);
  assert.throws(() => MetrologyCore.setParam(copied[1], 'no_such_param', 1), /unsupported/);
  check('model lifecycle: error handling', true);
}

/* ---------------- no instance below min_score ---------------- */
{
  const img = blankImage(240, 240, 40);                     // empty image: no edges at all
  const { obj } = applyCircle(img, { row: 111, column: 128, radius: 38 });
  assert.equal(obj.instances.length, 0, 'no instance on empty image');
  check('min_score: empty result', true);
}

console.log(`\nmetrology core: ${passed} checks passed`);

/* ==========================================================================
   gen_*_contour_xld / fit_*_contour_xld (operator level; DOM stubbed)
   ========================================================================== */
{
  /* minimal DOM stub for canvas creation in gen/result operators */
  global.document = {
    createElement: () => ({
      width: 0, height: 0,
      getContext: () => new Proxy({}, {
        get: (t, k) => k === 'measureText' ? () => ({ width: 10 }) : (typeof t[k] !== 'undefined' ? t[k] : () => {}),
        set: (t, k, v) => { t[k] = v; return true; },
      }),
    }),
  };
  const { METROLOGY_OP_IMPLS: IMPLS } = require('../js/metrology.js');

  const iconic = new Map(), ctrl = new Map();
  const ctx = {
    iconic: n => iconic.get(n),
    defIconic(n, rec) { iconic.set(n, rec); },
    defCtrl(n, v, t) { ctrl.set(n, { value: v, type: t }); },
    ctrl(n) { const v = ctrl.get(n); return v ? v.value : undefined; },
    displayImage() {}, displayOverlay() {}, setMetrologyOverlay() {},
    log() {},
  };
  const num = n => {
    const v = ctx.ctrl(n);
    return typeof v === 'number' ? v : parseFloat(String(v).replace(/[[\]\s]/g, '').split(',')[0]);
  };

  /* ---- numeric arguments: literals, control variables and expressions ---- */
  {
    const { MetrologyUI } = require('../js/metrology.js');
    const ev = t => MetrologyUI.numVal(t, ctx, NaN);
    ctx.defCtrl('Width', 640, 'integer');
    ctx.defCtrl('Height', 480, 'integer');
    ctx.defCtrl('Tuple', '[10, 20, 30]', 'integer tuple (3)');
    check('numVal: literals', ev(128) === 128 && ev("'128'") === 128 && ev('-2.5') === -2.5);
    check('numVal: control variable', ev('Width') === 640 && ev('Height*0.5') === 240,
      `Width*0.5 = ${ev('Height*0.5')}`);
    check('numVal: rad/deg', near(ev('rad(360)'), 2 * Math.PI, 1e-9) && near(ev('deg(rad(90))'), 90, 1e-9),
      `rad(360) = ${ev('rad(360)')}`);
    check('numVal: intrinsics', ev('max(Width, Height)') === 640 && ev('abs(0-7)') === 7 && ev('sqrt(Width/10)') === 8);
    check('numVal: tuple element', ev('Tuple[1]') === 20 && ev('Tuple') === 10);
    check('numVal: parenthesized / precedence', ev('(Width + 160) / 2') === 400 && ev('2 + 3 * 4') === 14,
      `(Width + 160) / 2 = ${ev('(Width + 160) / 2')}`);
    check('numVal: non-numbers fall back', ev("'printer_chip'") === undefined || Number.isNaN(ev("'printer_chip'")),
      `${ev("'printer_chip'")}`);
    check('numVal: unknown identifier falls back', Number.isNaN(ev('Nope + 1')), `${ev('Nope + 1')}`);
  }

  /* the whole point of the evaluator: HDevelop-style generated calls run */
  {
    ctx.defCtrl('Width', 640, 'integer');
    ctx.defCtrl('Height', 480, 'integer');
    IMPLS.gen_circle_contour_xld(['ExprCircle', 'Height*0.5', 'Width*0.5', 'Width*0.25',
      0, 'rad(360)', "'negative'", 0.001], ctx);
    const xs = iconic.get('ExprCircle').xld[0].x, ys = iconic.get('ExprCircle').xld[0].y;
    const cx = xs.reduce((a, b) => a + b, 0) / xs.length, cy = ys.reduce((a, b) => a + b, 0) / ys.length;
    check('gen_circle_contour_xld: expressions + rad()',
      near(cx, 320, 1) && near(cy, 240, 1) && xs.length > 1000,
      `center ${cx.toFixed(1)}/${cy.toFixed(1)}, ${xs.length} points`);
  }

  /* circle: gen -> fit round trip */
  IMPLS.gen_circle_contour_xld(['CircleXld', 110, 130, 40, 0, 0, "'positive'", 1], ctx);
  check('gen_circle_contour_xld: contour stored', iconic.get('CircleXld').kind === 'xld' && iconic.get('CircleXld').xld[0].x.length > 100);
  IMPLS.fit_circle_contour_xld(['CircleXld', "'geotukey'", -1, 0, 0, 10, 2.0,
    'FitRow', 'FitColumn', 'FitRadius', 'FitS0', 'FitS1', 'FitOrd'], ctx);
  check('fit_circle_contour_xld: row', near(num('FitRow'), 110, 0.5), `fitted ${num('FitRow')}`);
  check('fit_circle_contour_xld: column', near(num('FitColumn'), 130, 0.5), `fitted ${num('FitColumn')}`);
  check('fit_circle_contour_xld: radius', near(num('FitRadius'), 40, 0.5), `fitted ${num('FitRadius')}`);
  check('fit_circle_contour_xld: order', ctx.ctrl('FitOrd') === 'positive');

  /* ellipse: gen -> fit round trip */
  IMPLS.gen_ellipse_contour_xld(['EllXld', 120, 150, 0.3, 50, 30, 0, 0, "'positive'", 1], ctx);
  IMPLS.fit_ellipse_contour_xld(['EllXld', "'geotukey'", -1, 0, 0, 10, 2.0,
    'ERow', 'ECol', 'EPhi', 'ERa', 'ERb', 'ES0', 'ES1', 'EOrd'], ctx);
  check('fit_ellipse_contour_xld: center', near(num('ERow'), 120, 1) && near(num('ECol'), 150, 1),
    `${num('ERow')}/${num('ECol')}`);
  check('fit_ellipse_contour_xld: axes', near(num('ERa'), 50, 1) && near(num('ERb'), 30, 1),
    `ra ${num('ERa')} rb ${num('ERb')}`);
  check('fit_ellipse_contour_xld: phi', near(num('EPhi'), 0.3, 0.05), `${num('EPhi')}`);

  /* line with outliers: Tukey pruning must reject them */
  const rows = [], cols = [];
  for (let x = 50; x <= 150; x += 5) { cols.push(x); rows.push(100 + Math.sin(x) * 0.4); }
  for (let i = 0; i < 4; i++) { cols.push(60 + i * 25); rows.push(145); }
  IMPLS.gen_contour_polygon_xld(['LineXld', `[${rows.join(', ')}]`, `[${cols.join(', ')}]`], ctx);
  IMPLS.fit_line_contour_xld(['LineXld', "'tukey'", -1, 0, 10, 2.0,
    'LB', 'CB', 'LE', 'CE', 'Nr', 'Nc', 'Dist'], ctx);
  check('fit_line_contour_xld: row', near(num('Nr'), 1, 0.01) && near(num('Nc'), 0, 0.01) && near(num('Dist'), 100, 1),
    `Nr ${num('Nr')} Nc ${num('Nc')} Dist ${num('Dist')}`);
  check('fit_line_contour_xld: span', near(num('CB'), 50, 2) && near(num('CE'), 150, 2),
    `${num('CB')}..${num('CE')} (outliers at ends rejected)`);

  /* ClippingEndPoints (4th argument, as in HDevelop) must shorten the segment */
  const cr = [], cs = [];
  for (let x = 50; x <= 150; x += 5) { cs.push(x); cr.push(100); }
  IMPLS.gen_contour_polygon_xld(['ClipXld', `[${cr.join(', ')}]`, `[${cs.join(', ')}]`], ctx);
  IMPLS.fit_line_contour_xld(['ClipXld', "'tukey'", -1, 0, 10, 2.0,
    'cB', 'cCb', 'cE', 'cCe', 'cNr', 'cNc', 'cD'], ctx);
  IMPLS.fit_line_contour_xld(['ClipXld', "'tukey'", -1, 4, 10, 2.0,
    'dB', 'dCb', 'dE', 'dCe', 'dNr', 'dNc', 'dD'], ctx);
  check('fit_line_contour_xld: segment follows the contour',
    near(num('cCb'), 50, 0.5) && near(num('cCe'), 150, 0.5) && near(num('cD'), 100, 0.1),
    `${num('cCb')}..${num('cCe')}`);
  check('fit_line_contour_xld: ClippingEndPoints',
    near(num('dCb'), 70, 0.5) && near(num('dCe'), 130, 0.5),
    `no clip ${num('cCb')}..${num('cCe')}, clip 4 ${num('dCb')}..${num('dCe')}`);

  /* rectangle2 from a noisy perimeter polygon */
  const rr = [], cc = [];
  const corner = (x, y) => { cc.push(x + Math.sin(x * 3 + y) * 0.5); rr.push(y + Math.cos(y * 3 + x) * 0.5); };
  for (let x = 60; x <= 180; x += 6) corner(x, 80);
  for (let y = 86; y <= 154; y += 6) corner(180, y);
  for (let x = 174; x >= 60; x -= 6) corner(x, 160);
  for (let y = 154; y >= 86; y -= 6) corner(60, y);
  IMPLS.gen_contour_polygon_xld(['RectXld', `[${rr.join(', ')}]`, `[${cc.join(', ')}]`], ctx);
  IMPLS.fit_rectangle2_contour_xld(['RectXld', "'tukey'", -1, 0, 0, 10, 2.0,
    'RRow', 'RCol', 'RPhi', 'RL1', 'RL2', 'ROrd'], ctx);
  check('fit_rectangle2_contour_xld: size', near(num('RL1'), 60, 1.5) && near(num('RL2'), 40, 1.5),
    `l1 ${num('RL1')} l2 ${num('RL2')}`);
  check('fit_rectangle2_contour_xld: center', near(num('RRow'), 120, 1.5) && near(num('RCol'), 120, 1.5),
    `${num('RRow')}/${num('RCol')}`);
  check('fit_rectangle2_contour_xld: phi', near(num('RPhi'), 0, 0.1), `${num('RPhi')}`);
  check('fit_rectangle2_contour_xld: order', ctx.ctrl('ROrd') === 'positive', `${ctx.ctrl('ROrd')}`);

  /* the same contour traversed backwards must report the opposite PointOrder
     and identical geometry (orientation is searched, not taken from the seed) */
  iconic.set('RectRevXld', {
    kind: 'xld', type: 'XLD contours (1)', contours: 1,
    xld: [{ x: cc.slice().reverse(), y: rr.slice().reverse() }], dispose() {},
  });
  IMPLS.fit_rectangle2_contour_xld(['RectRevXld', "'tukey'", -1, 0, 0, 10, 2.0,
    'RRow2', 'RCol2', 'RPhi2', 'RL12', 'RL22', 'ROrd2'], ctx);
  check('fit_rectangle2_contour_xld: reversed order', ctx.ctrl('ROrd2') === 'negative', `${ctx.ctrl('ROrd2')}`);
  check('fit_rectangle2_contour_xld: reversed geometry',
    near(num('RRow2'), num('RRow'), 0.05) && near(num('RCol2'), num('RCol'), 0.05) &&
    near(num('RL12'), num('RL1'), 0.05) && near(num('RL22'), num('RL2'), 0.05),
    `${num('RRow2')}/${num('RCol2')} l1 ${num('RL12')} l2 ${num('RL22')}`);

  /* multiple contours in one XLD -> tuple outputs */
  iconic.set('TwoXld', {
    kind: 'xld', type: 'XLD contours (2)', contours: 2,
    xld: [
      { x: Array.from({ length: 60 }, (_, i) => 80 + 25 * Math.cos(2 * Math.PI * i / 60)), y: Array.from({ length: 60 }, (_, i) => 90 + 25 * Math.sin(2 * Math.PI * i / 60)) },
      { x: Array.from({ length: 60 }, (_, i) => 180 + 40 * Math.cos(2 * Math.PI * i / 60)), y: Array.from({ length: 60 }, (_, i) => 160 + 40 * Math.sin(2 * Math.PI * i / 60)) },
    ],
    dispose() {},
  });
  IMPLS.fit_circle_contour_xld(['TwoXld', "'geotukey'", -1, 0, 0, 10, 2.0,
    'TR', 'TC', 'TRad', 'TS0', 'TS1', 'TOrd'], ctx);
  const tcols = String(ctx.ctrl('TC')).replace(/[[\]\s]/g, '').split(',').map(Number);
  const trads = String(ctx.ctrl('TRad')).replace(/[[\]\s]/g, '').split(',').map(Number);
  check('fit: multiple contours -> tuples', tcols.length === 2 && near(tcols[0], 80, 1) && near(tcols[1], 180, 1),
    `cols ${tcols}`);
  check('fit: radii', near(trads[0], 25, 1) && near(trads[1], 40, 1), `radii ${trads}`);

  /* error path: fitting a non-XLD must fail loudly */
  iconic.set('NotXld', { kind: 'image' });
  assert.throws(() => IMPLS.fit_circle_contour_xld(['NotXld', "'geotukey'", -1, 0, 0, 10, 2.0,
    'a', 'b', 'c', 'd', 'e', 'f'], ctx), /XLD/);
  check('fit: non-XLD input rejected', true);

  /* ---- XLD generation: gen_cross_contour_xld ----------------------------- */
  const minmax = a => [Math.min(...a), Math.max(...a)];

  IMPLS.gen_cross_contour_xld(['Cross0', 100, 200, 40, 0, 'CrRow', 'CrCol', 'CrAngle'], ctx);
  const cross0 = iconic.get('Cross0');
  const c0 = cross0.xld[0];
  check('gen_cross_contour_xld: closed contour, 8 points',
    cross0.kind === 'xld' && c0.x.length === 9 && c0.x[8] === c0.x[0] && c0.y[8] === c0.y[0],
    `${c0.x.length} points`);
  check('gen_cross_contour_xld: arms have total length Size',
    near(minmax(c0.x)[0], 180, 1e-9) && near(minmax(c0.x)[1], 220, 1e-9) &&
    near(minmax(c0.y)[0], 80, 1e-9) && near(minmax(c0.y)[1], 120, 1e-9),
    `x ${minmax(c0.x)}, y ${minmax(c0.y)}`);
  check('gen_cross_contour_xld: center and angle outputs',
    near(num('CrRow'), 100, 1e-9) && near(num('CrCol'), 200, 1e-9) && near(num('CrAngle'), 0, 1e-9),
    `${num('CrRow')}/${num('CrCol')}, AngleOut ${num('CrAngle')}`);

  IMPLS.gen_cross_contour_xld(['Cross45', 100, 200, 40, 'rad(45)', 'a1', 'a2', 'a3'], ctx);
  const c45 = iconic.get('Cross45').xld[0];
  const d45 = 20 * Math.cos(Math.PI / 4);
  check('gen_cross_contour_xld: Angle rotates the arms',
    near(minmax(c45.x)[0], 200 - d45, 1e-9) && near(minmax(c45.x)[1], 200 + d45, 1e-9) &&
    near(minmax(c45.y)[0], 100 - d45, 1e-9) && near(minmax(c45.y)[1], 100 + d45, 1e-9) &&
    c45.x.every((x, i) => near(Math.abs(x - 200), Math.abs(c45.y[i] - 100), 1e-9)) &&
    near(num('a3'), Math.PI / 4, 1e-3),                      // tuples are stored rounded for display
    `x ${minmax(c45.x)}, AngleOut ${num('a3')}`);

  /* a cross is symmetric under a half turn: Angle + pi is the same contour */
  IMPLS.gen_cross_contour_xld(['CrossTurn', 100, 200, 40, 'rad(45) + PI', 'b1', 'b2', 'b3'], ctx);
  const cTurn = iconic.get('CrossTurn').xld[0];
  check('gen_cross_contour_xld: Angle normalized into [0, pi)',
    near(num('b3'), Math.PI / 4, 1e-3) && cTurn.x.every((x, i) => near(x, c45.x[i], 1e-9)),
    `AngleOut ${num('b3')} instead of ${(Math.PI / 4 + Math.PI).toFixed(4)}`);

  /* adversarial: a cross must not be generated from a degenerate Size */
  assert.throws(() => IMPLS.gen_cross_contour_xld(['BadCross', 100, 100, 0, 0, 'a', 'b', 'c'], ctx), /Size/);
  check('gen_cross_contour_xld: Size <= 0 rejected', true);

  /* ---- XLD generation: gen_rectangle2_contour_xld ------------------------ */
  IMPLS.gen_rectangle2_contour_xld(['Rect2A', 120, 160, 0, 50, 30], ctx);
  const rA = iconic.get('Rect2A').xld[0];
  check('gen_rectangle2_contour_xld: 4 corners + closing point',
    rA.x.length === 5 && rA.x[4] === rA.x[0] && rA.y[4] === rA.y[0], `${rA.x.length} points`);
  check('gen_rectangle2_contour_xld: Length1/Length2 are half sizes',
    near(minmax(rA.x)[0], 110, 1e-9) && near(minmax(rA.x)[1], 210, 1e-9) &&
    near(minmax(rA.y)[0], 90, 1e-9) && near(minmax(rA.y)[1], 150, 1e-9),
    `x ${minmax(rA.x)}, y ${minmax(rA.y)}`);

  IMPLS.gen_rectangle2_contour_xld(['Rect2B', 120, 160, 'rad(90)', 50, 30], ctx);
  const rB = iconic.get('Rect2B').xld[0];
  check('gen_rectangle2_contour_xld: Phi = rad(90) swaps the sides',
    near(minmax(rB.x)[0], 130, 1e-9) && near(minmax(rB.x)[1], 190, 1e-9) &&
    near(minmax(rB.y)[0], 70, 1e-9) && near(minmax(rB.y)[1], 170, 1e-9),
    `x ${minmax(rB.x)}, y ${minmax(rB.y)}`);

  /* Phi is measured from the column axis: at rad(45) the first corner (the one
     with both half sides positive) is up-right, at rad(-45) down-right */
  IMPLS.gen_rectangle2_contour_xld(['Rect2C', 120, 160, 'rad(45)', 50, 30], ctx);
  const rC = iconic.get('Rect2C').xld[0];
  IMPLS.gen_rectangle2_contour_xld(['Rect2D', 120, 160, 'rad(-45)', 50, 30], ctx);
  const rD = iconic.get('Rect2D').xld[0];
  const s2 = Math.SQRT2, ext = 80 / s2;
  check('gen_rectangle2_contour_xld: Phi rotates around the column axis',
    near(rC.x[0], 160 + 20 / s2, 1e-9) && near(rC.y[0], 120 + ext, 1e-9) &&
    near(rD.x[0], 160 + ext, 1e-9) && near(rD.y[0], 120 - 20 / s2, 1e-9) &&
    near(minmax(rC.x)[0], 160 - ext, 1e-9) && near(minmax(rC.x)[1], 160 + ext, 1e-9),
    `+45° corner ${rC.x[0].toFixed(2)}/${rC.y[0].toFixed(2)}, -45° corner ${rD.x[0].toFixed(2)}/${rD.y[0].toFixed(2)}`);

  /* ---- XLD generation: gen_contour_region_xld ---------------------------
     A region record of this build is a mask: a 0/255 byte image (threshold) or
     a label image with the ids it holds (connection / select_shape).  Both are
     exercised here with plain typed arrays, no OpenCV needed. */
  const RW = 40, RH = 30;
  const box = new Uint8Array(RW * RH);                       // filled 10 x 5 rectangle
  for (let y = 5; y <= 9; y++) for (let x = 10; x <= 19; x++) box[y * RW + x] = 255;
  iconic.set('Box', { kind: 'region', mat: { cols: RW, rows: RH, data: box }, dispose() {} });
  IMPLS.gen_contour_region_xld(['Box', 'BoxXld', "'border'", "'border'", -1, 0], ctx);
  const bc = iconic.get('BoxXld').xld[0];
  check('gen_contour_region_xld: border pixel chain',
    bc.x.length === 2 * (10 + 5) - 4 + 1 && near(minmax(bc.x)[0], 10, 0) && near(minmax(bc.x)[1], 19, 0) &&
    near(minmax(bc.y)[0], 5, 0) && near(minmax(bc.y)[1], 9, 0) &&
    bc.x.every((x, i) => x === 10 || x === 19 || bc.y[i] === 5 || bc.y[i] === 9) &&
    bc.x[bc.x.length - 1] === bc.x[0] && bc.y[bc.x.length - 1] === bc.y[0],
    `${bc.x.length} points, x ${minmax(bc.x)}, y ${minmax(bc.y)}`);

  /* ClippingEndPoints and MaxNumPoints apply per contour */
  IMPLS.gen_contour_region_xld(['Box', 'BoxClip', "'border'", "'border'", -1, 5], ctx);
  const bclip = iconic.get('BoxClip').xld[0];
  check('gen_contour_region_xld: ClippingEndPoints shortens the contour',
    bclip.x.length === bc.x.length - 10, `${bclip.x.length} of ${bc.x.length} points`);
  IMPLS.gen_contour_region_xld(['Box', 'BoxSub', "'border'", "'border'", 8, 0], ctx);
  check('gen_contour_region_xld: MaxNumPoints subsamples',
    iconic.get('BoxSub').xld[0].x.length === 8, `${iconic.get('BoxSub').xld[0].x.length} points`);

  /* labels: the same rectangle as label 2 of a region array, with a second
     region that must be left out */
  const labels = new Int32Array(RW * RH);
  for (let y = 5; y <= 9; y++) for (let x = 10; x <= 19; x++) labels[y * RW + x] = 2;
  for (let y = 20; y <= 24; y++) for (let x = 30; x <= 34; x++) labels[y * RW + x] = 1;
  iconic.set('Labeled', { kind: 'selected', ids: [2], labels, w: RW, h: RH, dispose() {} });
  IMPLS.gen_contour_region_xld(['Labeled', 'LabelXld', "'border'", "'border'", -1, 0], ctx);
  const lc = iconic.get('LabelXld').xld;
  check('gen_contour_region_xld: one contour per selected region',
    lc.length === 1 && near(minmax(lc[0].x)[0], 10, 0) && near(minmax(lc[0].y)[0], 5, 0),
    `${lc.length} contour(s), x ${lc.length ? minmax(lc[0].x) : '-'}`);

  /* a hollow region: the hole is a second contour with Mode 'border_holes' */
  const ring = new Uint8Array(RW * RH);
  for (let y = 2; y < 22; y++) for (let x = 2; x < 22; x++) ring[y * RW + x] = 255;
  for (let y = 7; y < 17; y++) for (let x = 7; x < 17; x++) ring[y * RW + x] = 0;
  iconic.set('Ring', { kind: 'region', mat: { cols: RW, rows: RH, data: ring }, dispose() {} });
  IMPLS.gen_contour_region_xld(['Ring', 'RingXld', "'border'", "'border'", -1, 0], ctx);
  IMPLS.gen_contour_region_xld(['Ring', 'RingHoles', "'border_holes'", "'border'", -1, 0], ctx);
  const rh = iconic.get('RingHoles').xld;
  check('gen_contour_region_xld: holes add their border contour',
    iconic.get('RingXld').xld.length === 1 && rh.length === 2 &&
    near(minmax(rh[1].x)[0], 6, 0) && near(minmax(rh[1].x)[1], 17, 0) &&
    near(minmax(rh[1].y)[0], 6, 0) && near(minmax(rh[1].y)[1], 17, 0),
    `${rh.length} contours, hole x ${rh.length > 1 ? minmax(rh[1].x) : '-'}`);

  /* adversarial: no region, no contour */
  iconic.set('NotRegion', { kind: 'xld', xld: [{ x: [1], y: [1] }] });
  assert.throws(() => IMPLS.gen_contour_region_xld(['NotRegion', 'x', "'border'", "'border'", -1, 0], ctx), /region/);
  check('gen_contour_region_xld: non-region input rejected', true);
}

/* ==========================================================================
   metrology object operators: measure regions exist before apply, and
   get_metrology_object_result always returns the fitted contour (iconic)
   ========================================================================== */
{
  const img = blankImage(240, 240, 40);
  drawRect(img, 100, 40, 112, 200, 220);                    // bright bar x in [100, 112)

  const { METROLOGY_OP_IMPLS: IMPLS } = require('../js/metrology.js');
  const iconic = new Map([['Image', {
    kind: 'image', gray: img.gray, W: img.W, H: img.H,
    canvas: { width: img.W, height: img.H },
  }]]);
  const ctrl = new Map();
  const ctx = {
    iconic: n => iconic.get(n),
    defIconic(n, rec) { iconic.set(n, rec); },
    defCtrl(n, v, t) { ctrl.set(n, { value: v, type: t }); },
    ctrl(n) { const v = ctrl.get(n); return v ? v.value : undefined; },
    displayImage() {}, displayOverlay() {}, setMetrologyOverlay() {},
    log() {},
  };
  const num = n => {
    const v = ctx.ctrl(n);
    return typeof v === 'number' ? v : parseFloat(String(v).replace(/[[\]\s]/g, '').split(',')[0]);
  };
  const len = n => {
    const v = ctx.ctrl(n);
    if (typeof v === 'number') return 1;
    const s = String(v).replace(/[[\]\s]/g, '');
    return s === '' ? 0 : s.split(',').length;
  };

  IMPLS.create_metrology_model(['MH'], ctx);
  IMPLS.add_metrology_object_line_measure(['MH', 50, 106, 190, 106, 10, 10, 1.2, 20,
    "['measure_transition']", "['all']", 'LIdx'], ctx);

  /* HDevelop: the measure regions are the iconic output and belong to the model,
     so they can be queried before apply; Row/Column hold the edge points found by
     the last apply and therefore stay empty until the model has been applied */
  IMPLS.get_metrology_object_measures(['MeasRegions', 'MH', 'LIdx', "'all'", 'MR', 'MC'], ctx);
  check('get_metrology_object_measures: regions as iconic output before apply',
    iconic.get('MeasRegions') && iconic.get('MeasRegions').kind === 'xld' && iconic.get('MeasRegions').contours === 14,
    iconic.get('MeasRegions') ? iconic.get('MeasRegions').type : 'missing');
  check('get_metrology_object_measures: no edge points before apply',
    len('MR') === 0 && len('MC') === 0, `${len('MR')} rows, ${len('MC')} columns`);
  IMPLS.get_metrology_object_param(['MH', 'LIdx', "'num_measures'", 'NM'], ctx);
  check('get_metrology_object_param: num_measures', num('NM') === 14, `${num('NM')}`);

  /* changing a layout parameter rebuilds the regions */
  IMPLS.set_metrology_object_param(['MH', 'LIdx', "'measure_length1'", '20'], ctx);
  IMPLS.get_metrology_object_measures(['MeasRegions2', 'MH', 'LIdx', "'all'", 'MR2', 'MC2'], ctx);
  check('set_metrology_object_param: measure regions rebuilt',
    iconic.get('MeasRegions2') && iconic.get('MeasRegions2').contours === 7,
    iconic.get('MeasRegions2') ? `${iconic.get('MeasRegions2').type}, ${len('MR2')} rows` : 'missing');
  IMPLS.set_metrology_object_param(['MH', 'LIdx', "'measure_length1'", '10'], ctx);

  IMPLS.apply_metrology_model(['Image', 'MH'], ctx);
  /* the iconic output is returned for every ResultType, not only 'all_contours_xld' */
  IMPLS.get_metrology_object_result(['CAll', 'MH', 'LIdx', "'all_param'", '0', 'ResAll'], ctx);
  check('get_metrology_object_result: contour on all_param',
    iconic.get('CAll') && iconic.get('CAll').kind === 'xld' && iconic.get('CAll').contours === 1,
    iconic.get('CAll') ? iconic.get('CAll').type : 'missing');
  check('get_metrology_object_result: all_param result',
    len('ResAll') === 4 && near(num('ResAll'), 50, 12), `${ctx.ctrl('ResAll')}`);
  IMPLS.get_metrology_object_result(['CScore', 'MH', 'LIdx', "'score'", '0', 'ResScore'], ctx);
  check('get_metrology_object_result: contour on score',
    iconic.get('CScore') && iconic.get('CScore').contours === 1,
    iconic.get('CScore') ? iconic.get('CScore').type : 'missing');

  /* the fitted contour can be fed straight into fit_*_contour_xld: the metrology
     line object runs vertically, its measured (positive) edge is the bar's right
     boundary at column 111.5, so the fitted line is vertical there */
  IMPLS.fit_line_contour_xld(['CAll', "'tukey'", -1, 0, 10, 2.0,
    'fB', 'fCb', 'fE', 'fCe', 'fNr', 'fNc', 'fD'], ctx);
  check('get_metrology_object_result -> fit_line_contour_xld',
    near(num('fCb'), 111.5, 2) && near(num('fCe'), 111.5, 2) &&
    near(num('fE') - num('fB'), 140, 12) && near(Math.abs(num('fD')), 111.5, 2),
    `${ctx.ctrl('fCb')} ${ctx.ctrl('fCe')} rows ${num('fB')}..${num('fE')} D ${num('fD')}`);

  /* this build's earlier order (…, Instance, ResultType, GenParamName, GenParamValue)
     is still accepted; it also returns the fitted contour as the iconic output */
  IMPLS.get_metrology_object_result(['COld', 'MH', 'LIdx', '0', "'all_param'", '[]', 'ResOld'], ctx);
  check('get_metrology_object_result: older argument order',
    iconic.get('COld') && iconic.get('COld').contours === 1 &&
    String(ctx.ctrl('ResOld')) === String(ctx.ctrl('ResAll')),
    `${ctx.ctrl('ResOld')} vs ${ctx.ctrl('ResAll')}`);

  /* HDevelop: (MetrologyHandle, Index, Instance, GenParamName, GenParamValue :
     Parameter) — no iconic output, 'result_type' / 'used_edges' select what the
     numerical tuple contains */
  IMPLS.get_metrology_object_result(['MH', 'LIdx', '0', "'result_type'", "'all_param'", 'ResHdev'], ctx);
  IMPLS.get_metrology_object_result(['MH', 'LIdx', '0', "'score'", '[]', 'ResScoreHdev'], ctx);
  IMPLS.get_metrology_object_result(['MH', 'LIdx', '0', "'used_edges'", "'row'", 'UsedRows'], ctx);
  IMPLS.get_metrology_object_result(['MH', 'LIdx', '0', "'used_edges'", "'amplitude'", 'UsedMag'], ctx);
  check('get_metrology_object_result: HDevelop argument order',
    String(ctx.ctrl('ResHdev')) === String(ctx.ctrl('ResAll')) &&
    num('ResScoreHdev') > 0 && len('UsedRows') === 14 && num('UsedRows') === 50,
    `${ctx.ctrl('ResHdev')} / score ${ctx.ctrl('ResScoreHdev')} / ${len('UsedRows')} used edges`);
  check('get_metrology_object_result: used_edges amplitudes',
    len('UsedMag') === 14 && num('UsedMag') > 0, `${ctx.ctrl('UsedMag')}`);

  /* get_metrology_object_measures: the edge points of the last apply, filtered by
     Transition.  The object runs vertically at column 106 and its region normal
     points towards decreasing columns, so profile offset -MeasureLength1 starts at
     the bar's right boundary 111.5 (bright -> dark, 'negative') and the left one at
     100 (dark -> bright, 'positive'). */
  IMPLS.get_metrology_object_measures(['MH', 'LIdx', "'all'", 'MR3', 'MC3'], ctx);
  check('get_metrology_object_measures: edge points after apply',
    len('MR3') === 14 && num('MR3') === 50 && near(num('MC3'), 111.5, 2),
    `${len('MR3')} rows, first ${num('MR3')}/${num('MC3')}`);
  /* the edges are extracted by apply_metrology_model and one edge per region is
     stored (measure_select 'first'); it is a dark -> light transition along the
     profile, so Transition 'negative' filters everything out */
  IMPLS.get_metrology_object_measures(['MH', 'LIdx', "'negative'", 'MR5', 'MC5'], ctx);
  check('get_metrology_object_measures: Transition filters',
    len('MR5') === 0 && len('MC5') === 0, `${len('MR5')} rows, ${len('MC5')} columns`);

  /* HDevelop: [] means "use the documented default of this parameter" — here
     Index = 'all' and Transition = 'all'; the iconic output is one closed
     rectangular contour per measure region */
  IMPLS.get_metrology_object_measures(['MeasDef', 'MH', '[]', '[]', 'MR6', 'MC6'], ctx);
  const md = iconic.get('MeasDef');
  check('get_metrology_object_measures: [] takes the documented defaults',
    len('MR6') === 14 && near(num('MC6'), 111.5, 2) && md && md.contours === 14,
    `${len('MR6')} rows, first ${num('MR6')}/${num('MC6')}, ${md ? md.contours : 'missing'} regions`);
  check('get_metrology_object_measures: one rectangular region per measure',
    md && md.xld.length === 14 && md.xld.every(c => c.x.length === 5) &&
    md.xld[0].x[0] === md.xld[0].x[4] && md.xld[0].y[0] === md.xld[0].y[4],
    md ? `${md.xld[0].x.length} points per region, closed` : 'missing');

  /* model image size + model/result/number-of-instances queries */
  IMPLS.set_metrology_model_image_size(['MH', 320, 240], ctx);
  IMPLS.get_metrology_model_param(['MH', "['image_size']", 'ISz'], ctx);
  check('get_metrology_model_param: image_size', len('ISz') === 2 && num('ISz') === 320, `${ctx.ctrl('ISz')}`);
  IMPLS.get_metrology_object_num_instances(['MH', 'LIdx', 'NInst'], ctx);
  check('get_metrology_object_num_instances', num('NInst') === 1, `${ctx.ctrl('NInst')}`);

  /* model contour (nominal, available before apply) with Resolution sampling */
  IMPLS.get_metrology_object_model_contour(['ModelC', 'MH', 'LIdx', 10], ctx);
  const mc = iconic.get('ModelC');
  check('get_metrology_object_model_contour: xld',
    mc && mc.kind === 'xld' && mc.contours === 1 && mc.xld[0].x.length === 15,
    mc ? `${mc.type}, ${mc.xld[0].x.length} points (Resolution 10 over 140 px)` : 'missing');
  check('get_metrology_object_model_contour: nominal geometry',
    mc && near(mc.xld[0].x[0], 106, 0.01) && near(mc.xld[0].y[0], 50, 0.01) &&
    near(mc.xld[0].y[14], 190, 0.01),
    mc ? `${mc.xld[0].x[0]}/${mc.xld[0].y[0]} .. ${mc.xld[0].y[14]}` : 'missing');

  /* result contour (fitted, per instance); HDevelop's Resolution defaults to
     1.5, so the 140 px long fitted line is returned as ~94 points */
  IMPLS.get_metrology_object_result_contour(['ResC', 'MH', 'LIdx', '0'], ctx);
  const rc = iconic.get('ResC');
  const rcN = rc ? rc.xld[0].x.length : 0;
  check('get_metrology_object_result_contour: fitted geometry',
    rc && rc.contours === 1 && rcN >= 90 && rcN <= 98 &&
    near(rc.xld[0].x[0], 111.5, 2) && near(rc.xld[0].y[0], num('fB'), 0.01) &&
    near(rc.xld[0].y[rcN - 1], num('fE'), 0.01),
    rc ? `${rcN} points, ${rc.xld[0].x[0]}/${rc.xld[0].y[0]} .. ${rc.xld[0].y[rcN - 1]}` : 'missing');
  IMPLS.get_metrology_object_result_contour(['ResNone', 'MH', 'LIdx', '5'], ctx);
  check('get_metrology_object_result_contour: missing instance -> empty',
    iconic.get('ResNone') && iconic.get('ResNone').contours === 0,
    iconic.get('ResNone') ? iconic.get('ResNone').type : 'missing');
  /* HDevelop's Resolution argument samples the fitted contour */
  IMPLS.get_metrology_object_result_contour(['ResCd', 'MH', 'LIdx', '0', 10], ctx);
  check('get_metrology_object_result_contour: Resolution sampling',
    iconic.get('ResCd') && iconic.get('ResCd').xld[0].x.length === 15,
    iconic.get('ResCd') ? `${iconic.get('ResCd').xld[0].x.length} points (140 px / 10)` : 'missing');
  /* [] takes HDevelop's documented defaults (Index = 0, Instance = 'all') and
     with an omitted Resolution the 1.5 of HDevelop samples the contour */
  IMPLS.get_metrology_object_result_contour(['ResDef', 'MH', '[]', '[]'], ctx);
  check('get_metrology_object_result_contour: [] takes the documented defaults',
    iconic.get('ResDef') && iconic.get('ResDef').contours === 1 &&
    Math.abs(iconic.get('ResDef').xld[0].x.length - rcN) <= 1,
    iconic.get('ResDef') ? `${iconic.get('ResDef').xld[0].x.length} points vs ${rcN} at 1.5` : 'missing');

  /* circle: model contour follows Resolution for a curved contour too */
  IMPLS.add_metrology_object_circle_measure(['MH', 120, 120, 40, 12, 8, 1.0, 25,
    "['measure_transition']", "['all']", 'CIdx'], ctx);
  /* HDevelop numbers the objects of a model from 0 — the index is not a global
     counter, so a fresh model always starts at 0 */
  IMPLS.get_metrology_object_indices(['MH', 'IdxOut'], ctx);
  check('get_metrology_object_indices: numbered from 0 per model',
    len('IdxOut') === 2 && num('IdxOut') === 0 && num('CIdx') === 1,
    `${ctx.ctrl('IdxOut')}`);
  IMPLS.get_metrology_object_model_contour(['CircleModel', 'MH', 'CIdx', 5], ctx);
  const cm = iconic.get('CircleModel');
  check('get_metrology_object_model_contour: circle from Resolution',
    cm && Math.round(cm.xld[0].x.length) === Math.round((2 * Math.PI * 40) / 5) + 1,
    cm ? `${cm.xld[0].x.length} points (perimeter 251.3 / 5)` : 'missing');

  /* reset uses the HDevelop name (and the old plural spelling still works) */
  IMPLS.set_metrology_object_param(['MH', 'LIdx', "'min_score'", '0.9'], ctx);
  IMPLS.reset_metrology_object_param(['MH', 'LIdx'], ctx);
  IMPLS.get_metrology_object_param(['MH', 'LIdx', "'min_score'", 'MS'], ctx);
  check('reset_metrology_object_param', num('MS') === 0.7, `${num('MS')}`);
  check('reset_metrology_object_params alias', typeof IMPLS.reset_metrology_object_params === 'function');

  /* HDevelop: reset_metrology_object_param (MetrologyHandle, Index, GenParamName)
     resets only the named parameters */
  IMPLS.set_metrology_object_param(['MH', 'LIdx', "'min_score'", '0.9'], ctx);
  IMPLS.set_metrology_object_param(['MH', 'LIdx', "'measure_threshold'", '12'], ctx);
  IMPLS.reset_metrology_object_param(['MH', 'LIdx', "'measure_threshold'"], ctx);
  IMPLS.get_metrology_object_param(['MH', 'LIdx', "['min_score', 'measure_threshold']", 'Two'], ctx);
  check('reset_metrology_object_param: GenParamName',
    num('Two') === 0.9 && String(ctx.ctrl('Two')).indexOf('30') >= 0, `${ctx.ctrl('Two')}`);

  /* add_metrology_object_rectangle2_measure in HDevelop's argument order
     (…, Length1, Length2, MeasureLength1, MeasureLength2, MeasureSigma,
      MeasureThreshold, GenParamName, GenParamValue : Index) */
  IMPLS.add_metrology_object_rectangle2_measure(['MH', 120, 120, 0, 60, 40, 15, 5, 1, 30,
    "['measure_transition']", "['all']", 'R2Idx'], ctx);
  IMPLS.get_metrology_object_param(['MH', 'R2Idx', "'measure_length1'", 'R2L1'], ctx);
  IMPLS.get_metrology_object_param(['MH', 'R2Idx', "'measure_length2'", 'R2L2'], ctx);
  check('add_metrology_object_rectangle2_measure: HDevelop argument order',
    num('R2L1') === 15 && num('R2L2') === 5, `measure_length1 ${num('R2L1')}, measure_length2 ${num('R2L2')}`);
  IMPLS.get_metrology_object_param(['MH', 'R2Idx', "'num_measures'", 'R2NM'], ctx);
  check('add_metrology_object_rectangle2_measure: regions',
    num('R2NM') === 2 * (Math.round(120 / 15) + Math.round(80 / 15)), `${num('R2NM')} regions`);

  /* add_metrology_object_generic in HDevelop's argument order: Shape may be a
     tuple, ShapeParam then holds the parameters of all shapes concatenated */
  IMPLS.add_metrology_object_generic(['MH', "['circle', 'line']", '[120, 120, 30, 50, 106, 190, 106]',
    15, 5, 1, 30, "['measure_transition']", "['all']", 'GenIdx'], ctx);
  const genIdx = String(ctx.ctrl('GenIdx')).replace(/[[\]\s]/g, '').split(',').map(Number);
  check('add_metrology_object_generic: HDevelop argument order',
    genIdx.length === 2 && genIdx.every(Number.isInteger), `indices ${ctx.ctrl('GenIdx')}`);
  IMPLS.get_metrology_object_param(['MH', genIdx[0], "'num_measures'", 'GenCircleNM'], ctx);
  IMPLS.get_metrology_object_param(['MH', genIdx[1], "'num_measures'", 'GenLineNM'], ctx);
  check('add_metrology_object_generic: ShapeParam split per shape',
    num('GenCircleNM') === Math.round((2 * Math.PI * 30) / 15) && num('GenLineNM') === Math.round(140 / 15),
    `circle ${num('GenCircleNM')} regions, line ${num('GenLineNM')} regions`);

  /* the older 12-argument form of this build is still accepted */
  IMPLS.add_metrology_object_generic(['MH', "'circle'", 60, 60, 0, 20, 20, 1, 30,
    "['measure_transition']", "['all']", 'GenLegacy'], ctx);
  IMPLS.get_metrology_object_param(['MH', 'GenLegacy', "'num_measures'", 'GenLegacyNM'], ctx);
  check('add_metrology_object_generic: legacy argument order',
    num('GenLegacyNM') === 8, `${num('GenLegacyNM')} regions (clamped to the 8 region minimum)`);

  IMPLS.clear_metrology_model(['MH'], ctx);
}
