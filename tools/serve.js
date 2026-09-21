'use strict';
/* ==========================================================================
   OpenCVS local dev server — no dependencies, plain Node (tools/node).

   1. Serves the IDE statically (open http://localhost:8177/).
   2. Keeps program.ovs on disk in sync with the browser, so the program can be
      edited in an external editor (e.g. VS Code) while the IDE stays live:
        - browser edits  -> POST /api/program -> file on disk
        - external save  -> fs.watch -> SSE (/events) -> browser reloads
   ========================================================================== */
const http = require('http');
const fs = require('fs');
const path = require('path');

const ROOT = process.env.OVS_ROOT ? path.resolve(process.env.OVS_ROOT) : path.resolve(__dirname, '..');
const PORT = +(process.env.PORT || 8177);
const PROGRAM_FILE = path.join(ROOT, 'program.ovs');

const MIME = {
  '.html': 'text/html; charset=utf-8', '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8', '.json': 'application/json',
  '.png': 'image/png', '.svg': 'image/svg+xml', '.ttf': 'font/ttf',
  '.wasm': 'application/wasm', '.md': 'text/plain; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8', '.ovs': 'text/plain; charset=utf-8',
};

/* Seed for program.ovs on first run. Keep in sync with PROCEDURES in js/app.js. */
const DEFAULT_PROGRAM = [
  '* OpenCVS program - editable here (e.g. in VS Code) or in the IDE program window',
  '* procedure: main',
  "* Blob analysis demo - synthetic chip inspection",
  "read_image (Image, 'printer_chip')",
  "get_image_size (Image, Width, Height)",
  "dev_open_window (0, 0, 640/2, 480/2, 'black', WindowHandle)",
  "dev_display (Image)",
  "threshold (Image, Region, 128, 255)",
  "connection (Region, ConnectedRegions)",
  "select_shape (ConnectedRegions, SelectedRegions, 'area', 'and', 1000, 100000)",
  "count_obj (SelectedRegions, Number)",
  "area_center (SelectedRegions, Area, Row, Column)",
  "dev_display (Image)",
  "dev_display (SelectedRegions)",
  "if (Number > 0)",
  "    disp_message (WindowHandle, 'Found ' + Number + ' parts', 'window', 12, 12, 'green', 'true')",
  "endif",
  "stop ()",
  '* procedure: detect_features',
  "* Threshold with fixed limits and connect components",
  "threshold (Image, Region, 100, 255)",
  "connection (Region, ConnectedRegions)",
  "return ()",
  '* procedure: acquire_demo',
  "* Webcam acquisition (browser camera via getUserMedia)",
  "* 'DirectShow' is accepted for HALCON syntax compatibility",
  "open_framegrabber ('DirectShow', 0, 0, 0, 0, 0, 0, 'default', 8, 'gray', -1, 'default', 'default', 'default', 'default', 'default', -1, AcqHandle)",
  "grab_image (Image, AcqHandle)",
  "get_image_size (Image, Width, Height)",
  "dev_display (Image)",
  "threshold (Image, Region, 128, 255)",
  "connection (Region, ConnectedRegions)",
  "select_shape (ConnectedRegions, SelectedRegions, 'area', 'and', 1000, 100000)",
  "count_obj (SelectedRegions, Number)",
  "dev_display (Image)",
  "dev_display (SelectedRegions)",
  "close_framegrabber (AcqHandle)",
  "stop ()",
  '* procedure: metrology_demo',
  "* Metrology demo - dimensional measurement on the synthetic chip",
  "* (HALCON metrology model: measure regions + robust shape fitting)",
  "read_image (Image, 'printer_chip')",
  "create_metrology_model (MetrologyHandle)",
  "* bright fiducial circle, top-left",
  "add_metrology_object_circle_measure (MetrologyHandle, 92, 120, 24, 12, 8, 1.0, 25, ['measure_transition'], ['all'], CircleIdx)",
  "* die body outline",
  "add_metrology_object_rectangle2_measure (MetrologyHandle, 240, 320, 0, 132, 92, 15, 5, 1.0, 25, ['measure_transition'], ['all'], DieIdx)",
  "* die left edge (vertical caliper line)",
  "add_metrology_object_line_measure (MetrologyHandle, 155, 190, 325, 190, 10, 8, 1.0, 25, ['measure_transition'], ['all'], EdgeIdx)",
  "set_metrology_object_param (MetrologyHandle, 'all', 'min_score', 0.5)",
  "* nominal (model) contour and measure regions are available before apply",
  "set_metrology_model_image_size (MetrologyHandle, 640, 480)",
  "get_metrology_object_model_contour (ModelContours, MetrologyHandle, 'all', 5)",
  "get_metrology_object_measures (MeasureContours, MetrologyHandle, CircleIdx, 'all', MeasureRows, MeasureColumns)",
  "dev_display (Image)",
  "dev_display (ModelContours)",
  "dev_display (MeasureContours)",
  "apply_metrology_model (Image, MetrologyHandle)",
  "* the measures of the last apply: the edges found on the profiles (empty before apply)",
  "get_metrology_object_measures (MeasureContours, MetrologyHandle, CircleIdx, 'all', MeasureRows, MeasureColumns)",
  "get_metrology_object_num_instances (MetrologyHandle, 'all', NumInstances)",
  "get_metrology_model_param (MetrologyHandle, ['image_size'], ModelSize)",
  "* HDevelop result order: (MetrologyHandle, Index, Instance, GenParamName, GenParamValue : Parameter)",
  "get_metrology_object_result (MetrologyHandle, CircleIdx, 0, 'result_type', 'all_param', CircleResult)",
  "get_metrology_object_result (MetrologyHandle, DieIdx, 0, 'result_type', 'all_param', DieResult)",
  "get_metrology_object_result (MetrologyHandle, EdgeIdx, 0, 'result_type', 'all_param', EdgeResult)",
  "get_metrology_object_result (MetrologyHandle, 'all', 'all', 'result_type', 'score', Scores)",
  "* the fitted result contours of every instance as XLD (Resolution 2.0)",
  "get_metrology_object_result_contour (FitContours, MetrologyHandle, 'all', 'all', 2.0)",
  "* refit the measured circle contour directly (fit_*_contour_xld)",
  "get_metrology_object_result_contour (CircleContour, MetrologyHandle, CircleIdx, 0, 1.0)",
  "fit_circle_contour_xld (CircleContour, 'geotukey', -1, 0, 0, 10, 2.0, FitRow, FitColumn, FitRadius, FitStartPhi, FitEndPhi, FitOrder)",
  "stop ()",
  '* procedure: display_demo',
  "* Display demo - disp_* primitives, region and XLD generators",
  "* Row = y, Column = x; Phi/Angle are radians measured from the column axis",
  "read_image (Image, 'printer_chip')",
  "get_image_size (Image, Width, Height)",
  "dev_open_window (0, 0, Width/2, Height/2, 'black', WindowHandle)",
  "dev_update_window ('off')",
  "dev_display (Image)",
  "* --- disp_* drawing primitives: drawn with the current dev_set_* settings",
  "dev_set_draw ('margin')",
  "dev_set_line_width (2)",
  "dev_set_color ('green')",
  "disp_rectangle1 (WindowHandle, Height*0.08, Width*0.06, Height*0.42, Width*0.44)",
  "disp_rectangle2 (WindowHandle, Height*0.25, Width*0.72, rad(30), Width*0.16, Height*0.17)",
  "disp_circle (WindowHandle, Height*0.72, Width*0.22, Width*0.12)",
  "disp_ellipse (WindowHandle, Height*0.72, Width*0.70, rad(20), Width*0.16, Height*0.16)",
  "disp_line (WindowHandle, Height*0.05, Width*0.55, Height*0.40, Width*0.95)",
  "disp_arrow (WindowHandle, Height*0.92, Width*0.08, Height*0.92, Width*0.92, 16)",
  "disp_cross (WindowHandle, Height*0.5, Width*0.5, 40, rad(45))",
  "disp_polygon (WindowHandle, [Height*0.44, Height*0.44, Height*0.58], [Width*0.62, Width*0.92, Width*0.77])",
  "* --- region generators: a region built from geometric parameters",
  "dev_set_color ('cyan')",
  "gen_rectangle1 (Rect1, Height*0.08, Width*0.06, Height*0.42, Width*0.44)",
  "gen_rectangle2 (Rect2, Height*0.25, Width*0.72, rad(30), Width*0.16, Height*0.17)",
  "gen_circle (Circle, Height*0.72, Width*0.22, Width*0.12)",
  "gen_ellipse (Ellipse, Height*0.72, Width*0.70, rad(20), Width*0.16, Height*0.16)",
  "gen_region_line (LineRegion, Height*0.05, Width*0.55, Height*0.40, Width*0.95)",
  "gen_region_polygon_filled (PolyFilled, [Height*0.44, Height*0.44, Height*0.58], [Width*0.62, Width*0.92, Width*0.77])",
  "gen_region_polygon (PolyOutline, [Height*0.44, Height*0.44, Height*0.58], [Width*0.62, Width*0.92, Width*0.77])",
  "disp_region (PolyFilled, WindowHandle)",
  "disp_region (PolyOutline, WindowHandle)",
  "* --- XLD generators: the same geometry as sub-pixel contours",
  "dev_set_color ('yellow')",
  "gen_cross_contour_xld (CrossContour, Height*0.5, Width*0.5, 40, rad(45), CenterRow, CenterCol, AngleOut)",
  "gen_rectangle2_contour_xld (RectContour, Height*0.25, Width*0.72, rad(30), Width*0.16, Height*0.17)",
  "gen_contour_region_xld (PolyFilled, PolyContour, 'border', 'border', -1, 0)",
  "disp_obj (CrossContour, WindowHandle)",
  "disp_obj (RectContour, WindowHandle)",
  "disp_obj (PolyContour, WindowHandle)",
  "* --- a second window: a window handle of 0 means the active window",
  "dev_open_window (Height/2, 0, Width/2, Height/2, 'black', Win2)",
  "dev_set_color ('white')",
  "disp_image (Image, Win2)",
  "disp_circle (0, Height*0.5, Width*0.5, Width*0.10)",
  "disp_cross (0, Height*0.5, Width*0.5, Width*0.20, 0)",
  "disp_message (Win2, 'disp_* primitives - window handle 0 = active window', 'window', 12, 12, 'green', 'true')",
  "dev_update_window ('on')",
  "stop ()",
].join('\n');

