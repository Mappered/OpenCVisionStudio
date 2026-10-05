'use strict';
/* ==========================================================================
   OpenCVS — smoke test for js/export.js (the workspace export).

   DOM-free: builds a small program model, runs every emitter, and checks the
   zip writer against known CRC/zip values.  This is the half of the export
   feature that does not need a browser.

   Run:  tools/node/node tools/test-export.js
   ========================================================================== */
const assert = require('node:assert/strict');
const { ExportKit } = require('../js/export.js');

let passed = 0;
function check(name, cond, detail) {
  assert.ok(cond, `${name}${detail ? ' — ' + detail : ''}`);
  passed++;
  console.log(`  ok  ${name}${detail ? ` (${detail})` : ''}`);
}
const dec = b => new TextDecoder().decode(b);

/* ---------------- zip writer ---------------- */
{
  check('crc32: the standard check value', ExportKit.crc32(new TextEncoder().encode('123456789')) === 0xCBF43926,
    '0x' + ExportKit.crc32(new TextEncoder().encode('123456789')).toString(16));

  const files = [
    { path: 'ws/README.md', data: '# hello\n' },
    { path: 'ws/src/main.py', data: 'print("hi")\n' },
  ];
  const z = ExportKit.zip(files);
  check('zip: returns a Uint8Array', z instanceof Uint8Array);
  check('zip: starts with the local-file magic PK\\x03\\x04',
    z[0] === 0x50 && z[1] === 0x4B && z[2] === 0x03 && z[3] === 0x04);
  const names = ExportKit.unzipNames(z);
  check('zip: central directory lists every entry in order', names.join(',') === 'ws/README.md,ws/src/main.py', names.join(','));
  check('zip: a stored entry round-trips', dec(ExportKit.unzipEntry(z, 'ws/README.md').data) === '# hello\n');
  check('zip: a second entry round-trips', dec(ExportKit.unzipEntry(z, 'ws/src/main.py').data) === 'print("hi")\n');
  check('zip: an unknown entry throws', (() => { try { ExportKit.unzipEntry(z, 'nope'); return false; } catch { return true; } })());
  check('zip: an empty file list still produces a valid archive',
    ExportKit.unzipNames(ExportKit.zip([])).length === 0);
}

/* ---------------- language catalogue ---------------- */
{
  const L = ExportKit.LANGUAGES;
  check('languages: eight targets', L.length === 8, String(L.length));
  check('languages: the default is TypeScript', ExportKit.DEFAULT_LANGUAGE_ID === 'typescript', ExportKit.DEFAULT_LANGUAGE_ID);
  check('languages: default is flagged on exactly one entry', L.filter(l => l.def).length === 1);
  check('languages: the two C# variants share the cs family',
    L.filter(l => l.family === 'cs').length === 2 && L.filter(l => l.family === 'cs').every(l => l.id.startsWith('csharp-')));
  check('languages: every entry has the fields the emitters need',
    L.every(l => l.id && l.label && l.family && l.ext.startsWith('.') && l.vscodeLang && l.lib && l.runtime && Array.isArray(l.recommend)));
  check('languages: ids are unique', new Set(L.map(l => l.id)).size === L.length);
  check('languages: language() resolves an id', ExportKit.language('rust').family === 'rs');
  check('languages: language() falls back to the default', ExportKit.language('nope').id === ExportKit.DEFAULT_LANGUAGE_ID);
  check('languages: the order the dialog shows', L.map(l => l.id).join(',') ===
    'csharp-net48,csharp-net10,javascript,typescript,nodejs-ts,python,c,rust');
}

/* ---------------- expression translation ---------------- */
{
  const t = (e, f) => ExportKit.translateExpr(e, f);
  check('expr: rad() becomes the target maths', t('rad(30)', 'js') === '((30) * Math.PI / 180)', t('rad(30)', 'js'));
  check('expr: Python gets math.radians', t('rad(30)', 'py') === 'math.radians(30)', t('rad(30)', 'py'));
  check('expr: |Tuple| is a length', t('|Regions|', 'cs') === '(Regions).Length', t('|Regions|', 'cs'));
  check('expr: Python length', t('|Regions|', 'py') === 'len(Regions)');
  check('expr: and / or / not become operators', t('A and B or not C', 'js') === 'A && B || !C', t('A and B or not C', 'js'));
  check('expr: Python keeps its keywords', t('A and B or not C', 'py') === 'A and B or not C');
  check('expr: <> is !=', t('A <> B', 'c') === 'A != B', t('A <> B', 'c'));
  check('expr: a string comparison keeps its literal', t("Mode = 'on'", 'js') === 'Mode == "on"', t("Mode = 'on'", 'js'));
  check('expr: Python keeps single quotes', t("Mode = 'on'", 'py') === "Mode == 'on'", t("Mode = 'on'", 'py'));
  check('expr: an escaped quote survives', t("'it''s' + S", 'js') === '"it\'s" + S', t("'it''s' + S", 'js'));
  check('expr: a literal is not rewritten inside', t("'Area and less'", 'js') === '"Area and less"', t("'Area and less'", 'js'));
  check('expr: a number comparison is untouched', t('A >= 3', 'cs') === 'A >= 3');
  check('expr: the empty string stays empty', t('', 'js') === '');
}

