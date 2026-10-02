'use strict';
/* ==========================================================================
   OpenCVS — HALCON-syntax operator registry backed by OpenCV WASM
   (opencv.js / WebAssembly). Each program line is parsed by the engine in
   app.js and routed here by operator name; implementations work on real
   cv.Mat data and define iconic/control results via the provided ctx.
   ========================================================================== */

function hslToRgb(h, s, l) {
  s /= 100; l /= 100;
  const k = n => (n + h / 30) % 12;
  const a = s * Math.min(l, 1 - l);
  const f = n => l - a * Math.max(-1, Math.min(k(n) - 3, Math.min(9 - k(n), 1)));
  return [Math.round(f(0) * 255), Math.round(f(8) * 255), Math.round(f(4) * 255)];
}

/* gray cv.Mat (CV_8UC1) -> display canvas */
function ocvGrayToCanvas(mat) {
  const c = document.createElement('canvas');
  c.width = mat.cols; c.height = mat.rows;
  const x = c.getContext('2d');
  const id = x.createImageData(mat.cols, mat.rows);
  const d = id.data, g = mat.data;
  for (let i = 0, p = 0; i < mat.cols * mat.rows; i++, p += 4) {
    d[p] = g[i]; d[p + 1] = g[i]; d[p + 2] = g[i]; d[p + 3] = 255;
  }
  x.putImageData(id, 0, 0);
  return c;
}

/* binary mask cv.Mat (0/255) -> translucent colored overlay canvas */
function ocvMaskToOverlay(mat, r, g, b) {
  const c = document.createElement('canvas');
  c.width = mat.cols; c.height = mat.rows;
  const x = c.getContext('2d');
  const id = x.createImageData(mat.cols, mat.rows);
  const d = id.data, m = mat.data;
  for (let i = 0, p = 0; i < mat.cols * mat.rows; i++, p += 4) {
    if (!m[i]) continue;
    d[p] = r; d[p + 1] = g; d[p + 2] = b; d[p + 3] = 150;
  }
  x.putImageData(id, 0, 0);
  return c;
}

/* label image (Int32Array) -> colored overlay; ids restricts to a subset (green) */
function ocvLabelsToOverlay(labels, w, h, ids) {
  const c = document.createElement('canvas');
  c.width = w; c.height = h;
  const x = c.getContext('2d');
  const id = x.createImageData(w, h);
  const d = id.data;
  const subset = ids ? new Set(ids) : null;
  for (let i = 0, p = 0; i < labels.length; i++, p += 4) {
    const l = labels[i];
    if (!l) continue;
    if (subset) {
      if (!subset.has(l)) continue;
      d[p] = 80; d[p + 1] = 200; d[p + 2] = 120;
    } else {
      const [r, g, b] = hslToRgb((l * 47) % 360, 75, 55);
      d[p] = r; d[p + 1] = g; d[p + 2] = b;
    }
    d[p + 3] = 165;
  }
  x.putImageData(id, 0, 0);
  return c;
}

/* numeric control arg: a literal, a control variable or a HALCON expression
   ('640/2', 'Width/4', 'Height*0.5', 'rad(360)') — the grammar lives in the
   metrology module (MetrologyUI.numVal, js/metrology.js). Numbers only are
   handled here as well, so this registry keeps working on its own. */
function numArg(tok, ctx, fallback) {
  if (typeof MetrologyUI !== 'undefined') return MetrologyUI.numVal(tok, ctx, fallback);
  const s = String(tok === undefined ? '' : tok).trim();
  if (!s || !/^[+*/().\d\s-]+$/.test(s)) return fallback;
  try {
    const v = Number(Function('"use strict"; return (' + s + ');')());
    return Number.isFinite(v) ? v : fallback;
  } catch (e) { return fallback; }
}

/* ---- argument lists of the disp_* / gen_* operators ----------------------
   HALCON passes coordinates as tuples as well: a single number / variable /
   expression, or a tuple of them whose elements are evaluated on their own
   (e.g. [Height/2, 20, 20+40]). */
function numArgList(tok, ctx) {
  const s = String(tok === undefined || tok === null ? '' : tok).trim();
  if (!s) return [];
  if (/^\[.*\]$/.test(s)) {
    const inner = s.slice(1, -1);
    const parts = (typeof MetrologyUI !== 'undefined' && MetrologyUI.splitList)
      ? MetrologyUI.splitList(inner) : inner.split(',');
    return parts.map(p => numArg(p, ctx, NaN)).filter(Number.isFinite);
  }
  const v = numArg(s, ctx, NaN);
  return Number.isFinite(v) ? [v] : [];
}

/* WindowHandle argument of the disp_* family: an empty argument or 0 means the
   active window (as in HALCON), an unknown handle is reported by the context */
function dispWindow(tok, ctx) {
  const s = String(tok === undefined || tok === null ? '' : tok).trim();
  if (!s) return undefined;
  const v = ctx.ctrl(s);
  const h = typeof v === 'number' ? v : numArg(s, ctx, NaN);
  if (!Number.isFinite(h) || h === 0) return undefined;
  return Math.round(h);
}

/* the numeric argument tuples of one disp_* call, merged into one value list per
   instance: a shorter tuple (typically a single value) is reused for the
   remaining instances, the way HALCON broadcasts it */
function dispInstances(ctx, specs) {
  const lists = specs.map(sp => {
    const l = numArgList(sp.tok, ctx);
    return l.length ? l : (sp.def || []);
  });
  if (lists.some(l => !l.length)) return null;
  const n = Math.max(...lists.map(l => l.length));
  const out = [];
  for (let i = 0; i < n; i++) out.push(lists.map(l => l[Math.min(i, l.length - 1)]));
  return out;
}

/* disp_obj / disp_region / disp_image: display an object tuple in a window
   (HALCON's object-first spelling of dev_display, WindowHandle second) */
function dispObject(args, ctx, op, want) {
  const raw = String(args[0] === undefined || args[0] === null ? '' : args[0]).trim();
  const list = /^\[.*\]$/.test(raw)
    ? raw.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean)
    : [raw];
  if (!list.length || !list[0]) throw new Error(`${op}: no object given`);
  const handle = dispWindow(args[1], ctx);
  for (const name of list) {
    const rec = ctx.iconic(name);
    if (!rec) throw new Error(`${op}: iconic object '${name}' is not defined`);
    if (want === 'region' && rec.kind === 'image') throw new Error(`${op}: '${name}' is an image, not a region`);
    if (want === 'image' && rec.kind !== 'image') throw new Error(`${op}: '${name}' is not an image`);
    ctx.displayObject(name, handle);
  }
}

/* define the iconic region of a gen_* operator: a cv.Mat mask like threshold's,
   so it can be displayed, connected or measured like any other region.  With no
   (valid) output name the region is anonymous and its mask is released. */
function defineGenRegion(ctx, op, name, mask, what) {
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(name || '')) { mask.delete(); return; }
  ctx.defIconic(name, {
    kind: 'region', type: 'region', mat: mask,
    canvas: ocvMaskToOverlay(mask, 236, 70, 60),
    dispose() { mask.delete(); },
  });
  ctx.log(`${op}: ${what}.`);
}

/* empty mask of the size the generated region should have (the current image;
   the IDE default when no image has been read yet) */
function genMask(ctx) {
  const d = (typeof ctx.imgSize === 'function' ? ctx.imgSize() : null) || { W: 640, H: 480 };
  return { mask: cv.Mat.zeros(d.H, d.W, cv.CV_8UC1), W: d.W, H: d.H };
}

/* the four corners of a rotated rectangle, row/column pairs (HALCON's
   convention: Phi measured from the column axis towards the row axis) */
