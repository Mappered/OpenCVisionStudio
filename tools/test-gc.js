'use strict';
/* ==========================================================================
   OpenCVS — smoke test for the frame cache of js/opencv_ops.js.

   Reading a folder used to keep every frame it had ever read for the life of
   the page (19.5 MB of gray pixels for a 5088x3840 photo, a hundred of them
   1.9 GB of WASM heap), which is what made a large image set unusable.  The
   cache now keeps the few most recently used frames warm and gives the rest
   back to OpenCV — but only frames that can be fetched and decoded again.

   DOM-free and OpenCV-free: the cache is plain data, so the collection is
   driven with hand-written frames instead of real decodes.

   Run:  tools/node/node.exe tools/test-gc.js
   ========================================================================== */
const assert = require('node:assert/strict');
const {
  IMAGE_SOURCES, IMAGE_NAMES, IMAGE_URLS,
  SOURCE_KEEP, SOURCE_KEEP_BYTES,
  registerImageSource, collectSources, sourceBytes, sourceReobtainable,
} = require('../js/opencv_ops.js');

let passed = 0;
function check(name, cond, detail) {
  assert.ok(cond, `${name}${detail ? ' — ' + detail : ''}`);
  passed++;
  console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
}

const MB = 1048576;
let clock = 0;                 // logical use order, like sourceTouch keeps it
const grays = [];              // the fake cv.Mats, to see that they were given back

/* a decoded frame of `mp` megabytes of gray pixels (cols*rows = mp MB), as it
   sits in IMAGE_SOURCES: a cv.Mat of gray values and nothing else */
function frame(name, mp, extra) {
  const side = Math.round(Math.sqrt(mp * MB));
  const gray = { cols: side, rows: side, deleted: false, delete() { this.deleted = true; } };
  grays.push(gray);
  const rec = Object.assign({ name, canvas: null, gray }, extra || {});
  IMAGE_SOURCES.set(name, rec);
  rec.used = ++clock;
  return rec;
}
function reset() { IMAGE_SOURCES.clear(); IMAGE_NAMES.clear(); IMAGE_URLS.clear(); grays.length = 0; clock = 0; }
/* a file of the listed folder: its name is known and its URL answers */
function listed(name, mp, extra) {
  const rec = frame(name, mp, extra);
  IMAGE_URLS.set(name, `http://localhost/img/${name}`);
  IMAGE_NAMES.add(name);
  return rec;
}
const released = rec => rec.gray === null && rec.canvas === null && !IMAGE_SOURCES.has(rec.name);

/* ---------------- what a frame costs, and whether it can be read again ---------------- */
{
  reset();
  const a = frame('a.png', 19.5);                   // one 5088x3840 photo
  check('sourceBytes: the gray frame is cols*rows', sourceBytes(a) === a.gray.cols * a.gray.rows,
    `${sourceBytes(a)} B = ${(sourceBytes(a) / MB).toFixed(1)} MB`);
  check('sourceBytes: a frame that is not decoded yet costs nothing', sourceBytes({}) === 0);
  check('sourceBytes: nothing is 0', sourceBytes(null) === 0);

  IMAGE_URLS.set('a.png', 'http://localhost/img/a.png');
  check('a file the folder listing named can be read again', sourceReobtainable(a) === true);
  check('a file that was fetched from a URL can be read again',
    sourceReobtainable({ name: 'b.png', url: 'http://localhost/img/b.png' }) === true);
  check('a supplied file (no URL, no granted folder) cannot be read again',
    sourceReobtainable(frame('c.png', 1)) === false);
  check('the built-in picture is never released', sourceReobtainable({ name: 'printer_chip', builtin: true }) === false);
  check('nothing is never released', sourceReobtainable(null) === false);
}

/* ---------------- the cache keeps the few most recently used frames ---------------- */
{
  reset();
  const recs = [];
  for (let i = 0; i < 6; i++) recs.push(listed(`f${i}.png`, 1));   // f0 read first, f5 last
  const before = grays.slice();
  const freed = collectSources([]);

  check('collectSources gives back every frame beyond the warm set',
    freed === 6 - SOURCE_KEEP, `${freed} of 6 released, SOURCE_KEEP=${SOURCE_KEEP}`);
  check('a released frame is gone from the cache',
    recs.slice(0, 3).every(r => !IMAGE_SOURCES.has(r.name)));
  check('a released frame was emptied', recs.slice(0, 3).every(released));
  check('a released frame handed its cv.Mat back to OpenCV',
    before.slice(0, 3).every(g => g.deleted === true));
  check('the frames that were read last stay warm',
    recs.slice(3).every(r => r.gray && IMAGE_SOURCES.get(r.name) === r));
  check('a released frame keeps its name, so it can be read again',
    recs.slice(0, 3).every(r => IMAGE_NAMES.has(r.name)));
  check('nothing is released twice', collectSources([]) === 0);
}

