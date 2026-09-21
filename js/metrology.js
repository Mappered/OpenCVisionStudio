'use strict';
/* ==========================================================================
   OpenCVS — HALCON-style metrology model (measure + fit operators)
   --------------------------------------------------------------------------
   Hand-implemented on top of raw gray arrays (no OpenCV equivalent exists —
   see ROADMAP "Operators with no OpenCV equivalent"). Two layers:

     MetrologyCore  DOM-free engine: model store, measure-region generation,
                    1-D edge extraction, robust shape fitting (line, circle,
                    ellipse, rectangle2), instance/score handling.
                    Testable with plain node (tools/test-metrology.js).

     METROLOGY_OP_IMPLS / METROLOGY_OPINFO
                    Operator implementations for the IDE execution engine
                    (app.js) and metadata for the Operator Window / autocomplete.

   Coordinates: HALCON row/column. Internally profiles and fits run in
   (x=column, y=row); conversions happen at the boundaries.
   ========================================================================== */

/* ==========================================================================
   small math helpers (pure)
   ========================================================================== */
const MetrologyMath = {
  /* solve A x = b for n x n A (Gaussian elimination with partial pivoting) */
  solveLinear(A, b, n) {
    const M = [];
    for (let i = 0; i < n; i++) M.push(A[i].slice());
    const x = b.slice();
    for (let col = 0; col < n; col++) {
      let piv = col;
      for (let r = col + 1; r < n; r++) if (Math.abs(M[r][col]) > Math.abs(M[piv][col])) piv = r;
      if (Math.abs(M[piv][col]) < 1e-12) return null;
      if (piv !== col) {
        [M[piv], M[col]] = [M[col], M[piv]];
        [x[piv], x[col]] = [x[col], x[piv]];
      }
      for (let r = col + 1; r < n; r++) {
        const f = M[r][col] / M[col][col];
        for (let c = col; c < n; c++) M[r][c] -= f * M[col][c];
        x[r] -= f * x[col];
      }
    }
    const out = new Array(n).fill(0);
    for (let i = n - 1; i >= 0; i--) {
      let s = x[i];
      for (let c = i + 1; c < n; c++) s -= M[i][c] * out[c];
      out[i] = s / M[i][i];
    }
    return out;
  },

  median(v) {
    if (!v.length) return 0;
    const s = v.slice().sort((a, b) => a - b);
    const m = s.length >> 1;
    return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2;
  },

  /* 3x3 symmetric eigen decomposition (Jacobi); returns {values, vectors[columns]} */
  eigen3(A) {
    let a = A.map(r => r.slice());
    let v = [[1, 0, 0], [0, 1, 0], [0, 0, 1]];
    for (let sweep = 0; sweep < 32; sweep++) {
      let off = Math.abs(a[0][1]) + Math.abs(a[0][2]) + Math.abs(a[1][2]);
      if (off < 1e-14) break;
      for (const [p, q] of [[0, 1], [0, 2], [1, 2]]) {
        if (Math.abs(a[p][q]) < 1e-18) continue;
        const theta = (a[q][q] - a[p][p]) / (2 * a[p][q]);
        const t = Math.sign(theta || 1) / (Math.abs(theta) + Math.hypot(theta * theta + 1));
        const c = 1 / Math.hypot(t * t + 1), s = t * c;
        for (let k = 0; k < 3; k++) {
          const akp = a[k][p], akq = a[k][q];
          a[k][p] = c * akp - s * akq;
          a[k][q] = s * akp + c * akq;
        }
        for (let k = 0; k < 3; k++) {
          const apk = a[p][k], aqk = a[q][k];
          a[p][k] = c * apk - s * aqk;
          a[q][k] = s * apk + c * aqk;
        }
        for (let k = 0; k < 3; k++) {
          const vkp = v[k][p], vkq = v[k][q];
          v[k][p] = c * vkp - s * vkq;
          v[k][q] = s * vkp + c * vkq;
        }
      }
    }
    return { values: [a[0][0], a[1][1], a[2][2]], vectors: v };
  },
};

/* ==========================================================================
   DOM-free metrology engine
   ========================================================================== */
