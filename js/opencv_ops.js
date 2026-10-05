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

/* --------------------------------------------------------------------------
   PIXEL CANVASES

   The canvases that carry an image / region to the Graphics Window are built
   from the cv.Mat of the object, and a machine-vision frame is large (the
   example photos are 5088×3840, 19.5 M pixels).  Two rules keep that cheap:

     * expand gray to RGBA with OpenCV and hand the whole block to one
       putImageData, instead of looping over every pixel in JavaScript;
     * write overlay colours through a Uint32 view of the ImageData (assigning
       to the Uint8ClampedArray byte by byte is ~10× slower, because every
       write clamps), looking the colour of a mask value / label up in a table
       instead of re-computing it per pixel.

   Measured on a 5088×3840 photo: gray canvas 1450 ms -> 140 ms, threshold
   region overlay 1540 ms -> 160 ms, connection/select_shape overlay
   650 ms -> 200 ms.  Every read_image pays the first one.
   -------------------------------------------------------------------------- */

/* ImageData holds RGBA bytes, so the four channels can be written as one
   32-bit word; which byte of that word is red depends on the byte order of the
   platform, so the packing is detected once instead of assumed. */
const PACK_RGBA = (() => {
  const u32 = new Uint32Array([0x0a0b0c0d]);
  const lowFirst = new Uint8Array(u32.buffer)[0] === 0x0d;
  return lowFirst
    ? (r, g, b, a) => (((a << 24) | (b << 16) | (g << 8) | r) >>> 0)
    : (r, g, b, a) => (((r << 24) | (g << 16) | (b << 8) | a) >>> 0);
})();

/* gray cv.Mat (CV_8UC1) -> display canvas (the image the Graphics Window shows) */
function ocvGrayToCanvas(mat) {
  const rgba = new cv.Mat();
  cv.cvtColor(mat, rgba, cv.COLOR_GRAY2RGBA);      // r = g = b = gray, alpha opaque
  /* The RGBA block of a 5088×3840 frame is 78 MB and handing it over as a copy
     costs ~55 ms — so the canvas gets a *view* on the WASM heap instead.  The
     ImageData only reads it, putImageData copies into the canvas at once, and
     nothing allocates inside the WASM heap in between, so the heap cannot grow
     (a growth would detach the view); the Mat is freed right after. */
  const id = new ImageData(
    new Uint8ClampedArray(rgba.data.buffer, rgba.data.byteOffset, rgba.data.length),
    mat.cols, mat.rows);
  const c = document.createElement('canvas');
  c.width = mat.cols; c.height = mat.rows;
  c.getContext('2d').putImageData(id, 0, 0);
  rgba.delete();
  return c;
}

/* binary mask cv.Mat (0/255, any non-zero counts as set) -> translucent
   colored overlay canvas.

   A zeroed RGBA block the size of the bounding box, one *masked* Mat.setTo
   writes the colour where the mask is set and leaves the rest transparent, and
   the block reaches the canvas in a single putImageData — every step runs in
   OpenCV or in Chromium, and only over the region, never over the frame.  The
   JavaScript walk over 19.5 M pixels this replaces was ~90 ms of the ~130 ms
   the operator used to cost.

   The colour used to come from a colour block of the whole frame kept between
   calls (a 5088x3840 RGBA block is 78 MB) that a ROI copy read from.  Measured
   on the real program this file is developed with: a program with three region
   colours (dyn_threshold 236,70,60 / connection 80,190,120 / select_shape
   255,215,64) thrashed a two entry cache, so a 78 MB block was rebuilt on
   nearly every call — 58-80 ms for a call that costs 25-30 ms with masked
   setTo — and the cache sat on 150 MB of WASM heap.  Both write the same
   pixels (compared byte for byte over a 13.4 M pixel region: no difference).

   Only the bounding box of the mask can hold set pixels and a region is
   usually a fraction of the frame (a 181x181 blob in the 5088x3840 photo:
   0.03 % of it), so the block is built for the bounding box and put into the
   canvas at that offset.  cv.boundingRect is a single C++ scan (0.2 ms) that
   saves walking the rest of the frame. */
function ocvMaskToOverlay(mat, r, g, b) {
  const w = mat.cols, h = mat.rows;
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const bb = cv.boundingRect(mat);
  if (!bb.width || !bb.height) return canvas;      // empty region: nothing to paint
  const sub = mat.roi(new cv.Rect(bb.x, bb.y, bb.width, bb.height));   // a view, no pixel is copied
  const block = new cv.Mat(bb.height, bb.width, cv.CV_8UC4, new cv.Scalar(0, 0, 0, 0));
  /* The Scalar reaches the channels in memory order, i.e. as the four RGBA
     bytes an ImageData expects, so the arguments are (r, g, b, alpha). */
  block.setTo(new cv.Scalar(r, g, b, 150), sub);   // the colour where the mask is set
  /* The ImageData is a view on the WASM heap.  putImageData copies out of it at
     once and nothing allocates inside the heap in between, so a heap growth
     cannot detach the view (the same reason ocvGrayToCanvas gets away with it). */
  ctx.putImageData(new ImageData(
    new Uint8ClampedArray(block.data.buffer, block.data.byteOffset, block.data.length),
    bb.width, bb.height), bb.x, bb.y);
  sub.delete(); block.delete();
  return canvas;
}

/* label image (Int32Array) -> colored overlay; ids restricts to a subset (green).
   A label id gets its colour once, and the id → colour table is a typed array
   (the labels of a normal program are small numbers); ids beyond that table are
   kept in a map, so even a pathological labelling stays correct.

   With a subset, `boxes` (the per-element bounding boxes of the region array)
   shortens the walk to the pixels of the selected elements only: every element
   lies inside its own box, so no pixel elsewhere can carry a selected label.
   `select_shape` / `select_shape_std` pick a handful of small blobs out of a
   19.5 M pixel frame, and the overlay is then built in their corner instead of
   over the whole image — the operator no longer pays for the frame size. */
