'use strict';
/* ==========================================================================
   OpenCVS — smoke test for js/features.js (the Feature Inspection math).

   DOM-free: the same feature values the Feature Inspection window shows, but
   computed from hand-written regions, label images and XLD contours.

   Run:  tools/node/node tools/test-features.js
   ========================================================================== */
const assert = require('node:assert/strict');
const { FeatureInspect } = require('../js/features.js');

let passed = 0;
function check(name, cond, detail) {
  assert.ok(cond, `${name}${detail ? ' — ' + detail : ''}`);
  passed++;
  console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
}
const near = (a, b, tol) => Math.abs(a - b) <= tol;

/* ---------------- the catalogue ---------------- */
{
  const g = FeatureInspect.GROUPS.map(x => x.id).join(',');
  check('catalogue: region, gray and xld groups', g === 'region,gray,xld', g);
  check('catalogue: group() finds a group', FeatureInspect.group('gray').title === 'Gray value features');
  check('catalogue: group() of an unknown id is undefined', FeatureInspect.group('nope') === undefined);
  check('catalogue: info() finds an item', FeatureInspect.info('region', 'area')[1] === 'area_center');
  check('catalogue: every item is a [name, operator, description] triple',
    FeatureInspect.GROUPS.every(gr => gr.items.every(it =>
      Array.isArray(it) && it.length === 3 && typeof it[0] === 'string' && typeof it[1] === 'string' && it[2].length > 10)));
  check('catalogue: region features are the HALCON select_shape names',
    FeatureInspect.names('region').join(',') ===
      'area,row,column,row1,column1,row2,column2,width,height,ratio,rectangularity',
    FeatureInspect.names('region').join(','));
  check('catalogue: the feature names of a group are unique',
    FeatureInspect.GROUPS.every(gr => new Set(gr.items.map(it => it[0])).size === gr.items.length));
}

/* ---------------- region features ---------------- */
{
  /* a 20 x 10 block whose bounding box is exactly the block: rectangularity 1 */
  const box = [5, 7, 14, 26];
  const area = 200, cent = [17, 12];            // centre of gravity: [column, row]
  const f = (n) => FeatureInspect.regionFeature(box, area, cent, n);
  check('region: area', f('area') === 200);
  check('region: row / column', f('row') === 12 && f('column') === 17);
  check('region: row1/row2/column1/column2', f('row1') === 5 && f('row2') === 14 && f('column1') === 7 && f('column2') === 26);
  check('region: width / height', f('width') === 20 && f('height') === 10, `${f('width')} x ${f('height')}`);
  check('region: ratio', near(f('ratio'), 2, 1e-12));
  check('region: rectangularity of a filled box is 1', near(f('rectangularity'), 1, 1e-12));
  check('region: rectangularity of a sparse region', near(FeatureInspect.regionFeature([0, 0, 9, 9], 25, [0, 0], 'rectangularity'), 0.25, 1e-12));
  check('region: feature names are case-insensitive', f('AREA') === 200);
  check('region: an unknown feature is NaN', Number.isNaN(f('circularity')));
  check('region: without a bounding box only area and centre are known',
    FeatureInspect.regionFeature(null, 200, cent, 'area') === 200 &&
    Number.isNaN(FeatureInspect.regionFeature(null, 200, cent, 'width')) &&
    FeatureInspect.regionFeature(null, 200, cent, 'ratio') === 0);
  check('region: a degenerate box does not divide by zero',
    Number.isNaN(FeatureInspect.regionFeature([3, 3, 3, 3], 1, null, 'ratio')) === false &&
    FeatureInspect.regionFeature([3, 3, 3, 3], 1, null, 'ratio') === 1 &&
    FeatureInspect.regionFeature([3, 3, 3, 3], 1, null, 'rectangularity') === 1);
  check('region: rectangularity of an empty box is 0',
    FeatureInspect.regionFeature(null, 0, null, 'rectangularity') === 0);
  check('region: without a centre of gravity row/column are NaN',
    Number.isNaN(FeatureInspect.regionFeature(box, area, null, 'row')) &&
    Number.isNaN(FeatureInspect.regionFeature(box, area, null, 'column')));
}