/* ---- program.ovs <-> procedures map (human-editable text format) ---- */
function parseOvs(text) {
  const procs = {};
  let current = null;
  for (const raw of text.split(/\r?\n/)) {
    const m = raw.match(/^\s*\*\s*procedure:\s*([A-Za-z_][A-Za-z0-9_]*)\s*$/i);
    if (m) { current = m[1]; procs[current] = []; continue; }
    if (current) procs[current].push(raw);
  }
  for (const lines of Object.values(procs)) {
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
  }
  return procs;
}

function serializeOvs(procs) {
  return Object.entries(procs)
    .map(([name, lines]) => `* procedure: ${name}\n${(lines || []).join('\n')}`)
    .join('\n') + '\n';
}

/* ---- SSE clients ---- */
const clients = new Set();
function broadcast(obj) {
  const payload = `data: ${JSON.stringify(obj)}\n\n`;
  for (const res of clients) { try { res.write(payload); } catch (e) { clients.delete(res); } }
}
setInterval(() => {
  for (const res of clients) { try { res.write(': ping\n\n'); } catch (e) { clients.delete(res); } }
}, 25000);

/* ---- file watching (external edits) ---- */
let selfWriting = false, lastSerialized = null;
function readProgramProcs() {
  try { return parseOvs(fs.readFileSync(PROGRAM_FILE, 'utf8')); } catch (e) { return {}; }
}
function watchProgram() {
  fs.watch(path.dirname(PROGRAM_FILE), (evt, fname) => {
    if (selfWriting || !fname || fname !== path.basename(PROGRAM_FILE)) return;
    setTimeout(() => {                       // let the writer finish
      const procs = readProgramProcs();
      const serialized = JSON.stringify(procs);
      if (serialized === lastSerialized) return;
      lastSerialized = serialized;
      broadcast({ kind: 'program', procs });
    }, 60);
  });
}