/* ---------------- parser ---------------- */
{
  const S = ExportKit.parseBody([
    '* a comment',
    'for I := 0 to 3 by 1',
    '    X := I',
    'endfor',
    'while (A = B)',
    'endwhile',
    'repeat',
    'until (Ok)',
    'if (N > 0)',
    'elseif (N < 0)',
    'else',
    'endif',
    'break',
    'read_image (Image, \'file\')',
    '',
  ]);
  const kinds = S.map(s => s.kind).join(',');
  check('parse: the statement kinds',
    kinds === 'comment,for,assign,endfor,while,endwhile,repeat,until,if,elseif,else,endif,break,call,blank', kinds);
  check('parse: a for keeps its name and bounds',
    S[1].name === 'I' && S[1].from === '0' && S[1].to === '3' && S[1].by === '1');
  check('parse: a for without by has no step', ExportKit.parseBody(['for I := 1 to 9'])[0].by === null);
  check('parse: a call keeps its operator and arguments',
    S[13].op === 'read_image' && S[13].args.length === 2 && S[13].args[1] === "'file'", JSON.stringify(S[13]));
  check('parse: an assignment keeps its expression', S[2].target === 'X' && S[2].expr === 'I');
  check('splitTop: nested brackets and strings are not split',
    ExportKit.splitTop("A, f(B, C), 'x,y', D").length === 4);
}

/* ---------------- the fixture program ---------------- */
const OPINFO = {
  read_image: { params: [['Image', 'output', 'iconic'], ['FileName', 'input', 'control']] },
  get_image_size: { params: [['Image', 'input', 'iconic'], ['Width', 'output', 'control'], ['Height', 'output', 'control']] },
  threshold: { params: [['Image', 'input', 'iconic'], ['Region', 'output', 'iconic'], ['MinGray', 'input', 'control'], ['MaxGray', 'input', 'control']] },
  connection: { params: [['Region', 'input', 'iconic'], ['ConnectedRegions', 'output', 'iconic']] },
  select_shape: { params: [['Regions', 'input', 'iconic'], ['SelectedRegions', 'output', 'iconic'], ['Features', 'input', 'control'], ['Operation', 'input', 'control'], ['Min', 'input', 'control'], ['Max', 'input', 'control']] },
  count_obj: { params: [['Objects', 'input', 'iconic'], ['Number', 'output', 'control']] },
  area_center: { params: [['Regions', 'input', 'iconic'], ['Area', 'output', 'control'], ['Row', 'output', 'control'], ['Column', 'output', 'control']] },
  dev_open_window: { params: [['Row', 'input', 'control'], ['Column', 'input', 'control'], ['Width', 'input', 'control'], ['Height', 'input', 'control'], ['Background', 'input', 'control'], ['WindowHandle', 'output', 'control']] },
  dev_display: { params: [['object', 'input', 'iconic']] },
  disp_message: { params: [['WindowHandle', 'input', 'control'], ['String', 'input', 'control'], ['CoordSystem', 'input', 'control'], ['Row', 'input', 'control'], ['Column', 'input', 'control'], ['Color', 'input', 'control'], ['Box', 'input', 'control']] },
  stop: { params: [] },
};
const PROCEDURES = {
  main: { lines: [
    "* Blob analysis demo",
    "read_image (Image, 'printer_chip')",
    "get_image_size (Image, Width, Height)",
    "dev_open_window (0, 0, 640/2, 480/2, 'black', WindowHandle)",
    "dev_display (Image)",
    "threshold (Image, Region, 128, 255)",
    "connection (Region, ConnectedRegions)",
    "detect_features (ConnectedRegions, Detected, DetectedCount)",
    "select_shape (ConnectedRegions, SelectedRegions, 'area', 'and', 1000, 100000)",
    "count_obj (SelectedRegions, Number)",
    "area_center (SelectedRegions, Area, Row, Column)",
    "if (Number > 0)",
    "    disp_message (WindowHandle, 'Found ' + Number + ' parts', 'window', 12, 12)",
    "endif",
    "stop ()",
  ] },
  detect_features: { params: [['Regions', 'input', 'iconic'], ['Selected', 'output', 'iconic'], ['Count', 'output', 'control']], lines: [
    "select_shape (Regions, Selected, 'area', 'and', 100, 100000)",
    "count_obj (Selected, Count)",
    "return ()",
  ] },
  scan_lines: { params: [['Count', 'input', 'control'], ['Sum', 'output', 'control']], lines: [
    "Sum := 0",
    "for I := 0 to Count by 1",
    "    Sum := Sum + I",
    "endfor",
    "while (Sum > 100)",
    "    Sum := Sum / 2",
    "endwhile",
    "repeat",
    "    Sum := Sum - 1",
    "until (Sum < 1)",
  ] },
};