function ocvLabelsToOverlay(labels, w, h, ids, boxes) {
  const green = PACK_RGBA(80, 200, 120, 165);
  if (ids && !ids.length) {                          // nothing selected: a blank overlay
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    return canvas;
  }
  if (ids && boxes && ids.every(id => boxes[id])) {
    const canvas = document.createElement('canvas');
    canvas.width = w; canvas.height = h;
    const ctx = canvas.getContext('2d');
    /* one block per selected element, drawn at the element's own bounding box:
       an element lies inside its box, so a small blob costs its own pixels and
       nothing of the surrounding 19.5 M pixel frame (not even a full-frame
       putImageData, which is the expensive part). */
    for (const id of ids) {
      const b = boxes[id];
      const y1 = Math.max(0, b[0]), y2 = Math.min(h - 1, b[2]);
      const x1 = Math.max(0, b[1]), x2 = Math.min(w - 1, b[3]);
      if (y2 < y1 || x2 < x1) continue;
      const bw = x2 - x1 + 1, bh = y2 - y1 + 1;
      const block = ctx.createImageData(bw, bh);
      const u32 = new Uint32Array(block.data.buffer);
      for (let r = 0; r < bh; r++) {
        const base = (y1 + r) * w + x1;
        for (let c = 0; c < bw; c++) if (labels[base + c] === id) u32[r * bw + c] = green;
      }
      ctx.putImageData(block, x1, y1);
    }
    return canvas;
  }
  const canvas = document.createElement('canvas');
  canvas.width = w; canvas.height = h;
  const ctx = canvas.getContext('2d');
  const subset = ids ? new Set(ids) : null;
  const lut = new Uint32Array(65536);
  const big = new Map();
  const pack = l => {
    if (subset) return green;
    const [r, g, b] = hslToRgb((l * 47) % 360, 75, 55);
    return PACK_RGBA(r, g, b, 165);
  };
  /* Every element lies inside its own box and a region array carries a box per
     element, so the walk can be limited to their union — a connected region
     that fills the frame keeps the whole frame, a few blobs in a corner cost
     their corner.  With a subset the boxes are not consulted: an id can be
     selected while its element has no box (then no pixel of it exists), but the
     shortcut must never risk a selected element outside the span. */
  const span = subset ? undefined : boxSpan(boxes, w, h);
  if (span === null) return canvas;                  // boxes given, all of them empty
  const [row0, row1, col0, col1] = span || [0, h - 1, 0, w - 1];
  const bw = col1 - col0 + 1, bh = row1 - row0 + 1;
  /* Only the span can hold a labelled pixel, so the pixel buffer is the span's
     and it is put into the canvas at the span's offset.  Allocating, clearing
     and compositing a full-frame 78 MB buffer costs ~70 ms more than the block,
     and a region array that covers part of the frame no longer pays for the
     rest of it. */
  const block = ctx.createImageData(bw, bh);
  const u32 = new Uint32Array(block.data.buffer);
  /* Every pixel of an element lies inside that element's own bounding box, and
     two elements never share a pixel, so walking the boxes one element at a
     time writes exactly the pixels the pixel-by-pixel walk would write — but it
     touches the boxes instead of the frame.  A 20 MP photo gives `connection`
     ~30 000 small parts whose boxes cover ~22 % of the frame, so 78 % of the
     walk disappears.  `boxes` is only trusted when it is complete: the subset
     callers pass `ids` (they take the path above) and `connection` takes its
     boxes from connectedComponentsWithStats together with the labels. */
  if (!subset && boxes && boxes.length > 1) {
    for (let id = 1; id < boxes.length; id++) {
      const b = boxes[id];
      if (!b) continue;
      const r0 = Math.max(row0, b[0]), r1 = Math.min(row1, b[2]);
      const c0 = Math.max(col0, b[1]), c1 = Math.min(col1, b[3]);
      if (r1 < r0 || c1 < c0) continue;
      const v = pack(id);
      for (let r = r0; r <= r1; r++) {
        const src = r * w + c0, dst = (r - row0) * bw + (c0 - col0);
        for (let c = 0; c <= c1 - c0; c++) if (labels[src + c] === id) u32[dst + c] = v;
      }
    }
    ctx.putImageData(block, col0, row0);
    return canvas;
  }
  for (let r = 0; r < bh; r++) {
    const src = (row0 + r) * w + col0;
    const dst = r * bw;
    for (let c = 0; c < bw; c++) {
      const l = labels[src + c];
      if (!l) continue;
      if (subset && !subset.has(l)) continue;
      let v = l < lut.length ? lut[l] : big.get(l);
      if (!v) { v = pack(l); if (l < lut.length) lut[l] = v; else big.set(l, v); }
      u32[dst + c] = v;
    }
  }
  ctx.putImageData(block, col0, row0);
  return canvas;
}

/* union of the element boxes as [row1, row2, col1, col2], clamped to the frame;
   null when there are boxes but not one of them holds a pixel, undefined when
   there are no boxes at all (the caller then walks the whole frame) */