/* ---------------- the frame in hand and the ones decoded ahead are pinned ---------------- */
{
  reset();
  const recs = [];
  for (let i = 0; i < 8; i++) recs.push(listed(`f${i}.png`, 1));
  /* the two oldest frames are the ones in use: the read_image that is running,
     named by its record, and one the readahead parked, named by name */
  const freed = collectSources([recs[0], 'f1.png']);
  check('the frame of the read_image that is running is never released',
    IMAGE_SOURCES.get('f0.png') === recs[0] && recs[0].gray !== null);
  check('a frame named by the readahead is never released',
    IMAGE_SOURCES.get('f1.png') === recs[1] && recs[1].gray !== null);
  check('the frames between the pinned ones can go', freed === 3, `${freed} released`);
  check('the frames read last stay warm',
    recs.slice(5).every(r => IMAGE_SOURCES.get(r.name) === r));
}

/* ---------------- a frame that cannot be read again is never released ---------------- */
{
  reset();
  const picked = frame('supplied.png', 19.5);             // "Load file…": no URL, no folder
  const builtin = frame('printer_chip', 1, { builtin: true });
  const stale = listed('stale.png', 19.5);                // read long ago, but of the folder
  const warm = [];
  for (let i = 0; i < 4; i++) warm.push(listed(`w${i}.png`, 1));

  const freed = collectSources([]);
  check('a supplied file keeps its pixels (it could not be read again)',
    IMAGE_SOURCES.get('supplied.png') === picked && picked.gray !== null);
  check('the built-in picture keeps its pixels', IMAGE_SOURCES.get('printer_chip') === builtin);
  check('a file of the folder waits its turn like any other',
    !IMAGE_SOURCES.has('stale.png') && stale.gray === null, `freed ${freed}`);
  check('the warm set is the most recently read frames',
    warm.slice(1).every(r => IMAGE_SOURCES.get(r.name) === r) && warm[0].gray === null);
}

/* ---------------- the cache holds more than SOURCE_KEEP only while it is small ---------------- */
{
  reset();
  const a = listed('a.png', 200), b = listed('b.png', 200), c = listed('c.png', 200);
  const freed = collectSources([]);
  check('the warm set never exceeds SOURCE_KEEP_BYTES of gray', freed === 2,
    `${freed} released, cap ${SOURCE_KEEP_BYTES / MB} MB`);
  check('the newest frame of the too-large set is the one that stays', IMAGE_SOURCES.get('c.png') === c);
  check('...and the two before it went', !IMAGE_SOURCES.has('a.png') && !IMAGE_SOURCES.has('b.png'));
  check('a frame of the warm set still exists after a second collection',
    collectSources([]) === 0 && IMAGE_SOURCES.get('c.png') === c);
}

/* ---------------- registering a file ---------------- */
{
  reset();
  const canvas = { width: 12, height: 7 };
  const rec = registerImageSource('shot.png', canvas, false);
  check('a registered file has no gray frame yet (it is decoded on the first read)', !rec.gray);
  check('a registered file knows its size', rec.w === 12 && rec.h === 7);
  check('a registered file is a name of this session', IMAGE_NAMES.has('shot.png'));
  check('registering counts as a use', rec.used > 0);
  const demo = registerImageSource('printer_chip', canvas, true);
  check('the built-in picture is not a file of the folder', !IMAGE_NAMES.has('printer_chip'));
  check('the built-in picture keeps its canvas', demo.canvas === canvas && demo.canvas.width === 12);

  /* re-loading a file replaces its frame and gives the old pixels back */
  const old = listed('again.png', 4);
  const was = old.gray;
  const again = registerImageSource('again.png', { width: 3, height: 3 }, false);
  check('loading a file again does not leak the frame it replaces', was.deleted === true);
  check('loading a file again replaces the record', IMAGE_SOURCES.get('again.png') === again && !again.gray);
}

console.log(`\n${passed} checks passed`);