const MetrologyCore = (() => {

  /* HALCON's MeasureLength1/MeasureLength2: the half edge lengths of a measure
     region PERPENDICULAR (the direction the gray profile is scanned in) and
     TANGENTIAL to the contour.  measure_distance defaults to MeasureLength1. */
  const PARAM_DEFAULTS = {
    measure_length1: 20,      // half length of a measure region perpendicular to the contour
    measure_length2: 5,       // half length of a measure region tangential to the contour
    measure_sigma: 1.0,       // Gaussian smoothing of the 1-D gray profile
    measure_threshold: 30,    // minimum gradient amplitude of an edge
    measure_select: 'first',  // 'first' | 'last' | 'all' candidate edges per profile
    measure_transition: 'positive', // 'positive' | 'negative' | 'all'
    measure_distance: 0,      // distance between measure regions; 0 = measure_length1
    measure_interpolation: 'bilinear', // 'nearest_neighbor' | 'bilinear'
    min_score: 0.7,           // minimum fraction of measures that must support an instance
    num_instances: 1,
    max_iterations: 5,        // robust refit iterations
    rand_seed: 42,
  };

  const NUMERIC_PARAMS = new Set(['measure_length1', 'measure_length2', 'measure_sigma',
    'measure_threshold', 'measure_distance', 'min_score', 'num_instances',
    'max_iterations', 'rand_seed']);
  /* parameters the measure region layout depends on: changing them rebuilds the
     regions (see refreshMeasures) */
  const MEASURE_GEOM_PARAMS = new Set(['measure_length1', 'measure_length2', 'measure_distance']);
  const STRING_PARAMS = {
    measure_select: ['first', 'last', 'all'],
    measure_transition: ['positive', 'negative', 'all'],
    measure_interpolation: ['nearest_neighbor', 'bilinear'],
  };

  const SHAPES = new Set(['circle', 'ellipse', 'line', 'rectangle2']);
  const MIN_POINTS = { line: 2, circle: 3, ellipse: 5, rectangle2: 8 };

  let modelSeq = 1;
  const models = new Map();

  /* ---------------- model / object lifecycle ---------------- */

  function createModel() {
    const m = {
      handle: modelSeq++, objects: new Map(),
      objectSeq: 0,                          // HALCON numbers the objects of a model from 0
      imageSize: null,                       // set_metrology_model_image_size
      modelParams: {},                       // set_metrology_model_param
    };
    models.set(m.handle, m);
    return m;
  }

  function getModel(handle) {
    const m = models.get(Math.round(handle));
    if (!m) throw new Error(`invalid metrology handle ${handle}`);
    return m;
  }

  /* drop every model and restart the handle counter: after a program
     reset a fresh create_metrology_model is handle 1 again, as in HDevelop */
  function reset() {
    models.clear();
    modelSeq = 1;
  }

  function addObject(model, shape, geom, params) {
    if (!SHAPES.has(shape)) throw new Error(`unsupported metrology object shape '${shape}'`);
    validateGeometry(shape, geom);
    const obj = {
      index: model.objectSeq++,
      shape,
      geom: Object.assign({}, geom),           // nominal geometry (approximate)
      defaults: Object.assign({}, PARAM_DEFAULTS, params || {}),
      params: Object.assign({}, PARAM_DEFAULTS, params || {}),
      measures: [],
      instances: [],
    };
    model.objects.set(obj.index, obj);
    /* The measure regions belong to the model, not to an apply: HALCON creates
       them when the object is added, so get_metrology_object_measures (and the
       corresponding overlay) works before apply_metrology_model has run. */
    refreshMeasures(obj);
    return obj.index;
  }

  function validateGeometry(shape, g) {
    const need = {
      circle: ['row', 'column', 'radius'],
      ellipse: ['row', 'column', 'phi', 'ra', 'rb'],
      line: ['rowBegin', 'columnBegin', 'rowEnd', 'columnEnd'],
      rectangle2: ['row', 'column', 'phi', 'length1', 'length2'],
    }[shape];
    for (const k of need) {
      if (!Number.isFinite(g[k])) throw new Error(`${shape}: parameter '${k}' must be a finite number`);
    }
  }

  function setParam(obj, name, value) {
    if (NUMERIC_PARAMS.has(name)) {
      const v = Number(value);
      if (!Number.isFinite(v)) throw new Error(`'${name}' must be numeric`);
      if (name === 'min_score' && (v < 0 || v > 1)) throw new Error("'min_score' must be within [0, 1]");
      if (name === 'num_instances' && (v < 1 || v !== Math.round(v))) throw new Error("'num_instances' must be a positive integer");
      if (name === 'max_iterations' && (v < 1 || v > 100)) throw new Error("'max_iterations' must be within [1, 100]");
      if (name !== 'min_score' && name !== 'measure_distance' && v <= 0) throw new Error(`'${name}' must be > 0`);
      obj.params[name] = v;
      if (MEASURE_GEOM_PARAMS.has(name)) refreshMeasures(obj);
      return;
    }
    if (STRING_PARAMS[name]) {
      const v = String(value);
      if (!STRING_PARAMS[name].includes(v)) throw new Error(`'${name}': unsupported value '${v}'`);
      obj.params[name] = v;
      return;
    }
    throw new Error(`unsupported metrology object parameter '${name}'`);
  }

  function getParam(obj, name) {
    if (name === 'num_measures') return obj.measures.length || null;
    if (Object.prototype.hasOwnProperty.call(obj.params, name)) return obj.params[name];
    if (Object.prototype.hasOwnProperty.call(obj.geom, name)) return obj.geom[name];
    const alias = { row_begin: 'rowBegin', column_begin: 'columnBegin', row_end: 'rowEnd', column_end: 'columnEnd' };
    if (alias[name] && Object.prototype.hasOwnProperty.call(obj.geom, alias[name])) return obj.geom[alias[name]];
    throw new Error(`unsupported metrology object parameter '${name}'`);
  }

  /* HDevelop's reset_metrology_object_param restores the default values of the
     parameters (MeasureLength1 = 20, MeasureSigma = 1, ...), not the values the
     object happened to be created with */
  function defaultOf(obj, name) {
    if (Object.prototype.hasOwnProperty.call(PARAM_DEFAULTS, name)) return PARAM_DEFAULTS[name];
    if (Object.prototype.hasOwnProperty.call(obj.defaults, name)) return obj.defaults[name];
    throw new Error(`unsupported metrology object parameter '${name}'`);
  }

  function resetParam(obj, name) {
    obj.params[name] = defaultOf(obj, name);
    if (MEASURE_GEOM_PARAMS.has(name)) refreshMeasures(obj);
  }

  function resetParams(obj) {
    obj.params = Object.assign({}, PARAM_DEFAULTS);
    refreshMeasures(obj);
  }

  function copyModel(model, indexSel) {
    const m2 = createModel();
    m2.imageSize = model.imageSize ? Object.assign({}, model.imageSize) : null;
    m2.modelParams = Object.assign({}, model.modelParams);
    for (const obj of model.objects.values()) {
      if (indexSel !== 'all' && obj.index !== indexSel) continue;
      const idx = addObject(m2, obj.shape, obj.geom, {});
      const o2 = m2.objects.get(idx);
      o2.defaults = Object.assign({}, obj.defaults);
      o2.params = Object.assign({}, obj.params);
      refreshMeasures(o2);
    }
    return m2;
  }

  function removeObjects(model, indexSel) {
    for (const [k, obj] of [...model.objects]) {
      if (indexSel === 'all' || k === indexSel) model.objects.delete(k);
    }
  }

  function selectObjects(model, indexSel) {
    if (indexSel === 'all') return [...model.objects.values()];
    const obj = model.objects.get(indexSel);
    if (!obj) throw new Error(`invalid metrology object index ${indexSel}`);
    return [obj];
  }

  /* ---------------- measure region generation ----------------
     Each measure region is a rectangle of half sizes (MeasureLength1
     perpendicular to the contour, MeasureLength2 tangential to it), centered on
     the nominal contour, with outward normal. */

  function measureDistance(obj) {
    const p = obj.params;
    return p.measure_distance > 0 ? p.measure_distance : p.measure_length1;
  }

  function generateMeasures(obj) {
    const g = obj.geom, d = measureDistance(obj);
    const out = [];
    const put = (x, y, nx, ny) => out.push({ cx: x, cy: y, nx, ny, edge: null });
    if (obj.shape === 'circle') {
      const n = clamp(Math.round((2 * Math.PI * g.radius) / d), 8, 400);
      for (let i = 0; i < n; i++) {
        const t = (2 * Math.PI * i) / n, c = Math.cos(t), s = Math.sin(t);
        put(g.column + g.radius * c, g.row + g.radius * s, c, s);
      }
    } else if (obj.shape === 'ellipse') {
      const P = Math.PI * (3 * (g.ra + g.rb) - Math.sqrt((3 * g.ra + g.rb) * (g.ra + 3 * g.rb)));
      const n = clamp(Math.round(P / d), 8, 400);
      const cp = Math.cos(g.phi), sp = Math.sin(g.phi);
      for (let i = 0; i < n; i++) {
        const t = (2 * Math.PI * i) / n, c = Math.cos(t), s = Math.sin(t);
        const ex = g.ra * c, ey = g.rb * s;              // ellipse point, unrotated
        let nx = c / g.ra, ny = s / g.rb;                // gradient direction
        const nl = Math.hypot(nx, ny) || 1;
        nx /= nl; ny /= nl;
        put(g.column + ex * cp - ey * sp, g.row + ex * sp + ey * cp,
            nx * cp - ny * sp, nx * sp + ny * cp);
      }
    } else if (obj.shape === 'line') {
      const dx = g.columnEnd - g.columnBegin, dy = g.rowEnd - g.rowBegin;
      const L = Math.hypot(dx, dy);
      if (L < 1) throw new Error('line: begin and end must be at least 1 pixel apart');
      const n = clamp(Math.round(L / d), 3, 400);
      const ux = dx / L, uy = dy / L;
      const nx = -uy, ny = ux;                           // profile direction
      for (let i = 0; i < n; i++) {
        const t = i / (n - 1);
        put(g.columnBegin + dx * t, g.rowBegin + dy * t, nx, ny);
      }
    } else { /* rectangle2 */
      const cp = Math.cos(g.phi), sp = Math.sin(g.phi);
      const u1 = [cp, sp], u2 = [-sp, cp];               // axis unit vectors (x, y)
      const sides = [
        { o: [g.column + u2[0] * g.length2, g.row + u2[1] * g.length2], dir: u1, ext: g.length1, n: u2 },
        { o: [g.column - u2[0] * g.length2, g.row - u2[1] * g.length2], dir: u1, ext: g.length1, n: [-u2[0], -u2[1]] },
        { o: [g.column + u1[0] * g.length1, g.row + u1[1] * g.length1], dir: u2, ext: g.length2, n: u1 },
        { o: [g.column - u1[0] * g.length1, g.row - u1[1] * g.length1], dir: u2, ext: g.length2, n: [-u1[0], -u1[1]] },
      ];
      for (const s of sides) {
        const n = Math.max(2, Math.round((2 * s.ext) / d));
        for (let i = 0; i < n; i++) {
          const t = (i / (n - 1)) * 2 - 1;
          put(s.o[0] + s.dir[0] * s.ext * t, s.o[1] + s.dir[1] * s.ext * t, s.n[0], s.n[1]);
        }
      }
    }
    return out;
  }

  /* (re)build an object's measure regions from its current nominal geometry and
     measure parameters; edges found in a previous apply are dropped because they
     refer to the old regions */
  function refreshMeasures(obj) {
    obj.measures = generateMeasures(obj);
    return obj.measures;
  }

  const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));

  /* ---------------- 1-D edge extraction ---------------- */

  function gaussianSmooth(p, sigma) {
    if (sigma <= 0.01) return Float64Array.from(p);
    const r = Math.max(1, Math.ceil(3 * sigma));
    const k = new Float64Array(2 * r + 1);
    let sum = 0;
    for (let i = -r; i <= r; i++) { k[i + r] = Math.exp(-(i * i) / (2 * sigma * sigma)); sum += k[i + r]; }
    for (let i = 0; i < k.length; i++) k[i] /= sum;
    const out = new Float64Array(p.length);
    for (let i = 0; i < p.length; i++) {
      let acc = 0;
      for (let j = -r; j <= r; j++) acc += p[clamp(i + j, 0, p.length - 1)] * k[j + r];
      out[i] = acc;
    }
    return out;
  }

  function sampleGray(gray, W, H, x, y, bilinear) {
    const cx = clamp(x, 0, W - 1), cy = clamp(y, 0, H - 1);   // clamp at image border
    if (!bilinear) return gray[Math.round(cy) * W + Math.round(cx)];
    const x0 = Math.floor(cx), y0 = Math.floor(cy);
    const fx = cx - x0, fy = cy - y0;
    const x1 = Math.min(W - 1, x0 + 1), y1 = Math.min(H - 1, y0 + 1);
    const g00 = gray[y0 * W + x0], g10 = gray[y0 * W + x1];
    const g01 = gray[y1 * W + x0], g11 = gray[y1 * W + x1];
    return (g00 * (1 - fx) + g10 * fx) * (1 - fy) + (g01 * (1 - fx) + g11 * fx) * fy;
  }

  /* extract edges for every measure region; fills m.edge = {off, mag, sign} or null.
     sign = +1 for a positive transition (gray rising along the profile, i.e.
     dark -> light), -1 for a negative one; get_metrology_object_measures needs
     it to honor its Transition argument. */
  function extractEdges(measures, params, gray, W, H) {
    /* the profile is scanned across the contour (along the region normal) over
       +/- MeasureLength1 — HALCON's half length perpendicular to the boundary */
    const L1 = Math.max(1, params.measure_length1);
    const n = Math.max(3, Math.round(2 * L1) + 1);
    const bilinear = params.measure_interpolation !== 'nearest_neighbor';
    for (const m of measures) {
      const prof = new Float64Array(n);
      for (let j = 0; j < n; j++) {
        const off = j - L1;
        prof[j] = sampleGray(gray, W, H, m.cx + m.nx * off, m.cy + m.ny * off, bilinear);
      }
      const s = gaussianSmooth(prof, params.measure_sigma);
      const grads = new Float64Array(n - 1);
      for (let i = 0; i < n - 1; i++) grads[i] = s[i + 1] - s[i];
      const cands = [];
      for (let i = 1; i < n - 2; i++) {
        const g = grads[i];
        if (params.measure_transition === 'positive' && g <= 0) continue;
        if (params.measure_transition === 'negative' && g >= 0) continue;
        const a = Math.abs(g);
        if (a < params.measure_threshold) continue;
        if (a < Math.abs(grads[i - 1]) || a < Math.abs(grads[i + 1])) continue;  // local maximum
        let sub = 0;
        const d0 = Math.abs(grads[i - 1]), d2 = Math.abs(grads[i + 1]);
        const den = d0 - 2 * a + d2;
        if (Math.abs(den) > 1e-9) sub = clamp(0.5 * (d0 - d2) / den, -0.5, 0.5);
        /* profile sample j sits at offset j - L1 across the contour, so the
           sub-pixel edge between samples i and i+1 is at i + 0.5 + sub - L1 */
        cands.push({ off: i + 0.5 + sub - L1, mag: a, sign: g > 0 ? 1 : -1 });
      }
      if (!cands.length) { m.edge = null; continue; }
      m.edge = params.measure_select === 'last' ? cands[cands.length - 1]
        : params.measure_select === 'all' ? cands
        : cands[0];
    }
  }

  /* ---------------- shape fitting (x=column, y=row) ---------------- */

  function fitLineModel(pts) {
    const n = pts.length;
    let mx = 0, my = 0;
    for (const p of pts) { mx += p.x; my += p.y; }
    mx /= n; my /= n;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of pts) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    if (sxx + syy < 1e-9) return null;
    const mean = (sxx + syy) / 2;
    const diff = Math.hypot((sxx - syy) / 2, sxy);
    const l1 = mean + diff;                                   // larger eigenvalue
    /* eigenvector of l1. The closed form (sxy, l1 - sxx) degenerates for an
       exactly axis-aligned line (sxy = 0 and l1 = sxx), which would return the
       null vector; there the eigenvector is simply the dominant axis. */
    let ux, uy;
    if (Math.abs(sxy) > 1e-12) { ux = sxy; uy = l1 - sxx; }
    else if (sxx >= syy) { ux = 1; uy = 0; }
    else { ux = 0; uy = 1; }
    const ul = Math.hypot(ux, uy) || 1;
    return { x: mx, y: my, ux: ux / ul, uy: uy / ul };        // point + unit direction
  }

  function lineResidual(m, p) {
    const dx = p.x - m.x, dy = p.y - m.y;
    return Math.abs(-dx * m.uy + dy * m.ux);                  // |cross| with direction
  }

  function lineParams(m, inliers) {
    /* PCA leaves the direction sign arbitrary, but HDevelop's RowBegin/ColBegin
       is the first supporting contour point and RowEnd/ColEnd the last, so
       orient the line along the (ordered) inlier set */
    let ux = m.ux, uy = m.uy;
    if (inliers.length >= 2) {
      const a = inliers[0], b = inliers[inliers.length - 1];
      if ((b.x - a.x) * ux + (b.y - a.y) * uy < 0) { ux = -ux; uy = -uy; }
    }
    let t0 = Infinity, t1 = -Infinity;
    for (const i of inliers) {
      const t = (i.x - m.x) * ux + (i.y - m.y) * uy;
      if (t < t0) t0 = t;
      if (t > t1) t1 = t;
    }
    return {
      rowBegin: m.y + uy * t0, columnBegin: m.x + ux * t0,
      rowEnd: m.y + uy * t1, columnEnd: m.x + ux * t1,
      ux, uy,
    };
  }

  function fitCircleKasa(pts) {
    const n = pts.length;
    let sx = 0, sy = 0, sxx = 0, sxy = 0, syy = 0, sxz = 0, syz = 0, sz = 0;
    for (const p of pts) {
      const z = p.x * p.x + p.y * p.y;
      sx += p.x; sy += p.y; sxx += p.x * p.x; sxy += p.x * p.y; syy += p.y * p.y;
      sxz += p.x * z; syz += p.y * z; sz += z;
    }
    // least squares of x^2+y^2 + a x + b y + c = 0
    const A = [[sxx, sxy, sx], [sxy, syy, sy], [sx, sy, n]];
    const sol = MetrologyMath.solveLinear(A, [-sxz, -syz, -sz], 3);
    if (!sol) return null;
    const [a, b, c] = sol;
    const r2 = (a * a + b * b) / 4 - c;
    if (r2 <= 1) return null;
    return { x: -a / 2, y: -b / 2, r: Math.sqrt(r2) };
  }

  /* Gauss-Newton refinement of the geometric circle fit */
  function refineCircle(m, pts) {
    let { x, y, r } = m;
    for (let it = 0; it < 4; it++) {
      let h00 = 0, h01 = 0, h02 = 0, h11 = 0, h12 = 0, h22 = 0, g0 = 0, g1 = 0, g2 = 0;
      for (const p of pts) {
        const dx = p.x - x, dy = p.y - y;
        const d = Math.hypot(dx, dy) || 1e-6;
        const e = d - r;
        const j0 = -dx / d, j1 = -dy / d, j2 = -1;
        h00 += j0 * j0; h01 += j0 * j1; h02 += j0 * j2;
        h11 += j1 * j1; h12 += j1 * j2; h22 += j2 * j2;
        g0 += j0 * e; g1 += j1 * e; g2 += j2 * e;
      }
      const sol = MetrologyMath.solveLinear([[h00, h01, h02], [h01, h11, h12], [h02, h12, h22]], [-g0, -g1, -g2], 3);
      if (!sol) break;
      x += sol[0]; y += sol[1]; r += sol[2];
      if (r <= 1) return null;
      if (Math.abs(sol[0]) + Math.abs(sol[1]) + Math.abs(sol[2]) < 1e-6) break;
    }
    return { x, y, r };
  }

  function circleResidual(m, p) {
    return Math.abs(Math.hypot(p.x - m.x, p.y - m.y) - m.r);
  }

  /* Levenberg-Marquardt fit of the explicit ellipse
     p = [cx, cy, a, b, phi] with approximate orthogonal residuals */
  function ellipseResiduals(par, pts) {
    const [cx, cy, a, b, phi] = par;
    const cp = Math.cos(phi), sp = Math.sin(phi);
    const out = new Float64Array(pts.length);
    for (let i = 0; i < pts.length; i++) {
      const dx = pts[i].x - cx, dy = pts[i].y - cy;
      const u = dx * cp + dy * sp, v = -dx * sp + dy * cp;
      const F = (u * u) / (a * a) + (v * v) / (b * b) - 1;
      const g = Math.hypot(2 * u / (a * a), 2 * v / (b * b)) || 1e-6;
      out[i] = F / g;
    }
    return out;
  }

  function fitEllipseLM(pts, init) {
    const nP = 5;
    let par = init.slice();
    let res = ellipseResiduals(par, pts);
    let sse = 0;
    for (const e of res) sse += e * e;
    let lambda = 1e-3;
    for (let it = 0; it < 24; it++) {
      const J = [];
      for (let k = 0; k < nP; k++) {
        const h = 1e-5 * Math.max(1, Math.abs(par[k]));
        const pk = par.slice(); pk[k] += h;
        const rk = ellipseResiduals(pk, pts);
        J.push(rk.map((v, i) => (v - res[i]) / h));
      }
      const H = [], g = new Array(nP).fill(0);
      for (let r = 0; r < nP; r++) {
        H.push(new Array(nP).fill(0));
        for (let c = 0; c < nP; c++) {
          let s = 0;
          for (let i = 0; i < pts.length; i++) s += J[r][i] * J[c][i];
          H[r][c] = s;
        }
        for (let i = 0; i < pts.length; i++) g[r] += J[r][i] * res[i];
      }
      for (let k = 0; k < nP; k++) H[k][k] += lambda * (1 + H[k][k]);
      const sol = MetrologyMath.solveLinear(H, g.map(v => -v), nP);
      if (!sol) return null;
      const trial = par.map((v, k) => v + sol[k]);
      trial[2] = Math.max(0.5, Math.abs(trial[2]));
      trial[3] = Math.max(0.5, Math.abs(trial[3]));
      const rt = ellipseResiduals(trial, pts);
      let sset = 0;
      for (const e of rt) sset += e * e;
      if (sset < sse) {
        const rel = (sse - sset) / (sse || 1);
        par = trial; res = rt; sse = sset;
        lambda = Math.max(1e-6, lambda / 3);
        if (rel < 1e-9) break;
      } else {
        lambda *= 4;
        if (lambda > 1e6) break;
      }
    }
    let [cx, cy, a, b, phi] = par;
    if (![cx, cy, a, b, phi].every(Number.isFinite) || a <= 0.5 || b <= 0.5) return null;
    if (a < b) { [a, b] = [b, a]; phi += Math.PI / 2; }         // HALCON: Ra >= Rb
    while (phi > Math.PI / 2) phi -= Math.PI;
    while (phi <= -Math.PI / 2) phi += Math.PI;
    return { x: cx, y: cy, a, b, phi };
  }

  function ellipseResidual(m, p) {
    const dx = p.x - m.x, dy = p.y - m.y;
    const cp = Math.cos(m.phi), sp = Math.sin(m.phi);
    const u = dx * cp + dy * sp, v = -dx * sp + dy * cp;
    const F = (u * u) / (m.a * m.a) + (v * v) / (m.b * m.b) - 1;
    const g = Math.hypot(2 * u / (m.a * m.a), 2 * v / (m.b * m.b)) || 1e-6;
    return Math.abs(F / g);
  }

  /* rectangle2: sides keep fixed normals; each side is a plane fitted by the
     median of its assigned points. Lengths follow from the plane distances,
     so truncated measure coverage near corners cannot shrink the result. */
  function rectBasis(m) {
    const c = Math.cos(m.phi), s = Math.sin(m.phi);
    return { u1: [c, s], u2: [-s, c] };
  }

  /* one assignment + plane-median update at a fixed orientation; null if a
     side is left with fewer than 2 points (that orientation is unusable) */
  function rectStep(pts, m) {
    const { u1, u2 } = rectBasis(m);
    const ns = [u1, [-u1[0], -u1[1]], u2, [-u2[0], -u2[1]]];
    const vals = [[], [], [], []];
    for (const p of pts) {
      const dx = p.x - m.x, dy = p.y - m.y;
      const d1 = dx * u1[0] + dy * u1[1], d2 = dx * u2[0] + dy * u2[1];
      const ad = [d1 - m.length1, -(d1 + m.length1), d2 - m.length2, -(d2 + m.length2)];
      const aa = ad.map(Math.abs);
      let bi = 0;
      for (let i = 1; i < 4; i++) if (aa[i] < aa[bi]) bi = i;
      vals[bi].push(ns[bi][0] * p.x + ns[bi][1] * p.y);
    }
    const a = vals.map(v => (v.length >= 2 ? MetrologyMath.median(v) : null));
    if (a[0] === null || a[1] === null || a[2] === null || a[3] === null) return null;
    const cc1 = (a[0] - a[1]) / 2, cc2 = (a[2] - a[3]) / 2;        // absolute center coords
    const h1 = cc1 - (m.x * u1[0] + m.y * u1[1]);
    const h2 = cc2 - (m.x * u2[0] + m.y * u2[1]);
    return {
      x: m.x + h1 * u1[0] + h2 * u2[0],
      y: m.y + h1 * u1[1] + h2 * u2[1],
      length1: Math.max(1, (a[0] + a[1]) / 2),              // distance of the ±u1 planes
      length2: Math.max(1, (a[2] + a[3]) / 2),
      moved: Math.abs(h1) + Math.abs(h2),
    };
  }

  /* converge center and lengths with phi held fixed; null if no step was usable */
  function fitRectAtPhi(pts, m0, iters) {
    let m = { x: m0.x, y: m0.y, phi: m0.phi, length1: m0.length1, length2: m0.length2 };
    let ok = false;
    for (let it = 0; it < iters; it++) {
      const s = rectStep(pts, m);
      if (!s) break;
      m = { x: s.x, y: s.y, phi: m.phi, length1: s.length1, length2: s.length2 };
      ok = true;
      if (s.moved < 1e-4) break;
    }
    return ok ? m : null;
  }

  /* robust cost of a fit: mean squared residual, each residual capped at
     3 sigma so a few outliers cannot steer the orientation search */
  function rectCost(pts, m) {
    const res = pts.map(p => rectResidual(m, p));
    const cap = Math.max(3 * 1.4826 * MetrologyMath.median(res), 0.05);
    let s = 0;
    for (const r of res) { const c = Math.min(r, cap); s += c * c; }
    return s / pts.length;
  }

  /* Orientation refinement. A moment/PCA seed weighs points, not sides, so a
     perimeter-sampled contour leaves it degrees off; since the side planes
     below keep phi fixed, that tilt spreads the points of every side and
     biases the center. HALCON's fit_rectangle2_contour_xld optimizes Phi too,
     so search it instead. The cost is ~pi/2 periodic (a quarter turn merely
     relabels the sides), so a half-turn window covers all distinct angles. */
  function refineRectPhi(pts, m0) {
    const sample = pts.length > 256
      ? pts.filter((_, i) => i % Math.ceil(pts.length / 256) === 0)
      : pts;
    const cost = phi => {
      const m = fitRectAtPhi(sample, Object.assign({}, m0, { phi }), 3);
      return m ? rectCost(sample, m) : Infinity;
    };
    const span = Math.PI / 2, N = 24;
    let best = m0.phi, bestCost = Infinity;
    for (let i = 0; i <= N; i++) {
      const phi = m0.phi - span / 2 + (span * i) / N;
      const c = cost(phi);
      if (c < bestCost) { bestCost = c; best = phi; }
    }
    if (!Number.isFinite(bestCost)) return null;
    /* golden-section refinement inside the winning bracket */
    const gr = (Math.sqrt(5) - 1) / 2;
    let lo = best - span / N, hi = best + span / N;
    let c1 = hi - gr * (hi - lo), c2 = lo + gr * (hi - lo);
    let f1 = cost(c1), f2 = cost(c2);
    for (let i = 0; i < 20; i++) {
      if (f1 < f2) { hi = c2; c2 = c1; f2 = f1; c1 = hi - gr * (hi - lo); f1 = cost(c1); }
      else { lo = c1; c1 = c2; f1 = f2; c2 = lo + gr * (hi - lo); f2 = cost(c2); }
    }
    const phi = (lo + hi) / 2, c = cost(phi);
    return c < bestCost ? phi : best;
  }

  /* rectangle2: sides keep fixed normals; each side is a plane fitted by the
     median of its assigned points. Lengths follow from the plane distances,
     so truncated measure coverage near corners cannot shrink the result.
     refinePhi searches the orientation (seed / contour fits); a refit of an
     already oriented model keeps its angle and only corrects center/lengths. */
  function fitRectangle(pts, nominal, refinePhi) {
    let m = {
      x: nominal.x !== undefined ? nominal.x : nominal.column,
      y: nominal.y !== undefined ? nominal.y : nominal.row,
      phi: nominal.phi || 0,
      length1: Math.max(1, nominal.length1), length2: Math.max(1, nominal.length2),
    };
    if (refinePhi !== false) {
      const phi = refineRectPhi(pts, m);
      if (phi !== null) m.phi = phi;
    }
    return fitRectAtPhi(pts, m, 4) || m;
  }

  function rectResidual(m, p) {
    const { u1, u2 } = rectBasis(m);
    const dx = p.x - m.x, dy = p.y - m.y;
    const d1 = dx * u1[0] + dy * u1[1], d2 = dx * u2[0] + dy * u2[1];
    // distance to the nearest side segment
    const sides = [
      [d2 - m.length2, d1, m.length1],
      [-(d2 + m.length2), d1, m.length1],
      [d1 - m.length1, d2, m.length2],
      [-(d1 + m.length1), d2, m.length2],
    ];
    let best = Infinity;
    for (const [dist, along, ext] of sides) {
      const over = Math.max(0, Math.abs(along) - ext);
      best = Math.min(best, Math.hypot(Math.abs(dist), over));
    }
    return best;
  }

  /* ---------------- robust instance extraction ---------------- */

  function initialFit(shape, pts, nominal) {
    if (shape === 'line') return fitLineModel(pts);
    if (shape === 'circle') {
      const k = fitCircleKasa(pts);
      return k ? refineCircle(k, pts) : null;
    }
    if (shape === 'ellipse') {
      const k = fitCircleKasa(pts);
      if (!k) return null;
      return fitEllipseLM(pts, [k.x, k.y, Math.max(k.r, 1), Math.max(k.r * 0.9, 0.6), nominal.phi || 0]);
    }
    return fitRectangle(pts, nominal);
  }

  /* refit on an inlier set, starting from the current model where the fit
     supports warm starts (rectangle2 side planes, ellipse LM) */
  function refitFromCurrent(shape, pts, nominal, model) {
    if (shape === 'line') return fitLineModel(pts);
    if (shape === 'circle') {
      const k = fitCircleKasa(pts) || model;
      return refineCircle(k, pts);
    }
    if (shape === 'ellipse') {
      return fitEllipseLM(pts, [model.x, model.y, model.a, model.b, model.phi]) ||
        fitEllipseLM(pts, (() => {
          const k = fitCircleKasa(pts);
          return k ? [k.x, k.y, Math.max(k.r, 1), Math.max(k.r * 0.9, 0.6), nominal.phi || 0] : null;
        })());
    }
    return fitRectangle(pts, model, false);                  // orientation already searched
  }

  /* ---------------- contour fitting (fit_*_contour_xld) ---------------- */

  /* subsample / clip a stored contour {x:[], y:[]} into [{x, y}, ...] */
  function prepareContour(contour, maxNumPoints, clipEnds) {
    let pts = contour.x.map((x, i) => ({ x, y: contour.y[i] }));
    if (clipEnds > 0) pts = pts.slice(clipEnds, Math.max(clipEnds + MIN_POINTS.circle, pts.length - clipEnds));
    if (Number.isFinite(maxNumPoints) && maxNumPoints > 0 && pts.length > maxNumPoints) {
      const stride = pts.length / maxNumPoints;
      const sub = [];
      for (let i = 0; i < maxNumPoints; i++) sub.push(pts[Math.floor(i * stride)]);
      pts = sub;
    }
    return pts;
  }

  /* Tukey-style prune + refit loop over a contour's points (no measure bookkeeping) */
  function fitContour(shape, pts, nominal, iterations, clipFactor) {
    let model = seedFit(shape, pts, nominal);
    if (!model) return null;
    /* tight seed support only where the seed is precise (RANSAC circle/line);
       nominal-seeded fits (rectangle2, ellipse) start from all points */
    let inliers = pts;
    if (shape === 'circle' || shape === 'line') {
      inliers = pts.filter(p => fitResidual(shape, model, p) <= 1.5);
      if (inliers.length < MIN_POINTS[shape]) return null;
    }
    for (let it = 0; it < Math.max(1, iterations); it++) {
      model = refitFromCurrent(shape, inliers, nominal, model) || model;
      const sigma = 1.4826 * MetrologyMath.median(inliers.map(p => fitResidual(shape, model, p)));
      const tol = Math.max(0.5, clipFactor * sigma);
      const next = pts.filter(p => fitResidual(shape, model, p) <= tol);
      if (next.length < MIN_POINTS[shape]) break;
      if (next.length === inliers.length) { inliers = next; break; }
      inliers = next;
    }
    const refined = refitFromCurrent(shape, inliers, nominal, model);
    if (refined) model = refined;
    return { model, inliers };
  }

  /* rectangle2 start guess from a contour: PCA axis + projection extents */
  function rectNominalFromContour(pts) {
    const n = pts.length;
    let mx = 0, my = 0;
    for (const p of pts) { mx += p.x; my += p.y; }
    mx /= n; my /= n;
    let sxx = 0, sxy = 0, syy = 0;
    for (const p of pts) { const dx = p.x - mx, dy = p.y - my; sxx += dx * dx; sxy += dx * dy; syy += dy * dy; }
    const mean = (sxx + syy) / 2, diff = Math.hypot((sxx - syy) / 2, sxy);
    const l1e = mean + diff;
    let ux = sxy, uy = l1e - sxx;
    if (Math.hypot(ux, uy) < 1e-9) { ux = 1; uy = 0; }
    const ul = Math.hypot(ux, uy);
    ux /= ul; uy /= ul;
    const u2 = [-uy, ux];
    let t1min = Infinity, t1max = -Infinity, t2min = Infinity, t2max = -Infinity;
    for (const p of pts) {
      const d1 = (p.x - mx) * ux + (p.y - my) * uy, d2 = (p.x - mx) * u2[0] + (p.y - my) * u2[1];
      if (d1 < t1min) t1min = d1; if (d1 > t1max) t1max = d1;
      if (d2 < t2min) t2min = d2; if (d2 > t2max) t2max = d2;
    }
    const c1 = (t1min + t1max) / 2, c2 = (t2min + t2max) / 2;
    return {
      column: mx + c1 * ux + c2 * u2[0], row: my + c1 * uy + c2 * u2[1],
      phi: Math.atan2(uy, ux),
      length1: Math.max(2, (t1max - t1min) / 2), length2: Math.max(2, (t2max - t2min) / 2),
    };
  }

  /* start/end angle and winding of a contour around (cx, cy) */
  function sweepInfo(pts, cx, cy) {
    const norm = a => {
      while (a > Math.PI) a -= 2 * Math.PI;
      while (a <= -Math.PI) a += 2 * Math.PI;
      return a;
    };
    const a0 = norm(Math.atan2(pts[0].y - cy, pts[0].x - cx));
    let prev = a0, total = 0;
    for (let i = 1; i < pts.length; i++) {
      const a = norm(Math.atan2(pts[i].y - cy, pts[i].x - cx));
      let d = a - prev;
      while (d > Math.PI) d -= 2 * Math.PI;
      while (d < -Math.PI) d += 2 * Math.PI;
      total += d;
      prev = a;
    }
    return { startPhi: a0, endPhi: norm(Math.atan2(pts[pts.length - 1].y - cy, pts[pts.length - 1].x - cx)), order: total >= 0 ? 'positive' : 'negative' };
  }

  /* nominal geometry for a shape from its contour points (fit start guesses) */
  function nominalFromContour(shape, pts) {
    if (shape === 'circle' || shape === 'ellipse') {
      const k = fitCircleKasa(pts);
      if (!k) return null;
      return shape === 'circle'
        ? { row: k.y, column: k.x, radius: k.r }
        : { row: k.y, column: k.x, phi: 0, ra: Math.max(k.r, 1), rb: Math.max(k.r, 0.5) };
    }
    if (shape === 'rectangle2') return rectNominalFromContour(pts);
    return null;                                             // line: not needed
  }

  function fitResidual(shape, m, p) {
    if (shape === 'line') return lineResidual(m, p);
    if (shape === 'circle') return circleResidual(m, p);
    if (shape === 'ellipse') return ellipseResidual(m, p);
    return rectResidual(m, p);
  }

  function paramsOf(shape, m, inlierPts) {
    if (shape === 'line') return lineParams(m, inlierPts);
    if (shape === 'circle') return { row: m.y, column: m.x, radius: m.r };
    if (shape === 'ellipse') return { row: m.y, column: m.x, phi: m.phi, ra: m.a, rb: m.b };
    let phi = m.phi;
    let l1 = m.length1, l2 = m.length2;
    if (l1 < l2) { [l1, l2] = [l2, l1]; phi += Math.PI / 2; }      // HALCON: Length1 >= Length2
    while (phi > Math.PI / 2) phi -= Math.PI;
    while (phi <= -Math.PI / 2) phi += Math.PI;
    return { row: m.y, column: m.x, phi, length1: l1, length2: l2 };
  }

  /* exact circle through 3 points (perpendicular bisectors) */
  function circleFrom3(p1, p2, p3) {
    const ax = (p1.x + p2.x) / 2, ay = (p1.y + p2.y) / 2;
    const ux = -(p2.y - p1.y), uy = p2.x - p1.x;
    const bx = (p2.x + p3.x) / 2, by = (p2.y + p3.y) / 2;
    const vx = -(p3.y - p2.y), vy = p3.x - p2.x;
    const det = ux * vy - uy * vx;
    if (Math.abs(det) < 1e-9) return null;
    const t = ((bx - ax) * vy - (by - ay) * vx) / det;
    const x = ax + t * ux, y = ay + t * uy;
    const r = Math.hypot(p1.x - x, p1.y - y);
    if (!Number.isFinite(r) || r <= 1 || r > 1e5) return null;
    return { x, y, r };
  }

  /* deterministic minimal-sample seeding so parallel edge groups (multiple
     instances) don't collapse into one compromise fit */
  function seedFit(shape, pts, nominal) {
    const n = pts.length;
    if (shape === 'circle' && n >= 3) {
      let best = null, bestSupport = 0;
      const sample = n > 240 ? pts.filter((_, i) => i % Math.ceil(n / 240) === 0) : pts;
      for (const k of [1, 2, 3, 5, 8]) {
        for (let i = 0; i < sample.length; i++) {
          const c = circleFrom3(sample[i], sample[(i + k) % sample.length], sample[(i + 2 * k) % sample.length]);
          if (!c) continue;
          let sup = 0;
          for (const p of pts) if (circleResidual(c, p) <= 1.5) sup++;
          if (sup > bestSupport) { bestSupport = sup; best = c; }
        }
      }
      if (best && bestSupport >= 3) return refineCircle(best, pts.filter(p => circleResidual(best, p) <= 1.5)) || best;
      return initialFit(shape, pts, nominal);
    }
    if (shape === 'line' && n >= 2) {
      let best = null, bestSupport = 0;
      for (let i = 0; i < n; i++) {
        for (const k of [1, 2, 3]) {
          const a = pts[i], b = pts[(i + k * Math.max(1, (n / 8) | 0)) % n];
          const dx = b.x - a.x, dy = b.y - a.y;
          const L = Math.hypot(dx, dy);
          if (L < 1e-6) continue;
          const m = { x: (a.x + b.x) / 2, y: (a.y + b.y) / 2, ux: dx / L, uy: dy / L };
          let sup = 0;
          for (const p of pts) if (lineResidual(m, p) <= 1.0) sup++;
          if (sup > bestSupport) { bestSupport = sup; best = m; }
        }
      }
      if (best && bestSupport >= 2) return best;
    }
    return initialFit(shape, pts, nominal);
  }

  /* fit one instance into pool (array of extracted edge points); returns
     {model, inliers[] (point refs), score} or null */
  function robustFit(shape, pool, nominal, totalMeasures, maxIter) {
    if (pool.length < MIN_POINTS[shape]) return null;
    let model = seedFit(shape, pool, nominal);
    if (!model) return null;
    /* tight seed support only for the precisely-seeded shapes; see fitContour */
    let inliers = (shape === 'circle' || shape === 'line')
      ? pool.filter(p => fitResidual(shape, model, p) <= 1.5)
      : pool.slice();
    if (inliers.length < MIN_POINTS[shape]) return null;
    for (let it = 0; it < Math.max(1, maxIter); it++) {
      model = refitFromCurrent(shape, inliers, nominal, model) || model;
      const sigma = 1.4826 * MetrologyMath.median(inliers.map(p => fitResidual(shape, model, p)));
      const tol = Math.max(1.0, 2.5 * sigma);
      const next = pool.filter(p => fitResidual(shape, model, p) <= tol);
      if (next.length < MIN_POINTS[shape]) break;
      if (next.length === inliers.length) { inliers = next; break; }
      inliers = next;
    }
    const refined = refitFromCurrent(shape, inliers, nominal, model);
    if (refined) model = refined;
    const sigma = 1.4826 * MetrologyMath.median(inliers.map(p => fitResidual(shape, model, p)));
    const tol = Math.max(1.0, 2.5 * sigma);
    const finalInl = pool.filter(p => fitResidual(shape, model, p) <= tol);
    if (finalInl.length >= MIN_POINTS[shape]) inliers = finalInl;
    const score = uniqueMeasures(inliers) / Math.max(1, totalMeasures);
    return { model, inliers, score };
  }

  function uniqueMeasures(pts) {
    return new Set(pts.map(p => p.mi)).size;
  }

  /* ---------------- apply: measure + fit one object ---------------- */

  function applyObject(obj, gray, W, H) {
    refreshMeasures(obj);
    extractEdges(obj.measures, obj.params, gray, W, H);
    const pool = [];
    obj.measures.forEach((m, mi) => {
      if (!m.edge) return;
      const list = Array.isArray(m.edge) ? m.edge : [m.edge];
      for (const e of list) {
        pool.push({ x: m.cx + m.nx * e.off, y: m.cy + m.ny * e.off, mi, mag: e.mag });
      }
    });
    obj.instances = [];
    let remaining = pool.slice();
    for (let k = 0; k < obj.params.num_instances; k++) {
      const inst = robustFit(obj.shape, remaining, obj.geom, obj.measures.length, obj.params.max_iterations);
      if (!inst || inst.score < obj.params.min_score) break;
      obj.instances.push(Object.assign({ score: inst.score, points: inst.inliers }, paramsOf(obj.shape, inst.model, inst.inliers)));
      const used = new Set(inst.inliers);
      remaining = remaining.filter(p => !used.has(p));
      if (remaining.length < MIN_POINTS[obj.shape]) break;
    }
    return obj;
  }

  function applyModel(model, gray, W, H) {
    for (const obj of model.objects.values()) applyObject(obj, gray, W, H);
    return model;
  }

  /* ---------------- results ---------------- */

  const RESULT_TYPES = {
    circle: ['row', 'column', 'radius'],
    ellipse: ['row', 'column', 'phi', 'ra', 'rb'],
    line: ['rowBegin', 'columnBegin', 'rowEnd', 'columnEnd'],
    rectangle2: ['row', 'column', 'phi', 'length1', 'length2'],
  };

  /* result values of one instance for one requested type (always an array) */
  function resultValue(obj, inst, type) {
    if (type === 'score') return [inst.score];
    const keys = RESULT_TYPES[obj.shape];
    if (type === 'all_param') return keys.map(k => inst[k]);
    const k = { row_begin: 'rowBegin', column_begin: 'columnBegin', row_end: 'rowEnd', column_end: 'columnEnd' }[type] || type;
    if (!keys.includes(k)) throw new Error(`result_type '${type}' is not available for ${obj.shape} objects`);
    return [inst[k]];
  }

  /* HDevelop: the measure regions are returned whose last apply produced an
     edge of the requested transition (direction), not merely any edge.  mags
     carries the edge amplitude (get_metrology_object_result 'used_edges'). */
  function measuresOf(obj, transition) {
    const rows = [], cols = [], mags = [];
    const want = transition === 'positive' ? 1 : -1;
    for (const m of obj.measures) {
      const list = m.edge ? (Array.isArray(m.edge) ? m.edge : [m.edge]) : [];
      for (const e of list) {
        if (transition !== 'all' && e.sign !== want) continue;
        rows.push(m.cy + m.ny * e.off);
        cols.push(m.cx + m.nx * e.off);
        mags.push(e.mag);
      }
    }
    return { rows, cols, mags };
  }

  /* The boundary of every measure region as a closed rectangular contour — the
     iconic output of get_metrology_object_measures.  HALCON returns one
     rectangle per measure region of half sizes MeasureLength1 (perpendicular to
     the contour) and MeasureLength2 (tangential); they belong to the model, so
     they are available before apply_metrology_model. */
  function measureRegionContours(obj) {
    const L1 = Math.max(1, obj.params.measure_length1);
    const L2 = Math.max(1, obj.params.measure_length2);
    return obj.measures.map(m => {
      const tx = -m.ny, ty = m.nx;                       // tangent direction
      const corner = (a, b) => [m.cx + m.nx * a + tx * b, m.cy + m.ny * a + ty * b];
      const pts = [corner(-L1, -L2), corner(L1, -L2), corner(L1, L2), corner(-L1, L2), corner(-L1, -L2)];
      return { x: pts.map(p => p[0]), y: pts.map(p => p[1]) };
    });
  }

  return {
    PARAM_DEFAULTS, SHAPES, models,
    createModel, getModel, addObject, setParam, getParam, resetParam, resetParams, reset,
    copyModel, removeObjects, selectObjects, applyModel, applyObject,
    resultValue, measuresOf, measureRegionContours, RESULT_TYPES,
    /* contour fitting (fit_*_contour_xld) */
    prepareContour, fitContour, nominalFromContour, sweepInfo, lineParams, paramsOf,
    /* low-level, exposed for tests */
    _fit: { fitLineModel, fitCircleKasa, refineCircle, fitEllipseLM, fitRectangle },
  };
})();