function boxSpan(boxes, w, h) {
  if (!boxes) return undefined;
  let r1 = Infinity, r2 = -Infinity, c1 = Infinity, c2 = -Infinity;
  for (let i = 1; i < boxes.length; i++) {
    const b = boxes[i];
    if (!b || b[2] < b[0] || b[3] < b[1]) continue;
    if (b[0] < r1) r1 = b[0];
    if (b[1] < c1) c1 = b[1];
    if (b[2] > r2) r2 = b[2];
    if (b[3] > c2) c2 = b[3];
  }
  if (r2 < r1 || c2 < c1) return null;
  return [Math.max(0, r1), Math.min(h - 1, r2), Math.max(0, c1), Math.min(w - 1, c2)];
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
    canvasFor: () => ocvMaskToOverlay(mask, 236, 70, 60),
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
   the points are collected from the pixel data of the mask itself.  Only the
   bounding box is walked: a region that fills 0.1 % of a 19.5 M pixel frame
   would otherwise be looked for over the whole frame (100x the work).  The box
   of a rectangle-shaped region comes from cv.boundingRect (a C++ scan, 2.5 ms
   on 19.5 M pixel), from the caller, or is not used when the region is empty. */
function maskBox(mask) {
  const b = cv.boundingRect(mask);
  return (b.width && b.height) ? [b.y, b.x, b.y + b.height - 1, b.x + b.width - 1] : null;
}

function maskPointMat(mask, box) {
  const w = mask.cols, h = mask.rows, d = mask.data;
  if (!box) box = maskBox(mask);
  const flat = [];
  if (box) {
    const r1 = Math.max(0, box[0]), r2 = Math.min(h - 1, box[2]);
    const c1 = Math.max(0, box[1]), c2 = Math.min(w - 1, box[3]);
    for (let r = r1; r <= r2; r++) {
      const off = r * w;
      for (let c = c1; c <= c2; c++) if (d[off + c]) flat.push(c, r);
    }
  }
  return flat.length ? cv.matFromArray(flat.length / 2, 1, cv.CV_32SC2, flat) : null;
}

/* bounding box [row1, column1, row2, column2] of one element of a region
   record, when the record knows it (connection reads it from the component
   statistics, labelBoxes computes it) */
function regionBox(rec, id) {
  const b = rec._boxes && rec._boxes[id];
  return (b && b.length === 4) ? b : null;
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
   program line uses ('printer_chip', '09_Start1.png', ...). The built-in demo
   image is synthesized by the IDE.  Real files come in two ways:

     * a folder listing (see FOLDER ACCESS OVER HTTP below) names every image of
       a folder, and read_image fetches and decodes them one by one, on demand;
     * the picker ("Load folder…" / "Load file…") decodes the picked files up
       front — the fallback when the folder cannot be listed over HTTP.

   Either way the names are what `list_image_files` reports, in sorted order.
   ========================================================================== */
const BUILTIN_IMAGE = 'printer_chip';
/* A source image of a machine-vision program is a camera frame, so its full
   resolution must survive: a resampled frame would silently rescale every
   measured distance.  Only truly oversized files (a panorama, a film scan) are
   reduced, and read_image says so when it happens. */
const IMAGE_MAX_SIDE = 8192;
const IMAGE_SOURCES = new Map();           // name -> { name, canvas, gray, w, h, builtin }

/* Every image file name this session has seen (the built-in demo picture is not
   a file).  The name outlives the pixels: see GARBAGE COLLECTION below. */
const IMAGE_NAMES = new Set();

/* --------------------------------------------------------------------------
   GARBAGE COLLECTION OF DECODED FRAMES

   Reading a folder used to keep every frame it had ever read, for the life of
   the page: the gray cv.Mat of a file was pinned under its name in
   IMAGE_SOURCES until a read_image of that same name came along.  That is what
   made a large image set unusable — measured on six 5088x3840 photos: 112 MB of
   gray frames (19.5 MB each) that were never freed, plus, before the display
   canvas became lazy, 6 x 78 MB of RGBA bitmaps.  A hundred such frames are
   1.9 GB of WASM heap for data the program has already finished with.

   19.5 MB of a frame that was read ten minutes ago, in a folder of a thousand,
   buys nothing: a frame is only worth keeping if the program is likely to read
   that name again soon, and the file can always be fetched and decoded again.
   So the few most recently used frames are kept warm and the rest are released.
   The name stays known — read_image, list_image_files and the Operator Window
   still offer it — and the next read of it simply decodes it again, exactly as
   if the file had never been read (which is why a released frame is only ever a
   file that can be fetched again: see sourceReobtainable).

   What is NOT freed here: the cv.Mat clone an image variable owns (that is the
   variable's own pixels, released by js/app.js when the variable is rebound or
   the run is cleared) and the display canvas of an image that is on screen.
   -------------------------------------------------------------------------- */
const SOURCE_KEEP = 3;                    // decoded frames kept warm for a re-read
const SOURCE_KEEP_BYTES = 256 * 1048576;  // ...and never more than this much gray
let sourceClock = 0;                      // logical time of the last use of a frame

const sourceBytes = rec => (rec && rec.gray ? rec.gray.cols * rec.gray.rows : 0);
function sourceTouch(rec) { if (rec) rec.used = ++sourceClock; }

/* Can this frame be fetched and decoded again if it is released?  Only a file
   the app can get its hands on twice: one a folder listing named (its URL is in
   IMAGE_URLS), one that was fetched from a URL that worked, or one that sits in
   the folder granted with "Folder...".  A file picked with "Load file..." /
   "Load folder..." never existed anywhere but as the blob that was decoded here
   — its bytes are gone once the blob is — so such a frame is never released. */
function sourceReobtainable(rec) {
  if (!rec || rec.builtin) return false;
  if (rec.url) return true;                      // fetched, and it answered
  if (IMAGE_URLS.has(rec.name)) return true;     // a folder listing named this file
  return !!(rec.handle && IMAGE_DIR_HANDLE);     // the granted folder holds it
}

/* Release the decoded frames that are not worth keeping.  The frames named in
   `pinned` and the ones the readahead chain is holding (SOURCE_PIN while it
   works on them, DECODED once they are parked — those are the frames the program
   is about to read) are never released, and neither is a frame that cannot be
   obtained again.  Returns how many frames were released. */
function collectSources(pinned) {
  const keep = new Set(pinned || []);
  const held = [];
  for (const rec of IMAGE_SOURCES.values()) {
    if (!rec.gray || !sourceReobtainable(rec)) continue;
    if (keep.has(rec) || keep.has(rec.name)) continue;
    if (SOURCE_PIN.has(rec.name) || DECODED.has(rec.name)) continue;
    held.push(rec);
  }
  held.sort((a, b) => (b.used || 0) - (a.used || 0));    // most recently used first
  let kept = 0, bytes = 0, freed = 0;
  for (const rec of held) {
    const cost = sourceBytes(rec);
    if (kept < SOURCE_KEEP && bytes + cost <= SOURCE_KEEP_BYTES) { kept++; bytes += cost; continue; }
    rec.gray.delete();                     // the WASM heap gives its 19.5 MB back
    rec.gray = null;
    rec.canvas = null;
    IMAGE_SOURCES.delete(rec.name);
    freed++;
  }
  return freed;
}

/* The folder that relative file names of list_image_files / read_image are
   resolved against.  '' is the folder the page is served from; "Load folder…"
   narrows it to the picked folder, and "Folder…" grants a folder directly with
   the File System Access API (needed for the folder of a program opened from
   disk, which a page cannot otherwise see).  See IMAGE_DIR_HANDLE. */
let IMAGE_DIR = '';
/* Images a folder listing found but that are not decoded yet (name -> URL).
   read_image fetches and decodes one only when the program asks for it. */
const IMAGE_URLS = new Map();

/* program literals keep their quotes ('photo.png'), file names don't */
function imageArgName(tok) {
  return String(tok === undefined || tok === null ? '' : tok).trim().replace(/^'(.*)'$/s, '$1');
}

/* the image files a picker hands over.  "Load file…" picks a few, "Load folder…"
   enumerates a whole directory (<input webkitdirectory>); either way the list is
   filtered by extension here, because a folder also contains non-images. */
const IMAGE_FILE_ACCEPT = 'image/*,.png,.jpg,.jpeg,.bmp,.gif,.webp,.tif,.tiff,.pgm,.ppm';
const IMAGE_FILE_RE = /\.(png|jpe?g|bmp|gif|webp|tiff?|pgm|ppm|pnm)$/i;
function isImageFileName(name) {
  return IMAGE_FILE_RE.test(String(name === undefined || name === null ? '' : name));
}

/* HALCON's 'default' sort order, so ImageFiles[0] is the first name in the folder */
const imageNameSort = (a, b) => a.localeCompare(b, 'en', { numeric: true, sensitivity: 'base' });

/* --------------------------------------------------------------------------
   FOLDER ACCESS OVER HTTP

   A page has no directory API, but the app is served by a small static server
   (python -m http.server, tools/serve.js) that answers a folder with an HTML
   index whose links name its entries.  That is the one way a page can see a
   real folder, and it is what makes

       list_image_files ('./', 'default', [], ImageFiles)
       read_image (Image, ImageFiles[3])

   work against the images sitting next to the program, like in HDevelop.
   -------------------------------------------------------------------------- */

/* the folder the page is served from, as a URL ending in '/' (null on file://) */
function appBaseUrl() {
  try { return new URL('.', location.href).href; } catch (_) { return null; }
}

/* 'example' | './' | '' -> the absolute URL of that folder.  '' and '.' mean the
   current image folder (IMAGE_DIR, or the page's folder while it is unset);
   anything else resolves against IMAGE_DIR. */
function imageDirUrl(dir) {
  const base = appBaseUrl();
  if (!base) return null;
  let d = String(dir === undefined || dir === null ? '' : dir).trim().replace(/^'(.*)'$/s, '$1');
  d = d.replace(/\\/g, '/').replace(/^\.\//, '');
  if (d === '' || d === '.') d = IMAGE_DIR;
  else if (IMAGE_DIR) d = IMAGE_DIR.replace(/\/+$/, '') + '/' + d;
  if (d && !/\/$/.test(d)) d += '/';
  try { return new URL(d, base).href; } catch (_) { return null; }
}

/* the URL of one file inside the current image folder */
function imageFileUrl(name) {
  const dir = imageDirUrl('');
  if (!dir) return null;
  const rel = String(name).replace(/\\/g, '/').replace(/^\.\//, '');
  try { return new URL(rel.split('/').map(encodeURIComponent).join('/'), dir).href; }
  catch (_) { return null; }
}

/* The entries a folder index lists, or null when the URL does not answer with a
   listing (file://, a 404, or a server that serves a page instead of an index). */
async function listDirEntries(url) {
  if (!url || !/^https?:$/.test(location.protocol)) return null;
  let res;
  try { res = await fetch(url, { cache: 'no-store' }); } catch (_) { return null; }
  if (!res.ok) return null;
  if (!/text\/html/i.test(res.headers.get('content-type') || '')) return null;
  const html = await res.text();
  if (!/<a\s[^>]*href=/i.test(html)) return null;
  const files = [], dirs = [];
  const re = /<a\s[^>]*\bhref\s*=\s*"([^"]*)"/gi;
  let m;
  while ((m = re.exec(html))) {
    let href = m[1];
    try { href = decodeURIComponent(href); } catch (_) { /* keep as is */ }
    href = href.split('?')[0].split('#')[0];
    if (!href || href.startsWith('..') || href.startsWith('/') || /^[a-z]+:/i.test(href)) continue;
    if (/\/$/.test(href)) dirs.push(href.replace(/^\.\//, ''));
    else files.push(href.replace(/^.*\//, ''));
  }
  return { files, dirs };
}

/* HALCON's Extensions argument: 'default' (the usual image formats) or a tuple of
   extensions without the dot, e.g. ['png','tif'] */
function imageExtensionFilter(tok, ctx) {
  const v = controlString(tok, ctx);
  if (!v || v.toLowerCase() === 'default') return IMAGE_FILE_RE;
  const list = (String(tok).match(/'([^']*)'/g) || []).map(s => s.slice(1, -1))
    .concat(v.split(',').map(s => s.trim().replace(/^'(.*)'$/s, '$1')))
    .map(s => s.replace(/^\./, '')).filter(Boolean);
  if (!list.length) return IMAGE_FILE_RE;
  return new RegExp(`\\.(${list.map(e => e.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`, 'i');
}

/* the URL of a folder of the server the page runs on, relative to the page's own
   folder — the folder browser walks the tree from there, so unlike imageDirUrl
   this does not resolve against IMAGE_DIR */
function serverDirUrl(relDir) {
  const base = appBaseUrl();
  if (!base) return null;
  let d = String(relDir === undefined || relDir === null ? '' : relDir)
    .replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '');
  if (d === '.' || d === './') d = '';
  if (d && !/\/$/.test(d)) d += '/';
  try { return new URL(d, base).href; } catch (_) { return null; }
}

/* The entries of a folder, from whichever listing the server offers:
     - the project's own dev server (tools/serve.js) answers /api/list with JSON
       and can list every folder, including the page's own — a static server
       cannot, because a folder holding index.html is served as a page;
     - a plain static server (py -m http.server) answers with an HTML index.
   null when the folder cannot be listed at all. */
async function listFolderEntries(relDir) {
  const rel = String(relDir === undefined || relDir === null ? '' : relDir)
    .replace(/\\/g, '/').replace(/^\/+/, '').replace(/^\.\//, '').replace(/\/+$/, '');
  const base = appBaseUrl();
  if (!base) return null;
  try {
    const api = new URL('api/list', base);
    api.searchParams.set('path', rel ? rel + '/' : '/');
    const res = await fetch(api.href, { cache: 'no-store' });
    if (res.ok && /json/i.test(res.headers.get('content-type') || '')) {
      const j = await res.json();
      if (j && Array.isArray(j.files)) {
        return { rel, files: j.files, dirs: j.dirs || [], via: 'api' };
      }
    }
  } catch (_) { /* no /api/list — try the folder index below */ }
  const url = serverDirUrl(rel);
  const e = url ? await listDirEntries(url) : null;
  return e ? { rel, files: e.files, dirs: e.dirs, via: 'index' } : null;
}

/* A HALCON directory argument -> the folder's page-relative name, or null when
   it does not name a folder of the server the page runs on (an absolute path, or
   a file:// page).  Resolution mirrors imageDirUrl: '' and '.' are the current
   image folder, anything else sits inside it. */
function pageRelDir(dir) {
  const d = String(dir === undefined || dir === null ? '' : dir).trim()
    .replace(/^'(.*)'$/s, '$1').replace(/\\/g, '/').replace(/^\.\//, '');
  if (/^[a-z][a-z0-9+.-]*:/i.test(d) || d.startsWith('/')) return null;   // not of this server
  let rel = d;
  if (rel === '' || rel === '.') rel = IMAGE_DIR;
  else if (IMAGE_DIR) rel = IMAGE_DIR.replace(/\/+$/, '') + '/' + rel;
  return rel.replace(/\/+$/, '');
}

/* the image file names a folder holds, sorted like HALCON's 'default' order;
   null when the folder cannot be listed */
async function enumImagesAtDir(dir, filter) {
  const rel = pageRelDir(dir);
  const entries = (rel === null ? null : await listFolderEntries(rel)) ||
    await listDirEntries(imageDirUrl(dir));
  if (!entries) return null;
  const re = filter || IMAGE_FILE_RE;
  return Array.from(new Set(entries.files.filter(n => re.test(n)))).sort(imageNameSort);
}
/* decode a blob and register it as an image source, exactly like a picked file */
function decodeImageBlob(blob) {
  return new Promise((resolve, reject) => {
    const url = URL.createObjectURL(blob);
    const img = new Image();
    img.onload = () => { URL.revokeObjectURL(url); resolve(img); };
    img.onerror = () => { URL.revokeObjectURL(url); reject(new Error('cannot be decoded')); };
    img.src = url;
  });
}

/* draw a decoded image into a canvas, reduced only when it exceeds IMAGE_MAX_SIDE */
function canvasFromImage(img) {
  const w = img.naturalWidth || img.width || 1, h = img.naturalHeight || img.height || 1;
  const scale = Math.min(1, IMAGE_MAX_SIDE / Math.max(w, h));
  const canvas = document.createElement('canvas');
  canvas.width = Math.max(1, Math.round(w * scale));
  canvas.height = Math.max(1, Math.round(h * scale));
  /* cv.imread reads this canvas back once (decodeSource).  With a software
     backed ("read frequently") context that readback is a plain memcpy instead
     of a GPU round trip: ~380 ms instead of ~460 ms on a 20 MP frame. */
  canvas.getContext('2d', { willReadFrequently: true })
    .drawImage(img, 0, 0, canvas.width, canvas.height);
  return { canvas, w, h, scaled: scale < 1 };
}

/* A decoded image file, kept as an image source: the picture is drawn into a
   canvas (reduced only when it exceeds IMAGE_MAX_SIDE), which is what the
   Graphics Window shows.  The gray cv.Mat the operators work on is built on the
   first read (decodeSource), so listing or opening a folder does not pay for
   the conversion of frames the program never reads. */
function registerDecodedSource(name, img) {
  const { canvas, w, h, scaled } = canvasFromImage(img);
  const rec = registerImageSource(name, canvas, false);
  rec.srcW = w; rec.srcH = h; rec.scaled = scaled;
  return rec;
}

/* The gray cv.Mat of an image source, built once and then reused by every later
   read_image of the same file — a 5088×3840 photo costs ~0.4 s in here (the
   browser's PNG inflation, the 78 MB canvas readback into the WASM heap and the
   gray expansion), while a repeat read is a ~5 ms copy.  The operator asks for
   this when it reads a file for the first time; the readahead above asks for it
   while the program is busy elsewhere.

   The RGBA canvas was needed once, to hand the pixels to OpenCV, and is dropped
   at the end: it is 78 MB for a 20 MP frame and nothing displays it — every
   image variable builds its own canvas on demand (js/app.js recCanvas) — so
   keeping one per file was 78 MB of bitmap per frame for the whole session.  The
   demo picture is the app's own canvas (ctx.syntheticImage) and stays. */
function decodeSource(rec) {
  if (rec.gray) return rec;                      // decoded already
  if (!rec.canvas) return rec;                   // released: the caller reads the file again
  const rgba = cv.imread(rec.canvas);
  const gray = new cv.Mat();
  cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
  rgba.delete();
  rec.gray = gray;
  rec.w = gray.cols; rec.h = gray.rows;
  if (!rec.builtin) rec.canvas = null;
  sourceTouch(rec);
  return rec;
}

/* fetch one image of a listed folder, decode it and keep it as an image source;
   the images the program does not read are not fetched (unless the readahead
   above asked for them) */
async function loadImageFromUrl(name, url) {
  const hit = IMAGE_SOURCES.get(name);
  if (hit) return hit;
  const res = await fetch(url, { cache: 'no-store' });
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const rec = registerDecodedSource(name, await decodeImageBlob(await res.blob()));
  rec.url = url;                     // this URL answered, so the frame can be fetched again
  return rec;
}

/* The folder granted with "Folder…" / "Set Working Folder…" (File System Access
   API).  A page cannot learn the folder of a program picked from disk, so the
   folder is granted once by hand; with a handle the app can enumerate it and
   decode any single image of it, without copying them all into memory. */
let IMAGE_DIR_HANDLE = null;

/* does this list_image_files directory argument mean "the folder I am using"? */
function isCurrentDirArg(dirArg) {
  const d = String(dirArg === undefined || dirArg === null ? '' : dirArg).trim().replace(/^'(.*)'$/s, '$1');
  return d === '' || d === '.' || d === './';
}

/* the image file names of the granted folder, or null when there is no handle */
async function enumImagesInFolderHandle(filter) {
  if (!IMAGE_DIR_HANDLE) return null;
  const re = filter || IMAGE_FILE_RE;
  const names = [];
  try {
    for await (const [name, entry] of IMAGE_DIR_HANDLE.entries()) {
      if (entry && entry.kind === 'file' && re.test(name)) names.push(name);
    }
  } catch (_) { return null; }
  return names.sort(imageNameSort);
}

/* One image of the current folder, decoded on demand — from the folder handle
   when there is one, else from the folder's URL.  Returns the image record, or
   null when the image cannot be obtained.  A file that the readahead below is
   decoding right now is not fetched twice: the caller waits for that decode. */
async function loadImageByName(name) {
  const hit = IMAGE_SOURCES.get(name);
  if (hit) return hit;
  if (!name || !isImageFileName(name)) return null;
  const busy = DECODING.get(name);
  if (busy) return busy;
  const p = fetchImageByName(name).finally(() => DECODING.delete(name));
  DECODING.set(name, p);
  return p;
}

async function fetchImageByName(name) {
  if (IMAGE_DIR_HANDLE) {
    try {
      const fh = await IMAGE_DIR_HANDLE.getFileHandle(name);
      const file = await fh.getFile();
      const off = await graySourceInWorker(name, { file });
      if (off) return off;
      const rec = registerDecodedSource(name, await decodeImageBlob(file));
      rec.handle = true;             // the granted folder can hand this file over again
      return rec;
    } catch (_) { /* not there or not readable — try the folder URL instead */ }
  }
  const url = IMAGE_URLS.get(name) || imageFileUrl(name);
  if (!url) return null;
  const off = await graySourceInWorker(name, { url });
  if (off) return off;
  try { return await loadImageFromUrl(name, url); } catch (_) { return null; }
}

/* --------------------------------------------------------------------------
   A GRAY FRAME FROM A WORKER

   Reading a file used to cost the page ~0.3 s of its own thread: the browser
   inflates the PNG, the picture is drawn into a canvas, 78 MB of RGBA are read
   back into the WASM heap and converted to gray — and that is exactly what a
   read_image line of a 5088×3840 frame sat through.  A worker does the
   inflation, the readback and the conversion on its own thread and sends back
   the gray frame only, so the page copies 19.5 MB into the WASM heap (~10 ms)
   and builds the display canvas.  Three workers run side by side, and the
   readahead below feeds them while the program is busy elsewhere.

   The luma is cvtColor's own fixed point, (R*4899 + G*9617 + B*1868 + 8192) >> 14,
   so the frame is the one the canvas path produces — verified on a 5088×3840
   frame, where all 19 537 920 bytes were equal.  cvtColor's vector body rounds
   the same way but its scalar tail truncates, so on a colour image whose width is
   not a multiple of the vector width a few pixels at the right edge of a row can
   come out one gray level apart.  The worker source is embedded and started from
   a blob URL because the app has no build step and must also run from a plain
   file:// page, where a worker file of its own could not be loaded.  Everything
   the worker needs travels in the message.  When there is no worker at all (Node,
   an old browser, a crash) the canvas path above is used — nothing depends on it.
   -------------------------------------------------------------------------- */
/* Three pictures at a time: a program that reads a folder reads the files in a
   row, so the pool has to be able to inflate most of them while the first one
   is being read — that is what makes the later read_image lines short. */
const GRAY_WORKERS = 3;
const GRAY_TIMEOUT = 30 * 1000;    // a frame that never comes back is dropped
const GRAY_WORKER_SRC = `
self.onmessage = async (e) => {
  const { id, url, file, maxSide } = e.data;
  try {
    const blob = file || await (await fetch(url, { cache: 'no-store' })).blob();
    const bmp = await createImageBitmap(blob);
    try {
      /* same reduction rule as canvasFromImage: only oversized files are scaled */
      const scale = Math.min(1, maxSide / Math.max(bmp.width, bmp.height));
      const w = Math.max(1, Math.round(bmp.width * scale));
      const h = Math.max(1, Math.round(bmp.height * scale));
      const off = new OffscreenCanvas(w, h);
      const ctx = off.getContext('2d', { willReadFrequently: true });
      ctx.drawImage(bmp, 0, 0, w, h);
      const rgba = ctx.getImageData(0, 0, w, h).data;
      const gray = new Uint8Array(w * h);
      for (let i = 0, j = 0; j < gray.length; i += 4, j++)
        gray[j] = (rgba[i] * 4899 + rgba[i + 1] * 9617 + rgba[i + 2] * 1868 + 8192) >> 14;
      self.postMessage({ id, ok: true, w, h, sw: bmp.width, sh: bmp.height, gray: gray.buffer },
        [gray.buffer]);
    } finally { bmp.close(); }
  } catch (err) {
    self.postMessage({ id, ok: false, error: String((err && err.message) || err) });
  }
};`;
let grayPool = null;               // [{ worker, url, busy, broken }]
let grayOff = false;               // no worker here (Node, an old browser, a crash)
let graySeq = 0;
const GRAY_JOBS = new Map();       // id -> { entry, resolve, timer }

function grayPoolCreate() {
  if (grayOff) return null;
  if (typeof Worker === 'undefined' || typeof OffscreenCanvas === 'undefined' ||
      typeof createImageBitmap === 'undefined') { grayOff = true; return null; }
  try {
    grayPool = [];
    for (let i = 0; i < GRAY_WORKERS; i++) {
      const url = URL.createObjectURL(new Blob([GRAY_WORKER_SRC], { type: 'text/javascript' }));
      const entry = { worker: null, url, busy: 0, broken: false };
      entry.worker = new Worker(url);
      entry.worker.onmessage = (e) => grayJobDone(entry, e.data);
      entry.worker.onerror = () => grayJobFailed(entry);
      grayPool.push(entry);
    }
  } catch (_) { grayOff = true; grayPool = null; }
  return grayPool;
}

function grayJobDone(entry, d) {
  entry.busy--;
  const job = GRAY_JOBS.get(d.id);
  if (!job) return;                          // dropped (a timeout got there first)
  GRAY_JOBS.delete(d.id);
  clearTimeout(job.timer);
  job.resolve(d.ok ? d : null);
}

/* a worker died (out of memory, a decoder bug): the page thread takes over */
function grayJobFailed(entry) {
  entry.broken = true;
  let alive = false;
  for (const [id, job] of GRAY_JOBS) {
    if (job.entry !== entry) { alive = true; continue; }
    GRAY_JOBS.delete(id);
    clearTimeout(job.timer);
    job.resolve(null);
  }
  if (!alive) { grayOff = true; for (const e of grayPool) e.worker.terminate(); grayPool = null; }
}

/* the idle worker, or the one with the least work */
function grayPick() {
  const pool = grayPoolCreate();
  if (!pool) return null;
  let best = null;
  for (const e of pool) {
    if (e.broken) continue;
    if (!best || e.busy < best.busy) best = e;
    if (!best.busy) break;
  }
  return best;
}

/* decode one file (a URL or a picked File) on a worker thread; null when the
   frame cannot be obtained this way and the page thread should do it */
function grayInWorker(source) {
  const entry = grayPick();
  if (!entry) return Promise.resolve(null);
  return new Promise(resolve => {
    const id = ++graySeq;
    const job = { entry, resolve, timer: 0 };
    job.timer = setTimeout(() => {
      if (GRAY_JOBS.delete(id)) { entry.busy--; resolve(null); }
    }, GRAY_TIMEOUT);
    GRAY_JOBS.set(id, job);
    entry.busy++;
    entry.worker.postMessage(Object.assign({ id, maxSide: IMAGE_MAX_SIDE }, source));
  });
}

/* a source whose gray frame the worker has already built: the frame is adopted
   into the WASM heap, so the record looks exactly like one of the canvas path —
   minus the RGBA canvas, which is only built if an image variable shows it */
async function graySourceInWorker(name, source) {
  const g = await grayInWorker(source);
  if (!g) return null;
  const gray = new cv.Mat(g.h, g.w, cv.CV_8UC1);
  gray.data.set(new Uint8Array(g.gray));
  const rec = registerImageSource(name, null, false);
  rec.gray = gray;
  rec.offThread = true;                    // the page did not inflate or read this one back
  rec.w = g.w; rec.h = g.h;
  rec.srcW = g.sw; rec.srcH = g.sh;
  rec.scaled = g.sw !== g.w || g.sh !== g.h;
  if (source.url) rec.url = source.url;    // this URL answered, so the frame is fetchable again
  else rec.handle = true;                  // it came out of the granted folder
  return rec;
}

/* --------------------------------------------------------------------------
   DECODING AHEAD

   Reading a 5088×3840 PNG costs ~0.4 s here: the picture is inflated by the
   browser, read back into the WASM heap as 78 MB of RGBA and converted to gray.
   A program that reads a folder pays that once per file, inside its read_image
   lines.  But the listing it did a line earlier already said which files it is
   about to read — so those are decoded in the background and are ready (as a
   gray frame) when the program asks for them.  The decoding overlaps the
   operators in between instead of the read_image lines.

   The plan is read from the program source: `read_image (Image, Files[3])`
   names the element, so a program that reads two of a hundred files decodes
   two, in the order it reads them.  Indices the source does not spell out fall
   back to the listed order.  Only PREFETCH_AHEAD decoded frames are held at a
   time, so a listing of a big folder does not eat the memory; the rest of the
   chain waits until the program has read one.
   -------------------------------------------------------------------------- */
const PREFETCH_AHEAD = 2;      // decoded frames waiting to be read
const PREFETCH_INFLIGHT = 3;   // files being fetched and inflated at the same time
const PREFETCH_MAX = 12;       // never decode more than this many ahead
const DECODED = new Map();     // name -> decoded source record, waiting to be read
const DECODING = new Map();    // name -> promise: one fetch+decode per file, shared
const TAKEN = new Set();       // names a read_image of this run has already read
const SOURCE_PIN = new Set();  // frames the chain holds right now: never released under it
let prefetchGen = 0;           // a new listing (or a stop) cancels the chain
let prefetchWait = [];         // the chain parked on a full DECODED

function prefetchRelease() {
  const w = prefetchWait;
  prefetchWait = [];
  for (const resume of w) resume();
}
const prefetchPark = () => new Promise(resume => prefetchWait.push(resume));

/* the files the program reads, in the order it reads them; null when the indices
   are computed at run time (the listed order is used then) */
function imageReadPlan(tuple, names) {
  if (typeof PROCEDURES === 'undefined' || typeof parseLine !== 'function') return null;
  if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(tuple || '')) return null;
  const at = new RegExp('^' + tuple + '\\s*\\[\\s*(\\d+)\\s*\\]$');
  const order = [], seen = new Set();
  let dynamic = false;
  for (const proc of Object.keys(PROCEDURES)) {
    for (const text of (PROCEDURES[proc] && PROCEDURES[proc].lines) || []) {
      const p = parseLine(String(text === undefined || text === null ? '' : text));
      if (!p || p.op !== 'read_image') continue;
      const arg = String(p.args[1] === undefined || p.args[1] === null ? '' : p.args[1]).trim();
      const m = at.exec(arg);
      if (!m) { if (arg.startsWith(tuple + '[')) dynamic = true; continue; }
      const name = names[+m[1]];
      if (name && !seen.has(name)) { seen.add(name); order.push(name); }
    }
  }
  return (order.length && !dynamic) ? order : null;
}

/* decode the listed files ahead of the program.  The chain starts PREFETCH_INFLIGHT
   files at once and then follows the plan in reading order: a program that reads
   four files pays the decode of the first one on its first read_image line, while
   the other three are already running on the workers and are ready (or nearly) by
   the time it asks for them.  Doing them strictly one after the other only moved
   the cost of one file. */
function prefetchImages(plan) {
  const gen = ++prefetchGen;
  TAKEN.clear();
  const queue = plan.filter(n => !(IMAGE_SOURCES.get(n) || {}).gray).slice(0, PREFETCH_MAX);
  const step = async () => {
    const flight = [];        // the files on their way, in the order the program reads them
    const more = () => {
      while (gen === prefetchGen && queue.length && flight.length < PREFETCH_INFLIGHT) {
        const n = queue.shift();
        SOURCE_PIN.add(n);    // its frame belongs to this chain until it is parked or dropped
        flight.push({ n, p: loadImageByName(n) });
      }
    };
    more();
    try {
      while (gen === prefetchGen && flight.length) {
        while (gen === prefetchGen && DECODED.size >= PREFETCH_AHEAD) await prefetchPark();
        if (gen !== prefetchGen) return;      // cancelled: the frames are ordinary cache entries
        const { n, p } = flight.shift();
        let rec = null;
        try { rec = await p; } catch (_) { rec = null; }   // unreadable: read_image reports it
        SOURCE_PIN.delete(n);
        more();
        /* the same fetch is shared with a read_image, which decodes its own frame;
           a frame the program read is not held (and cannot park the chain) */
        if (!rec || TAKEN.has(rec.name)) continue;
        decodeSource(rec);
        if (!rec.gray) continue;              // released under us: read_image reads it again
        sourceTouch(rec);
        DECODED.set(rec.name, rec);
      }
    } finally {
      /* A chain that is cancelled while a file is being fetched leaves the files
         behind it on their way too — they must not stay pinned against the
         collection for the rest of the session (a pin outlives every read). */
      for (const f of flight) SOURCE_PIN.delete(f.n);
    }
  };
  step();
}

/* the program read a frame: it is no longer "decoded ahead", the chain goes on */
function prefetchTake(rec) {
  if (!rec) return;
  TAKEN.add(rec.name);
  if (DECODED.delete(rec.name)) prefetchRelease();
}

/* stop decoding ahead — the program was stopped or reset.  Frames that are
   already decoded stay in IMAGE_SOURCES: read_image reuses them. */
function prefetchCancel() {
  prefetchGen++;
  prefetchRelease();
  /* Nothing is "about to be read" any more, so the frames the chain had parked
     must not stay pinned against the collection either — they are ordinary
     cache entries now (read_image still finds them, and a pixel that fell out of
     the cache is read from the file again). */
  DECODED.clear();
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
   (connection, select_shape).  `owned` marks the Mats the caller must delete,
   `box` the bounding box of the element (null when the record does not know
   it), so the caller can hand it on to maskPointMat. */
function regionMats(rec) {
  if (rec.mat && rec.mat.data) return [{ mask: rec.mat, owned: false, box: regionBox(rec, 1) }];
  if (rec.labels && rec.w && rec.h) {
    const ids = rec.ids || Array.from({ length: rec.count || 0 }, (_, i) => i + 1);
    const lab = rec.labels;
    return ids.map(id => {
      const mask = cv.Mat.zeros(rec.h, rec.w, cv.CV_8UC1);
      const d = mask.data;
      /* an element lies inside its own bounding box, so only that part of the
         label image has to be looked at; without a box the whole image is
         walked (the element's box is then unknown, not absent) */
      const box = regionBox(rec, id);
      if (box) {
        const r1 = Math.max(0, box[0]), r2 = Math.min(rec.h - 1, box[2]);
        const c1 = Math.max(0, box[1]), c2 = Math.min(rec.w - 1, box[3]);
        for (let r = r1; r <= r2; r++) {
          const off = r * rec.w;
          for (let c = c1; c <= c2; c++) if (lab[off + c] === id) d[off + c] = 255;
        }
      } else {
        for (let i = 0; i < lab.length; i++) if (lab[i] === id) d[i] = 255;
      }
      return { mask, owned: true, box };
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
   image, computed once per region record (1-based, like the element ids).  A
   region array that already knows its boxes (`connection` reads them from the
   component stats) is left alone; a box that is not there stays null and the
   feature that needs it says so, instead of returning a hole. */
function labelBoxes(regs) {
  if (regs._boxes) return regs._boxes;
  const { labels, w, count } = regs;
  const box = new Array((count || 0) + 1).fill(null);
  if (labels && w) {
    for (let i = 0; i < labels.length; i++) {
      const l = labels[i];
      if (!l || l >= box.length) continue;
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

/* one region feature of select_shape, with the meaning it has in HALCON.  The
   values come from js/features.js: the Feature Inspection window shows exactly
   the features select_shape selects on, so the two must not drift apart.  A
   feature that needs the bounding box of the element (width, ratio, …) still
   refuses to answer when the region array does not know it. */
function shapeFeature(regs, boxes, id, name) {
  const f = String(name === undefined || name === null ? '' : name).trim().replace(/^'(.*)'$/s, '$1').toLowerCase();
  const box = boxes && boxes[id];
  if (typeof FeatureInspect !== 'undefined' && FeatureInspect.REGION_NAMES.includes(f)) {
    if (!box && FeatureInspect.BOX_FEATURES.has(f)) {
      throw new Error(`select_shape: '${f}' needs the region array of connection()`);
    }
    return FeatureInspect.regionFeature(box, regs.areas[id], regs.cents[id], f);
  }
  throw new Error(`select_shape: feature '${f}' is not implemented in this build`);
}

/* Register (or replace) an image source.  `canvas` may be null: a frame decoded
   on a worker thread arrives as gray pixels only, and the display canvas of a
   file is built if and when an image variable shows it (see decodeSource). */
function registerImageSource(name, canvas, builtin) {
  const prev = IMAGE_SOURCES.get(name);
  if (prev && prev.gray) prev.gray.delete();     // loading a file again must not leak its pixels
  const rec = {
    name, canvas, builtin: !!builtin,
    w: canvas ? canvas.width : 0, h: canvas ? canvas.height : 0,
  };
  IMAGE_SOURCES.set(name, rec);
  if (!rec.builtin) IMAGE_NAMES.add(name);
  sourceTouch(rec);
  return rec;
}

/* ==========================================================================
   OPERATOR IMPLEMENTATIONS  (args = raw parsed tokens, e.g. '128' or ''name'')
   ========================================================================== */
const OP_IMPLS = {

  async read_image(args, ctx) {
    const t0 = performance.now();
    const want = controlString(args[1], ctx);
    let known = IMAGE_SOURCES.get(want);
    /* A record can be here with its pixels gone — a frame the collection took
       back between the decode and this line — so it is read again below rather
       than handed out without data.  See GARBAGE COLLECTION above. */
    if (known && !known.gray) {
      decodeSource(known);
      if (!known.gray) { IMAGE_SOURCES.delete(known.name); known = null; }
    }
    const cached = !!(known && known.gray);   // this file has been read before
    const ahead = !!(known && DECODED.has(known.name));   // decoded while the program worked
    /* An image that a folder listing (list_image_files) found is fetched and
       decoded here, on first use — so a program can read a whole folder without
       loading every file of it up front. */
    if (!known && want) {
      known = await loadImageByName(want);
      if (known && known.scaled && !known.scaleWarned) {
        known.scaleWarned = true;
        ctx.log(`read_image: '${want}' is ${known.srcW}×${known.srcH} and was reduced to ` +
          `${known.w}×${known.h} (over ${IMAGE_MAX_SIDE} px) — ` +
          `distances measured on it are scaled by ${(known.srcW / known.w).toFixed(4)}.`, 'warn');
      }
      if (!known && isImageFileName(want)) {
        ctx.log(`read_image: '${want}' could not be read — it is not in the folder this program ` +
          `uses (grant the folder with "Folder…" in the Operator Window).`, 'warn');
      }
    }
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
    /* The frame: a file is decoded once (decodeSource) and every read of it
       clones the gray cv.Mat, so each iconic variable owns its own pixels — a
       variable can be released without touching another one's, or the source's.
       The display canvas is not built here but by the variable that shows the
       image (js/app.js recCanvas), so a program that only measures a frame never
       pays 78 MB of RGBA for it.  The built-in demo picture is the app's own
       canvas.  The frames the program is finished with are released right after
       the clone. */
    let gray, canvas = null, canvasFor = null;
    if (known) {
      decodeSource(known);
      prefetchTake(known);                 // this frame is not "decoded ahead" any more
      sourceTouch(known);                  // …and it is the most recently used frame
      gray = known.gray.clone();
      if (known.builtin) canvas = known.canvas;               // shared with ctx.syntheticImage
      else canvasFor = () => ocvGrayToCanvas(gray);
      /* Garbage collection: the frames of the files this program has finished
         with are released here (the frame just read and the ones the readahead
         holds are kept).  Without this a run over a folder kept every frame it
         had ever read — 19.5 MB each, in the WASM heap, for the life of the
         page; that is what made a large image set unusable. */
      collectSources([known]);
    } else {
      const rgba = cv.imread(ctx.syntheticImage());
      gray = new cv.Mat();
      cv.cvtColor(rgba, gray, cv.COLOR_RGBA2GRAY);
      rgba.delete();
      canvasFor = () => ocvGrayToCanvas(gray);
    }
    ctx.defIconic(args[0], {
      kind: 'image', type: 'image (byte)',
      mat: gray, canvas, canvasFor,
      gray: gray.data.slice(0, gray.cols * gray.rows),
      dispose() { gray.delete(); },
    });
    /* fit: a freshly read image is fitted to the window, so reading one shows
       the whole frame even when the previous image was zoomed or panned */
    ctx.displayImage(args[0], true);
    /* The time is worth reporting: a 5088×3840 PNG takes ~0.5 s to read the
       first time, a repeat read of the same file ~10 ms. */
    if (known) {
      const ms = Math.round(performance.now() - t0);
      ctx.log(`read_image: read '${want}' (${gray.cols}x${gray.rows}, byte) via OpenCV WASM` +
        (known.builtin ? ' — built-in demo image.'
          : cached ? ` — ${ms} ms (file ${ahead ? 'decoded ahead' : 'already decoded'}).`
            : known.offThread ? ` — ${ms} ms (file fetched and turned into gray on a worker thread).`
              : ` — ${ms} ms (file decoded now; later reads of '${want}' reuse it).`));
    } else {
      ctx.log(`read_image: '${want}' has not been loaded — using the built-in ` +
        `'${BUILTIN_IMAGE}' image. Load the folder with "Load folder…" in the File menu.`, 'warn');
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
      canvasFor: () => ocvMaskToOverlay(dst, 236, 70, 60),
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
    /* the bounding box of every element comes with the stats, so the boxes of
       the region array are known without rescanning the label image */
    const boxes = [null];
    for (let i = 1; i <= n; i++) {
      const x = stats.data32S[i * 5], y = stats.data32S[i * 5 + 1];
      const w = stats.data32S[i * 5 + 2], h = stats.data32S[i * 5 + 3];
      areas.push(stats.data32S[i * 5 + 4]);
      cx.push(cents.data64F[i * 2]);
      cy.push(cents.data64F[i * 2 + 1]);
      boxes.push(w && h ? [y, x, y + h - 1, x + w - 1] : null);
    }
    labels.delete(); stats.delete(); cents.delete();
    ctx.defIconic(args[1], {
      kind: 'regions', type: `region array (${n})`,
      count: n, labels: lab, areas, cents: cx.map((x, i) => [x, cy[i]]),
      w: W, h: H, _boxes: boxes,
      canvasFor: () => ocvLabelsToOverlay(lab, W, H, null, boxes),
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
      w: regs.w, h: regs.h, _boxes: regs._boxes,
      dispose() {},
    };
    if (regs.labels) out.canvasFor = () => ocvLabelsToOverlay(regs.labels, regs.w, regs.h, ids, regs._boxes);
    if (regs.mat && ids.length) {
      out.mat = regs.mat;
      out.canvasFor = regs.canvasFor || (() => ocvMaskToOverlay(regs.mat, 236, 70, 60));
    }
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

  async list_image_files(args, ctx) {                      // Directory, Extensions, Options : ImageFiles
    /* The folder itself is enumerated when the app runs on a server (see
       FOLDER ACCESS OVER HTTP) — that is the real folder, and read_image then
       fetches its images on demand.  When the folder cannot be listed (file://,
       Electron without a server) the files loaded with "Load folder…" /
       "Load file…" are used instead.  The built-in demo image is never listed:
       HALCON returns only files that are in the folder, and listing it would
       shift every index by one. */
    const dirArg = controlString(args[0], ctx);
    const filter = imageExtensionFilter(args[1], ctx);
    /* the folder granted with "Folder…" wins, then the folder named over HTTP */
    const fromHandle = isCurrentDirArg(dirArg) ? await enumImagesInFolderHandle(filter) : null;
    const listed = fromHandle || await enumImagesAtDir(dirArg, filter);
    let names, how;
    if (listed) {
      names = listed; how = 'folder';
      IMAGE_URLS.clear();
      if (!fromHandle) {
        const dirUrl = imageDirUrl(dirArg);
        for (const n of names) IMAGE_URLS.set(n, new URL(encodeURIComponent(n), dirUrl).href);
      }
    } else {
      /* every file name this session has seen: a frame that was released to keep
         the memory down is still a file of the folder (see collectSources), and
         read_image reads it again when the program asks for it */
      names = Array.from(IMAGE_NAMES)
        .filter(n => !filter || filter.test(n))
        .sort(imageNameSort);
      how = 'loaded';
    }
    ctx.defCtrl(args[3], `[${names.map(n => `'${n}'`).join(', ')}]`,
      names.length === 1 ? 'string' : `string tuple (${names.length})`);
    if (!names.length) {
      if (how === 'folder') {
        ctx.log(`list_image_files: '${dirArg}' holds no image file.`, 'warn');
      } else {
        ctx.log(`list_image_files: no image file found for '${dirArg}' — a page cannot see the ` +
          `folder of a program opened from disk, so grant the folder once with "Folder…" in the ` +
          `Operator Window (or "Load folder…"), then run again.`, 'warn');
      }
      return;
    }
    ctx.log(`list_image_files: ${names.length} image file(s) ` +
      (how === 'folder' ? `in '${dirArg}'` : 'loaded') +
      `: ${names.map(n => `'${n}'`).join(', ')}.`);
    if (how === 'loaded' && names.length < 5) {
      ctx.log('list_image_files: only the loaded file(s) are known — "Load folder…" makes the ' +
        'whole folder available if the program needs more.', 'warn');
    }
    /* The files the program reads next are decoded now, in the background, so
       the read_image lines below do not pay for the browser's PNG inflation. */
    if (listed) {
      const plan = imageReadPlan(args[3], names) || names;
      prefetchImages(plan);
      ctx.log(`list_image_files: decoding ${Math.min(plan.length, PREFETCH_MAX)} of them ahead ` +
        `of the program${plan === names ? ' (listed order)' : ''} — ` +
        `read_image reuses them.`);
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
      mat: dst,
      /* The display canvas is built on first use (recCanvas, app.js): a
         mean_image result usually feeds another operator and is never shown,
         and the canvas of a 19.5 M pixel frame costs ~55 ms. */
      canvasFor: () => ocvGrayToCanvas(dst),
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
      canvasFor: () => ocvMaskToOverlay(dst, 236, 70, 60),
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
      labels: regs.labels, areas: regs.areas, cents: regs.cents, _boxes: regs._boxes,
      w: regs.w, h: regs.h,
      canvasFor: () => ocvLabelsToOverlay(regs.labels, regs.w, regs.h, sel, regs._boxes),
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
          const pts = m ? maskPointMat(m.mask, m.box) : null;
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
    for (const { mask, owned, box } of regions) {
      const pts = maskPointMat(mask, box);
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
    mat: gray,
    /* built on first use (recCanvas, app.js): a grab loop that only measures
       the frame never pays for the RGBA conversion of every grabbed frame */
    canvasFor: () => ocvGrayToCanvas(gray),
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

/* node export for the smoke test (tools/test-gc.js): the image-source cache and
   its collection are DOM-free, so they can be exercised without a browser */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = {
    IMAGE_SOURCES, IMAGE_NAMES, IMAGE_URLS,
    SOURCE_KEEP, SOURCE_KEEP_BYTES,
    registerImageSource, collectSources, sourceBytes, sourceTouch, sourceReobtainable,
  };
}