const model = ExportKit.buildModel(PROCEDURES, OPINFO);
{
  check('model: every procedure is modelled', model.procedures.length === 3, String(model.procedures.length));
  check('model: the entry is main', model.entry === 'main');
  check('model: parameters are normalised',
    model.byName.detect_features.params.length === 3 &&
    model.byName.detect_features.params[1].dir === 'output' &&
    model.byName.detect_features.params[1].type === 'iconic' &&
    model.byName.detect_features.params[2].type === 'control');
  check('model: statements are parsed', model.byName.main.stmts.length === 15, String(model.byName.main.stmts.length));
  check('model: byName indexes the procedures', Object.keys(model.byName).join(',') === 'main,detect_features,scan_lines');
}

/* ---------------- per-language emitters ---------------- */
{
  const mainOf = id => ExportKit.buildWorkspace(id, PROCEDURES, { opinfo: OPINFO, workspaceName: 'Demo' })
    .files.filter(f => /(^|\/)(Program|index|main)\.(cs|js|ts|py|c|rs)$/.test(f.path))
    .map(f => f.data)[0] || '';

  check('cs: Main is the entry point', /static void Main\(string\[\] args\)/.test(mainOf('csharp-net48')));
  check('cs: operators go through the Ops class', /Ops\.ReadImage\(/.test(mainOf('csharp-net48')), );
  check('cs: the namespace carries the workspace name', /namespace Demo\b/.test(mainOf('csharp-net10')));
  check('cs: a user procedure becomes a static method', /static \(Mat Selected, dynamic Count\) DetectFeatures\(Mat Regions\)/.test(mainOf('csharp-net48')), mainOf('csharp-net48').match(/static .*DetectFeatures.*/)[0]);
  check('js: main() is the entry point and is called', /^function main\(\) \{/m.test(mainOf('javascript')) && /^main\(\);$/m.test(mainOf('javascript')));
  check('js: operators go through the ops module', /ops\.readImage\(/.test(mainOf('javascript')));
  check('js: a multi-output user procedure returns an array', /return \[Selected, Count\];/.test(mainOf('javascript')));
  check('js: a multi-output call destructures', /let \[Detected, DetectedCount\] = detectFeatures\(ConnectedRegions\);/.test(mainOf('javascript')));
  check('js: an operator call destructures its outputs', /let \[Area, Row, Column\] = ops\.areaCenter\(SelectedRegions\);/.test(mainOf('javascript')));
  check('ts: TypeScript shares the JS emitter', /ops\.readImage\(/.test(mainOf('typescript')));
  check('py: a def is the entry point', /^def main\(\):/m.test(mainOf('python')) && /^    main\(\)$/m.test(mainOf('python')));
  check('py: operators are imported from ops', /read_image\(/.test(mainOf('python')) && /from ops import \*/.test(mainOf('python')));
  check('py: rad() becomes math.radians', /math\.radians\(/.test(mainOf('python')) === false);   // the fixture has no rad()
  check('c: int main(void) is the entry point', /^int main\(void\)$/m.test(mainOf('c')));
  check('c: operators are prefixed ovs_', /ovs_read_image\(&Image, /.test(mainOf('c')), mainOf('c').split('\n')[0]);
  check('rust: fn main() is the entry point', /^fn main\(\) \{/m.test(mainOf('rust')));
  check('rust: operators are module-qualified', /ops::read_image\(/.test(mainOf('rust')));

  /* control flow in the scan_lines procedure */
  const scanPy = ExportKit.buildWorkspace('python', PROCEDURES, { opinfo: OPINFO, workspaceName: 'Demo' })
    .files.find(f => f.path.endsWith('main.py')).data;
  check('py: a for loop becomes range()', /for I in range\(0, \(Count\) \+ 1, 1\):/.test(scanPy), scanPy.match(/for .*\n/)[0].trim());
  check('py: a while loop keeps its condition', /while Sum > 100:/.test(scanPy));
  check('py: a repeat becomes while True with a break', /while True:/.test(scanPy) && /if Sum < 1: break/.test(scanPy));

  const scanCs = ExportKit.buildWorkspace('csharp-net48', PROCEDURES, { opinfo: OPINFO, workspaceName: 'Demo' })
    .files.find(f => f.path.endsWith('Program.cs')).data;
  check('cs: a for loop becomes a C# for', /for \(var I = 0; I <= Count; I \+= 1\)/.test(scanCs), scanCs.match(/for \(.*\n/)[0].trim());
  check('cs: a repeat becomes do/while', /do \{/.test(scanCs) && /\} while \(!\(Sum < 1\)\);/.test(scanCs));
}

/* ---------------- the workspace ---------------- */
{
  for (const lang of ExportKit.LANGUAGES) {
    const ws = ExportKit.buildWorkspace(lang.id, PROCEDURES, { opinfo: OPINFO, workspaceName: 'Demo' });
    const names = ws.files.map(f => f.path);
    check(`${lang.id}: the workspace is rooted at Demo/`, names.every(n => n.startsWith('Demo/')), names[0]);
    check(`${lang.id}: .vscode settings select the language`,
      dec(ExportKit.unzipEntry(ExportKit.zip(ws.files), 'Demo/.vscode/settings.json').data).includes(`"files.defaultLanguage": "${lang.vscodeLang}"`));
    check(`${lang.id}: .vscode recommends the language extension`,
      names.includes('Demo/.vscode/extensions.json') && names.includes('Demo/.vscode/launch.json') && names.includes('Demo/.vscode/tasks.json'));
    check(`${lang.id}: README, editorconfig and gitignore are always there`,
      names.includes('Demo/README.md') && names.includes('Demo/.editorconfig') && names.includes('Demo/.gitignore'));
    check(`${lang.id}: no two files share a path`, new Set(names).size === names.length, names.join(','));
    check(`${lang.id}: every file has content`, ws.files.every(f => typeof f.data === 'string' || f.data instanceof Uint8Array));
    check(`${lang.id}: the README names the language and the runtime`, (() => {
      const r = ExportKit.unzipEntry(ExportKit.zip(ws.files), 'Demo/README.md').data;
      return dec(r).includes(lang.label) && dec(r).includes(lang.lib);
    })());
  }

  /* the language-specific project files */
  const projOf = id => ExportKit.buildWorkspace(id, PROCEDURES, { opinfo: OPINFO, workspaceName: 'Demo' }).files.map(f => f.path);
  check('cs .net48: Program.cs + Ops.cs + .csproj + net48',
    (() => { const n = projOf('csharp-net48'); return n.includes('Demo/Program.cs') && n.includes('Demo/Ops.cs') &&
      ExportKit.unzipEntry(ExportKit.zip(ExportKit.buildWorkspace('csharp-net48', PROCEDURES, { opinfo: OPINFO, workspaceName: 'Demo' }).files), 'Demo/Demo.csproj').data.length > 0 &&
      dec(ExportKit.unzipEntry(ExportKit.zip(ExportKit.buildWorkspace('csharp-net48', PROCEDURES, { opinfo: OPINFO, workspaceName: 'Demo' }).files), 'Demo/Demo.csproj').data).includes('<TargetFramework>net48</TargetFramework>'); })());
  check('cs .net10: the .csproj targets net10.0',
    (() => { const ws = ExportKit.buildWorkspace('csharp-net10', PROCEDURES, { opinfo: OPINFO, workspaceName: 'Demo' });
      return dec(ExportKit.unzipEntry(ExportKit.zip(ws.files), 'Demo/Demo.csproj').data).includes('<TargetFramework>net10.0</TargetFramework>'); })());
  check('cs: the .csproj references OpenCvSharp',
    (() => { const ws = ExportKit.buildWorkspace('csharp-net48', PROCEDURES, { opinfo: OPINFO, workspaceName: 'Demo' });
      return dec(ExportKit.unzipEntry(ExportKit.zip(ws.files), 'Demo/Demo.csproj').data).includes('OpenCvSharp4'); })());
  check('js: src/index.js + src/ops.js + package.json',
    ['Demo/src/index.js', 'Demo/src/ops.js', 'Demo/package.json'].every(p => projOf('javascript').includes(p)));
  check('ts: src/index.ts + tsconfig.json',
    ['Demo/src/index.ts', 'Demo/src/ops.ts', 'Demo/package.json', 'Demo/tsconfig.json'].every(p => projOf('typescript').includes(p)));
  check('nodejs-ts: the package pins Node 20',
    (() => { const ws = ExportKit.buildWorkspace('nodejs-ts', PROCEDURES, { opinfo: OPINFO, workspaceName: 'Demo' });
      return dec(ExportKit.unzipEntry(ExportKit.zip(ws.files), 'Demo/package.json').data).includes('>=20'); })());
  check('python: main.py + ops.py + requirements.txt',
    ['Demo/main.py', 'Demo/ops.py', 'Demo/requirements.txt'].every(p => projOf('python').includes(p)));
  check('c: main.c + ops.h + ops.c + Makefile',
    ['Demo/main.c', 'Demo/ops.h', 'Demo/ops.c', 'Demo/Makefile'].every(p => projOf('c').includes(p)));
  check('rust: src/main.rs + src/ops.rs + Cargo.toml',
    ['Demo/src/main.rs', 'Demo/src/ops.rs', 'Demo/Cargo.toml'].every(p => projOf('rust').includes(p)));

  /* workspace-name handling */
  const named = ExportKit.buildWorkspace('python', PROCEDURES, { opinfo: OPINFO, workspaceName: '  my cool proj!  ' });
  check('workspace: an awkward name is kept as the folder', named.files.every(f => f.path.startsWith('my cool proj!/')));
  check('workspace: the default name is used when none is given',
    ExportKit.buildWorkspace('python', PROCEDURES, { opinfo: OPINFO }).files.every(f => f.path.startsWith('opencvs-workspace/')));
}

/* ---------------- the runtime stubs ---------------- */
{
  const opsOf = id => {
    const ws = ExportKit.buildWorkspace(id, PROCEDURES, { opinfo: OPINFO, workspaceName: 'Demo' });
    const f = ws.files.find(x => /ops\.(cs|js|ts|py|c|rs|h)$/i.test(x.path));
    return f ? f.data : '';
  };
  check('runtime: only the operators the program calls are emitted',
    /ReadImage/.test(opsOf('csharp-net48')) && !/PaintRegion/.test(opsOf('csharp-net48')));
  check('runtime: read_image maps onto OpenCvSharp in C#', /Cv2\.ImRead/.test(opsOf('csharp-net48')));
  check('runtime: threshold maps onto OpenCvSharp in C#', /Cv2\.Threshold/.test(opsOf('csharp-net48')));
  check('runtime: an unmapped operator is a marked TODO stub',
    /NotImplementedException\("select_shape/.test(opsOf('csharp-net48')));
  check('runtime: JS stubs throw with the library name',
    /not implemented yet — implement it with opencv\.js/.test(opsOf('javascript')));
  check('runtime: Python stubs raise NotImplementedError',
    /raise NotImplementedError\("connection/.test(opsOf('python')));
  check('runtime: Rust stubs are unimplemented!',
    /unimplemented!\("count_obj/.test(opsOf('rust')));
  check('runtime: C stubs declare ovs_ functions in the header',
    /void ovs_read_image\(Hobject \*Image, HTuple FileName\);/.test(opsOf('c')));
  check('runtime: a display operator becomes an inert stub',
    /display operator: no console output/.test(opsOf('javascript')) || /display operator/.test(opsOf('csharp-net48')));
}

/* ---------------- formatting and identifier safety ---------------- */
{
  const fileOf = (id, re) => {
    const ws = ExportKit.buildWorkspace(id, PROCEDURES, { opinfo: OPINFO, workspaceName: 'Demo' });
    const f = ws.files.find(x => re.test(x.path));
    return f ? f.data : '';
  };
  const csMain = fileOf('csharp-net48', /Program\.cs$/);
  const csOps = fileOf('csharp-net48', /Ops\.cs$/);
  const tsMain = fileOf('typescript', /src\/index\.ts$/);
  const tsOps = fileOf('typescript', /src\/ops\.ts$/);
  const pyMain = fileOf('python', /main\.py$/);

  /* the block structures have to nest: a C# member sits two levels in, and the
     statements of its body one further */
  check('cs: Main is indented inside namespace + class', /^        static void Main\(string\[\] args\)$/m.test(csMain));
  check('cs: the body of Main is indented inside it', /^            var Image = Ops\.ReadImage\("printer_chip"\);$/m.test(csMain));
  check('cs: a user procedure lines up with Main', /^        static \(Mat Selected, dynamic Count\) DetectFeatures\(Mat Regions\)$/m.test(csMain));
  check('cs: the runtime class members sit inside the class', /^        public static Mat ReadImage/m.test(csOps));
  check('cs: the mapped threshold is a public static member', /^        public static Mat Threshold\(Mat Image, dynamic MinGray, dynamic MaxGray\)$/m.test(csOps));
  check('cs: the mapped threshold body is nested one level deeper',
    /^            Cv2\.Threshold\(Image, region, \(double\)MinGray, \(double\)MaxGray, ThresholdTypes\.Binary\);$/m.test(csOps));

  /* js/ts/python have no wrapper around the procedures, so they start at column 0 */
  check('ts: the entry function sits at column 0', /^function main\(\) \{$/m.test(tsMain));
  check('ts: a user procedure sits at column 0 too', /^function detectFeatures\(Regions\) \{$/m.test(tsMain), tsMain.split('\n').filter(l => /detectFeatures/.test(l)).join(' | '));
  check('ts: its statements are one level in', /^    let Selected = ops\.selectShape\(Regions, "area", "and", 100, 100000\);$/m.test(tsMain));
  check('ts: the runtime exports sit at column 0', /^export function readImage\(FileName\): any \{$/m.test(tsOps));
  check('ts: a multi-output stub is annotated with an array type', /^export function areaCenter\(Regions\): any\[\] \{$/m.test(tsOps));
  check('ts: a void stub is annotated as void', /^export function devDisplay\(object\): void \{$/m.test(tsOps));
  check('ts: the runtime body is one level in', /^    throw new Error\("read_image/m.test(tsOps));
  check('py: def main() and its body', /^def main\(\):$/m.test(pyMain) && /^    Image = read_image\('printer_chip'\)$/m.test(pyMain));
  check('py: a user procedure starts at column 0', /^def detect_features\(Regions\):$/m.test(pyMain));

  /* a HALCON parameter may be named after a language keyword */
  check('cs: a parameter called object is escaped for the keyword', /Mat @object/.test(csOps), csOps.split('\n').find(l => /DevDisplay/.test(l)));
  check('cs: the escaped name is used inside the runtime body', /Ops\.DevDisplay\(\(Mat\)Image\)/.test(csMain));

  /* C# — a value of unknown type would make the call dynamically bound, and a
     dynamically bound call cannot be deconstructed (CS8133), so every argument
     that is not provably static is pinned to the parameter's declared type */
  check('cs: an iconic argument is pinned to Mat', /Ops\.Threshold\(\(Mat\)Image, 128, 255\)/.test(csMain), csMain.split('\n').find(l => /Threshold\(/.test(l)));
  check('cs: a control argument is pinned to object', /Ops\.GetImageSize\(\(Mat\)Image\)/.test(csMain));
  check('cs: literals keep the call readable',
    /Ops\.DevSetColor\("yellow"\)|Ops\.ReadImage\("printer_chip"\)/.test(csMain) && !/\(object\)128/.test(csMain));
  check('cs: a compound expression is pinned as a whole',
    ExportKit.translateExpr('Height*0.5', 'cs') === 'Height*0.5' &&
    /Ops\.[A-Za-z0-9]+\(\(object\)WindowHandle, \(object\)\(Height\*0\.5\), \(object\)\(Width\*0\.5\)/.test(
      ExportKit.buildWorkspace('csharp-net48', {
        main: { lines: ['get_image_size (Image, Width, Height)', 'disp_rectangle1 (WindowHandle, Height*0.5, Width*0.5, 10, 10)'] },
      }, { opinfo: OPINFO, workspaceName: 'Pin' }).files.find(f => /Program\.cs$/.test(f.path)).data),
    ExportKit.buildWorkspace('csharp-net48', {
      main: { lines: ['get_image_size (Image, Width, Height)', 'disp_rectangle1 (WindowHandle, Height*0.5, Width*0.5, 10, 10)'] },
    }, { opinfo: OPINFO, workspaceName: 'Pin' }).files.find(f => /Program\.cs$/.test(f.path)).data
      .split('\n').find(l => /DispRectangle1/.test(l)));

  /* an argument that is not an identifier must not become a parameter name */
  const unknown = ExportKit.buildWorkspace('csharp-net48', { main: { lines: [
    "paint_region (Region, Image, Painted, 128, 'fill')",
  ] } }, { opinfo: OPINFO, workspaceName: 'Odd' });
  const unknownOps = unknown.files.find(f => /Ops\.cs$/.test(f.path)).data;
  check('runtime: an unknown operator names its parameters after the arguments',
    /public static void PaintRegion\(dynamic Region, dynamic Image, dynamic Painted, dynamic arg4, dynamic arg5\)/.test(unknownOps),
    unknownOps.split('\n').find(l => /PaintRegion/.test(l)));
  check('runtime: the literal itself is still passed at the call site',
    /Ops\.DispMessage\(\(object\)WindowHandle, \(object\)\("Found " \+ Number \+ " parts"\), "window", 12, 12\);/.test(csMain),
    csMain.split('\n').find(l => /DispMessage/.test(l)));

  /* a hand-written call may pass more arguments than the operator declares, and
     the surplus may even sit in an output slot — the signature wins */
  const odd = ExportKit.buildWorkspace('csharp-net48', { main: { lines: [
    "open_framegrabber ('DirectShow', 0, 0, 0, 0, 0, 0, 'default', 8, 'gray', -1, 'default', 'default', 'default', 'default', 'default', -1, AcqHandle)",
  ] } }, { opinfo: {
    open_framegrabber: { params: [['Name', 'input', 'control'], ['HorizontalOffset', 'input', 'control'],
      ['VerticalOffset', 'input', 'control'], ['ImageWidth', 'input', 'control'], ['ImageHeight', 'input', 'control'],
      ['StartRow', 'input', 'control'], ['StartColumn', 'input', 'control'], ['Field', 'input', 'control'],
      ['BitsPerChannel', 'input', 'control'], ['ColorType', 'input', 'control'], ['Generic', 'input', 'control'],
      ['ExternalTrigger', 'input', 'control'], ['CameraType', 'input', 'control'], ['Device', 'input', 'control'],
      ['Port', 'input', 'control'], ['LineIn', 'input', 'control'], ['AcqHandle', 'output', 'control']] },
  }, workspaceName: 'Odd' }).files.find(f => /Program\.cs$/.test(f.path)).data;
  check('cs: a literal in an output slot does not become a target',
    /var AcqHandle = Ops\.OpenFramegrabber\(/.test(odd), odd.split('\n').find(l => /OpenFramegrabber/.test(l)));
  check('cs: surplus arguments beyond the signature are dropped',
    (odd.split('\n').find(l => /OpenFramegrabber/.test(l)).match(/\(([^)]*)\)/)[1].split(', ').length === 16) &&
    !/OpenFramegrabber\(.*AcqHandle/.test(odd),
    odd.split('\n').find(l => /OpenFramegrabber/.test(l)));

  /* the same operator called twice must not declare its variables twice */
  const twiceProg = { main: { lines: [
    "read_image (Image, 'printer_chip')",
    'get_image_size (Image, Width, Height)',
    'get_image_size (Image, Width, Height)',
    'count_obj (Image, Number)',
    'count_obj (Image, Number)',
  ] } };
  const twiceOf = (id, re) => ExportKit.buildWorkspace(id, twiceProg, { opinfo: OPINFO, workspaceName: 'Twice' })
    .files.find(f => re.test(f.path)).data;
  const csTwice = twiceOf('csharp-net48', /Program\.cs$/);
  const tsTwice = twiceOf('typescript', /src\/index\.ts$/);
  check('cs: a repeated tuple call destructures into the existing names',
    (csTwice.match(/var \(Width, Height\) = Ops\.GetImageSize/g) || []).length === 1 &&
    /\(Width, Height\) = Ops\.GetImageSize\(\(Mat\)Image\);/.test(csTwice), csTwice.split('\n').filter(l => /GetImageSize/.test(l)).join(' | '));
  check('cs: a repeated single-output call assigns too',
    (csTwice.match(/var Number = /g) || []).length === 1 && /            Number = Ops\.CountObj\(\(Mat\)Image\);/.test(csTwice),
    csTwice.split('\n').filter(l => /CountObj/.test(l)).join(' | '));
  check('ts: the second call is a parenthesised destructuring assignment',
    /^    let \[Width, Height\] = ops\.getImageSize\(Image\);$/m.test(tsTwice) &&
    /^    \(\[Width, Height\] = ops\.getImageSize\(Image\)\);$/m.test(tsTwice), tsTwice.split('\n').filter(l => /getImageSize/.test(l)).join(' | '));
}

/* ---------------- parameters inferred for the real procedures ---------------- */
/* the exported program.ovs procedures carry no parameter list at all — one
   shared scope — so the parameters have to be worked out from the lines */
{
  const shared = {
    main: { lines: ["read_image (Image, 'printer_chip')", 'dev_display (Image)', 'inspect (Image)'] },
    inspect: { lines: ['threshold (Image, Region, 128, 255)', 'count_obj (Region, Count)'] },
  };
  const model2 = ExportKit.buildModel(shared, OPINFO);
  check('inference: the variable the procedure reads becomes its input',
    model2.byName.inspect.params.map(p => p.name).join(',') === 'Image', model2.byName.inspect.params.map(p => `${p.name}:${p.type}`).join(','));
  check('inference: and it is typed after the operator slots it fills',
    model2.byName.inspect.inferred === true && model2.byName.inspect.params[0].type === 'iconic');
  check('inference: a local of the procedure does not leak out as a parameter',
    !model2.byName.inspect.params.some(p => p.name === 'Region' || p.name === 'Count'));
  check('inference: the entry point never gains parameters',
    model2.byName.main.params.length === 0 && model2.byName.main.inferred === undefined);

  const csShared = ExportKit.buildWorkspace('csharp-net48', shared, { opinfo: OPINFO, workspaceName: 'Shared' })
    .files.find(f => /Program\.cs$/.test(f.path)).data;
  check('inference: the C# signature carries the inferred parameter',
    /static void Inspect\(Mat Image\)/.test(csShared), csShared.split('\n').find(l => /static .*Inspect/.test(l)));
  check('inference: the caller pins the argument it passes',
    /Inspect\(\(Mat\)Image\);/.test(csShared));
  check('inference: the comment says where the parameter came from',
    /— the program variables it reads became parameters/.test(csShared));
  check('inference: the entry point stays parameterless', /static void Main\(string\[\] args\)/.test(csShared));

  const pyShared = ExportKit.buildWorkspace('python', shared, { opinfo: OPINFO, workspaceName: 'Shared' })
    .files.find(f => /main\.py$/.test(f.path)).data;
  check('inference: the Python signature too', /^def inspect\(Image\):$/m.test(pyShared));
}

/* ---------------- HALCON syntax the target language does not have ---------- */
{
  const syntax = { main: { lines: [
    "gen_region_polygon (Region, [Height*0.44, Height*0.44], [Width*0.62, Width*0.92])",
    "read_tuple (FileName, Values, ['a', 'b'])",
    "disp_message (WindowHandle, 'Found ' + Number + ' parts', 12, 12)",
    'Root := sqrt(Number)',
    'Deg := rad(90) + deg(Half)',
  ] } };
  const srcOf = (id, re) => ExportKit.buildWorkspace(id, syntax, { opinfo: OPINFO, workspaceName: 'Syntax' })
    .files.find(f => re.test(f.path)).data;
  const csSyn = srcOf('csharp-net48', /Program\.cs$/);
  const tsSyn = srcOf('typescript', /src\/index\.ts$/);
  const pySyn = srcOf('python', /main\.py$/);
  const rsSyn = srcOf('rust', /src\/main\.rs$/);
  const cSyn = srcOf('c', /main\.c$/);

  check('tuples: C# gets a dynamic array', /new dynamic\[\] \{ Height\*0\.44, Height\*0\.44 \}/.test(csSyn), csSyn.split('\n').find(l => /GenRegionPolygon/.test(l)));
  check('tuples: Rust gets a vec!', /vec!\[Height\*0\.44, Height\*0\.44\]/.test(rsSyn));
  check('tuples: Python gets a list', /\[Height\*0\.44, Height\*0\.44\]/.test(pySyn));
  check('tuples: the string elements of a C array become a const char * array',
    /\(const char \*\[\]\)\{ "a", "b" \}/.test(cSyn), cSyn.split('\n').find(l => /ReadTuple/.test(l)));
  check('tuples: a numeric C array stays double',
    /\(double\[\]\)\{ Height\*0\.44, Height\*0\.44 \}/.test(cSyn), cSyn.split('\n').find(l => /GenRegionPolygon/.test(l)));

  check('concat: Python stringifies the number', /'Found ' \+ str\(Number\) \+ ' parts'/.test(pySyn), pySyn.split('\n').find(l => /Found/.test(l)));
  check('concat: Rust formats the parts', /format!\("\{\}\{\}\{\}", "Found ", Number, " parts"\)/.test(rsSyn));
  check('concat: C concatenates through a helper', /ovs_cat\(3, "Found ", ovs_str\(Number\), " parts"\)/.test(cSyn));
  check('concat: C# and TypeScript keep the +', /"Found " \+ Number \+ " parts"/.test(csSyn) && /"Found " \+ Number \+ " parts"/.test(tsSyn));
  check('concat: the helpers exist in the C runtime', /HTuple ovs_cat\(int count, \.\.\.\);/.test(srcOf('c', /ops\.h$/)));

  check('intrinsics: sqrt maps onto the standard library',
    /Math\.Sqrt\(Number\)/.test(csSyn) && /math\.sqrt\(Number\)/.test(pySyn) && /\(Number\)\.sqrt\(\)/.test(rsSyn),
    [csSyn, pySyn, rsSyn].map(t => t.split('\n').find(l => /Sqrt|sqrt/.test(l))).join(' | '));
  check('intrinsics: rad/deg become angle conversions',
    /\* Math\.PI \/ 180\.0/.test(csSyn) && /math\.radians\(90\)/.test(pySyn) && /\.to_radians\(\)/.test(rsSyn),
    csSyn.split('\n').find(l => /Deg =/.test(l)));
}

/* ---------------- the C# project has to compile for real ---------------- */
{
  const csprojOf = id => ExportKit.buildWorkspace(id, PROCEDURES, { opinfo: OPINFO, workspaceName: 'Demo' })
    .files.find(f => /\.csproj$/.test(f.path)).data;
  const net48 = csprojOf('csharp-net48');
  check('csproj: net48 references Microsoft.CSharp for its dynamic call sites',
    /<TargetFramework>net48<\/TargetFramework>/.test(net48) && /<Reference Include="Microsoft\.CSharp" \/>/.test(net48), net48);
  check('csproj: net48 does not ask for nullable annotations',
    !/<Nullable>/.test(net48));
  check('csproj: the OpenCvSharp packages are pinned to one version',
    (net48.match(/Version="([0-9][^"]*)"/g) || []).length === 2 &&
    new Set((net48.match(/Version="([0-9][^"]*)"/g) || [])).size === 1, net48);
  check('csproj: implicit usings are off so the explicit using list wins',
    /<ImplicitUsings>disable<\/ImplicitUsings>/.test(net48) && /<LangVersion>latest<\/LangVersion>/.test(net48));
  check('csproj: the namespace matches the generated namespace',
    /<RootNamespace>Demo<\/RootNamespace>/.test(net48));
}

console.log(`\n${passed} checks passed`);