/* ==========================================================================
   IDE glue: argument evaluation, canvas overlays, operator implementations
   ========================================================================== */

const MetrologyUI = (() => {

  /* split a comma list while respecting quotes */
  function splitList(s) {
    const out = [];
    let cur = '', q = false;
    for (const ch of s) {
      if (ch === "'") q = !q;
      if (ch === ',' && !q) { out.push(cur); cur = ''; }
      else cur += ch;
    }
    if (cur.trim() !== '' || out.length) out.push(cur);
    return out;
  }

  /* ---- HALCON number expressions ------------------------------------------
     A numeric argument is written the way HDevelop writes it: a literal, a
     control variable, an element of a control tuple, or an expression built
     from them with the mathematical intrinsics:

       128   '128'   Height   Width/2   Radius[0]   Height*0.5   rad(360)
       deg(1.5708)   max(Length1, Length2)   abs(dx)   PI

     The expression is parsed here (no eval / Function), so anything that is
     not an expression — a file name, an object name — simply yields the
     caller's fallback value. */
  const EXPR_FUNCS = {
    rad: a => a[0] * Math.PI / 180, deg: a => a[0] * 180 / Math.PI,
    abs: a => Math.abs(a[0]), fabs: a => Math.abs(a[0]),
    ceil: a => Math.ceil(a[0]), floor: a => Math.floor(a[0]),
    round: a => Math.round(a[0]), int: a => Math.trunc(a[0]), trunc: a => Math.trunc(a[0]),
    sqrt: a => Math.sqrt(a[0]), exp: a => Math.exp(a[0]),
    log: a => Math.log(a[0]), lg: a => Math.log10(a[0]), log10: a => Math.log10(a[0]),
    sin: a => Math.sin(a[0]), cos: a => Math.cos(a[0]), tan: a => Math.tan(a[0]),
    asin: a => Math.asin(a[0]), acos: a => Math.acos(a[0]), atan: a => Math.atan(a[0]),
    atan2: a => Math.atan2(a[0], a[1]),
    min: a => Math.min(...a), max: a => Math.max(...a), pow: a => Math.pow(a[0], a[1]),
  };
  const EXPR_CONSTS = { pi: Math.PI, e: Math.E, m_pi: Math.PI };

  function parseNumberExpr(src, resolve) {
    const s = String(src);
    let i = 0;
    const ws = () => { while (i < s.length && /\s/.test(s[i])) i++; };
    const fail = msg => { throw new Error(`${msg} at '${s.slice(i, i + 8)}'`); };

    function expr() {                        // + -
      let v = term();
      for (;;) {
        ws();
        if (s[i] === '+') { i++; v += term(); }
        else if (s[i] === '-') { i++; v -= term(); }
        else return v;
      }
    }
    function term() {                        // * / %
      let v = unary();
      for (;;) {
        ws();
        if (s[i] === '*') { i++; v *= unary(); }
        else if (s[i] === '/') { i++; v /= unary(); }
        else if (s[i] === '%') { i++; v %= unary(); }
        else return v;
      }
    }
    function unary() {
      ws();
      if (s[i] === '-') { i++; return -unary(); }
      if (s[i] === '+') { i++; return unary(); }
      return atom();
    }
    function atom() {
      ws();
      if (s[i] === '(') { i++; const v = expr(); ws(); if (s[i] !== ')') fail("missing ')'"); i++; return v; }
      const num = /^(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?/.exec(s.slice(i));
      if (num) { i += num[0].length; return parseFloat(num[0]); }
      const id = /^[A-Za-z_][A-Za-z0-9_]*/.exec(s.slice(i));
      if (!id) fail('unexpected input');
      i += id[0].length;
      ws();
      if (s[i] === '(') {                    // intrinsic: rad(360), max(a, b) …
        i++;
        const argv = [];
        ws();
        if (s[i] !== ')') for (;;) {
          argv.push(expr()); ws();
          if (s[i] === ',') { i++; continue; }
          break;
        }
        ws();
        if (s[i] !== ')') fail("missing ')'");
        i++;
        const f = EXPR_FUNCS[id[0].toLowerCase()];
        if (!f) throw new Error(`unknown function '${id[0]}'`);
        return f(argv);
      }
      if (s[i] === '[') {                    // tuple element: Radius[0]
        i++;
        const k = expr();
        ws();
        if (s[i] !== ']') fail("missing ']'");
        i++;
        return resolve(id[0], k);
      }
      return resolve(id[0], null);
    }

    const v = expr();
    ws();
    if (i < s.length) fail('unexpected input');
    return v;
  }

  /* control variable -> number (element of a tuple when an index is given) */
  function ctrlNumber(ctx, name, idx) {
    const v = ctx && ctx.ctrl ? ctx.ctrl(name) : undefined;
    if (v === undefined) {
      const k = EXPR_CONSTS[name.toLowerCase()];
      if (k !== undefined) return k;
      throw new Error(`unknown control variable '${name}'`);
    }
    if (typeof v === 'number') return v;
    const parts = String(v).replace(/^\[|\]$/g, '').split(',').map(x => parseFloat(x));
    const k = idx === null ? 0 : Math.round(idx);
    if (Number.isFinite(parts[k])) return parts[k];
    throw new Error(`'${name}' has no numeric element ${k}`);
  }

  /* number from: control variable (or tuple element), 'quoted' number, literal
     or any HALCON expression over them ('640/2', 'Height*0.5', 'rad(360)') */
  function numVal(tok, ctx, fallback) {
    const t = String(tok === undefined ? '' : tok).trim();
    if (!t) return fallback;
    const v = ctx && ctx.ctrl ? ctx.ctrl(t) : undefined;
    if (typeof v === 'number') return v;
    if (typeof v === 'string') {
      const n = parseFloat(v.replace(/^\[|\]$/g, '').split(',')[0]);
      return Number.isFinite(n) ? n : fallback;
    }
    const q = t.match(/^'(.*)'$/s);
    if (q) { const n = parseFloat(q[1]); return Number.isFinite(n) ? n : fallback; }
    try {
      const n = parseNumberExpr(t, (name, idx) => ctrlNumber(ctx, name, idx));
      return Number.isFinite(n) ? n : fallback;
    } catch (e) { return fallback; }
  }

  /* string from: 'quoted' or control variable; [] is HALCON's "use the default
     value" and only has that meaning when the caller names a default */
  function strVal(tok, ctx, fallback) {
    const t = String(tok === undefined ? '' : tok).trim();
    const q = t.match(/^'(.*)'$/s);
    if (q) return q[1];
    const v = ctx.ctrl(t);
    if (typeof v === 'string') return v.replace(/^'|'$/g, '');
    if (t === '[]' || t === "''") return fallback;
    return t || fallback;
  }

  /* HALCON generic parameter lists: 'name', 42, ['a','b'], [1, 2] */
  function listVal(tok, ctx) {
    const t = String(tok === undefined ? '' : tok).trim();
    if (!t || t === '[]' || t === "''") return [];
    const inner = t.startsWith('[') && t.endsWith(']') ? t.slice(1, -1) : t;
    return splitList(inner).map(s => {
      s = s.trim();
      const q = s.match(/^'(.*)'$/s);
      if (q) return q[1];
      if (s !== '' && !isNaN(+s)) return +s;
      const v = ctx.ctrl(s);
      return v === undefined ? s : v;
    });
  }

  /* Object index/instance: an integer, 'all', or [] — HALCON's way of writing
     "use the documented default value" for an input control parameter. */
  function indexVal(tok, ctx, fallback = 'all') {
    const t = String(tok === undefined ? '' : tok).trim();
    if (!t || t === '[]' || t === "''") return fallback;
    if (/^'all'$/i.test(t) || /^all$/i.test(t)) return 'all';
    const v = numVal(t, ctx, NaN);
    if (!Number.isFinite(v)) throw new Error(`invalid index '${t}' (expected an integer or 'all')`);
    return Math.round(v);
  }

  const fmt = v => {
    const r = Math.round(v * 1000) / 1000;
    return Object.is(r, -0) ? 0 : r;
  };

  const tupleStr = vals => `[${vals.map(v => (typeof v === 'number' ? fmt(v) : String(v))).join(', ')}]`;

  function defTuple(ctx, name, vals, kind) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name || '')) return;
    if (vals.length === 1 && kind === 'number') ctx.defCtrl(name, fmt(vals[0]), Number.isInteger(vals[0]) ? 'integer' : 'real');
    else if (vals.length === 1 && kind === 'string') ctx.defCtrl(name, String(vals[0]), 'string');
    else ctx.defCtrl(name, tupleStr(vals), `${kind} tuple (${vals.length})`);
  }

  /* handle -> model */
  function modelOf(args, i, ctx) {
    const h = numVal(args[i], ctx, NaN);
    return MetrologyCore.getModel(h);
  }

  function applyGenParams(obj, names, values) {
    for (let i = 0; i < names.length; i++) {
      MetrologyCore.setParam(obj, String(names[i]), values[i] === undefined ? '' : values[i]);
    }
  }

  /* ---------------- overlays ---------------- */

  /* points of an instance's contour. With dist > 0 the sampling follows the
     HDevelop sampling argument of get_metrology_object_*_contour ('Distance'
     for the model contour, 'Resolution' for the result contour — both are the
     distance between successive contour points); otherwise a fixed, dense
     sampling is used for display. */
  function contourPoints(obj, inst, dist) {
    const pts = [];
    const push = (x, y) => pts.push([x, y]);
    const d = dist > 0 ? dist : 0;
    const segs = perim => d ? Math.min(4000, Math.max(8, Math.round(perim / d))) : 72;
    if (obj.shape === 'circle') {
      const n = segs(2 * Math.PI * inst.radius);
      for (let i = 0; i <= n; i++) {
        const t = (2 * Math.PI * i) / n;
        push(inst.column + inst.radius * Math.cos(t), inst.row + inst.radius * Math.sin(t));
      }
    } else if (obj.shape === 'ellipse') {
      const n = segs(Math.PI * (3 * (inst.ra + inst.rb) - Math.sqrt((3 * inst.ra + inst.rb) * (inst.ra + 3 * inst.rb))));
      const cp = Math.cos(inst.phi), sp = Math.sin(inst.phi);
      for (let i = 0; i <= n; i++) {
        const t = (2 * Math.PI * i) / n;
        const ex = inst.ra * Math.cos(t), ey = inst.rb * Math.sin(t);
        push(inst.column + ex * cp - ey * sp, inst.row + ex * sp + ey * cp);
      }
    } else if (obj.shape === 'line') {
      const L = Math.hypot(inst.columnEnd - inst.columnBegin, inst.rowEnd - inst.rowBegin);
      const n = d ? Math.max(2, Math.round(L / d)) : 1;
      for (let i = 0; i <= n; i++) {
        const t = i / n;
        push(inst.columnBegin + (inst.columnEnd - inst.columnBegin) * t,
             inst.rowBegin + (inst.rowEnd - inst.rowBegin) * t);
      }
    } else {
      const cp = Math.cos(inst.phi), sp = Math.sin(inst.phi);
      const u1 = [cp, sp], u2 = [-sp, cp];
      const c = [inst.column, inst.row];
      const corner = (s1, s2) => push(c[0] + u1[0] * s1 * inst.length1 + u2[0] * s2 * inst.length2,
                                      c[1] + u1[1] * s1 * inst.length1 + u2[1] * s2 * inst.length2);
      if (!d) { corner(1, 1); corner(-1, 1); corner(-1, -1); corner(1, -1); corner(1, 1); }
      else {                                                 // walk the perimeter in order
        const sides = [[1, 1, -1, 1], [-1, 1, -1, -1], [-1, -1, 1, -1], [1, -1, 1, 1]];
        for (const [s1a, s2a, s1b, s2b] of sides) {
          const len = Math.hypot((s1b - s1a) * inst.length1, (s2b - s2a) * inst.length2);
          const n = Math.max(1, Math.round(len / d));
          for (let i = 0; i < n; i++) {
            const t = i / n;
            const a = (1 - t) * s1a + t * s1b, b = (1 - t) * s2a + t * s2b;
            corner(a, b);
          }
        }
        corner(1, 1);
      }
    }
    return pts;
  }

  function nominalContour(obj, dist) {
    return contourPoints(obj, {
      row: obj.geom.row, column: obj.geom.column, radius: obj.geom.radius,
      phi: obj.geom.phi, ra: obj.geom.ra, rb: obj.geom.rb,
      length1: obj.geom.length1, length2: obj.geom.length2,
      rowBegin: obj.geom.rowBegin, columnBegin: obj.geom.columnBegin,
      rowEnd: obj.geom.rowEnd, columnEnd: obj.geom.columnEnd,
    }, dist);
  }

  function newCanvas(W, H) {
    const c = document.createElement('canvas');
    c.width = W; c.height = H;
    return c;
  }

  /* full metrology visualization: measure regions, edges, fitted contours */
  function buildOverlay(model, W, H) {
    const c = newCanvas(W, H);
    const g = c.getContext('2d');
    for (const obj of model.objects.values()) {
      for (const m of obj.measures) {
        const L1 = obj.params.measure_length1, L2 = obj.params.measure_length2;
        const tx = -m.ny, ty = m.nx;                        // tangent
        g.save();
        g.translate(m.cx, m.cy);
        g.rotate(Math.atan2(ty, tx));
        g.strokeStyle = m.edge ? 'rgba(255,209,102,0.7)' : 'rgba(255,209,102,0.25)';
        g.lineWidth = 1;
        /* rotated frame: local x runs along the tangent, local y across the
           contour, so the rectangle spans +/-MeasureLength2 tangentially and
           +/-MeasureLength1 perpendicular to the boundary (HALCON) */
        g.strokeRect(-L2, -L1, 2 * L2, 2 * L1);
        g.restore();
        if (m.edge) {
          const list = Array.isArray(m.edge) ? m.edge : [m.edge];
          for (const e of list) {
            const x = m.cx + m.nx * e.off, y = m.cy + m.ny * e.off;
            g.strokeStyle = 'rgba(77,195,255,0.95)';
            g.lineWidth = 1;
            g.beginPath();
            g.moveTo(x - 3, y); g.lineTo(x + 3, y);
            g.moveTo(x, y - 3); g.lineTo(x, y + 3);
            g.stroke();
          }
        }
      }
      const used = new Set();
      for (const inst of obj.instances) for (const p of inst.points) used.add(p.mi);
      for (const inst of obj.instances) {
        const pts = contourPoints(obj, inst);
        g.strokeStyle = 'rgba(88,220,120,0.95)';
        g.lineWidth = 1.6;
        g.beginPath();
        pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
        g.stroke();
        const cxp = inst.column !== undefined ? inst.column : (inst.columnBegin + inst.columnEnd) / 2;
        const cyp = inst.row !== undefined ? inst.row : (inst.rowBegin + inst.rowEnd) / 2;
        g.strokeStyle = 'rgba(88,220,120,1)';
        g.beginPath();
        g.moveTo(cxp - 6, cyp); g.lineTo(cxp + 6, cyp);
        g.moveTo(cxp, cyp - 6); g.lineTo(cxp, cyp + 6);
        g.stroke();
        g.fillStyle = 'rgba(88,220,120,1)';
        g.font = '11px sans-serif';
        g.fillText(`${obj.index}:${(inst.score * 100).toFixed(0)}%`, cxp + 8, cyp - 8);
      }
      if (!obj.instances.length) {                          // nothing fitted: show the nominal contour
        const pts = nominalContour(obj);
        g.strokeStyle = 'rgba(239,83,80,0.55)';
        g.lineWidth = 1.2;
        g.setLineDash([5, 4]);
        g.beginPath();
        pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
        g.stroke();
        g.setLineDash([]);
      } else {
        obj.measures.forEach((m, mi) => {
          if (used.has(mi) || !m.edge) return;
          const list = Array.isArray(m.edge) ? m.edge : [m.edge];
          for (const e of list) {
            const x = m.cx + m.nx * e.off, y = m.cy + m.ny * e.off;
            g.strokeStyle = 'rgba(239,83,80,0.9)';
            g.beginPath();
            g.moveTo(x - 2.5, y - 2.5); g.lineTo(x + 2.5, y + 2.5);
            g.moveTo(x + 2.5, y - 2.5); g.lineTo(x - 2.5, y + 2.5);
            g.stroke();
          }
        });
      }
    }
    return c;
  }

  /* XLD-style canvas holding only the fitted contours; data = point lists */
  function buildContours(model, objects, W, H) {
    const c = newCanvas(W, H);
    const g = c.getContext('2d');
    let n = 0;
    const data = [];
    for (const obj of objects) {
      for (const inst of obj.instances) {
        n++;
        const pts = contourPoints(obj, inst);
        data.push({ x: pts.map(p => p[0]), y: pts.map(p => p[1]) });
        g.strokeStyle = 'rgba(88,220,120,0.95)';
        g.lineWidth = 1.6;
        g.beginPath();
        pts.forEach(([x, y], i) => i ? g.lineTo(x, y) : g.moveTo(x, y));
        g.stroke();
      }
    }
    return { canvas: c, count: n, data };
  }

  /* define an iconic XLD variable from a list of contours {x:[], y:[]} */
  function defineXld(ctx, name, contours, W, H) {
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name || '')) return;
    const c = newCanvas(W, H);
    const g = c.getContext('2d');
    g.strokeStyle = 'rgba(88,220,120,0.95)';
    g.lineWidth = 1.6;
    for (const cont of contours) {
      g.beginPath();
      for (let i = 0; i < cont.x.length; i++) i ? g.lineTo(cont.x[i], cont.y[i]) : g.moveTo(cont.x[i], cont.y[i]);
      g.stroke();
    }
    ctx.defIconic(name, {
      kind: 'xld', type: `XLD contours (${contours.length})`, canvas: c,
      xld: contours, contours: contours.length, dispose() {},
    });
  }

  return { splitList, numVal, strVal, listVal, indexVal, fmt, tupleStr, defTuple, modelOf, applyGenParams,
           buildOverlay, buildContours, defineXld, contourPoints, nominalContour };
})();