/* ---- request handling ---- */
function sendJson(res, code, obj) {
  const body = JSON.stringify(obj);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) });
  res.end(body);
}

function serveStatic(req, res, urlPath) {
  let p = decodeURIComponent(urlPath.split('?')[0]);
  if (p === '/' || p === '') p = '/index.html';
  const file = path.normalize(path.join(ROOT, p));
  if (!file.startsWith(ROOT) || p.split('/').some(seg => seg.startsWith('.'))) {
    res.writeHead(403); res.end('forbidden'); return;
  }
  fs.readFile(file, (err, data) => {
    if (err) { res.writeHead(404); res.end('not found'); return; }
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file).toLowerCase()] || 'application/octet-stream' });
    res.end(data);
  });
}

const server = http.createServer((req, res) => {
  const u = new URL(req.url, `http://${req.headers.host || 'localhost'}`);
  if (u.pathname === '/api/program' && req.method === 'GET') {
    return sendJson(res, 200, { procs: readProgramProcs() });
  }
  if (u.pathname === '/api/program' && req.method === 'POST') {
    let body = '';
    req.on('data', c => { body += c; if (body.length > 2e6) req.destroy(); });
    req.on('end', () => {
      try {
        const procs = parseOvs(serializeOvs(JSON.parse(body).procs || {}));
        const text = serializeOvs(procs);
        lastSerialized = JSON.stringify(procs);
        selfWriting = true;
        fs.writeFile(PROGRAM_FILE, text, err => {
          selfWriting = false;
          if (err) return sendJson(res, 500, { ok: false, error: String(err) });
          sendJson(res, 200, { ok: true });
        });
      } catch (e) { sendJson(res, 400, { ok: false, error: String(e) }); }
    });
    return;
  }
  if (u.pathname === '/events' && req.method === 'GET') {
    res.writeHead(200, {
      'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache',
      Connection: 'keep-alive', 'Access-Control-Allow-Origin': '*',
    });
    res.write(': connected\n\n');
    clients.add(res);
    req.on('close', () => clients.delete(res));
    return;
  }
  if (u.pathname.startsWith('/api/')) return sendJson(res, 404, { ok: false });
  serveStatic(req, res, u.pathname);
});

/* ---- startup ---- */
if (!fs.existsSync(PROGRAM_FILE)) {
  fs.writeFileSync(PROGRAM_FILE, DEFAULT_PROGRAM);
  console.log(`seeded ${path.relative(ROOT, PROGRAM_FILE)}`);
}
lastSerialized = JSON.stringify(readProgramProcs());
watchProgram();
server.listen(PORT, () => {
  console.log(`OpenCVS dev server:  http://localhost:${PORT}/`);
  console.log(`program file:        ${PROGRAM_FILE}`);
  console.log('Edit program.ovs in VS Code - changes sync to the IDE live.');
});