function rect2Corners(row, col, phi, length1, length2) {
  const ca = Math.cos(phi || 0), sa = Math.sin(phi || 0);
  const pts = [];
  for (const [u, v] of [[1, 1], [-1, 1], [-1, -1], [1, -1]]) {
    pts.push(Math.round(col + ca * u * length1 - sa * v * length2),
             Math.round(row + sa * u * length1 + ca * v * length2));
  }
  return pts;
}

/* fill a polygon given as flat [x0, y0, x1, y1, ...] into the mask.  OpenCV.js
   only converts a cv.MatVector to the contour list these calls expect, a plain
   JS array of Mats is rejected. */
function fillMaskPolygon(mask, flat) {
  const poly = cv.matFromArray(flat.length / 2, 1, cv.CV_32SC2, flat);
  const polys = new cv.MatVector();
  polys.push_back(poly);
  cv.fillPoly(mask, polys, new cv.Scalar(255));
  polys.delete();
  poly.delete();
}

/* the set pixels of a mask as a CV_32SC2 point Mat — the input format of
   minAreaRect / convexHull.  The embedded OpenCV build has no findNonZero, so
   the points are collected from the pixel data of the mask itself. */
function maskPointMat(mask) {
  const w = mask.cols, n = w * mask.rows, d = mask.data;
  const flat = [];
  for (let i = 0; i < n; i++) {
    if (d[i]) { const y = (i / w) | 0; flat.push(i - y * w, y); }
  }
  return flat.length ? cv.matFromArray(flat.length / 2, 1, cv.CV_32SC2, flat) : null;
}

/* the four corners of a RotatedRect as [[x, y], ...] in rotational order.
   opencv.js returns an array of {x, y}, other builds return a CV_32FC2 Mat, so
   both shapes are accepted. */
function rectCorners(r) {
  const bp = cv.boxPoints(r);
  if (bp && bp.length === 4 && typeof bp[0].x === 'number') return bp.map(p => [p.x, p.y]);
  const f = (bp && bp.data32F) || [];
  const c = [];
  for (let k = 0; k < 4; k++) c.push([f[k * 2], f[k * 2 + 1]]);
  if (bp && bp.delete) bp.delete();
  return c;
}

/* gen_region_polygon / gen_region_polygon_filled: the closed polygon through
   the given point lists, as its outline or filled */
function genPolygonRegion(args, ctx, op, filled) {
  const rows = numArgList(args[1], ctx), cols = numArgList(args[2], ctx);
  if (rows.length < 3 || rows.length !== cols.length) {
    throw new Error(`${op}: Row and Col must be equally long point lists (>= 3)`);
  }
  const flat = [];
  for (let i = 0; i < rows.length; i++) flat.push(Math.round(cols[i]), Math.round(rows[i]));
  const { mask } = genMask(ctx);
  if (filled) {
    fillMaskPolygon(mask, flat);
  } else {
    const poly = cv.matFromArray(rows.length, 1, cv.CV_32SC2, flat);
    const polys = new cv.MatVector();
    polys.push_back(poly);
    cv.polylines(mask, polys, true, new cv.Scalar(255), 1);
    polys.delete();
    poly.delete();
  }
  defineGenRegion(ctx, op, args[0], mask, `polygon region (${rows.length} points) created`);
}

/* ==========================================================================
   IMAGE SOURCES FOR read_image
   Every image file read_image can return lives here, keyed by the file name the
   program line uses ('printer_chip', 'photo.png', ...). The built-in demo image
   is synthesized by the IDE; files the user loads in the Operator Window
   (Parameters tab of read_image -> "Load file…") are added under their own name.
   ========================================================================== */
const BUILTIN_IMAGE = 'printer_chip';
const IMAGE_MAX_SIDE = 2048;               // bigger files are scaled down when loaded
const IMAGE_SOURCES = new Map();           // name -> { name, canvas, w, h, builtin }

/* program literals keep their quotes ('photo.png'), file names don't */
function imageArgName(tok) {
  return String(tok === undefined || tok === null ? '' : tok).trim().replace(/^'(.*)'$/s, '$1');
}

/* text files written by open_file / fwrite_string / close_file.  A browser page
   cannot write to disk, so the written text is collected in memory and offered
   as a download when the file is closed (like the "Save Program" button). */
const OPEN_FILES = new Map();
let FILE_SEQ = 1;

/* elements of a control tuple value ('[1, 2, 3]' or a single value) */
function controlTupleElements(v) {
  const s = String(v === undefined || v === null ? '' : v).trim();
  const inner = /^\[([\s\S]*)\]$/.exec(s);
  const body = inner ? inner[1] : s;
  return body.split(',').map(x => x.trim().replace(/^'(.*)'$/s, '$1')).filter(x => x !== '');
}

/* a control argument as a string: 'file.png', FileName, or an element of a
   control tuple (ImageFiles[3], ImageFiles[Index+1]) — so
   `read_image (Image, ImageFiles[Index])` resolves like in HDevelop. */
function controlString(tok, ctx) {
  const t = String(tok === undefined || tok === null ? '' : tok).trim();
  const q = t.match(/^'(.*)'$/s);
  if (q) return q[1];
  const idx = t.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*([^\]]+)\s*\]$/);
  if (idx && ctx && ctx.ctrl) {
    const v = ctx.ctrl(idx[1]);
    if (typeof v === 'string') {
      const parts = controlTupleElements(v);
      const k = Math.round(numArg(idx[2], ctx, NaN));
      return (Number.isFinite(k) && k >= 0 && k < parts.length) ? parts[k] : '';
    }
  }
  if (ctx && ctx.ctrl) {
    const v = ctx.ctrl(t);
    if (typeof v === 'string') return v.replace(/^'(.*)'$/s, '$1');
    if (typeof v === 'number') return String(v);
  }
  return t;
}

/* one of a fixed set of HALCON keywords ('dark'), quoted or via a variable */
function strKind(tok, ctx, fallback, allowed, op) {
  const raw = (typeof MetrologyUI !== 'undefined' && MetrologyUI.strVal)
    ? MetrologyUI.strVal(tok, ctx, fallback)
    : String(tok === undefined || tok === null ? '' : tok).replace(/^'(.*)'$/s, '$1').trim() || fallback;
  const v = String(raw).trim().toLowerCase();
  if (!allowed.includes(v)) {
    throw new Error(`${op}: expected ${allowed.map(a => `'${a}'`).join(' | ')}`);
  }
  return v;
}

/* HALCON string expression: 'text', a string control variable or tuple, or a
   concatenation of them with '+'; \n, \t and \r are the documented escapes. */
function unescapeHdev(s) {
  return String(s).replace(/\\t/g, '\t').replace(/\\n/g, '\n').replace(/\\r/g, '\r').replace(/\\\\/g, '\\');
}

function splitTopPlus(s) {
  const out = [];
  let cur = '', q = false;
  for (const ch of s) {
    if (ch === "'") q = !q;
    if (ch === '+' && !q) { out.push(cur); cur = ''; } else cur += ch;
  }
  out.push(cur);
  return out;
}

function stringExpr(tok, ctx) {
  const t = String(tok === undefined || tok === null ? '' : tok).trim();
  const q = t.match(/^'(.*)'$/s);
  if (q) return unescapeHdev(q[1]);
  const plus = splitTopPlus(t);
  if (plus.length > 1) return plus.map(p => stringExpr(p.trim(), ctx)).join('');
  const v = ctx && ctx.ctrl ? ctx.ctrl(t) : undefined;
  if (v !== undefined) {
    const s = String(v).trim();
    return /^\[[\s\S]*\]$/.test(s) ? controlTupleElements(s).join('\n') : s.replace(/^'(.*)'$/s, '$1');
  }
  /* an element of a control tuple ('Rows[k-1]', 'ImageFiles[3]') or a plain
     variable name that controlString knows how to resolve */
  if (ctx && ctx.ctrl && /^[A-Za-z_][A-Za-z0-9_]*\s*(\[[^\]]+\])?$/.test(t)) {
    const s = controlString(t, ctx);
    if (s !== t) return s.replace(/^'(.*)'$/s, '$1');
  }
  return unescapeHdev(t);
}