/* dimensions of the last image an apply ran on, per model (for XLD canvas size) */
const lastApplyDims = new Map();

/* ==========================================================================
   operator implementations (args = raw parsed tokens, ctx from app.js)
   ========================================================================== */
const METROLOGY_OP_IMPLS = {

  create_metrology_model(args, ctx) {
    const m = MetrologyCore.createModel();
    ctx.defCtrl(args[0], m.handle, 'integer');
    ctx.log(`create_metrology_model: empty model created (handle ${m.handle}).`);
  },

  add_metrology_object_circle_measure(args, ctx) {
    const m = MetrologyUI.modelOf(args, 0, ctx);
    const geom = {
      row: MetrologyUI.numVal(args[1], ctx, NaN), column: MetrologyUI.numVal(args[2], ctx, NaN),
      radius: MetrologyUI.numVal(args[3], ctx, NaN),
    };
    const idx = MetrologyCore.addObject(m, 'circle', geom, {
      measure_length1: MetrologyUI.numVal(args[4], ctx, 20),
      measure_length2: MetrologyUI.numVal(args[5], ctx, 5),
      measure_sigma: MetrologyUI.numVal(args[6], ctx, 1),
      measure_threshold: MetrologyUI.numVal(args[7], ctx, 30),
    });
    MetrologyUI.applyGenParams(m.objects.get(idx), MetrologyUI.listVal(args[8], ctx), MetrologyUI.listVal(args[9], ctx));
    ctx.defCtrl(args[10], idx, 'integer');
    ctx.log(`add_metrology_object_circle_measure: circle object ${idx} added (center approx ${MetrologyUI.fmt(geom.row)}/${MetrologyUI.fmt(geom.column)}, r approx ${MetrologyUI.fmt(geom.radius)}).`);
  },

  add_metrology_object_ellipse_measure(args, ctx) {
    const m = MetrologyUI.modelOf(args, 0, ctx);
    const geom = {
      row: MetrologyUI.numVal(args[1], ctx, NaN), column: MetrologyUI.numVal(args[2], ctx, NaN),
      phi: MetrologyUI.numVal(args[3], ctx, 0),
      ra: MetrologyUI.numVal(args[4], ctx, NaN), rb: MetrologyUI.numVal(args[5], ctx, NaN),
    };
    const idx = MetrologyCore.addObject(m, 'ellipse', geom, {
      measure_length1: MetrologyUI.numVal(args[6], ctx, 20),
      measure_length2: MetrologyUI.numVal(args[7], ctx, 5),
      measure_sigma: MetrologyUI.numVal(args[8], ctx, 1),
      measure_threshold: MetrologyUI.numVal(args[9], ctx, 30),
    });
    MetrologyUI.applyGenParams(m.objects.get(idx), MetrologyUI.listVal(args[10], ctx), MetrologyUI.listVal(args[11], ctx));
    ctx.defCtrl(args[12], idx, 'integer');
    ctx.log(`add_metrology_object_ellipse_measure: ellipse object ${idx} added (center approx ${MetrologyUI.fmt(geom.row)}/${MetrologyUI.fmt(geom.column)}, ra/rb approx ${MetrologyUI.fmt(geom.ra)}/${MetrologyUI.fmt(geom.rb)}).`);
  },

  add_metrology_object_line_measure(args, ctx) {
    const m = MetrologyUI.modelOf(args, 0, ctx);
    const geom = {
      rowBegin: MetrologyUI.numVal(args[1], ctx, NaN), columnBegin: MetrologyUI.numVal(args[2], ctx, NaN),
      rowEnd: MetrologyUI.numVal(args[3], ctx, NaN), columnEnd: MetrologyUI.numVal(args[4], ctx, NaN),
    };
    const idx = MetrologyCore.addObject(m, 'line', geom, {
      measure_length1: MetrologyUI.numVal(args[5], ctx, 20),
      measure_length2: MetrologyUI.numVal(args[6], ctx, 5),
      measure_sigma: MetrologyUI.numVal(args[7], ctx, 1),
      measure_threshold: MetrologyUI.numVal(args[8], ctx, 30),
    });
    MetrologyUI.applyGenParams(m.objects.get(idx), MetrologyUI.listVal(args[9], ctx), MetrologyUI.listVal(args[10], ctx));
    ctx.defCtrl(args[11], idx, 'integer');
    ctx.log(`add_metrology_object_line_measure: line object ${idx} added (from ${MetrologyUI.fmt(geom.rowBegin)}/${MetrologyUI.fmt(geom.columnBegin)} to ${MetrologyUI.fmt(geom.rowEnd)}/${MetrologyUI.fmt(geom.columnEnd)}).`);
  },

  /* HDevelop:
       add_metrology_object_rectangle2_measure (MetrologyHandle, Row, Column, Phi,
         Length1, Length2, MeasureLength1, MeasureLength2, MeasureSigma,
         MeasureThreshold, GenParamName, GenParamValue : Index)
     Earlier revisions of this demo omitted the two measure lengths (11 instead of
     13 arguments); that form is still accepted and uses the defaults. */
  add_metrology_object_rectangle2_measure(args, ctx) {
    const m = MetrologyUI.modelOf(args, 0, ctx);
    const hdev = args.length >= 13;
    const geom = {
      row: MetrologyUI.numVal(args[1], ctx, NaN), column: MetrologyUI.numVal(args[2], ctx, NaN),
      phi: MetrologyUI.numVal(args[3], ctx, 0),
      length1: MetrologyUI.numVal(args[4], ctx, NaN), length2: MetrologyUI.numVal(args[5], ctx, NaN),
    };
    const idx = MetrologyCore.addObject(m, 'rectangle2', geom, hdev
      ? {
        measure_length1: MetrologyUI.numVal(args[6], ctx, 20),
        measure_length2: MetrologyUI.numVal(args[7], ctx, 5),
        measure_sigma: MetrologyUI.numVal(args[8], ctx, 1),
        measure_threshold: MetrologyUI.numVal(args[9], ctx, 30),
      }
      : {
        measure_sigma: MetrologyUI.numVal(args[6], ctx, 1),
        measure_threshold: MetrologyUI.numVal(args[7], ctx, 30),
      });
    const genAt = hdev ? 10 : 8;
    MetrologyUI.applyGenParams(m.objects.get(idx), MetrologyUI.listVal(args[genAt], ctx), MetrologyUI.listVal(args[genAt + 1], ctx));
    ctx.defCtrl(args[genAt + 2], idx, 'integer');
    ctx.log(`add_metrology_object_rectangle2_measure: rectangle2 object ${idx} added (center approx ${MetrologyUI.fmt(geom.row)}/${MetrologyUI.fmt(geom.column)}, l1/l2 approx ${MetrologyUI.fmt(geom.length1)}/${MetrologyUI.fmt(geom.length2)}, phi ${MetrologyUI.fmt(geom.phi)}).`);
  },

  /* HDevelop:
       add_metrology_object_generic (MetrologyHandle, Shape, ShapeParam,
         MeasureLength1, MeasureLength2, MeasureSigma, MeasureThreshold,
         GenParamName, GenParamValue : Index)
     Shape may be a tuple; ShapeParam then holds the parameters of all shapes
     concatenated, as in HDevelop:
       'circle'     [Row, Column, Radius]
       'ellipse'    [Row, Column, Phi, Radius1, Radius2]
       'line'       [RowBegin, ColumnBegin, RowEnd, ColumnEnd]
       'rectangle2' [Row, Column, Phi, Length1, Length2]
     Earlier revisions of this demo used (MetrologyHandle, Shape, Rows, Cols,
     Phi, Length1, Length2, MeasureSigma, MeasureThreshold, GenParamName,
     GenParamValue : Index); that 12-argument form is still accepted. */
  add_metrology_object_generic(args, ctx) {
    const m = MetrologyUI.modelOf(args, 0, ctx);
    if (args.length >= 12) {
      const shape = MetrologyUI.strVal(args[1], ctx, '').toLowerCase();
      const rows = MetrologyUI.listVal(args[2], ctx), cols = MetrologyUI.listVal(args[3], ctx);
      const phi = MetrologyUI.numVal(args[4], ctx, 0);
      const l1 = MetrologyUI.numVal(args[5], ctx, NaN), l2 = MetrologyUI.numVal(args[6], ctx, NaN);
      const geom = shape === 'line'
        ? { rowBegin: rows[0], columnBegin: cols[0], rowEnd: rows[1], columnEnd: cols[1] }
        : shape === 'circle'
          ? { row: rows[0], column: cols[0], radius: l1 }
          : shape === 'ellipse'
            ? { row: rows[0], column: cols[0], phi, ra: l1, rb: l2 }
            : { row: rows[0], column: cols[0], phi, length1: l1, length2: l2 };
      const idx = MetrologyCore.addObject(m, shape, geom, {
        measure_sigma: MetrologyUI.numVal(args[7], ctx, 1),
        measure_threshold: MetrologyUI.numVal(args[8], ctx, 30),
      });
      MetrologyUI.applyGenParams(m.objects.get(idx), MetrologyUI.listVal(args[9], ctx), MetrologyUI.listVal(args[10], ctx));
      ctx.defCtrl(args[11], idx, 'integer');
      ctx.log(`add_metrology_object_generic: ${shape} object ${idx} added.`);
      return;
    }
    const ARITY = { circle: 3, ellipse: 5, line: 4, rectangle2: 5 };
    const shapes = MetrologyUI.listVal(args[1], ctx).map(s => String(s).toLowerCase());
    const sp = MetrologyUI.listVal(args[2], ctx).map(Number);
    const params = {
      measure_length1: MetrologyUI.numVal(args[3], ctx, 20),
      measure_length2: MetrologyUI.numVal(args[4], ctx, 5),
      measure_sigma: MetrologyUI.numVal(args[5], ctx, 1),
      measure_threshold: MetrologyUI.numVal(args[6], ctx, 30),
    };
    const genNames = MetrologyUI.listVal(args[7], ctx), genValues = MetrologyUI.listVal(args[8], ctx);
    const indices = [];
    let at = 0;
    for (const shape of shapes.length ? shapes : ['circle']) {
      const n = ARITY[shape];
      if (!n) throw new Error(`add_metrology_object_generic: unsupported Shape '${shape}'`);
      const p = sp.slice(at, at + n);
      at += n;
      if (p.length < n || !p.every(Number.isFinite)) {
        throw new Error(`add_metrology_object_generic: ShapeParam must supply ${n} value(s) for '${shape}'`);
      }
      const geom = shape === 'circle' ? { row: p[0], column: p[1], radius: p[2] }
        : shape === 'line' ? { rowBegin: p[0], columnBegin: p[1], rowEnd: p[2], columnEnd: p[3] }
          : shape === 'ellipse' ? { row: p[0], column: p[1], phi: p[2], ra: p[3], rb: p[4] }
            : { row: p[0], column: p[1], phi: p[2], length1: p[3], length2: p[4] };
      const idx = MetrologyCore.addObject(m, shape, geom, params);
      MetrologyUI.applyGenParams(m.objects.get(idx), genNames, genValues);
      indices.push(idx);
    }
    if (at !== sp.length) {
      ctx.log(`add_metrology_object_generic: ${sp.length - at} surplus ShapeParam value(s) ignored.`, 'warn');
    }
    MetrologyUI.defTuple(ctx, args[9], indices, 'integer');
    ctx.log(`add_metrology_object_generic: object(s) ${indices.join(', ')} added as ${shapes.join(', ')}.`);
  },

  set_metrology_object_param(args, ctx) {
    const m = MetrologyUI.modelOf(args, 0, ctx);
    const sel = MetrologyUI.indexVal(args[1], ctx);
    const names = MetrologyUI.listVal(args[2], ctx).map(String);
    const values = MetrologyUI.listVal(args[3], ctx);
    for (const obj of MetrologyCore.selectObjects(m, sel)) {
      for (let i = 0; i < names.length; i++) {
        MetrologyCore.setParam(obj, names[i], values[i] === undefined ? '' : values[i]);
      }
    }
    ctx.log(`set_metrology_object_param: object(s) ${sel === 'all' ? 'all' : sel} updated (${names.join(', ')}).`);
  },

  get_metrology_object_param(args, ctx) {
    const m = MetrologyUI.modelOf(args, 0, ctx);
    const sel = MetrologyUI.indexVal(args[1], ctx);
    const names = MetrologyUI.listVal(args[2], ctx).map(String);
    if (!names.length) throw new Error('get_metrology_object_param: no parameter name given');
    const out = [];
    for (const name of names) {
      for (const obj of MetrologyCore.selectObjects(m, sel)) {
        const v = MetrologyCore.getParam(obj, name);
        if (v === null || v === undefined) throw new Error(`get_metrology_object_param: parameter '${name}' is not set`);
        out.push(v);
      }
    }
    if (out.length === 1 && typeof out[0] === 'number') {
      ctx.defCtrl(args[3], MetrologyUI.fmt(out[0]), Number.isInteger(out[0]) ? 'integer' : 'real');
    } else {
      ctx.defCtrl(args[3], MetrologyUI.tupleStr(out), `tuple (${out.length})`);
    }
  },

  set_metrology_model_param(args, ctx) {
    const m = MetrologyUI.modelOf(args, 0, ctx);
    const names = MetrologyUI.listVal(args[1], ctx).map(String);
    const values = MetrologyUI.listVal(args[2], ctx);
    for (let i = 0; i < names.length; i++) {
      const name = names[i];
      if (name !== 'camera_param' && name !== 'plane_pose') {
        throw new Error(`set_metrology_model_param: unsupported model parameter '${name}'`);
      }
      m.modelParams[name] = values[i];
    }
    ctx.log(`set_metrology_model_param: 2-D mode — '${names.join(', ')}' stored but not applied (image-plane metrology).`, 'warn');
  },

  get_metrology_model_param(args, ctx) {
    const m = MetrologyUI.modelOf(args, 0, ctx);
    const names = MetrologyUI.listVal(args[1], ctx).map(String);
    if (!names.length) throw new Error('get_metrology_model_param: no parameter name given');
    const out = [];
    for (const name of names) {
      if (name === 'image_size') {                           // extension: the size set via set_metrology_model_image_size
        if (m.imageSize) out.push(m.imageSize.W, m.imageSize.H);
        continue;
      }
      if (name !== 'camera_param' && name !== 'plane_pose') {
        throw new Error(`get_metrology_model_param: unsupported model parameter '${name}'`);
      }
      const v = m.modelParams[name];
      if (v !== undefined) out.push(...(Array.isArray(v) ? v : [v]));
    }
    MetrologyUI.defTuple(ctx, args[2], out, 'number');
  },

  set_metrology_model_image_size(args, ctx) {
    const m = MetrologyUI.modelOf(args, 0, ctx);
    const W = MetrologyUI.numVal(args[1], ctx, NaN);
    const H = MetrologyUI.numVal(args[2], ctx, NaN);
    if (!(W > 0) || !(H > 0)) throw new Error('set_metrology_model_image_size: Width and Height must be > 0');
    m.imageSize = { W, H };
    lastApplyDims.set(m.handle, { W, H });                    // XLD canvases use it before the first apply
    ctx.log(`set_metrology_model_image_size: model ${m.handle} image size set to ${W}x${H}.`);
  },

  /* HDevelop:
       get_metrology_object_model_contour ( : Contour : MetrologyHandle, Index,
         Resolution : )
     Resolution is the distance between successive contour points (default 1.5). */
  get_metrology_object_model_contour(args, ctx) {
    const m = MetrologyUI.modelOf(args, 1, ctx);
    const sel = MetrologyUI.indexVal(args[2], ctx, 0);
    const res = MetrologyUI.numVal(args[3], ctx, 1.5);
    const dims = lastApplyDims.get(m.handle) || m.imageSize || { W: 640, H: 480 };
    const contours = [];
    for (const obj of MetrologyCore.selectObjects(m, sel)) {
      const pts = MetrologyUI.nominalContour(obj, res);
      contours.push({ x: pts.map(p => p[0]), y: pts.map(p => p[1]) });
    }
    MetrologyUI.defineXld(ctx, args[0], contours, dims.W, dims.H);
    ctx.log(`get_metrology_object_model_contour: ${contours.length} model contour(s) returned (Resolution ${MetrologyUI.fmt(res)}).`);
  },

  /* HDevelop:
       get_metrology_object_result_contour ( : Contour : MetrologyHandle, Index,
         Instance, Resolution : )
     Resolution is the distance between successive contour points (default 1.5);
     a line contour is always returned as its two end points. */
  get_metrology_object_result_contour(args, ctx) {
    const m = MetrologyUI.modelOf(args, 1, ctx);
    const sel = MetrologyUI.indexVal(args[2], ctx, 0);
    const instSel = MetrologyUI.indexVal(args[3], ctx);
    const res = MetrologyUI.numVal(args[4], ctx, 1.5);
    const dims = lastApplyDims.get(m.handle) || m.imageSize || { W: 640, H: 480 };
    const contours = [];
    let n = 0;
    for (const obj of MetrologyCore.selectObjects(m, sel)) {
      const insts = instSel === 'all' ? obj.instances
        : instSel >= 0 && instSel < obj.instances.length ? [obj.instances[instSel]] : [];
      for (const inst of insts) {
        const pts = MetrologyUI.contourPoints(obj, inst, res);
        contours.push({ x: pts.map(p => p[0]), y: pts.map(p => p[1]) });
        n++;
      }
    }
    MetrologyUI.defineXld(ctx, args[0], contours, dims.W, dims.H);
    if (!n) ctx.log(`get_metrology_object_result_contour: no instance ${instSel} — run apply_metrology_model first.`, 'warn');
    else ctx.log(`get_metrology_object_result_contour: ${n} result contour(s) returned (Resolution ${MetrologyUI.fmt(res)}).`);
  },

  get_metrology_object_num_instances(args, ctx) {
    const m = MetrologyUI.modelOf(args, 0, ctx);
    const sel = MetrologyUI.indexVal(args[1], ctx, 0);
    const counts = MetrologyCore.selectObjects(m, sel).map(obj => obj.instances.length);
    MetrologyUI.defTuple(ctx, args[2], counts, 'integer');
  },

  apply_metrology_model(args, ctx) {
    const rec = ctx.iconic(args[0]);
    const m = MetrologyUI.modelOf(args, 1, ctx);
    if (!rec || rec.kind !== 'image' || !rec.gray) {
      throw new Error('apply_metrology_model: first argument must be a single-channel image');
    }
    const W = rec.mat ? rec.mat.cols : rec.canvas.width;
    const H = rec.mat ? rec.mat.rows : rec.canvas.height;
    if (m.imageSize && (m.imageSize.W !== W || m.imageSize.H !== H)) {
      ctx.log(`apply_metrology_model: image is ${W}x${H} but the model's image size is ${m.imageSize.W}x${m.imageSize.H} (set_metrology_model_image_size).`, 'warn');
    }
    lastApplyDims.set(m.handle, { W, H });
    MetrologyCore.applyModel(m, rec.gray, W, H);
    let fitted = 0;
    for (const obj of m.objects.values()) {
      for (const inst of obj.instances) {
        fitted++;
        const where = obj.shape === 'line'
          ? `line ${MetrologyUI.fmt(inst.rowBegin)}/${MetrologyUI.fmt(inst.columnBegin)} → ${MetrologyUI.fmt(inst.rowEnd)}/${MetrologyUI.fmt(inst.columnEnd)}`
          : obj.shape === 'circle'
            ? `center ${MetrologyUI.fmt(inst.row)}/${MetrologyUI.fmt(inst.column)}, radius ${MetrologyUI.fmt(inst.radius)}`
            : obj.shape === 'ellipse'
              ? `center ${MetrologyUI.fmt(inst.row)}/${MetrologyUI.fmt(inst.column)}, ra/rb ${MetrologyUI.fmt(inst.ra)}/${MetrologyUI.fmt(inst.rb)}, phi ${MetrologyUI.fmt(inst.phi)}`
              : `center ${MetrologyUI.fmt(inst.row)}/${MetrologyUI.fmt(inst.column)}, l1/l2 ${MetrologyUI.fmt(inst.length1)}/${MetrologyUI.fmt(inst.length2)}, phi ${MetrologyUI.fmt(inst.phi)}`;
        ctx.log(`apply_metrology_model: object ${obj.index} (${obj.shape}) instance found — ${where}, score ${(inst.score * 100).toFixed(0)}%`);
      }
      if (!obj.instances.length) {
        ctx.log(`apply_metrology_model: object ${obj.index} (${obj.shape}) — no instance reached min_score ${obj.params.min_score}.`, 'warn');
      }
    }
    if (ctx.setMetrologyOverlay) ctx.setMetrologyOverlay(MetrologyUI.buildOverlay(m, W, H));
    ctx.log(`apply_metrology_model: ${m.objects.size} object(s) measured, ${fitted} instance(s) fitted.`);
  },

  /* HDevelop:
       get_metrology_object_measures ( : Contours : MetrologyHandle, Index,
         Transition : Row, Column)
     Contours receives the rectangular boundaries of the measure regions (model
     data — available before apply_metrology_model), Row and Column the image
     coordinates of the edges found by the last apply_metrology_model, filtered
     by Transition.  This build also accepts the shorter
       (MetrologyHandle, Index, Transition, Row, Column)
     without the iconic output. */
  get_metrology_object_measures(args, ctx) {
    /* argument 0 decides which order is meant: a metrology handle is numeric,
       an output object name never is */
    const legacy = Number.isFinite(MetrologyUI.numVal(args[0], ctx, NaN));
    if (!legacy && args.length < 6) {
      throw new Error('get_metrology_object_measures: expected (Contours, MetrologyHandle, Index, Transition, Row, Column)');
    }
    const at = legacy ? 0 : 1;
    const m = MetrologyUI.modelOf(args, at, ctx);
    const sel = MetrologyUI.indexVal(args[at + 1], ctx);
    const transition = MetrologyUI.strVal(args[at + 2], ctx, 'all');
    if (!['all', 'positive', 'negative'].includes(transition)) {
      throw new Error(`get_metrology_object_measures: Transition must be 'all', 'positive' or 'negative'`);
    }
    const objects = MetrologyCore.selectObjects(m, sel);
    if (!legacy) {
      const dims = lastApplyDims.get(m.handle) || m.imageSize || { W: 640, H: 480 };
      const contours = [];
      for (const obj of objects) contours.push(...MetrologyCore.measureRegionContours(obj));
      MetrologyUI.defineXld(ctx, args[0], contours, dims.W, dims.H);
    }
    const rows = [], cols = [];
    for (const obj of objects) {
      const r = MetrologyCore.measuresOf(obj, transition);
      rows.push(...r.rows); cols.push(...r.cols);
    }
    MetrologyUI.defTuple(ctx, args[at + 3], rows, 'real');
    MetrologyUI.defTuple(ctx, args[at + 4], cols, 'real');
    if (!rows.length) {
      ctx.log(`get_metrology_object_measures: no ${transition === 'all' ? '' : transition + ' '}edges measured — run apply_metrology_model first.`, 'warn');
    }
  },

  /* Two argument orders are accepted.  HDevelop's:
       get_metrology_object_result ( : : MetrologyHandle, Index, Instance,
         GenParamName, GenParamValue : Parameter)
     GenParamName = 'result_type' selects the values through GenParamValue
     ('all_param', 'score' or the name of a single parameter), GenParamName =
     'used_edges' returns GenParamValue 'row', 'column' or 'amplitude' — the
     edges the measure regions contributed — and any other GenParamName is the
     parameter itself.  HDevelop's operator has no iconic result: the fitted
     contour comes from get_metrology_object_result_contour.
     This build's earlier order is still accepted:
       (Contours, MetrologyHandle, Index, Instance, ResultType, GenParamName,
         GenParamValue)
     and additionally returns the fitted contour(s) as the iconic output. */
  get_metrology_object_result(args, ctx) {
    /* argument 0 decides which order is meant: a metrology handle is numeric,
       an output object name never is */
    const hdev = Number.isFinite(MetrologyUI.numVal(args[0], ctx, NaN));
    if (!hdev && args.length < 5) {
      throw new Error('get_metrology_object_result: expected (Contours, MetrologyHandle, Index, Instance, ResultType, GenParamName, GenParamValue)');
    }
    const at = hdev ? 0 : 1;
    const m = MetrologyUI.modelOf(args, at, ctx);
    const sel = MetrologyUI.indexVal(args[at + 1], ctx, 0);
    const objects = MetrologyCore.selectObjects(m, sel);
    /* the two middle arguments of this build's order only differ in what they
       mean, which is decided by which of them is an object index */
    const isIdx = t => {
      const s = String(t === undefined ? '' : t).trim();
      if (/^'?all'?$/i.test(s)) return true;
      return Number.isFinite(MetrologyUI.numVal(s, ctx, NaN));
    };
    let instSel, what, rawSel, outIdx;
    if (hdev) {
      const genName = MetrologyUI.strVal(args[3], ctx, 'result_type');
      const genValue = MetrologyUI.strVal(args[4], ctx, 'all_param');
      instSel = MetrologyUI.indexVal(args[2], ctx);
      what = genName === 'result_type' ? 'result_type'
        : genName === 'used_edges' ? 'used_edges' : 'param';
      rawSel = what === 'param' ? genName : genValue;
      outIdx = 5;
    } else {
      const hdevOrder = isIdx(args[3]) && !isIdx(args[4]);
      instSel = MetrologyUI.indexVal(hdevOrder ? args[3] : args[4], ctx);
      rawSel = hdevOrder ? args[4] : args[3];
      what = 'result_type';
      outIdx = hdevOrder ? 6 : 5;
      /* the iconic output is the fitted contour(s) of the selected objects and
         is returned for every ResultType, as in HDevelop: ResultType /
         GenParamName only decide what goes into the numeric result */
      const dims = lastApplyDims.get(m.handle) || { W: 640, H: 480 };
      const { canvas, count, data } = MetrologyUI.buildContours(m, objects, dims.W, dims.H);
      if (/^[A-Za-z_][A-Za-z0-9_]*$/.test(args[0] || '')) {
        ctx.defIconic(args[0], {
          kind: 'xld', type: `XLD contours (${count})`, canvas,
          xld: data, contours: count, dispose() {},
        });
      }
    }
    const type = MetrologyUI.strVal(rawSel, ctx, 'all_param');
    if (what === 'used_edges') {
      /* approximation: every edge of the measure regions of the last apply is
         reported (this build does not keep which of them the fit kept) */
      const kind = String(type).toLowerCase();
      if (!['row', 'column', 'amplitude'].includes(kind)) {
        throw new Error(`get_metrology_object_result: 'used_edges' expects GenParamValue 'row', 'column' or 'amplitude' (got '${type}')`);
      }
      const values = [];
      for (const obj of objects) {
        const r = MetrologyCore.measuresOf(obj, 'all');
        values.push(...(kind === 'row' ? r.rows : kind === 'column' ? r.cols : r.mags));
      }
      if (!values.length) ctx.log(`get_metrology_object_result: no used edges — run apply_metrology_model first.`, 'warn');
      MetrologyUI.defTuple(ctx, args[outIdx], values, 'real');
      ctx.log(`get_metrology_object_result: used edge ${kind} of ${values.length} edge(s) returned.`);
      return;
    }
    if (type === 'all_contours_xld') {
      if (args[outIdx] !== undefined) ctx.defCtrl(args[outIdx], '[]', 'empty tuple');
      ctx.log(`get_metrology_object_result: fitted contour(s) returned as XLD.`);
      return;
    }
    const types = type === 'all_param' ? ['all_param']
      : MetrologyUI.splitList(String(type).trim()).map(s => MetrologyUI.strVal(s, ctx, s));
    const values = [];
    for (const obj of objects) {
      const insts = instSel === 'all' ? obj.instances
        : instSel >= 0 && instSel < obj.instances.length ? [obj.instances[instSel]] : [];
      for (const inst of insts) {
        for (const t of types) values.push(...MetrologyCore.resultValue(obj, inst, t));
      }
    }
    if (!values.length) ctx.log(`get_metrology_object_result: no results (check min_score / instances).`, 'warn');
    MetrologyUI.defTuple(ctx, args[outIdx], values, 'number');
  },

  get_metrology_object_indices(args, ctx) {
    const m = MetrologyUI.modelOf(args, 0, ctx);
    MetrologyUI.defTuple(ctx, args[1], [...m.objects.keys()].sort((a, b) => a - b), 'integer');
  },

  clear_metrology_object(args, ctx) {
    const m = MetrologyUI.modelOf(args, 0, ctx);
    const sel = MetrologyUI.indexVal(args[1], ctx);
    MetrologyCore.removeObjects(m, sel);
    ctx.log(`clear_metrology_object: object(s) ${sel === 'all' ? 'all' : sel} removed from model ${m.handle}.`);
  },

  clear_metrology_model(args, ctx) {
    const m = MetrologyUI.modelOf(args, 0, ctx);
    MetrologyCore.removeObjects(m, 'all');
    MetrologyCore.models.delete(m.handle);
    ctx.log(`clear_metrology_model: model ${m.handle} destroyed.`);
  },

  /* HDevelop:
       copy_metrology_model ( : : MetrologyHandle, Index : CopiedMetrologyHandle)
     Two control inputs, one control output - no iconic result. The objects of the copy
     are numbered from 0 again, exactly like a model built from scratch. */
  copy_metrology_model(args, ctx) {
    const m = MetrologyUI.modelOf(args, 0, ctx);
    const sel = MetrologyUI.indexVal(args[1], ctx);
    const m2 = MetrologyCore.copyModel(m, sel);
    ctx.defCtrl(args[2], m2.handle, 'integer');
    ctx.log(`copy_metrology_model: model ${m.handle} (${sel === 'all' ? 'all objects' : 'object ' + sel}) copied to new model ${m2.handle}.`);
  },

  /* HDevelop:
       reset_metrology_object_param (MetrologyHandle, Index, GenParamName)
     Without GenParamName every parameter is reset to its default value. */
  reset_metrology_object_param(args, ctx) {
    const m = MetrologyUI.modelOf(args, 0, ctx);
    const sel = MetrologyUI.indexVal(args[1], ctx);
    const names = args[2] === undefined ? [] : MetrologyUI.listVal(args[2], ctx).map(String);
    for (const obj of MetrologyCore.selectObjects(m, sel)) {
      if (names.length) for (const name of names) MetrologyCore.resetParam(obj, name);
      else MetrologyCore.resetParams(obj);
    }
    ctx.log(`reset_metrology_object_param: object(s) ${sel === 'all' ? 'all' : sel} ${names.length ? `parameter(s) ${names.join(', ')}` : 'reset to their defaults'}.`);
  },

  /* ---------------- XLD generation (XLD Creation) ---------------- */

  gen_circle_contour_xld(args, ctx) {
    const row = MetrologyUI.numVal(args[1], ctx, NaN), col = MetrologyUI.numVal(args[2], ctx, NaN);
    const r = MetrologyUI.numVal(args[3], ctx, NaN);
    if (![row, col, r].every(Number.isFinite) || r <= 0) throw new Error('gen_circle_contour_xld: Row/Column/Radius must be numbers, Radius > 0');
    const contour = arcContour(row, col, 0, r, r,
      MetrologyUI.numVal(args[4], ctx, 0), MetrologyUI.numVal(args[5], ctx, 0),
      MetrologyUI.strVal(args[6], ctx, 'positive'), MetrologyUI.numVal(args[7], ctx, 1));
    MetrologyUI.defineXld(ctx, args[0], [contour], 640, 480);
    ctx.log(`gen_circle_contour_xld: circle contour (${contour.x.length} points) created.`);
  },

  gen_ellipse_contour_xld(args, ctx) {
    const row = MetrologyUI.numVal(args[1], ctx, NaN), col = MetrologyUI.numVal(args[2], ctx, NaN);
    const phi = MetrologyUI.numVal(args[3], ctx, 0);
    const ra = MetrologyUI.numVal(args[4], ctx, NaN), rb = MetrologyUI.numVal(args[5], ctx, NaN);
    if (![row, col, ra, rb].every(Number.isFinite) || ra <= 0 || rb <= 0) throw new Error('gen_ellipse_contour_xld: Row/Column/Ra/Rb must be numbers, axes > 0');
    const contour = arcContour(row, col, phi, ra, rb,
      MetrologyUI.numVal(args[6], ctx, 0), MetrologyUI.numVal(args[7], ctx, 0),
      MetrologyUI.strVal(args[8], ctx, 'positive'), MetrologyUI.numVal(args[9], ctx, 1));
    MetrologyUI.defineXld(ctx, args[0], [contour], 640, 480);
    ctx.log(`gen_ellipse_contour_xld: ellipse contour (${contour.x.length} points) created.`);
  },

  gen_contour_polygon_xld(args, ctx) {
    const rows = MetrologyUI.listVal(args[1], ctx).map(Number);
    const cols = MetrologyUI.listVal(args[2], ctx).map(Number);
    if (rows.length < 2 || rows.length !== cols.length) throw new Error('gen_contour_polygon_xld: Row and Col must be equally long point lists (>= 2)');
    if (!rows.every(Number.isFinite) || !cols.every(Number.isFinite)) throw new Error('gen_contour_polygon_xld: point coordinates must be numeric');
    MetrologyUI.defineXld(ctx, args[0], [{ x: cols, y: rows }], 640, 480);
    ctx.log(`gen_contour_polygon_xld: polygon contour (${rows.length} points) created.`);
  },

  gen_cross_contour_xld(args, ctx) {                       // Cross, Row, Col, Size, Angle -> CenterRow, CenterCol, AngleOut
    const row = MetrologyUI.numVal(args[1], ctx, NaN), col = MetrologyUI.numVal(args[2], ctx, NaN);
    const size = MetrologyUI.numVal(args[3], ctx, NaN);
    if (![row, col, size].every(Number.isFinite) || size <= 0) {
      throw new Error('gen_cross_contour_xld: Row/Col/Size must be numbers, Size > 0');
    }
    /* a cross is symmetric under a half turn, so the angle is normalized into
       [0, pi) — that is also the angle of the first contour arm (AngleOut) */
    let angle = MetrologyUI.numVal(args[4], ctx, 0) % Math.PI;
    if (angle < 0) angle += Math.PI;
    const contour = crossContour(row, col, size, angle);
    const d = xldDims(ctx);
    MetrologyUI.defineXld(ctx, args[0], [contour], d.W, d.H);
    MetrologyUI.defTuple(ctx, args[5], [row], 'real');
    MetrologyUI.defTuple(ctx, args[6], [col], 'real');
    MetrologyUI.defTuple(ctx, args[7], [angle], 'real');
    ctx.log(`gen_cross_contour_xld: cross contour (${contour.x.length} points, size ${MetrologyUI.fmt(size)}) created.`);
  },

  gen_rectangle2_contour_xld(args, ctx) {                  // Rectangle, Row, Column, Phi, Length1, Length2
    const row = MetrologyUI.numVal(args[1], ctx, NaN), col = MetrologyUI.numVal(args[2], ctx, NaN);
    const phi = MetrologyUI.numVal(args[3], ctx, 0);
    const l1 = MetrologyUI.numVal(args[4], ctx, NaN), l2 = MetrologyUI.numVal(args[5], ctx, NaN);
    if (![row, col, l1, l2].every(Number.isFinite) || l1 < 0 || l2 < 0) {
      throw new Error('gen_rectangle2_contour_xld: Row/Column/Length1/Length2 must be numbers, Length1/Length2 >= 0');
    }
    const contour = rect2Contour(row, col, phi, l1, l2);
    const d = xldDims(ctx);
    MetrologyUI.defineXld(ctx, args[0], [contour], d.W, d.H);
    ctx.log(`gen_rectangle2_contour_xld: rectangle contour (5 corners) created.`);
  },

  gen_contour_region_xld(args, ctx) {                      // Regions, Contours, Mode, Algorithm, MaxNumPoints, ClippingEndPoints
    const rec = ctx.iconic(args[0]);
    if (!rec) throw new Error(`gen_contour_region_xld: iconic object '${String(args[0]).replace(/'/g, '')}' is not defined`);
    const mask = regionMasks(rec);
    if (!mask) throw new Error('gen_contour_region_xld: argument 0 must be a region (single region or region array)');
    const mode = MetrologyUI.strVal(args[2], ctx, 'border');
    const algorithm = MetrologyUI.strVal(args[3], ctx, 'border');
    for (const s of [mode, algorithm]) {
      if (s !== 'border' && s !== 'border_holes') ctx.log(`gen_contour_region_xld: '${s}' is not supported — using 'border'.`, 'warn');
    }
    const withHoles = mode === 'border_holes' || algorithm === 'border_holes';
    const maxPoints = MetrologyUI.numVal(args[4], ctx, -1);
    const clipEnds = Math.max(0, Math.round(MetrologyUI.numVal(args[5], ctx, 0)));
    const contours = [];
    for (const inside of mask.inside) {
      for (const c of borderContours(mask.W, mask.H, inside, withHoles)) {
        const pts = MetrologyCore.prepareContour(c, maxPoints, clipEnds);
        if (pts.length < 2) continue;
        contours.push({ x: pts.map(p => p.x), y: pts.map(p => p.y) });
      }
    }
    MetrologyUI.defineXld(ctx, args[1], contours, mask.W, mask.H);
    if (!contours.length) ctx.log('gen_contour_region_xld: the region is empty — no contour created.', 'warn');
    else ctx.log(`gen_contour_region_xld: ${contours.length} border contour(s) created.`);
  },

  /* ---------------- contour fitting (Filters / XLD) ---------------- */

  fit_circle_contour_xld(args, ctx) {
    const contours = xldContours(args, 0, ctx);
    const o = fitOpts(args, ctx, 2, true);
    const R = [], C = [], RAD = [], S0 = [], S1 = [], ORD = [];
    for (const cont of contours) {
      const pts = MetrologyCore.prepareContour(cont, o.maxPoints, o.clipEnds);
      if (pts.length < 3) { ctx.log('fit_circle_contour_xld: contour with fewer than 3 points skipped.', 'warn'); continue; }
      const r = MetrologyCore.fitContour('circle', pts, MetrologyCore.nominalFromContour('circle', pts), o.iterations, o.clip);
      if (!r) { ctx.log('fit_circle_contour_xld: circle fit failed for a contour.', 'warn'); continue; }
      const sw = MetrologyCore.sweepInfo(pts, r.model.x, r.model.y);
      R.push(r.model.y); C.push(r.model.x); RAD.push(r.model.r);
      S0.push(sw.startPhi); S1.push(sw.endPhi); ORD.push(sw.order);
    }
    MetrologyUI.defTuple(ctx, args[7], R, 'real');
    MetrologyUI.defTuple(ctx, args[8], C, 'real');
    MetrologyUI.defTuple(ctx, args[9], RAD, 'real');
    MetrologyUI.defTuple(ctx, args[10], S0, 'real');
    MetrologyUI.defTuple(ctx, args[11], S1, 'real');
    MetrologyUI.defTuple(ctx, args[12], ORD, 'string');
  },

  fit_ellipse_contour_xld(args, ctx) {
    const contours = xldContours(args, 0, ctx);
    const o = fitOpts(args, ctx, 2, true);
    const R = [], C = [], PH = [], RA = [], RB = [], S0 = [], S1 = [], ORD = [];
    for (const cont of contours) {
      const pts = MetrologyCore.prepareContour(cont, o.maxPoints, o.clipEnds);
      if (pts.length < 5) { ctx.log('fit_ellipse_contour_xld: contour with fewer than 5 points skipped.', 'warn'); continue; }
      const r = MetrologyCore.fitContour('ellipse', pts, MetrologyCore.nominalFromContour('ellipse', pts), o.iterations, o.clip);
      if (!r) { ctx.log('fit_ellipse_contour_xld: ellipse fit failed for a contour.', 'warn'); continue; }
      const sw = MetrologyCore.sweepInfo(pts, r.model.x, r.model.y);
      R.push(r.model.y); C.push(r.model.x); PH.push(r.model.phi); RA.push(r.model.a); RB.push(r.model.b);
      S0.push(sw.startPhi); S1.push(sw.endPhi); ORD.push(sw.order);
    }
    MetrologyUI.defTuple(ctx, args[7], R, 'real');
    MetrologyUI.defTuple(ctx, args[8], C, 'real');
    MetrologyUI.defTuple(ctx, args[9], PH, 'real');
    MetrologyUI.defTuple(ctx, args[10], RA, 'real');
    MetrologyUI.defTuple(ctx, args[11], RB, 'real');
    MetrologyUI.defTuple(ctx, args[12], S0, 'real');
    MetrologyUI.defTuple(ctx, args[13], S1, 'real');
    MetrologyUI.defTuple(ctx, args[14], ORD, 'string');
  },

  fit_line_contour_xld(args, ctx) {
    const contours = xldContours(args, 0, ctx);
    const o = fitOpts(args, ctx, 2, false);
    const RB = [], CB = [], RE = [], CE = [], NR = [], NC = [], D = [];
    for (const cont of contours) {
      const pts = MetrologyCore.prepareContour(cont, o.maxPoints, o.clipEnds);
      if (pts.length < 2) { ctx.log('fit_line_contour_xld: contour with fewer than 2 points skipped.', 'warn'); continue; }
      const r = MetrologyCore.fitContour('line', pts, null, o.iterations, o.clip);
      if (!r) { ctx.log('fit_line_contour_xld: line fit failed for a contour.', 'warn'); continue; }
      const par = MetrologyCore.lineParams(r.model, r.inliers);
      RB.push(par.rowBegin); CB.push(par.columnBegin); RE.push(par.rowEnd); CE.push(par.columnEnd);
      const nr = par.ux, nc = -par.uy;                         // unit normal in (row, col) components
      NR.push(nr); NC.push(nc);
      D.push(nr * r.model.y + nc * r.model.x);
    }
    MetrologyUI.defTuple(ctx, args[6], RB, 'real');
    MetrologyUI.defTuple(ctx, args[7], CB, 'real');
    MetrologyUI.defTuple(ctx, args[8], RE, 'real');
    MetrologyUI.defTuple(ctx, args[9], CE, 'real');
    MetrologyUI.defTuple(ctx, args[10], NR, 'real');
    MetrologyUI.defTuple(ctx, args[11], NC, 'real');
    MetrologyUI.defTuple(ctx, args[12], D, 'real');
  },

  fit_rectangle2_contour_xld(args, ctx) {
    const contours = xldContours(args, 0, ctx);
    const o = fitOpts(args, ctx, 2, true);
    const R = [], C = [], PH = [], L1 = [], L2 = [], ORD = [];
    for (const cont of contours) {
      const pts = MetrologyCore.prepareContour(cont, o.maxPoints, o.clipEnds);
      if (pts.length < 8) { ctx.log('fit_rectangle2_contour_xld: contour with fewer than 8 points skipped.', 'warn'); continue; }
      const nominal = MetrologyCore.nominalFromContour('rectangle2', pts);
      const r = MetrologyCore.fitContour('rectangle2', pts, nominal, o.iterations, o.clip);
      if (!r) { ctx.log('fit_rectangle2_contour_xld: rectangle fit failed for a contour.', 'warn'); continue; }
      const p = MetrologyCore.paramsOf('rectangle2', r.model, r.inliers);
      const sw = MetrologyCore.sweepInfo(pts, r.model.x, r.model.y);
      R.push(p.row); C.push(p.column); PH.push(p.phi); L1.push(p.length1); L2.push(p.length2);
      ORD.push(sw.order);
    }
    MetrologyUI.defTuple(ctx, args[7], R, 'real');
    MetrologyUI.defTuple(ctx, args[8], C, 'real');
    MetrologyUI.defTuple(ctx, args[9], PH, 'real');
    MetrologyUI.defTuple(ctx, args[10], L1, 'real');
    MetrologyUI.defTuple(ctx, args[11], L2, 'real');
    MetrologyUI.defTuple(ctx, args[12], ORD, 'string');
  },
};

