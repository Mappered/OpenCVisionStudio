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
    const want = imageArgName(args[1]);
    const known = IMAGE_SOURCES.get(want);
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

  select_shape(args, ctx) {                                // feature 'area', 'and', Min..Max
    const regs = ctx.iconic(args[0]);
    const min = +args[4], max = +args[5];
    const ids = [];
    for (let l = 1; l <= regs.count; l++)
      if (regs.areas[l] >= min && regs.areas[l] <= max) ids.push(l);
    ctx.defIconic(args[1], {
      kind: 'selected', type: `region array (${ids.length})`,
      count: ids.length, ids, labels: regs.labels, areas: regs.areas, cents: regs.cents,
      w: regs.w, h: regs.h,
      canvas: ocvLabelsToOverlay(regs.labels, regs.w, regs.h, ids),
      dispose() {},
    });
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