/* ---------------- XLD features ---------------- */
{
  /* a 10 x 10 square, closed (the first point repeated), walked clockwise:
     perimeter 40, extremes 2..12 */
  const x = [2, 12, 12, 2, 2], y = [2, 2, 12, 12, 2];
  const v = FeatureInspect.xldValues({ x, y });
  check('xld: num_points', v.num_points === 5);
  check('xld: contlength is the perimeter', near(v.contlength, 40, 1e-9), `contlength ${v.contlength}`);
  check('xld: row1/row2/column1/column2', v.row1 === 2 && v.row2 === 12 && v.column1 === 2 && v.column2 === 12);
  check('xld: width / height are continuous extents', v.width === 10 && v.height === 10, `${v.width} x ${v.height}`);
  check('xld: ratio', near(v.ratio, 1, 1e-12));
  check('xld: mean row / column', near(v.row, (2 + 2 + 12 + 12 + 2) / 5, 1e-12) && near(v.column, (2 + 12 + 12 + 2 + 2) / 5, 1e-12));
  check('xld: an empty contour is null', FeatureInspect.xldValues({ x: [], y: [] }) === null && FeatureInspect.xldValues(null) === null);
  const line = FeatureInspect.xldValues({ x: [0, 3], y: [4, 4] });
  check('xld: a flat contour has height 0 and ratio 0', line.height === 0 && line.ratio === 0 && near(line.contlength, 3, 1e-12));
}

/* ---------------- gray value features ---------------- */
{
  /* labels: element 1 = columns 0..3 of all 6 rows (24 px), element 2 = 2 x 2 in
     the top right corner; the plane rises by 10 per row and 1 per column */
  const W = 8, H = 6;
  const labels = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < 4; c++) labels[r * W + c] = 1;
  for (let r = 0; r < 2; r++) for (let c = 4; c < 6; c++) labels[r * W + c] = 2;
  const gray = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < W; c++) gray[r * W + c] = r * 10 + c;
  const plane = { gray, W, H };
  const reg = { labels, w: W, h: H };

  const s1 = FeatureInspect.grayStats(plane, reg, 1, [0, 0, 5, 3]);
  /* expected values, computed straight from the pixel list */
  const px = [];
  for (let r = 0; r <= 5; r++) for (let c = 0; c <= 3; c++) px.push(r * 10 + c);
  const mean = px.reduce((a, b) => a + b, 0) / px.length;
  const dev = Math.sqrt(px.reduce((a, b) => a + (b - mean) ** 2, 0) / px.length);
  check('gray: element 1 pixel count', s1.count === 24, `${s1.count} px`);
  check('gray: min / max', s1.min === 0 && s1.max === 53, `${s1.min} .. ${s1.max}`);
  check('gray: mean', near(s1.mean, mean, 1e-9), `${s1.mean} vs ${mean.toFixed(3)}`);
  check('gray: deviation', near(s1.deviation, dev, 1e-9), `${s1.deviation.toFixed(3)} vs ${dev.toFixed(3)}`);
  check('gray: a small region is measured without sampling', s1.step === 1);

  const s2 = FeatureInspect.grayStats(plane, reg, 2, [0, 4, 1, 5]);
  check('gray: element 2 is measured on its own pixels', s2.count === 4 && near(s2.mean, 9.5, 1e-9), `${s2.count} px, mean ${s2.mean}`);
  check('gray: a box may be omitted (the whole label image is scanned)', FeatureInspect.grayStats(plane, reg, 2, null).count === 4);

  const none = FeatureInspect.grayStats(plane, reg, 3, [0, 0, 5, 7]);
  check('gray: an id no pixel belongs to has count 0', none && none.count === 0);

  /* the same region as a 0/255 mask (one element, id 1) */
  const maskData = new Uint8Array(W * H);
  for (let r = 0; r < H; r++) for (let c = 0; c < 4; c++) maskData[r * W + c] = 255;
  const mreg = { mat: { data: maskData, cols: W } };
  const sm = FeatureInspect.grayStats(plane, mreg, 1, [0, 0, 5, 3]);
  check('gray: a mask region measures the same pixels', sm.count === 24 && near(sm.mean, mean, 1e-9));
  check('gray: id 2 of a one-element mask is empty', FeatureInspect.grayStats(plane, mreg, 2, [0, 0, 5, 3]).count === 0);

  /* a constant plane has no deviation */
  const flat = { gray: new Uint8Array(W * H).fill(7), W, H };
  const sf = FeatureInspect.grayStats(flat, reg, 1, [0, 0, 5, 3]);
  check('gray: deviation of a constant region is 0', sf.deviation === 0 && sf.min === 7 && sf.max === 7);

  /* guards: plane and region of different frames are refused, not mis-measured */
  check('gray: a mask from another frame is refused', FeatureInspect.grayStats(plane, { mat: { data: maskData, cols: W + 1 } }, 1, null) === null);
  check('gray: a label image of another frame is refused', FeatureInspect.grayStats(plane, { labels, w: W, h: H + 1 }, 1, null) === null);
  check('gray: without pixels of its own a region has no gray features', FeatureInspect.grayStats(plane, { mat: null }, 1, null) === null);
  check('gray: without a plane there is nothing to measure', FeatureInspect.grayStats(null, reg, 1, null) === null);
}