/* dimensions of the last image an apply ran on, per model, live above the impls */

/* analytic arc contour for the gen_*_contour_xld operators
   (Resolution = maximum distance between neighboring points, in pixels) */
function arcContour(row, col, phi, a, b, startPhi, endPhi, order, resolution) {
  let sweep = endPhi - startPhi;
  if (sweep <= 0) sweep += 2 * Math.PI;                      // StartPhi == EndPhi: full contour
  const res = Math.max(0.05, resolution || 1);
  const n = Math.max(3, Math.ceil((sweep * Math.max(a, b)) / res) + 1);
  const dir = order === 'negative' ? -1 : 1;
  const cp = Math.cos(phi), sp = Math.sin(phi);
  const x = new Array(n), y = new Array(n);
  for (let i = 0; i < n; i++) {
    const t = startPhi + dir * sweep * (i / (n - 1));
    const ex = a * Math.cos(t), ey = b * Math.sin(t);
    x[i] = col + ex * cp - ey * sp;
    y[i] = row + ex * sp + ey * cp;
  }
  return { x, y };
}

/* canvas size for a generated XLD contour: the size of the image the IDE is
   working on (app.js ctx), the workspace default without one */
function xldDims(ctx) {
  if (typeof ctx.imgSize === 'function') {
    const d = ctx.imgSize();
    if (d && d.W > 0 && d.H > 0) return d;
  }
  return { W: 640, H: 480 };
}

