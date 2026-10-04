'use strict';
/* ==========================================================================
   OpenCVS — Feature Inspection: shape, gray value and XLD features
   --------------------------------------------------------------------------
   The measurements behind Visualization ▸ Feature Inspection.  HDevelop uses
   this window to look at a single region element or XLD contour and to read the
   numbers its thresholds are picked from (select_shape, select_gray).

   Everything here is pure: plain arrays in, numbers out.  No DOM, no OpenCV —
   the region's moments and bounding boxes come from js/opencv_ops.js, which
   calls into this module, and the smoke test (tools/test-features.js) exercises
   it with plain node.

   Feature names follow HALCON (area, row, column, width, height, ratio,
   rectangularity, min/max/mean/deviation, contlength, num_points …) so a value
   read here is the value of the same-named select_shape feature.
   ========================================================================== */
const FeatureInspect = (() => {

  /* ==========================================================================
     THE CATALOGUE — what the window can show
     [name, operator, description]: `operator` is the HALCON operator that
     computes the value (HDevelop's tooltip) and `description` the one-line
     meaning.  Items listed here are the ones THIS BUILD computes; HALCON knows
     many more (select_shape alone has 34 further region features).
     ========================================================================== */
  const GROUPS = [
    {
      id: 'region', title: 'Region features', op: 'select_shape',
      note: 'Shape and geometry of one region element (the values of select_shape).',
      items: [
        ['area', 'area_center', 'Number of pixels of the region.'],
        ['row', 'area_center', 'Row of the centre of gravity (pixel centre coordinates).'],
        ['column', 'area_center', 'Column of the centre of gravity.'],
        ['row1', 'smallest_rectangle1', 'Smallest row of the surrounding rectangle.'],
        ['column1', 'smallest_rectangle1', 'Smallest column of the surrounding rectangle.'],
        ['row2', 'smallest_rectangle1', 'Largest row of the surrounding rectangle.'],
        ['column2', 'smallest_rectangle1', 'Largest column of the surrounding rectangle.'],
        ['width', 'smallest_rectangle1', 'Extent of the region in the column direction (column2 - column1 + 1).'],
        ['height', 'smallest_rectangle1', 'Extent of the region in the row direction (row2 - row1 + 1).'],
        ['ratio', 'select_shape', 'Width divided by height.'],
        ['rectangularity', 'select_shape', 'Area divided by the area of the surrounding rectangle (1 = a filled rectangle).'],
      ],
    },
    {
      id: 'gray', title: 'Gray value features', op: 'min_max_gray / intensity',
      note: 'Gray values of the image shown in the graphics window, inside the region.',
      items: [
        ['min', 'min_max_gray', 'Smallest gray value inside the region.'],
        ['max', 'min_max_gray', 'Largest gray value inside the region.'],
        ['mean', 'intensity', 'Mean gray value inside the region.'],
        ['deviation', 'intensity', 'Standard deviation of the gray values inside the region.'],
      ],
    },
    {
      id: 'xld', title: 'XLD features', op: 'length_xld / select_shape_xld',
      note: 'Geometry of one XLD contour (the contour points are sub-pixel).',
      items: [
        ['num_points', 'length_xld', 'Number of contour points.'],
        ['contlength', 'length_xld', 'Perimeter: the sum of the distances between successive contour points.'],
        ['row', 'select_shape_xld', 'Mean row of the contour points.'],
        ['column', 'select_shape_xld', 'Mean column of the contour points.'],
        ['row1', 'select_shape_xld', 'Smallest row of the contour.'],
        ['column1', 'select_shape_xld', 'Smallest column of the contour.'],
        ['row2', 'select_shape_xld', 'Largest row of the contour.'],
        ['column2', 'select_shape_xld', 'Largest column of the contour.'],
        ['width', 'select_shape_xld', 'Extent in the column direction (column2 - column1, not +1: the points are continuous).'],
        ['height', 'select_shape_xld', 'Extent in the row direction (row2 - row1).'],
        ['ratio', 'select_shape_xld', 'Width divided by height.'],
      ],
    },
  ];

  const group = id => GROUPS.find(g => g.id === id);
  const info = (gid, name) => {
    const g = group(gid);
    return g && g.items.find(it => it[0] === name);
  };
  /* the features of a group, in catalogue order */
  const names = gid => group(gid).items.map(it => it[0]);

  /* ==========================================================================
     REGION FEATURES — from the element's area, centre of gravity and
     surrounding rectangle, which js/opencv_ops.js measures once per record
     (`regionFeatures` / `labelBoxes`) and js/features.js then interprets.
     ========================================================================== */

  /* features whose value needs the surrounding rectangle (an element of a label
     image whose box is unknown cannot answer them — select_shape says so) */
  const BOX_FEATURES = new Set(['row1', 'row2', 'column1', 'column2', 'width',
    'height', 'ratio', 'rectangularity']);

  const REGION_NAMES = names('region');

  function regionFeature(box, area, cent, name) {
    const wdt = () => (box ? box[3] - box[1] + 1 : NaN);
    const hgt = () => (box ? box[2] - box[0] + 1 : NaN);
    switch (String(name).toLowerCase()) {
      case 'area':    return area;
      case 'row':     return cent ? cent[1] : NaN;
      case 'column':  return cent ? cent[0] : NaN;
      case 'row1':    return box ? box[0] : NaN;
      case 'row2':    return box ? box[2] : NaN;
      case 'column1': return box ? box[1] : NaN;
      case 'column2': return box ? box[3] : NaN;
      case 'width':   return wdt();
      case 'height':  return hgt();
      case 'ratio': { const h = hgt(); return h ? wdt() / h : 0; }
      case 'rectangularity': {
        const w = wdt(), h = hgt();
        return (w > 0 && h > 0) ? area / (w * h) : 0;
      }
      default: return NaN;
    }
  }

  /* ==========================================================================
     GRAY VALUE FEATURES — one pass over the region's pixels of the gray plane
     ========================================================================== */

  /* Above this many pixels of the element's bounding box the walk samples with
     a stride.  HDevelop measures every pixel; a region covering a whole 20 MP
     photo would otherwise be walked on every step of the program.  The stride
     is reported (grayStats().step) and the window notes it. */
  const MAX_SAMPLES = 1000000;

  /* Gray values of ONE region element over a gray plane.
       plane = { gray, W, H }        the gray plane (row major, stride W)
       reg   = { mat } | { labels, w, h }
                                     the region record: a 0/255 mask (element 1)
                                     or a label image the ids of which are kept
       id    = the element id (1-based, as everywhere in this build)
       box   = the element's bounding box [row1, column1, row2, column2] or null
     Returns {count, min, max, mean, deviation, step} or null when the plane and
     the region do not belong together. */
  function grayStats(plane, reg, id, box) {
    if (!plane || !plane.gray || !reg) return null;
    const gray = plane.gray, W = plane.W, H = plane.H;
    if (!W || !H || W * H > gray.length) return null;
    const labels = reg.labels || null;
    const mask = reg.mat ? reg.mat.data : null;
    if (!labels && !mask) return null;
    if (labels && ((reg.h && reg.h !== H) || (reg.w || W) < W)) return null;
    if (mask && reg.mat.cols !== W) return null;      // mask and plane are different frames
    const lw = labels ? (reg.w || W) : W;
    let r1 = 0, c1 = 0, r2 = H - 1, c2 = W - 1;
    if (box) {
      r1 = Math.max(0, box[0]); c1 = Math.max(0, box[1]);
      r2 = Math.min(H - 1, box[2]); c2 = Math.min(W - 1, box[3]);
    }
    if (r2 < r1 || c2 < c1) return null;
    const span = Math.max(1, (r2 - r1 + 1) * (c2 - c1 + 1));
    const step = Math.max(1, Math.ceil(Math.sqrt(span / MAX_SAMPLES)));
    let n = 0, sum = 0, sum2 = 0, mn = Infinity, mx = -Infinity;
    for (let r = r1; r <= r2; r += step) {
      const go = r * W, lo = r * lw;
      for (let c = c1; c <= c2; c += step) {
        const inside = labels ? labels[lo + c] === id : (id === 1 && !!mask[go + c]);
        if (!inside) continue;
        const v = gray[go + c];
        if (v === undefined) continue;
        n++; sum += v; sum2 += v * v;
        if (v < mn) mn = v;
        if (v > mx) mx = v;
      }
    }
    if (!n) return { count: 0, min: NaN, max: NaN, mean: NaN, deviation: NaN, step };
    const mean = sum / n;
    return {
      count: n, min: mn, max: mx, mean,
      deviation: Math.sqrt(Math.max(0, sum2 / n - mean * mean)),
      step,
    };
  }

  /* ==========================================================================
     XLD FEATURES — from one contour {x:[], y:[]}
     ========================================================================== */
  function xldValues(cont) {
    const xs = (cont && cont.x) || [], ys = (cont && cont.y) || [];
    const n = Math.min(xs.length, ys.length);
    if (!n) return null;
    let r1 = Infinity, r2 = -Infinity, c1 = Infinity, c2 = -Infinity;
    let sx = 0, sy = 0, len = 0;
    for (let i = 0; i < n; i++) {
      const x = xs[i], y = ys[i];
      sx += x; sy += y;
      if (y < r1) r1 = y;
      if (y > r2) r2 = y;
      if (x < c1) c1 = x;
      if (x > c2) c2 = x;
      /* a closed contour (gen_circle_contour_xld …) repeats its first point, so
         the closing segment is already in the sum */
      if (i) len += Math.hypot(x - xs[i - 1], y - ys[i - 1]);
    }
    const width = c2 - c1, height = r2 - r1;
    return {
      num_points: n, contlength: len,
      row: sy / n, column: sx / n,
      row1: r1, column1: c1, row2: r2, column2: c2,
      width, height, ratio: height ? width / height : 0,
    };
  }

  /* ==========================================================================
     DISPLAY: gauge ranges and number formatting
     ========================================================================== */

  /* the gauge range a feature is shown with until the user sets its own */
  const FIXED_RANGE = {
    min: [0, 255], max: [0, 255], mean: [0, 255], deviation: [0, 128],
    ratio: [0, 4], rectangularity: [0, 1],
  };
  /* the smallest 1·10ⁿ / 2·10ⁿ / 5·10ⁿ that is >= v (a readable gauge end) */
  function niceCeil(v) {
    if (!(v > 0) || !Number.isFinite(v)) return 1;
    const e = Math.pow(10, Math.floor(Math.log10(v)));
    const m = v / e;
    const s = m <= 1 ? 1 : m <= 2 ? 2 : m <= 5 ? 5 : 10;
    return s * e;
  }
  function defaultRange(name, value) {
    const fixed = FIXED_RANGE[String(name).toLowerCase()];
    if (fixed) return fixed.slice();
    return [0, niceCeil(Math.max(1, Math.abs(Number(value) || 0)) * 1.2)];
  }
  /* where the value sits in the range, as the gauge's fill fraction 0..1 (0.5 %
     minimum, so a small value stays visible) */
  function gaugeFraction(value, lo, hi) {
    if (!Number.isFinite(value) || !(hi > lo)) return 0;
    return Math.min(1, Math.max(0.005, (value - lo) / (hi - lo)));
  }

  /* numbers of the feature list: integers as they are, otherwise 4 significant
     digits (a difference of 1e-5 in `rectangularity` is noise, not information) */
  function format(v) {
    if (v === null || v === undefined) return '—';
    if (typeof v === 'string') return v;
    if (!Number.isFinite(v)) return '—';
    if (Number.isInteger(v) && Math.abs(v) < 1e7) return String(v);
    const a = Math.abs(v);
    if (a > 0 && (a >= 1e5 || a < 1e-3)) return v.toExponential(2);
    const digits = Math.max(0, 3 - Math.floor(Math.log10(a || 1)));
    return v.toFixed(digits);
  }

  return { GROUPS, group, info, names, REGION_NAMES, BOX_FEATURES,
           regionFeature, grayStats, xldValues,
           defaultRange, gaugeFraction, niceCeil, format, MAX_SAMPLES };
})();

/* node export for the smoke test (tools/test-features.js) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { FeatureInspect };
}