/* one mask cv.Mat per region of a region record: either a single 0/255 mask
   (threshold, gen_*) or a label image together with the ids it keeps
   (connection, select_shape).  `owned` marks the Mats the caller must delete. */
function regionMats(rec) {
  if (rec.mat && rec.mat.data) return [{ mask: rec.mat, owned: false }];
  if (rec.labels && rec.w && rec.h) {
    const ids = rec.ids || Array.from({ length: rec.count || 0 }, (_, i) => i + 1);
    const lab = rec.labels;
    return ids.map(id => {
      const mask = cv.Mat.zeros(rec.h, rec.w, cv.CV_8UC1);
      const d = mask.data;
      for (let i = 0; i < lab.length; i++) if (lab[i] === id) d[i] = 255;
      return { mask, owned: true };
    });
  }
  return [];
}

/* numbers of an argument that may be a scalar, a literal tuple '[a, b]' or a
   control variable holding one — HALCON's generic tuples (Min/Max of
   select_shape, Length1/Length2 of gen_rectangle2 …) */
function numberList(tok, ctx) {
  const vals = (typeof MetrologyUI !== 'undefined' && MetrologyUI.listVal)
    ? MetrologyUI.listVal(tok, ctx) : [tok];
  return vals
    .flatMap(v => (typeof v === 'string' && /^\[[\s\S]*\]$/.test(v.trim())) ? controlTupleElements(v) : [v])
    .map(v => numArg(String(v), ctx, NaN));
}

/* the region features of a mask region (threshold, gen_*): area, centre and
   bounding box are taken from the mask, so select_shape works on it as well */
function regionFeatures(regs) {
  if (regs.count) return regs;
  const m = cv.moments(regs.mat, false);
  const area = m.m00;
  const b = cv.boundingRect(regs.mat);
  regs.count = 1;
  regs.ids = [1];
  regs.areas = [0, area];
  regs.cents = [[0, 0], [area ? m.m10 / area : 0, area ? m.m01 / area : 0]];
  regs._boxes = [null, [b.y, b.x, b.y + b.height - 1, b.x + b.width - 1]];
  return regs;
}

/* bounding box [row1, column1, row2, column2] of every element of a label
   image, computed once per region record (1-based, like the element ids) */
function labelBoxes(regs) {
  if (regs._boxes) return regs._boxes;
  const { labels, w, count } = regs;
  const box = new Array((count || 0) + 1);
  if (labels && w) {
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i];
      if (!l) continue;
      const r = Math.floor(i / w), c = i - r * w;
      const b = box[l] || (box[l] = [r, c, r, c]);
      if (r < b[0]) b[0] = r;
      if (c < b[1]) b[1] = c;
      if (r > b[2]) b[2] = r;
      if (c > b[3]) b[3] = c;
    }
  }
  return (regs._boxes = box);
}

/* one region feature of select_shape, with the meaning it has in HALCON */
function shapeFeature(regs, boxes, id, name) {
  const f = String(name === undefined || name === null ? '' : name).trim().replace(/^'(.*)'$/s, '$1').toLowerCase();
  const box = boxes && boxes[id];
  const need = () => { throw new Error(`select_shape: '${f}' needs the region array of connection()`); };
  const wdt = () => (box ? box[3] - box[1] + 1 : need());
  const hgt = () => (box ? box[2] - box[0] + 1 : need());
  switch (f) {
    case 'area':    return regs.areas[id];
    case 'row':     return regs.cents[id][1];
    case 'column':  return regs.cents[id][0];
    case 'row1':    return box ? box[0] : need();
    case 'row2':    return box ? box[2] : need();
    case 'column1': return box ? box[1] : need();
    case 'column2': return box ? box[3] : need();
    case 'width':   return wdt();
    case 'height':  return hgt();
    case 'ratio': { const h = hgt(); return h ? wdt() / h : 0; }
    default:
      throw new Error(`select_shape: feature '${f}' is not implemented in this build`);
  }
}

function registerImageSource(name, canvas, builtin) {
  const rec = { name, canvas, builtin: !!builtin, w: canvas.width, h: canvas.height };
  IMAGE_SOURCES.set(name, rec);
  return rec;
}

/* ==========================================================================
   OPERATOR IMPLEMENTATIONS  (args = raw parsed tokens, e.g. '128' or ''name'')
   ========================================================================== */