/* ---------------- sampling of very large regions ---------------- */
{
  /* 4 MP, so the walk has to stride (MAX_SAMPLES = 1e6): a 2000 x 2000 plane and
     a mask covering all of it */
  const W = 2000, H = 2000;
  const gray = new Uint8Array(W * H).fill(100);
  const mask = new Uint8Array(W * H).fill(255);
  const s = FeatureInspect.grayStats({ gray, W, H }, { mat: { data: mask, cols: W } }, 1, [0, 0, H - 1, W - 1]);
  check('sampling: the stride grows with the element', s.step === 2, `step ${s.step}`);
  check('sampling: at most ~MAX_SAMPLES pixels are read', s.count > 900000 && s.count <= FeatureInspect.MAX_SAMPLES,
    `${s.count} px of 4e6`);
  check('sampling: the statistics stay exact for a constant plane', s.mean === 100 && s.min === 100 && s.max === 100 && s.deviation === 0);
}

/* ---------------- gauge ranges ---------------- */
{
  check('range: gray features use the 8 bit range', FeatureInspect.defaultRange('min', 12).join(',') === '0,255');
  check('range: deviation has its own range', FeatureInspect.defaultRange('deviation', 3).join(',') === '0,128');
  check('range: ratio and rectangularity are fixed', FeatureInspect.defaultRange('ratio', 1).join(',') === '0,4' &&
    FeatureInspect.defaultRange('rectangularity', 0.5).join(',') === '0,1');
  check('range: a grey value range is rounded up to a readable end', FeatureInspect.defaultRange('area', 1234).join(',') === '0,2000');
  check('range: a small value gets a small range', FeatureInspect.defaultRange('contlength', 12).join(',') === '0,20');
  check('range: an area of 0 still gets a range', FeatureInspect.defaultRange('area', 0).join(',') === '0,2');
  check('range: niceCeil rounds up to 1/2/5 * 10^n', FeatureInspect.niceCeil(3) === 5 && FeatureInspect.niceCeil(1) === 1 &&
    FeatureInspect.niceCeil(120) === 200 && near(FeatureInspect.niceCeil(0.0004), 0.0005, 1e-12));

  check('gauge: the value sits proportionally in the range', near(FeatureInspect.gaugeFraction(75, 0, 100), 0.75, 1e-12));
  check('gauge: the value is clamped to the range', FeatureInspect.gaugeFraction(300, 0, 100) === 1 && FeatureInspect.gaugeFraction(-5, 0, 100) === 0.005);
  check('gauge: a tiny value stays visible', FeatureInspect.gaugeFraction(0, 0, 1000) === 0.005);
  check('gauge: a degenerate range draws nothing', FeatureInspect.gaugeFraction(5, 3, 3) === 0);
  check('gauge: a non-finite value draws nothing', FeatureInspect.gaugeFraction(NaN, 0, 1) === 0);
}

/* ---------------- number formatting ---------------- */
{
  check('format: integers stay integers', FeatureInspect.format(42) === '42' && FeatureInspect.format(1234567) === '1234567');
  check('format: four significant digits', FeatureInspect.format(1.23456) === '1.235' && FeatureInspect.format(0.123456) === '0.1235',
    `${FeatureInspect.format(1.23456)} / ${FeatureInspect.format(0.123456)}`);
  check('format: large and tiny numbers go exponential', FeatureInspect.format(123456789) === '1.23e+8' && FeatureInspect.format(0.00012) === '1.20e-4');
  check('format: a missing value is a dash', FeatureInspect.format(NaN) === '—' && FeatureInspect.format(null) === '—' &&
    FeatureInspect.format(undefined) === '—' && FeatureInspect.format(Infinity) === '—');
  check('format: strings pass through', FeatureInspect.format('region') === 'region');
}

console.log(`\nfeature inspection: ${passed} checks passed`);