/* gen_cross_contour_xld: the two arms of a cross of total length `size` around
   (row, col), rotated by `angle` (radians, from the column axis).  The contour
   runs center -> arm end -> center -> ... so that every segment of the closed
   contour is an arm half (8 points; the center appears four times). */
function crossContour(row, col, size, angle) {
  const k = size / 2, ca = Math.cos(angle), sa = Math.sin(angle);
  const pts = [
    [col + k * ca, row - k * sa], [col, row],
    [col - k * ca, row + k * sa], [col, row],
    [col - k * sa, row - k * ca], [col, row],
    [col + k * sa, row + k * ca], [col, row],
    [col + k * ca, row - k * sa],                     // closing point
  ];
  return { x: pts.map(p => p[0]), y: pts.map(p => p[1]) };
}

/* gen_rectangle2_contour_xld: the four corners (plus the repeated first corner)
   of a rotated rectangle, Phi measured from the column axis like everywhere
   else in this build */
function rect2Contour(row, col, phi, length1, length2) {
  const ca = Math.cos(phi || 0), sa = Math.sin(phi || 0);
  const pts = [[1, 1], [-1, 1], [-1, -1], [1, -1], [1, 1]].map(([u, v]) => [
    col + ca * u * length1 - sa * v * length2,
    row + sa * u * length1 + ca * v * length2,
  ]);
  return { x: pts.map(p => p[0]), y: pts.map(p => p[1]) };
}