const OP_IMPLS = {

  read_image(args, ctx) {
    const want = controlString(args[1], ctx);
    const known = IMAGE_SOURCES.get(want);
    /* `read_image (Image, ImageFiles[3])` with fewer files: name the element
       that does not exist instead of just reporting an empty file name */
    const argTok = String(args[1] === undefined || args[1] === null ? '' : args[1]).trim();
    const idxTok = argTok.match(/^([A-Za-z_][A-Za-z0-9_]*)\s*\[\s*([^\]]+)\s*\]$/);
    if (idxTok && !known) {
      const tup = ctx.ctrl ? ctx.ctrl(idxTok[1]) : undefined;
      const n = typeof tup === 'string' ? controlTupleElements(tup).length : 0;
      ctx.log(`read_image: ${argTok} is out of range — '${idxTok[1]}' has ${n} element(s)` +
        (n ? ` (valid index 0…${n - 1})` : '') + '.', 'warn');
    }
    const src = cv.imread(known ? known.canvas : ctx.syntheticImage());
    const gray = new cv.Mat();
    cv.cvtColor(src, gray, cv.COLOR_RGBA2GRAY);
    src.delete();
    ctx.defIconic(args[0], {
      kind: 'image', type: 'image (byte)',
      mat: gray, canvas: ocvGrayToCanvas(gray),
      gray: gray.data.slice(0, gray.cols * gray.rows),
      dispose() { gray.delete(); },
    });
    ctx.displayImage(args[0]);
    if (known) {
      ctx.log(`read_image: read '${want}' (${gray.cols}x${gray.rows}, byte) via OpenCV WASM` +
        (known.builtin ? ' — built-in demo image.' : ''));
    } else {
      ctx.log(`read_image: '${want}' has not been loaded — using the built-in ` +
        `'${BUILTIN_IMAGE}' image. Load the file with "Load file…" in the Operator Window.`, 'warn');
    }
  },

  get_image_size(args, ctx) {
    const img = ctx.iconic(args[0]);
    ctx.defCtrl(args[1], img.mat.cols, 'integer');
    ctx.defCtrl(args[2], img.mat.rows, 'integer');
  },

  threshold(args, ctx) {                                   // Region = MinGray <= g <= MaxGray
    const img = ctx.iconic(args[0]);
    const min = +args[2], max = +args[3];
    const dst = new cv.Mat();
    const low = new cv.Mat();
    cv.threshold(img.mat, low, min - 1, 255, cv.THRESH_BINARY);        // g >= min
    if (max < 255) {
      const high = new cv.Mat();
      cv.threshold(img.mat, high, max, 255, cv.THRESH_BINARY_INV);     // g <= max
      cv.bitwise_and(low, high, dst);
      high.delete();
    } else {
      low.copyTo(dst);
    }
    low.delete();
    ctx.defIconic(args[1], {
      kind: 'region', type: 'region', mat: dst,
      canvas: ocvMaskToOverlay(dst, 236, 70, 60),
      dispose() { dst.delete(); },
    });
  },

  connection(args, ctx) {
    const region = ctx.iconic(args[0]);
    const labels = new cv.Mat(), stats = new cv.Mat(), cents = new cv.Mat();
    const n = cv.connectedComponentsWithStats(region.mat, labels, stats, cents, 8, cv.CV_32S) - 1;
    const W = region.mat.cols, H = region.mat.rows;
    const lab = labels.data32S.slice(0, W * H);
    const areas = [0], cx = [0], cy = [0];
    for (let i = 1; i <= n; i++) {
      areas.push(stats.data32S[i * 5 + 4]);
      cx.push(cents.data64F[i * 2]);
      cy.push(cents.data64F[i * 2 + 1]);
    }
    labels.delete(); stats.delete(); cents.delete();
    ctx.defIconic(args[1], {
      kind: 'regions', type: `region array (${n})`,
      count: n, labels: lab, areas, cents: cx.map((x, i) => [x, cy[i]]),
      w: W, h: H,
      canvas: ocvLabelsToOverlay(lab, W, H, null),
      dispose() {},
    });
  },

  /* Region, SelectedRegions, Features, Operation, Min, Max — Features, Min and
     Max are tuples of the same length ('area' 1000..100000, or ['width',
     'ratio'] with a pair of limits each). */
  select_shape(args, ctx) {
    const regs = regionFeatures(ctx.iconic(args[0]));
    const feats = (typeof MetrologyUI !== 'undefined' && MetrologyUI.listVal)
      ? MetrologyUI.listVal(args[2], ctx).map(String)
      : [String(args[2] === undefined ? 'area' : args[2])];
    const op = strKind(args[3], ctx, 'and', ['and', 'or'], 'select_shape');
    const mins = numberList(args[4], ctx), maxs = numberList(args[5], ctx);
    if (!feats.length || mins.some(v => !Number.isFinite(v)) || maxs.some(v => !Number.isFinite(v))) {
      throw new Error('select_shape: Features/Min/Max must be feature names and matching numbers');
    }
    const boxes = labelBoxes(regs);
    const ids = [];
    for (let l = 1; l <= regs.count; l++) {
      let hit = null;
      for (let k = 0; k < feats.length; k++) {
        const lo = mins[Math.min(k, mins.length - 1)], hi = maxs[Math.min(k, maxs.length - 1)];
        const v = shapeFeature(regs, boxes, l, feats[k]);
        const ok = v >= lo && v <= hi;
        hit = hit === null ? ok : (op === 'and' ? hit && ok : hit || ok);
      }
      if (hit) ids.push(l);
    }
    const out = {
      kind: 'selected', type: `region array (${ids.length})`,
      count: ids.length, ids, labels: regs.labels, areas: regs.areas, cents: regs.cents,
      w: regs.w, h: regs.h,
      dispose() {},
    };
    if (regs.labels) out.canvas = ocvLabelsToOverlay(regs.labels, regs.w, regs.h, ids);
    if (regs.mat && ids.length) { out.mat = regs.mat; if (!out.canvas) out.canvas = regs.canvas; }
    ctx.defIconic(args[1], out);
  },

  count_obj(args, ctx) {
    const rec = ctx.iconic(args[0]);
    ctx.defCtrl(args[1], rec.ids ? rec.ids.length : (rec.count || 1), 'integer');
  },

  area_center(args, ctx) {
    const rec = ctx.iconic(args[0]);
    const ids = rec.ids || Array.from({ length: rec.count }, (_, i) => i + 1);
    const A = ids.map(i => rec.areas[i]);
    const R = ids.map(i => rec.cents[i][1].toFixed(1));
    const C = ids.map(i => rec.cents[i][0].toFixed(1));
    ctx.defCtrl(args[1], `[${A.join(', ')}]`, `integer tuple (${A.length})`);
    ctx.defCtrl(args[2], `[${R.join(', ')}]`, `real tuple (${R.length})`);
    ctx.defCtrl(args[3], `[${C.join(', ')}]`, `real tuple (${C.length})`);
  },

  /* ---- region generation (gen_*) -----------------------------------------
     Regions built from geometric parameters instead of from an image.  The
     mask has the size of the current image, so a generated region lines up with
     the image that is displayed — and with the contours of the gen_*_contour_xld
     operators. */
  gen_rectangle1(args, ctx) {                              // Region, Row1, Column1, Row2, Column2
    const r1 = numArgList(args[1], ctx), c1 = numArgList(args[2], ctx);
    const r2 = numArgList(args[3], ctx), c2 = numArgList(args[4], ctx);
    if (!r1.length || !c1.length || !r2.length || !c2.length) {
      throw new Error('gen_rectangle1: Row1/Column1/Row2/Column2 must be numbers or tuples of numbers');
    }
    const { mask } = genMask(ctx);
    const n = Math.max(r1.length, c1.length, r2.length, c2.length);
    const at = (l, i) => l[Math.min(i, l.length - 1)];
    for (let i = 0; i < n; i++) {
      const y0 = Math.round(Math.min(at(r1, i), at(r2, i))), y1 = Math.round(Math.max(at(r1, i), at(r2, i)));
      const x0 = Math.round(Math.min(at(c1, i), at(c2, i))), x1 = Math.round(Math.max(at(c1, i), at(c2, i)));
      cv.rectangle(mask, new cv.Point(x0, y0), new cv.Point(x1, y1), new cv.Scalar(255), cv.FILLED);
    }
    defineGenRegion(ctx, 'gen_rectangle1', args[0], mask,
      n > 1 ? `rectangle region (${n} rectangles) created` : 'rectangle region created');
  },

  gen_rectangle2(args, ctx) {                              // Rectangle, Row, Column, Phi, Length1, Length2
    const inst = dispInstances(ctx, [
      { tok: args[1] }, { tok: args[2] }, { tok: args[3], def: [0] }, { tok: args[4] }, { tok: args[5] },
    ]);
    if (!inst) throw new Error('gen_rectangle2: Row/Column/Length1/Length2 must be numbers or tuples of numbers');
    if (inst.some(([, , , l1, l2]) => l1 < 0 || l2 < 0)) throw new Error('gen_rectangle2: Length1/Length2 must be >= 0');
    const { mask } = genMask(ctx);
    for (const [row, col, phi, l1, l2] of inst) fillMaskPolygon(mask, rect2Corners(row, col, phi, l1, l2));
    defineGenRegion(ctx, 'gen_rectangle2', args[0], mask,
      inst.length > 1 ? `rectangle region (${inst.length} rectangles) created` : 'rectangle region created');
  },

  gen_circle(args, ctx) {                                  // Circle, Row, Column, Radius
    const inst = dispInstances(ctx, [{ tok: args[1] }, { tok: args[2] }, { tok: args[3] }]);
    if (!inst) throw new Error('gen_circle: Row/Column/Radius must be numbers or tuples of numbers');
    if (inst.some(([, , r]) => r < 0.5)) throw new Error('gen_circle: Radius must be >= 0.5');
    const { mask } = genMask(ctx);
    for (const [row, col, r] of inst) {
      cv.circle(mask, new cv.Point(Math.round(col), Math.round(row)), Math.round(r), new cv.Scalar(255), cv.FILLED);
    }
    defineGenRegion(ctx, 'gen_circle', args[0], mask,
      inst.length > 1 ? `circle region (${inst.length} circles) created` : 'circle region created');
  },

  gen_ellipse(args, ctx) {                                 // Ellipse, Row, Column, Phi, Radius1, Radius2
    const inst = dispInstances(ctx, [
      { tok: args[1] }, { tok: args[2] }, { tok: args[3], def: [0] }, { tok: args[4] }, { tok: args[5] },
    ]);
    if (!inst) throw new Error('gen_ellipse: Row/Column/Radius1/Radius2 must be numbers or tuples of numbers');
    if (inst.some(([, , , a, b]) => a <= 0 || b <= 0)) throw new Error('gen_ellipse: Radius1/Radius2 must be > 0');
    const { mask } = genMask(ctx);
    for (const [row, col, phi, ra, rb] of inst) {
      cv.ellipse(mask, new cv.Point(Math.round(col), Math.round(row)),
        new cv.Size(Math.round(ra), Math.round(rb)), (phi || 0) * 180 / Math.PI,
        0, 360, new cv.Scalar(255), cv.FILLED);
    }
    defineGenRegion(ctx, 'gen_ellipse', args[0], mask,
      inst.length > 1 ? `ellipse region (${inst.length} ellipses) created` : 'ellipse region created');
  },

  gen_region_line(args, ctx) {                             // RegionLines, BeginRow, BeginCol, EndRow, EndCol
    const inst = dispInstances(ctx, [{ tok: args[1] }, { tok: args[2] }, { tok: args[3] }, { tok: args[4] }]);
    if (!inst) throw new Error('gen_region_line: BeginRow/BeginCol/EndRow/EndCol must be numbers or tuples of numbers');
    const { mask } = genMask(ctx);
    for (const [r1, c1, r2, c2] of inst) {
      cv.line(mask, new cv.Point(Math.round(c1), Math.round(r1)),
        new cv.Point(Math.round(c2), Math.round(r2)), new cv.Scalar(255), 1);
    }
    defineGenRegion(ctx, 'gen_region_line', args[0], mask,
      inst.length > 1 ? `line region (${inst.length} lines) created` : 'line region created');
  },

  gen_region_polygon(args, ctx) {                          // Region, Row, Col
    genPolygonRegion(args, ctx, 'gen_region_polygon', false);
  },

  gen_region_polygon_filled(args, ctx) {                   // Region, Row, Col
    genPolygonRegion(args, ctx, 'gen_region_polygon_filled', true);
  },

  dev_display(args, ctx) {
    /* displays the object(s) in the active window; HDevelop also accepts an
       object tuple, e.g. dev_display ([Image, Region]) */
    const raw = String(args[0] == null ? '' : args[0]).trim();
    const list = /^\[.*\]$/.test(raw)
      ? raw.slice(1, -1).split(',').map(s => s.trim()).filter(Boolean)
      : [raw];
    if (!list.length || !list[0]) throw new Error('dev_display: no object given');
    for (const name of list) {
      const rec = ctx.iconic(name);
      if (!rec) throw new Error(`dev_display: iconic object '${name}' is not defined`);
      if (rec.kind === 'image') ctx.displayImage(name);
      else ctx.displayOverlay(name);
    }
  },

  disp_message(args, ctx) {                                // WindowHandle, String, CoordSystem, Row, Column, Color, Box
    const txt = args[1].split('+').map(t => {
      t = t.trim();
      if (t.startsWith("'")) return t.replace(/'/g, '');
      const v = ctx.ctrl(t);
      return v !== undefined ? String(v) : t;
    }).join('');
    let h = ctx.ctrl(args[0]);
    if (h === undefined) h = +String(args[0]).replace(/'/g, '');
    const unq = v => String(v == null ? '' : v).replace(/'/g, '').trim();
    const cs = unq(args[2]) || 'window';
    ctx.setMessage(txt, Number.isInteger(h) ? h : undefined, {
      cs: cs === 'image' ? 'image' : 'window',
      row: numArg(args[3], ctx, 12),
      col: numArg(args[4], ctx, 12),
      color: unq(args[5]) || 'green',
      box: unq(args[6]) || 'true',
    });
  },

  /* ---- drawing primitives (disp_*) ----------------------------------------
     These draw straight into a graphics window and produce no iconic result:
     the window keeps them in its display history (paintPrimitive in app.js),
     with the dev_set_color / dev_set_draw / dev_set_line_width that were in
     effect.  Coordinates are image coordinates (Row = y, Column = x), all
     coordinate arguments accept tuples, and a window handle of 0 (or an empty
     argument) means the active window. */
  disp_cross(args, ctx) {                                  // WindowHandle, Row, Column, Size, Angle
    const inst = dispInstances(ctx, [
      { tok: args[1] }, { tok: args[2] }, { tok: args[3], def: [20] }, { tok: args[4], def: [0] },
    ]);
    if (!inst) throw new Error('disp_cross: Row/Column must be numbers or tuples of numbers');
    ctx.dispPrimitive(dispWindow(args[0], ctx), {
      kind: 'cross',
      shapes: inst.map(([row, col, size, angle]) => ({ row, col, size, angle })),
    });
  },

  disp_line(args, ctx) {                                   // WindowHandle, Row1, Column1, Row2, Column2
    const inst = dispInstances(ctx, [{ tok: args[1] }, { tok: args[2] }, { tok: args[3] }, { tok: args[4] }]);
    if (!inst) throw new Error('disp_line: Row1/Column1/Row2/Column2 must be numbers or tuples of numbers');
    ctx.dispPrimitive(dispWindow(args[0], ctx), {
      kind: 'line',
      shapes: inst.map(([row1, col1, row2, col2]) => ({ row1, col1, row2, col2 })),
    });
  },

  disp_arrow(args, ctx) {                                  // WindowHandle, Row1, Column1, Row2, Column2, Size
    const inst = dispInstances(ctx, [
      { tok: args[1] }, { tok: args[2] }, { tok: args[3] }, { tok: args[4] }, { tok: args[5], def: [20] },
    ]);
    if (!inst) throw new Error('disp_arrow: Row1/Column1/Row2/Column2 must be numbers or tuples of numbers');
    ctx.dispPrimitive(dispWindow(args[0], ctx), {
      kind: 'arrow',
      shapes: inst.map(([row1, col1, row2, col2, size]) => ({ row1, col1, row2, col2, size })),
    });
  },

  disp_circle(args, ctx) {                                 // WindowHandle, Row, Column, Radius
    const inst = dispInstances(ctx, [{ tok: args[1] }, { tok: args[2] }, { tok: args[3] }]);
    if (!inst) throw new Error('disp_circle: Row/Column/Radius must be numbers or tuples of numbers');
    ctx.dispPrimitive(dispWindow(args[0], ctx), {
      kind: 'circle',
      shapes: inst.map(([row, col, radius]) => ({ row, col, radius })),
    });
  },

  disp_ellipse(args, ctx) {                                // WindowHandle, Row, Column, Phi, Radius1, Radius2
    const inst = dispInstances(ctx, [
      { tok: args[1] }, { tok: args[2] }, { tok: args[3], def: [0] }, { tok: args[4] }, { tok: args[5] },
    ]);
    if (!inst) throw new Error('disp_ellipse: Row/Column/Radius1/Radius2 must be numbers or tuples of numbers');
    ctx.dispPrimitive(dispWindow(args[0], ctx), {
      kind: 'ellipse',
      shapes: inst.map(([row, col, phi, ra, rb]) => ({ row, col, phi, ra, rb })),
    });
  },

  disp_rectangle1(args, ctx) {                             // WindowHandle, Row1, Column1, Row2, Column2
    const inst = dispInstances(ctx, [{ tok: args[1] }, { tok: args[2] }, { tok: args[3] }, { tok: args[4] }]);
    if (!inst) throw new Error('disp_rectangle1: Row1/Column1/Row2/Column2 must be numbers or tuples of numbers');
    ctx.dispPrimitive(dispWindow(args[0], ctx), {
      kind: 'rectangle1',
      shapes: inst.map(([row1, col1, row2, col2]) => ({ row1, col1, row2, col2 })),
    });
  },

  disp_rectangle2(args, ctx) {                             // WindowHandle, Row, Column, Phi, Length1, Length2
    const inst = dispInstances(ctx, [
      { tok: args[1] }, { tok: args[2] }, { tok: args[3], def: [0] }, { tok: args[4] }, { tok: args[5] },
    ]);
    if (!inst) throw new Error('disp_rectangle2: Row/Column/Length1/Length2 must be numbers or tuples of numbers');
    ctx.dispPrimitive(dispWindow(args[0], ctx), {
      kind: 'rectangle2',
      shapes: inst.map(([row, col, phi, length1, length2]) => ({ row, col, phi, length1, length2 })),
    });
  },

  disp_polygon(args, ctx) {                                // WindowHandle, Row, Column
    const rows = numArgList(args[1], ctx), cols = numArgList(args[2], ctx);
    if (rows.length < 2 || rows.length !== cols.length) {
      throw new Error('disp_polygon: Row and Column must be equally long point lists (>= 2)');
    }
    ctx.dispPrimitive(dispWindow(args[0], ctx), { kind: 'polygon', shapes: [{ rows, cols }] });
  },

  /* HALCON's object-first spellings of dev_display */
  disp_obj(args, ctx) {                                    // Object, WindowHandle
    dispObject(args, ctx, 'disp_obj', 'any');
  },
  disp_region(args, ctx) {                                 // Regions, WindowHandle
    dispObject(args, ctx, 'disp_region', 'region');
  },
  disp_image(args, ctx) {                                  // Image, WindowHandle
    dispObject(args, ctx, 'disp_image', 'image');
  },

  dev_open_window(args, ctx) {
    const handle = ctx.openWindow({
      row: numArg(args[0], ctx, 0),
      col: numArg(args[1], ctx, 0),
      width: numArg(args[2], ctx, 640),
      height: numArg(args[3], ctx, 480),
      background: args[4] || 'black',
    });
    ctx.defCtrl(args[5], handle, 'integer');
    ctx.log(`dev_open_window: graphics window ${handle} opened (now the active window).`);
  },

  dev_close_window(args, ctx) {                            // closes the active floating window
    ctx.closeWindow(ctx.getActiveWindow());
  },

  close_window(args, ctx) {                                // HALCON form: close_window(WindowHandle)
    let h = ctx.ctrl(args[0]);
    if (h === undefined) h = +String(args[0]).replace(/'/g, '');
    ctx.closeWindow(Number.isInteger(h) ? h : ctx.getActiveWindow());
  },

  dev_set_window(args, ctx) {                              // switch the active output window
    let h = ctx.ctrl(args[0]);
    if (h === undefined) h = +String(args[0]).replace(/'/g, '');
    ctx.setActiveWindow(h);
  },

  dev_get_window(args, ctx) {                              // handle of the active window
    ctx.defCtrl(args[0], ctx.getActiveWindow(), 'integer');
  },

  dev_clear_window(args, ctx) {                            // clear the active window
    ctx.clearWindow();
  },

  /* ---- display parameters -------------------------------------------------
     HDevelop: the settings stay in effect until they are changed and are
     inherited by every graphics window opened afterwards.  They apply to the
     objects displayed afterwards (and to the window's history redraw). */
  dev_set_color(args, ctx) {                               // ColorName or #rrggbb / #rrggbbaa
    const name = String(args[0] == null ? '' : args[0]).replace(/'/g, '').trim();
    ctx.setDisplayParams({ color: name || null, colored: 0 });
  },

  dev_set_colored(args, ctx) {                             // 3 | 6 | 12 colors
    const n = numArg(args[0], ctx, 6);
    ctx.setDisplayParams({ colored: [3, 6, 12].includes(n) ? n : 6, color: null });
  },

  dev_set_draw(args, ctx) {                                // 'fill' (default) | 'margin'
    const m = String(args[0] == null ? '' : args[0]).replace(/'/g, '').trim().toLowerCase();
    if (m !== 'fill' && m !== 'margin') throw new Error("dev_set_draw: mode must be 'fill' or 'margin'");
    ctx.setDisplayParams({ draw: m });
  },

  dev_set_line_width(args, ctx) {                          // integer >= 1
    const w = numArg(args[0], ctx, 1);
    if (!(w >= 1)) throw new Error('dev_set_line_width: line width must be >= 1');
    ctx.setDisplayParams({ lineWidth: Math.round(w) });
  },

  dev_set_part(args, ctx) {                                // Row1, Column1, Row2, Column2
    ctx.setPart(numArg(args[0], ctx, 0), numArg(args[1], ctx, 0), numArg(args[2], ctx, -1), numArg(args[3], ctx, -1));
  },

  dev_update_window(args, ctx) {                           // 'on' (default) | 'off'
    const s = String(args[0] == null ? '' : args[0]).replace(/'/g, '').trim().toLowerCase();
    ctx.setUpdateWindow(s !== 'off');
    ctx.log(`dev_update_window: automatic display of iconic operator results ${s === 'off' ? 'off' : 'on'}.`);
  },

  dev_set_paint(args, ctx) {                               // mode 'default' | '3d_plot' | 'histogram' | 'bars'
    const m = String(args[0] == null ? '' : args[0]).replace(/'/g, '').trim().toLowerCase();
    if (m && m !== 'default') ctx.log(`dev_set_paint ('${m}'): only the default paint mode is supported.`, 'warn');
  },

  dev_set_lut(args, ctx) {                                 // colour lookup table: ignored
    ctx.log('dev_set_lut: colour lookup tables are not supported (ignored).', 'warn');
  },

  /* Frame grabber emulation on the browser camera API (getUserMedia).
     The HALCON interface name ('DirectShow', 'GigEVision', ...) is accepted
     for program compatibility. Falls back to a simulated test-pattern
     source when no camera is available (or permission is denied). */
  async open_framegrabber(args, ctx) {
    const name = args[0].replace(/'/g, '');
    let stream = null, video = null;
    try {
      if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
        stream = await Promise.race([
          navigator.mediaDevices.getUserMedia({ video: true }),
          new Promise((_, rej) => setTimeout(() => rej(new Error('camera timeout')), 10000)),
        ]);
        video = document.createElement('video');
        video.muted = true;
        video.srcObject = stream;
        await video.play();
      }
    } catch (e) {
      stream = null; video = null;
    }
    const handle = GRABBER_SEQ++;
    GRABBERS.set(handle, { stream, video, canvas: null, tick: 0 });
    ctx.defCtrl(args[17], handle, 'integer');
    ctx.log(stream
      ? `open_framegrabber: '${name}' opened via browser camera (getUserMedia), handle ${handle}`
      : `open_framegrabber: '${name}' — no camera available, using SIMULATED test-pattern source (handle ${handle})`, stream ? 'msg' : 'warn');
  },

  grab_image(args, ctx) {
    ocvGrabHandle(ctx.ctrl(args[1]), args[0], ctx);
  },

  grab_image_async(args, ctx) {
    return OP_IMPLS.grab_image(args, ctx);
  },

  close_framegrabber(args, ctx) {
    const handle = ctx.ctrl(args[0]);
    const g = GRABBERS.get(handle);
    if (!g) return;
    releaseGrabber(g);
    GRABBERS.delete(handle);
    ctx.log(`close_framegrabber: handle ${handle} closed, camera released.`);
  },

  /* ---- operators of imported HDevelop programs ---------------------------
     The small, frequently used part of the "system"/"file"/"tools" operator
     families that HDevelop example programs rely on. */

  dev_update_on(args, ctx) {
    ctx.setUpdateWindow(true);
    ctx.log('dev_update_on: automatic display of iconic operator results on.');
  },

  dev_update_off(args, ctx) {
    ctx.setUpdateWindow(false);
    ctx.log('dev_update_off: automatic display of iconic operator results off.');
  },

  list_image_files(args, ctx) {                            // Directory, Extensions, Options : ImageFiles
    /* a page cannot enumerate a folder, so the image files of the session are
       listed: the built-in demo image plus every file loaded with "Load file…".
       HALCON sorts the names ('default' sort order), so they are sorted here as
       well — ImageFiles[0] is then the first name in the folder. */
    const sortNames = (a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });
    const names = Array.from(IMAGE_SOURCES.keys()).sort(sortNames);
    if (!names.length) names.push(BUILTIN_IMAGE);
    ctx.defCtrl(args[3], `[${names.map(n => `'${n}'`).join(', ')}]`,
      names.length === 1 ? 'string' : `string tuple (${names.length})`);
    ctx.log(`list_image_files: ${names.length} image file(s) available (${names.map(n => `'${n}'`).join(', ')}).`);
    if (names.length < 5) {
      ctx.log("list_image_files: a page cannot read a folder — load the image files of the program's " +
        'folder with "Load file…" to make ImageFiles[0…n] available.', 'warn');
    }
  },

  mean_image(args, ctx) {                                  // Image : ImageMean : MaskWidth, MaskHeight
    const img = ctx.iconic(args[0]);
    let w = Math.round(numArg(args[2], ctx, 9)), h = Math.round(numArg(args[3], ctx, 9));
    if (!(w >= 1)) w = 9;
    if (!(h >= 1)) h = 9;
    if (w % 2 === 0) w++;
    if (h % 2 === 0) h++;
    const dst = new cv.Mat();
    cv.blur(img.mat, dst, new cv.Size(w, h));
    ctx.defIconic(args[1], {
      kind: 'image', type: 'image (byte)',
      mat: dst, canvas: ocvGrayToCanvas(dst),
      gray: dst.data.slice(0, dst.cols * dst.rows),
      dispose() { dst.delete(); },
    });
    ctx.log(`mean_image: ${w}x${h} mean filter applied (byte image).`);
  },

  dyn_threshold(args, ctx) {              // OrigImage, ThresholdImage : RegionDynThresh : Offset, LightDark
    const orig = ctx.iconic(args[0]);
    const thr = ctx.iconic(args[1]);
    if (orig.mat.cols !== thr.mat.cols || orig.mat.rows !== thr.mat.rows) {
      throw new Error('dyn_threshold: OrigImage and ThresholdImage must have the same size');
    }
    const offset = numArg(args[3], ctx, 5);
    const mode = strKind(args[4], ctx, 'light', ['light', 'dark', 'equal', 'not_equal'], 'dyn_threshold');
    const diff = new cv.Mat(), dst = new cv.Mat();
    if (mode === 'light') {                                // g > ThresholdImage + Offset
      cv.subtract(orig.mat, thr.mat, diff);
      cv.threshold(diff, dst, offset, 255, cv.THRESH_BINARY);
    } else if (mode === 'dark') {                          // g < ThresholdImage - Offset
      cv.subtract(thr.mat, orig.mat, diff);
      cv.threshold(diff, dst, offset, 255, cv.THRESH_BINARY);
    } else if (mode === 'equal') {                         // |g - ThresholdImage| <= Offset
      cv.absdiff(orig.mat, thr.mat, diff);
      cv.threshold(diff, dst, offset, 255, cv.THRESH_BINARY_INV);
    } else {                                               // 'not_equal'
      cv.absdiff(orig.mat, thr.mat, diff);
      cv.threshold(diff, dst, offset, 255, cv.THRESH_BINARY);
    }
    diff.delete();
    ctx.defIconic(args[2], {
      kind: 'region', type: 'region', mat: dst,
      canvas: ocvMaskToOverlay(dst, 236, 70, 60),
      dispose() { dst.delete(); },
    });
    ctx.log(`dyn_threshold: region from the local threshold (Offset ${offset}, LightDark '${mode}').`);
  },

  select_shape_std(args, ctx) {                            // Regions : SelectedRegions : Shape, Percent
    const regs = ctx.iconic(args[0]);
    const feature = strKind(args[2], ctx, 'max_area',
      ['max_area', 'min_area', 'original', 'rectangle1', 'rectangle2'], 'select_shape_std');
    if (feature === 'original') { ctx.defIconic(args[1], regs); return; }
    if (!regs.labels || !regs.count) {
      ctx.defIconic(args[1], regs);                        // a single region is trivially extreme
      ctx.log(`select_shape_std ('${feature}'): the single input region is selected.`);
      return;
    }
    const ids = regs.ids || Array.from({ length: regs.count }, (_, i) => i + 1);
    if (!ids.length) throw new Error('select_shape_std: the input region array is empty');
    const area = id => (regs.areas && Number.isFinite(regs.areas[id])) ? regs.areas[id] : 0;
    const select = sel => ctx.defIconic(args[1], {
      kind: 'selected', type: `region array (${sel.length})`, count: sel.length, ids: sel,
      labels: regs.labels, areas: regs.areas, cents: regs.cents, w: regs.w, h: regs.h,
      canvas: ocvLabelsToOverlay(regs.labels, regs.w, regs.h, sel),
      dispose() {},
    });
    if (feature === 'max_area' || feature === 'min_area') {
      let best = ids[0];
      for (const id of ids) {
        if (feature === 'max_area' ? area(id) > area(best) : area(id) < area(best)) best = id;
      }
      select([best]);
      ctx.log(`select_shape_std ('${feature}'): region ${best} of ${ids.length} selected (area ${area(best)}).`);
      return;
    }
    /* 'rectangle1' / 'rectangle2': HALCON adopts a region when its area
       differs from the area of the enclosing rectangle by more than
       Percent percent. */
    const percent = numArg(args[3], ctx, 70);
    const boxes = labelBoxes(regs);
    const masks = feature === 'rectangle2' ? regionMats(regs) : null;
    const sel = [];
    try {
      ids.forEach((id, k) => {
        let rectArea = 0;
        if (feature === 'rectangle1') {
          const box = boxes && boxes[id];
          if (!box) return;
          rectArea = (box[3] - box[1] + 1) * (box[2] - box[0] + 1);
        } else {
          const m = masks && masks[k];
          const pts = m ? maskPointMat(m.mask) : null;
          if (!pts) return;
          const r = cv.minAreaRect(pts);
          pts.delete();
          rectArea = r.size.width * r.size.height;
        }
        const diff = rectArea > 0 ? 100 * (rectArea - area(id)) / rectArea : 0;
        if (diff > percent) sel.push(id);
      });
    } finally {
      if (masks) masks.forEach(m => { if (m.owned) m.mask.delete(); });
    }
    select(sel);
    ctx.log(`select_shape_std ('${feature}'): ${sel.length} of ${ids.length} region(s) selected ` +
      `(area difference > ${percent}%).`);
  },

  smallest_rectangle2(args, ctx) {   // Regions : Row, Column, Phi, Length1, Length2
    const rec = ctx.iconic(args[0]);
    const regions = regionMats(rec);
    if (!regions.length) throw new Error('smallest_rectangle2: the input contains no region');
    const Row = [], Column = [], Phi = [], L1 = [], L2 = [];
    for (const { mask, owned } of regions) {
      const pts = maskPointMat(mask);
      if (owned) mask.delete();
      if (pts) {
        const r = cv.minAreaRect(pts);
        /* minAreaRect: centre and size of the smallest enclosing rectangle.
           HALCON wants Phi of the longer side, Length1 >= Length2 and half edge
           lengths — the corners are used instead of the (OpenCV version
           dependent) angle of minAreaRect, see boxPoints. */
        const c = rectCorners(r);
        pts.delete();
        let edge = 0, len = -1;
        for (let k = 0; k < 4; k++) {
          const a = c[k], b = c[(k + 1) % 4];
          const l = Math.hypot(b[0] - a[0], b[1] - a[1]);
          if (l > len) { len = l; edge = k; }
        }
        const a = c[edge], b = c[(edge + 1) % 4];
        let phi = Math.atan2(b[1] - a[1], b[0] - a[0]);
        while (phi > Math.PI / 2) phi -= Math.PI;
        while (phi <= -Math.PI / 2) phi += Math.PI;
        Row.push((c[0][1] + c[1][1] + c[2][1] + c[3][1]) / 4);
        Column.push((c[0][0] + c[1][0] + c[2][0] + c[3][0]) / 4);
        Phi.push(phi);
        L1.push(len / 2);
        L2.push(Math.hypot(c[(edge + 2) % 4][0] - b[0], c[(edge + 2) % 4][1] - b[1]) / 2);
      } else {
        pts && pts.delete();
      }
    }
    MetrologyUI.defTuple(ctx, args[1], Row, 'real');
    MetrologyUI.defTuple(ctx, args[2], Column, 'real');
    MetrologyUI.defTuple(ctx, args[3], Phi, 'real');
    MetrologyUI.defTuple(ctx, args[4], L1, 'real');
    MetrologyUI.defTuple(ctx, args[5], L2, 'real');
    ctx.log(`smallest_rectangle2: enclosing rectangle(s) computed for ${Row.length} region(s).`);
  },

  distance_pp(args, ctx) {                       // Row1, Column1, Row2, Column2 : Distance
    const r1 = numArgList(args[0], ctx), c1 = numArgList(args[1], ctx);
    const r2 = numArgList(args[2], ctx), c2 = numArgList(args[3], ctx);
    if (!r1.length || !c1.length || !r2.length || !c2.length) {
      throw new Error('distance_pp: Row1, Column1, Row2, Column2 must be numbers or tuples of numbers');
    }
    const at = (l, i) => l[Math.min(i, l.length - 1)];
    const n = Math.max(r1.length, c1.length, r2.length, c2.length);
    const d = [];
    for (let i = 0; i < n; i++) d.push(Math.hypot(at(r1, i) - at(r2, i), at(c1, i) - at(c2, i)));
    MetrologyUI.defTuple(ctx, args[4], d, 'real');
  },

  angle_lx(args, ctx) {                          // Row1, Column1, Row2, Column2 : Angle
    const r1 = numArgList(args[0], ctx), c1 = numArgList(args[1], ctx);
    const r2 = numArgList(args[2], ctx), c2 = numArgList(args[3], ctx);
    if (!r1.length || !c1.length || !r2.length || !c2.length) {
      throw new Error('angle_lx: Row1, Column1, Row2, Column2 must be numbers or tuples of numbers');
    }
    const at = (l, i) => l[Math.min(i, l.length - 1)];
    const n = Math.max(r1.length, c1.length, r2.length, c2.length);
    const a = [];
    for (let i = 0; i < n; i++) {
      a.push(Math.atan2(at(r2, i) - at(r1, i), at(c2, i) - at(c1, i)));
    }
    MetrologyUI.defTuple(ctx, args[4], a, 'real');
  },

  parse_filename(args, ctx) {              // FileName : : BaseName, Extension, Directory
    const full = controlString(args[0], ctx);
    const norm = String(full).replace(/\\/g, '/');
    const slash = norm.lastIndexOf('/');
    const dir = slash >= 0 ? norm.slice(0, slash + 1) : '';
    const file = slash >= 0 ? norm.slice(slash + 1) : norm;
    const dot = file.lastIndexOf('.');
    const base = dot > 0 ? file.slice(0, dot) : file;
    const ext = dot > 0 ? file.slice(dot) : '';
    ctx.defCtrl(args[1], base, 'string');
    ctx.defCtrl(args[2], ext, 'string');
    ctx.defCtrl(args[3], dir, 'string');
    ctx.log(`parse_filename: '${full}' — base '${base}', extension '${ext}', directory '${dir}'.`);
  },

  open_file(args, ctx) {                   // FileName, FileType : FileHandle
    const name = controlString(args[0], ctx);
    const type = strKind(args[1], ctx, 'output', ['output', 'input'], 'open_file');
    if (type === 'input') throw new Error("open_file: only 'output' files are supported in this build");
    const handle = FILE_SEQ++;
    OPEN_FILES.set(handle, { name, chunks: [] });
    ctx.defCtrl(args[2], handle, 'integer');
    ctx.log(`open_file: '${name}' opened for output (handle ${handle}).`);
  },

  fwrite_string(args, ctx) {               // FileHandle, String
    const handle = Math.round(numArg(args[0], ctx, NaN));
    const f = OPEN_FILES.get(handle);
    if (!f) throw new Error(`fwrite_string: invalid file handle ${args[0]}`);
    f.chunks.push(stringExpr(args[1], ctx));
  },

  close_file(args, ctx) {                  // FileHandle
    const handle = Math.round(numArg(args[0], ctx, NaN));
    const f = OPEN_FILES.get(handle);
    if (!f) throw new Error(`close_file: invalid file handle ${args[0]}`);
    OPEN_FILES.delete(handle);
    const text = f.chunks.join('');
    let saved = false;
    try {                                  // a page cannot write to disk: offer a download instead
      const url = URL.createObjectURL(new Blob([text], { type: 'text/plain' }));
      const a = document.createElement('a');
      a.href = url;
      a.download = String(f.name).split(/[\\/]/).pop() || 'output.txt';
      document.body.appendChild(a);
      a.click();
      a.remove();
      setTimeout(() => URL.revokeObjectURL(url), 5000);
      saved = true;
    } catch (e) { /* download blocked — the log message still names the file */ }
    ctx.log(`close_file: '${f.name}' closed — ${text.length} character(s) written` +
      (saved ? ', offered as download.' : '.'));
  },
};

/* grab one frame from an acquisition handle into an iconic variable */
function ocvGrabHandle(handle, name, ctx) {
  const g = GRABBERS.get(handle);
  if (!g) throw new Error('grab_image: invalid acquisition handle');
  let gray;
  if (g.stream && g.video && g.video.videoWidth) {
    const v = g.video;
    if (!g.canvas) g.canvas = document.createElement('canvas');
    g.canvas.width = v.videoWidth;
    g.canvas.height = v.videoHeight;
    g.canvas.getContext('2d').drawImage(v, 0, 0);
    const rgba = cv.imread(g.canvas);
    gray = new cv.Mat();
    cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
    rgba.delete();
  } else {
    gray = cv.matFromArray(SIM_H, SIM_W, cv.CV_8UC1, Array.from(simCameraFrame(g.tick++)));
  }
  ctx.defIconic(name, {
    kind: 'image', type: `image (byte, ${gray.cols}x${gray.rows}${g.stream ? '' : ', simulated'})`,
    mat: gray, canvas: ocvGrayToCanvas(gray),
    gray: gray.data.slice(0, gray.cols * gray.rows),
    dispose() { gray.delete(); },
  });
}

/* acquisition handles */
const GRABBERS = new Map();
let GRABBER_SEQ = 1;

/* stop the camera track(s) of one acquisition handle and detach its video element */
function releaseGrabber(g) {
  if (g.stream) g.stream.getTracks().forEach(t => t.stop());
  if (g.video) { g.video.pause(); g.video.srcObject = null; }
}

/* release every acquisition handle and restart the handle numbers. The IDE
   calls this on a program reset (F2), so a stopped program never keeps the
   camera busy — and a re-run sees the same handles as the first run. */
function disposeGrabbers() {
  GRABBERS.forEach(releaseGrabber);
  GRABBERS.clear();
  GRABBER_SEQ = 1;
}

/* animated synthetic camera frame (simulated grabber source) */
const SIM_W = 640, SIM_H = 480;
function simCameraFrame(tick) {
  const g = new Uint8Array(SIM_W * SIM_H);
  for (let y = 0; y < SIM_H; y++)
    for (let x = 0; x < SIM_W; x++)
      g[y * SIM_W + x] = 28 + ((x * 7 + y * 13 + tick * 4) % 23);
  const sq = (cx, cy, s, v) => {
    for (let y = Math.max(0, cy); y < Math.min(SIM_H, cy + s); y++)
      for (let x = Math.max(0, cx); x < Math.min(SIM_W, cx + s); x++)
        g[y * SIM_W + x] = v;
  };
  sq(80 + (tick * 9) % 380, 90, 90, 210);
  sq(320 - (tick * 6) % 240, 260, 60, 180);
  sq(480, 120 + (tick * 5) % 260, 40, 235);
  return g;
}