/* ---- gen_contour_region_xld ----------------------------------------------
   Border contours of the regions of this build: a region record holds either a
   0/255 mask (cv.Mat, e.g. threshold) or a label image with the ids it keeps
   (connection / select_shape).  Both are turned into one "inside" test per
   region, and the border of each is traced pixel by pixel. */

function regionMasks(rec) {
  if (rec.mat && rec.mat.data) {
    const W = rec.mat.cols, H = rec.mat.rows, d = rec.mat.data;
    return { W, H, inside: [i => d[i] !== 0] };
  }
  if (rec.labels && rec.w && rec.h) {
    const W = rec.w, H = rec.h, lab = rec.labels;
    const ids = rec.ids || Array.from({ length: rec.count || 0 }, (_, i) => i + 1);
    return { W, H, inside: ids.map(k => i => lab[i] === k) };
  }
  return null;
}

/* Moore neighbourhood tracing (8-connected, clockwise) of the pixels for which
   `inside(index)` holds, starting at the first such pixel in row-major order.
   Returns a closed contour {x: [], y: []} with one point per border pixel (the
   start pixel is repeated at the end). */
function traceBorder(W, H, inside, start) {
  if (!(start >= 0)) return null;
  const N8 = [[-1, 0], [-1, 1], [0, 1], [1, 1], [1, 0], [1, -1], [0, -1], [-1, -1]];   // N, NE, E, SE, S, SW, W, NW
  const at = (x, y) => x >= 0 && y >= 0 && x < W && y < H && inside(y * W + x);
  const x0 = start % W, y0 = (start - x0) / W;
  const xs = [x0], ys = [y0];
  let cx = x0, cy = y0;
  let from = 6;                                       // the start pixel was reached from the west
  for (let step = 0, max = 8 * W * H; step < max; step++) {
    let moved = false;
    for (let k = 1; k <= 7; k++) {                    // clockwise from the pixel we came from
      const d = (from + k) % 8;
      const nx = cx + N8[d][0], ny = cy + N8[d][1];
      if (!at(nx, ny)) continue;
      from = (d + 4) % 8;                             // in the new pixel we came from the opposite side
      cx = nx; cy = ny;
      moved = true;
      break;
    }
    if (!moved) break;                                // isolated pixel / dead end
    if (cx === x0 && cy === y0) break;                // closed: back at the start
    xs.push(cx); ys.push(cy);
  }
  if (xs.length > 1) { xs.push(xs[0]); ys.push(ys[0]); }
  return { x: xs, y: ys };
}

/* the holes of a region (background components that do not touch the image
   border), each as the set of region pixels that surround it — the inner border
   of the region, which is what Mode 'border_holes' adds to the contour set */
function holeRegions(W, H, inside) {
  const isBg = i => !inside(i);
  const seen = new Uint8Array(W * H);
  const stack = [];
  const add = i => { if (!seen[i] && isBg(i)) { seen[i] = 1; stack.push(i); } };
  for (let x = 0; x < W; x++) { add(x); add((H - 1) * W + x); }
  for (let y = 0; y < H; y++) { add(y * W); add(y * W + W - 1); }
  while (stack.length) {
    const i = stack.pop(), x = i % W, y = (i - x) / W;
    if (x > 0) add(i - 1);
    if (x < W - 1) add(i + 1);
    if (y > 0) add(i - W);
    if (y < H - 1) add(i + W);
  }
  const holes = [];
  for (let i = 0; i < W * H; i++) {
    if (seen[i] || !isBg(i)) continue;
    const cells = [i];
    seen[i] = 1;
    for (let k = 0; k < cells.length; k++) {
      const j = cells[k], x = j % W, y = (j - x) / W;
      if (x > 0 && !seen[j - 1] && isBg(j - 1)) { seen[j - 1] = 1; cells.push(j - 1); }
      if (x < W - 1 && !seen[j + 1] && isBg(j + 1)) { seen[j + 1] = 1; cells.push(j + 1); }
      if (y > 0 && !seen[j - W] && isBg(j - W)) { seen[j - W] = 1; cells.push(j - W); }
      if (y < H - 1 && !seen[j + W] && isBg(j + W)) { seen[j + W] = 1; cells.push(j + W); }
    }
    /* the region pixels that touch this hole (4-connected) form its inner border */
    const border = new Set();
    for (const j of cells) {
      const x = j % W, y = (j - x) / W;
      if (x > 0 && inside(j - 1)) border.add(j - 1);
      if (x < W - 1 && inside(j + 1)) border.add(j + 1);
      if (y > 0 && inside(j - W)) border.add(j - W);
      if (y < H - 1 && inside(j + W)) border.add(j + W);
    }
    if (border.size > 1) {
      let start = -1;
      for (const j of border) if (start < 0 || j < start) start = j;
      holes.push({ start, inside: idx => border.has(idx) });
    }
  }
  return holes;
}

/* every border contour of one region: the outer border and, on request, the
   borders of its holes */
function borderContours(W, H, inside, withHoles) {
  const out = [];
  let start = -1;
  for (let i = 0; i < W * H; i++) if (inside(i)) { start = i; break; }
  const outer = traceBorder(W, H, inside, start);
  if (outer && outer.x.length > 1) out.push(outer);
  if (withHoles) {
    for (const h of holeRegions(W, H, inside)) {
      const c = traceBorder(W, H, h.inside, h.start);
      if (c && c.x.length > 1) out.push(c);
    }
  }
  return out;
}

/* XLD contours from an iconic argument */
function xldContours(args, i, ctx) {
  const rec = ctx.iconic(args[i]);
  if (!rec || rec.kind !== 'xld' || !rec.xld || !rec.xld.length) {
    throw new Error(`${ctx.currentOp || 'operator'}: argument ${i + 1} must contain XLD contours (e.g. from get_metrology_object_result or gen_*_contour_xld)`);
  }
  return rec.xld;
}

/* numeric fit options shared by the fit_*_contour_xld operators.
   hasMaxClosureDist: closed contours (circle, ellipse, rectangle2) carry an
   extra MaxClosureDist argument that fit_line_contour_xld does not have. */
function fitOpts(args, ctx, i0, hasMaxClosureDist) {
  const num = (i, d) => MetrologyUI.numVal(args[i], ctx, d);
  const shift = hasMaxClosureDist ? 1 : 0;
  return {
    maxPoints: num(i0, -1),
    clipEnds: Math.max(0, Math.round(num(i0 + 1 + shift, 0))),
    iterations: Math.max(1, Math.round(num(i0 + 2 + shift, 5))),
    clip: Math.max(0.1, num(i0 + 3 + shift, 2)),
  };
}

/* ==========================================================================
   operator metadata (Operator Window, autocomplete, operator dialog)
   ========================================================================== */
const METROLOGY_OPINFO = {
  create_metrology_model: {
    params: [['MetrologyHandle', 'output', 'control']],
    desc: `Creates an empty metrology model and returns its handle. Metrology objects
           (circle, ellipse, line, rectangle2) are registered with the
           <code>add_metrology_object_*_measure</code> operators and measured with
           <code>apply_metrology_model</code>.`,
  },
  add_metrology_object_circle_measure: {
    params: [['MetrologyHandle', 'input', 'control'], ['Row', 'input', 'control'],
             ['Column', 'input', 'control'], ['Radius', 'input', 'control'],
             ['MeasureLength1', 'input', 'control', '20'], ['MeasureLength2', 'input', 'control', '5'],
             ['MeasureSigma', 'input', 'control', '1'], ['MeasureThreshold', 'input', 'control', '30'],
             ['GenParamName', 'input', 'control', '[]'], ['GenParamValue', 'input', 'control', '[]'],
             ['Index', 'output', 'control']],
    desc: `Adds a circle (approximate center <code>Row</code>/<code>Column</code> and
           <code>Radius</code>) to the model. Along the circle, measure rectangles of half
           sizes (<code>MeasureLength1</code> perpendicular to the contour,
           <code>MeasureLength2</code> tangential to it) are placed, <code>MeasureLength1</code>
           pixels apart; in each one the smoothed (Gaussian <code>MeasureSigma</code>) gray
           profile is searched for edges with amplitude &ge; <code>MeasureThreshold</code>. The
           edge points are then fitted to a circle. <code>GenParamName</code>/
           <code>GenParamValue</code> may set parameters such as 'measure_transition' (e.g.
           ['measure_transition'], ['all']).`,
  },
  add_metrology_object_ellipse_measure: {
    params: [['MetrologyHandle', 'input', 'control'], ['Row', 'input', 'control'],
             ['Column', 'input', 'control'], ['Phi', 'input', 'control'],
             ['Ra', 'input', 'control'], ['Rb', 'input', 'control'],
             ['MeasureLength1', 'input', 'control', '20'], ['MeasureLength2', 'input', 'control', '5'],
             ['MeasureSigma', 'input', 'control', '1'], ['MeasureThreshold', 'input', 'control', '30'],
             ['GenParamName', 'input', 'control', '[]'], ['GenParamValue', 'input', 'control', '[]'],
             ['Index', 'output', 'control']],
    desc: `Adds an ellipse with approximate parameters
           (<code>Row</code>, <code>Column</code>, <code>Phi</code>, <code>Ra</code>,
           <code>Rb</code>) to the model. Edge extraction and fitting as with
           <code>add_metrology_object_circle_measure</code>; the result normalizes
           <code>Ra</code> &ge; <code>Rb</code>.`,
  },
  add_metrology_object_line_measure: {
    params: [['MetrologyHandle', 'input', 'control'], ['RowBegin', 'input', 'control'],
             ['ColumnBegin', 'input', 'control'], ['RowEnd', 'input', 'control'],
             ['ColumnEnd', 'input', 'control'],
             ['MeasureLength1', 'input', 'control', '20'], ['MeasureLength2', 'input', 'control', '5'],
             ['MeasureSigma', 'input', 'control', '1'], ['MeasureThreshold', 'input', 'control', '30'],
             ['GenParamName', 'input', 'control', '[]'], ['GenParamValue', 'input', 'control', '[]'],
             ['Index', 'output', 'control']],
    desc: `Adds a line segment from (<code>RowBegin</code>, <code>ColumnBegin</code>) to
           (<code>RowEnd</code>, <code>ColumnEnd</code>) to the model. Measure rectangles are
           placed along the segment and the extracted edge points are fitted to a line;
           the returned segment spans the supporting inlier points.`,
  },
  add_metrology_object_rectangle2_measure: {
    params: [['MetrologyHandle', 'input', 'control'], ['Row', 'input', 'control'],
             ['Column', 'input', 'control'], ['Phi', 'input', 'control'],
             ['Length1', 'input', 'control'], ['Length2', 'input', 'control'],
             ['MeasureLength1', 'input', 'control', '20'], ['MeasureLength2', 'input', 'control', '5'],
             ['MeasureSigma', 'input', 'control', '1'], ['MeasureThreshold', 'input', 'control', '30'],
             ['GenParamName', 'input', 'control', '[]'], ['GenParamValue', 'input', 'control', '[]'],
             ['Index', 'output', 'control']],
    desc: `Adds a rectangle with approximate parameters (<code>Row</code>, <code>Column</code>,
           <code>Phi</code>, half side lengths <code>Length1</code>/<code>Length2</code>) to the
           model. Measure rectangles are placed along the four sides; the edge points are
           assigned to sides and fitted. Earlier revisions of this build omitted
           <code>MeasureLength1</code>/<code>MeasureLength2</code> (11 instead of 13 arguments);
           that form is still accepted.`,
  },
  add_metrology_object_generic: {
    params: [['MetrologyHandle', 'input', 'control'], ['Shape', 'input', 'control'],
             ['ShapeParam', 'input', 'control'],
             ['MeasureLength1', 'input', 'control', '20'], ['MeasureLength2', 'input', 'control', '5'],
             ['MeasureSigma', 'input', 'control', '1'], ['MeasureThreshold', 'input', 'control', '30'],
             ['GenParamName', 'input', 'control', '[]'], ['GenParamValue', 'input', 'control', '[]'],
             ['Index', 'output', 'control']],
    desc: `Generic form of the add operators. <code>Shape</code> is 'circle', 'ellipse',
           'line' or 'rectangle2' (or a tuple of them) and <code>ShapeParam</code> carries the
           shape data, concatenated per shape as in HDevelop: 'circle' [Row, Column, Radius],
           'ellipse' [Row, Column, Phi, Radius1, Radius2], 'line' [RowBegin, ColumnBegin,
           RowEnd, ColumnEnd], 'rectangle2' [Row, Column, Phi, Length1, Length2]. One object
           is created per shape element. The older 12-argument form of this build (Shape,
           Rows, Cols, Phi, Length1, Length2, &hellip;) is still accepted.`,
  },
  set_metrology_object_param: {
    params: [['MetrologyHandle', 'input', 'control'], ['Index', 'input', 'control', "'all'"],
             ['GenParamName', 'input', 'control', "'num_instances'"],
             ['GenParamValue', 'input', 'control', '1']],
    desc: `Sets parameters of one object (or 'all'): 'measure_length1', 'measure_length2',
           'measure_sigma', 'measure_threshold', 'measure_select' ('first'|'last'|'all'),
           'measure_transition' ('positive'|'negative'|'all'), 'measure_distance',
           'measure_interpolation', 'min_score' [0..1], 'num_instances', 'max_iterations',
           'rand_seed'.`,
  },
  get_metrology_object_param: {
    params: [['MetrologyHandle', 'input', 'control'], ['Index', 'input', 'control', "'all'"],
             ['GenParamName', 'input', 'control', "'num_measures'"],
             ['GenParamValue', 'output', 'control']],
    desc: `Returns object parameters (same names as
           <code>set_metrology_object_param</code>) plus the nominal geometry ('row',
           'radius', 'length1', &hellip;) and 'num_measures'.`,
  },
  set_metrology_model_param: {
    params: [['MetrologyHandle', 'input', 'control'], ['GenParamName', 'input', 'control'],
             ['GenParamValue', 'input', 'control']],
    desc: `Model-wide parameters. This 2-D implementation accepts 'camera_param' and
           'plane_pose' for program compatibility and measures in the image plane.`,
  },
  apply_metrology_model: {
    params: [['Image', 'input', 'iconic'], ['MetrologyHandle', 'input', 'control']],
    desc: `Measures and fits all objects of the model in <code>Image</code>: for every
           measure region the 1-D gray profile across the contour is extracted and searched
           for edges; the edge points are fitted robustly (outlier rejection over
           'max_iterations'). The results and scores are stored per object; a visualization
           (measure regions, edge points, fitted contours) is drawn into the active
           graphics window.`,
  },
  get_metrology_object_measures: {
    params: [['Contours', 'output', 'iconic'], ['MetrologyHandle', 'input', 'control'],
             ['Index', 'input', 'control', "'all'"], ['Transition', 'input', 'control', "'all'"],
             ['Row', 'output', 'control'], ['Column', 'output', 'control']],
    desc: `Returns the measure regions of the object(s) <code>Index</code> as XLD
           rectangles in <code>Contours</code> and the image coordinates of the edges found
           by the last <code>apply_metrology_model</code> in <code>Row</code> and
           <code>Column</code>. Before an apply the edge tuples are empty; the regions are
           model data and are available as soon as the object has been added (they are
           rebuilt when <code>measure_length1</code>, <code>measure_length2</code> or
           <code>measure_distance</code> is set). With <code>Transition</code> =
           'positive' / 'negative' only edges of that direction are returned. As in
           HDevelop, <code>[]</code> selects the documented default of an input parameter
           (<code>Index</code> = 'all', <code>Transition</code> = 'all'). Row/Column are
           returned in measure-region order, pair by pair (HALCON leaves that order
           undefined). The shorter call
           <code>(MetrologyHandle, Index, Transition, Row, Column)</code> without the
           iconic output is accepted as well.`,
  },
  get_metrology_object_result: {
    params: [['MetrologyHandle', 'input', 'control'], ['Index', 'input', 'control', '0'],
             ['Instance', 'input', 'control', "'all'"], ['GenParamName', 'input', 'control', "'result_type'"],
             ['GenParamValue', 'input', 'control', "'all_param'"], ['Parameter', 'output', 'control']],
    desc: `Returns the fitted result(s) of object(s) <code>Index</code> and instance
           <code>Instance</code> (0-based or 'all') in <code>Parameter</code>.
           <code>GenParamName</code> = 'result_type' selects the values through
           <code>GenParamValue</code> = 'all_param' (the full parameter tuple: circle
           [row, column, radius]; ellipse [row, column, phi, ra, rb]; line [row_begin,
           column_begin, row_end, column_end]; rectangle2 [row, column, phi, length1,
           length2]), 'score', or the name of a single parameter ('row', 'radius',
           &hellip;). <code>GenParamName</code> = 'used_edges' returns
           <code>GenParamValue</code> = 'row', 'column' or 'amplitude' — the edges the
           measure regions contributed (this build keeps them from the last
           <code>apply_metrology_model</code>); any other GenParamName is the parameter
           itself.<br>
           This build's older order
           <code>(Contours, MetrologyHandle, Index, Instance, ResultType, GenParamName,
           GenParamValue)</code> is still accepted and additionally returns the fitted
           contour(s) as the iconic <code>Contours</code> (HDevelop only has the numeric
           result here — its contour output is
           <code>get_metrology_object_result_contour</code>); its legacy selector
           'all_contours_xld' returns the contours with an empty numeric result.`,
  },
  get_metrology_object_indices: {
    params: [['MetrologyHandle', 'input', 'control'], ['Indices', 'output', 'control']],
    desc: `Returns the indices of all metrology objects in the model, numbered from 0.`,
  },
  clear_metrology_object: {
    params: [['MetrologyHandle', 'input', 'control'], ['Index', 'input', 'control', "'all'"]],
    desc: `Removes object(s) <code>Index</code> ('all' for every object) from the model.`,
  },
  clear_metrology_model: {
    params: [['MetrologyHandle', 'input', 'control']],
    desc: `Destroys the metrology model and frees its objects.`,
  },
  copy_metrology_model: {
    params: [['MetrologyHandle', 'input', 'control'], ['Index', 'input', 'control', "'all'"],
             ['CopiedMetrologyHandle', 'output', 'control']],
    desc: `Copies object(s) <code>Index</code> ('all' for the whole model) into a new model
           and returns its handle. The copy is a model of its own, so its objects are
           numbered from 0 (use <code>get_metrology_object_indices</code> to query them).`,
  },
  reset_metrology_object_params: {
    params: [['MetrologyHandle', 'input', 'control'], ['Index', 'input', 'control']],
    desc: `Deprecated alias of <code>reset_metrology_object_param</code> (HDevelop spells it
           without the trailing 's').`,
  },
  reset_metrology_object_param: {
    params: [['MetrologyHandle', 'input', 'control'], ['Index', 'input', 'control', "'all'"],
             ['GenParamName', 'input', 'control', '[]']],
    desc: `Resets the parameters of object(s) <code>Index</code> ('all' for every object) to
           their default values (MeasureLength1 = 20, MeasureLength2 = 5, MeasureSigma = 1,
           MeasureThreshold = 30, min_score = 0.7, &hellip;) — HDevelop's signature is
           <code>(MetrologyHandle, Index)</code> and always resets every parameter. As an
           extension this build also takes a <code>GenParamName</code> tuple and then
           resets only the named parameters.`,
  },
  get_metrology_model_param: {
    params: [['MetrologyHandle', 'input', 'control'], ['GenParamName', 'input', 'control'],
             ['GenParamValue', 'output', 'control']],
    desc: `Returns the parameters set with <code>set_metrology_model_param</code>
           ('camera_param', 'plane_pose') and, as an extension, 'image_size' (the
           size passed to <code>set_metrology_model_image_size</code>, as
           [Width, Height]).`,
  },
  set_metrology_model_image_size: {
    params: [['MetrologyHandle', 'input', 'control'], ['Width', 'input', 'control'],
             ['Height', 'input', 'control']],
    desc: `Declares the image size of the metrology model. Needed when the model is
           used before an image is available (e.g. to size the XLD output of
           <code>get_metrology_object_model_contour</code>);
           <code>apply_metrology_model</code> warns if the applied image deviates
           from the declared size.`,
  },
  get_metrology_object_model_contour: {
    params: [['Contour', 'output', 'iconic'], ['MetrologyHandle', 'input', 'control'],
             ['Index', 'input', 'control', '0'], ['Resolution', 'input', 'control', '1.5']],
    desc: `Returns the <b>model</b> contour(s) of object(s) <code>Index</code> as XLD
           — the nominal geometry the measure regions are placed on, not the fitted
           result. <code>Resolution</code> is the distance between successive contour
           points (1.5 in HDevelop). Available before
           <code>apply_metrology_model</code>.`,
  },
  get_metrology_object_result_contour: {
    params: [['Contour', 'output', 'iconic'], ['MetrologyHandle', 'input', 'control'],
             ['Index', 'input', 'control', '0'], ['Instance', 'input', 'control', "'all'"],
             ['Resolution', 'input', 'control', '1.5']],
    desc: `Returns the fitted contour of instance <code>Instance</code> (0-based, or
           'all') of object(s) <code>Index</code> as XLD, i.e. the same shape
           <code>get_metrology_object_result</code> returns, per instance.
           <code>Resolution</code> is the distance between successive contour points
           (1.5 in HDevelop); a line contour is always its two end points.`,
  },
  get_metrology_object_num_instances: {
    params: [['MetrologyHandle', 'input', 'control'], ['Index', 'input', 'control', '0'],
             ['NumInstances', 'output', 'control']],
    desc: `Returns the number of instances found by the last
           <code>apply_metrology_model</code> per object (a tuple for
           <code>Index</code> = 'all').`,
  },
  gen_circle_contour_xld: {
    params: [['ContCircle', 'output', 'iconic'], ['Row', 'input', 'control'],
             ['Column', 'input', 'control'], ['Radius', 'input', 'control'],
             ['StartPhi', 'input', 'control', '0'], ['EndPhi', 'input', 'control', '0'],
             ['PointOrder', 'input', 'control', "'positive'"], ['Resolution', 'input', 'control', '1']],
    desc: `Creates a circle/arc contour XLD. <code>StartPhi</code> = <code>EndPhi</code>
           generates the full circle; <code>PointOrder</code> 'positive' walks increasing
           angles. Adjacent points are <code>Resolution</code> pixels apart.`,
  },
  gen_ellipse_contour_xld: {
    params: [['ContEllipse', 'output', 'iconic'], ['Row', 'input', 'control'],
             ['Column', 'input', 'control'], ['Phi', 'input', 'control', '0'],
             ['Ra', 'input', 'control'], ['Rb', 'input', 'control'],
             ['StartPhi', 'input', 'control', '0'], ['EndPhi', 'input', 'control', '0'],
             ['PointOrder', 'input', 'control', "'positive'"], ['Resolution', 'input', 'control', '1']],
    desc: `Creates an ellipse/arc contour XLD, parameterized like
           <code>gen_circle_contour_xld</code> with axes (<code>Ra</code>, <code>Rb</code>)
           rotated by <code>Phi</code>.`,
  },
  gen_contour_polygon_xld: {
    params: [['Contour', 'output', 'iconic'], ['Row', 'input', 'control'], ['Col', 'input', 'control']],
    desc: `Creates an open polygon contour XLD from the point lists
           <code>Row</code> / <code>Col</code> (e.g. [10, 50, 50] and [20, 20, 80]).`,
  },
  gen_cross_contour_xld: {
    params: [['Cross', 'output', 'iconic'], ['Row', 'input', 'control'],
             ['Col', 'input', 'control'], ['Size', 'input', 'control'],
             ['Angle', 'input', 'control', '0'], ['CenterRow', 'output', 'control'],
             ['CenterCol', 'output', 'control'], ['AngleOut', 'output', 'control']],
    desc: `Creates a cross contour XLD of total length <code>Size</code> centred on
           (<code>Row</code>, <code>Col</code>) and rotated by <code>Angle</code>
           (radians: <code>0</code> gives a +, <code>rad(45)</code> an &times;).
           A cross is symmetric under a half turn, so the angle is normalized into
           [0, &pi;). HDevelop's signature has only the iconic <code>Cross</code>
           output; the additional <code>CenterRow</code>, <code>CenterCol</code> and
           <code>AngleOut</code> outputs (center of the cross and the normalized angle)
           are an extension of this build.`,
  },
  gen_rectangle2_contour_xld: {
    params: [['Rectangle', 'output', 'iconic'], ['Row', 'input', 'control'],
             ['Column', 'input', 'control'], ['Phi', 'input', 'control'],
             ['Length1', 'input', 'control'], ['Length2', 'input', 'control']],
    desc: `Creates the contour XLD of a rotated rectangle with centre
           (<code>Row</code>, <code>Column</code>) and <em>half</em> side lengths
           <code>Length1</code> / <code>Length2</code>, rotated by
           <code>Phi</code> (radians, measured from the column axis). The contour
           has the four corners plus the repeated first corner.`,
  },
  gen_contour_region_xld: {
    params: [['Regions', 'input', 'iconic'], ['Contours', 'output', 'iconic'],
             ['Mode', 'input', 'control', "'border'"], ['Algorithm', 'input', 'control', "'border'"],
             ['MaxNumPoints', 'input', 'control', '-1'], ['ClippingEndPoints', 'input', 'control', '0']],
    desc: `Turns the border of a region (or of each region of a region array) into
           XLD contours, pixel by pixel. <code>Mode</code> 'border' gives the outer
           border, 'border_holes' the outer border and the borders of the holes;
           <code>MaxNumPoints</code> &gt; 0 subsamples long borders and
           <code>ClippingEndPoints</code> drops points at both ends of each
           contour.`,
  },
  fit_circle_contour_xld: {
    params: [['Contours', 'input', 'iconic'], ['Algorithm', 'input', 'control', "'geotukey'"],
             ['MaxNumPoints', 'input', 'control', '-1'], ['MaxClosureDist', 'input', 'control', '0'],
             ['ClippingEndPoints', 'input', 'control', '0'], ['Iterations', 'input', 'control', '5'],
             ['ClippingFactor', 'input', 'control', '2'],
             ['Row', 'output', 'control'], ['Column', 'output', 'control'], ['Radius', 'output', 'control'],
             ['StartPhi', 'output', 'control'], ['EndPhi', 'output', 'control'], ['PointOrder', 'output', 'control']],
    desc: `Fits a circle to each XLD contour (geometric least squares with
           Tukey-style outlier pruning over <code>Iterations</code>;
           <code>ClippingFactor</code> scales the rejection threshold,
           <code>MaxNumPoints</code> &gt; 0 subsamples long contours,
           <code>ClippingEndPoints</code> drops points at both ends). All
           <code>Algorithm</code> names are accepted — the robust geometric fit is used
           throughout. Returns center, radius and the angular range of the supporting
           arc. With several contours the outputs are tuples.`,
  },
  fit_ellipse_contour_xld: {
    params: [['Contours', 'input', 'iconic'], ['Algorithm', 'input', 'control', "'fitzgibbon'"],
             ['MaxNumPoints', 'input', 'control', '-1'], ['MaxClosureDist', 'input', 'control', '0'],
             ['ClippingEndPoints', 'input', 'control', '0'], ['Iterations', 'input', 'control', '5'],
             ['ClippingFactor', 'input', 'control', '2'],
             ['Row', 'output', 'control'], ['Column', 'output', 'control'], ['Phi', 'output', 'control'],
             ['Ra', 'output', 'control'], ['Rb', 'output', 'control'],
             ['StartPhi', 'output', 'control'], ['EndPhi', 'output', 'control'], ['PointOrder', 'output', 'control']],
    desc: `Fits an ellipse to each XLD contour (robust geometric fit, parameters
           normalized to <code>Ra</code> &ge; <code>Rb</code>). Outputs center, orientation,
           axes and the angular range of the supporting arc.`,
  },
  fit_line_contour_xld: {
    params: [['Contours', 'input', 'iconic'], ['Algorithm', 'input', 'control', "'tukey'"],
             ['MaxNumPoints', 'input', 'control', '-1'], ['ClippingEndPoints', 'input', 'control', '0'],
             ['Iterations', 'input', 'control', '5'], ['ClippingFactor', 'input', 'control', '2'],
             ['RowBegin', 'output', 'control'], ['ColBegin', 'output', 'control'],
             ['RowEnd', 'output', 'control'], ['ColEnd', 'output', 'control'],
             ['Nr', 'output', 'control'], ['Nc', 'output', 'control'], ['Dist', 'output', 'control']],
    desc: `Fits a line to each XLD contour (orthogonal regression with
           Tukey-style outlier pruning). Returns the fitted segment
           (<code>RowBegin</code>&hellip;<code>ColEnd</code>, i.e. first and last
           supporting contour point) plus the line in normal form
           <code>Nr</code>&middot;row + <code>Nc</code>&middot;col = <code>Dist</code>.
           <code>ClippingEndPoints</code> drops points at both ends of the contour
           before fitting and therefore shortens the segment.`,
  },
  fit_rectangle2_contour_xld: {
    params: [['Contours', 'input', 'iconic'], ['Algorithm', 'input', 'control', "'tukey'"],
             ['MaxNumPoints', 'input', 'control', '-1'], ['MaxClosureDist', 'input', 'control', '0'],
             ['ClippingEndPoints', 'input', 'control', '0'], ['Iterations', 'input', 'control', '5'],
             ['ClippingFactor', 'input', 'control', '2'],
             ['Row', 'output', 'control'], ['Column', 'output', 'control'], ['Phi', 'output', 'control'],
             ['Length1', 'output', 'control'], ['Length2', 'output', 'control'], ['PointOrder', 'output', 'control']],
    desc: `Fits a rectangle to each XLD contour. The orientation is searched over a
           &pi;/2 window (a quarter turn only relabels the sides) with a robust capped
           cost, starting from the principal axis, and the four side planes are then
           fitted with outlier pruning. Outputs are normalized to
           <code>Length1</code> &ge; <code>Length2</code>.`,
  },
};

/* backward-compatible spellings: the plural form was used before the operator was
   renamed to the HDevelop name */
METROLOGY_OP_IMPLS.reset_metrology_object_params = METROLOGY_OP_IMPLS.reset_metrology_object_param;
METROLOGY_OPINFO.reset_metrology_object_params = METROLOGY_OPINFO.reset_metrology_object_param;

/* global Metrology: console/debug handle + lifecycle used by app.js */const Metrology = {
  core: MetrologyCore,
  lastApplyDims,
  /* every handle this module owns: the models and the object indices they hold,
     plus the image dimensions remembered for their XLD overlays */
  disposeAll() {
    MetrologyCore.reset();
    lastApplyDims.clear();
  },
};

/* register with the operator registry (js/opencv_ops.js) */
if (typeof OP_IMPLS !== 'undefined') Object.assign(OP_IMPLS, METROLOGY_OP_IMPLS);

/* node export for the smoke test (tools/test-metrology.js) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { MetrologyCore, MetrologyMath, METROLOGY_OPINFO, METROLOGY_OP_IMPLS, MetrologyUI };
}
