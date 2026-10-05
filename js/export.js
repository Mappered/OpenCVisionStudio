'use strict';
/* ==========================================================================
   OpenCVS — Export: a program as a VS Code workspace in another language
   --------------------------------------------------------------------------
   The toolbar's Export button builds a .zip that holds a complete VS Code
   workspace for the language picked in the dialog:

     <name>/.vscode/settings.json      selects the language in the editor
     <name>/.vscode/extensions.json    recommends the language's extension
     <name>/.vscode/launch.json        run configuration
     <name>/.vscode/tasks.json         build task
     <name>/README.md                  what the workspace is, what is TODO
     <name>/.editorconfig, .gitignore
     <name>/<project file>             .csproj / package.json / Cargo.toml / …
     <name>/<source>                   the translated program + its runtime

   The translation is STRUCTURAL.  Control flow (if / for / while / repeat,
   assignments, procedure calls) and the procedure interfaces are turned into
   the target language; every HALCON operator becomes a call into a generated
   runtime module (`Ops.cs`, `ops.py`, `ops.rs`, …).  That module implements the
   few operators this build can map onto the target's vision library
   (read_image, threshold, …) and leaves every other one as a clearly marked
   TODO stub that still carries the HALCON signature, so an exported workspace
   is a starting point — it is NOT meant to build as-is ("no need to compile").

   Everything below is pure and DOM-free: the zip writer, the program model and
   the emitters are covered by tools/test-export.js.
   ========================================================================== */
const ExportKit = (() => {

  /* ==========================================================================
     ZIP WRITER (stored entries, no compression)
     A stored zip is: one local header + payload per file, then the central
     directory and its end record.  Deflate would need a compressor; storing is
     valid, universally understood and enough for a workspace.
     ========================================================================== */
  const CRC_TABLE = (() => {
    const t = new Uint32Array(256);
    for (let n = 0; n < 256; n++) {
      let c = n;
      for (let k = 0; k < 8; k++) c = (c & 1) ? (0xEDB88320 ^ (c >>> 1)) : (c >>> 1);
      t[n] = c >>> 0;
    }
    return t;
  })();

  function crc32(bytes) {
    let c = 0xFFFFFFFF;
    for (let i = 0; i < bytes.length; i++) c = CRC_TABLE[(c ^ bytes[i]) & 0xFF] ^ (c >>> 8);
    return (c ^ 0xFFFFFFFF) >>> 0;
  }

  const u16 = n => new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF]);
  const u32 = n => new Uint8Array([n & 0xFF, (n >>> 8) & 0xFF, (n >>> 16) & 0xFF, (n >>> 24) & 0xFF]);
  function concatBytes(...parts) {
    let len = 0;
    for (const p of parts) len += p.length;
    const out = new Uint8Array(len);
    let o = 0;
    for (const p of parts) { out.set(p, o); o += p.length; }
    return out;
  }
  const utf8 = s => new TextEncoder().encode(String(s));

  /* files: [{ path, data }] — `data` is a string (UTF-8) or a Uint8Array.
     Returns the whole archive as a Uint8Array. */
  function zip(files) {
    const DOS_DATE = 0x21;                        // 1980-01-01, the zip epoch
    const locals = [], central = [];
    let offset = 0;
    for (const f of files) {
      const path = String(f.path).replace(/\\/g, '/');
      const nameBytes = utf8(path);
      const data = (f.data instanceof Uint8Array) ? f.data : utf8(f.data == null ? '' : f.data);
      const crc = crc32(data);
      const local = concatBytes(
        u32(0x04034b50), u16(20), u16(0x0800), u16(0), u16(0), u16(DOS_DATE),
        u32(crc), u32(data.length), u32(data.length), u16(nameBytes.length), u16(0),
        nameBytes, data);
      locals.push(local);
      central.push(concatBytes(
        u32(0x02014b50), u16(20), u16(20), u16(0x0800), u16(0), u16(0), u16(DOS_DATE),
        u32(crc), u32(data.length), u32(data.length),
        u16(nameBytes.length), u16(0), u16(0), u16(0), u16(0), u32(0),
        u32(offset), nameBytes));
      offset += local.length;
    }
    const cd = concatBytes(...central);
    const eocd = concatBytes(
      u32(0x06054b50), u16(0), u16(0), u16(files.length), u16(files.length),
      u32(cd.length), u32(offset), u16(0));
    return concatBytes(...locals, cd, eocd);
  }

  /* Minimal reader used by the smoke test: the central directory's entry names
     and the payload of one entry (stored entries only). */
  function unzipNames(bytes) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    let eocd = -1;
    for (let i = bytes.length - 22; i >= 0 && i > bytes.length - 22 - 0xFFFF; i--) {
      if (dv.getUint32(i, true) === 0x06054b50) { eocd = i; break; }
    }
    if (eocd < 0) throw new Error('not a zip: no end-of-central-directory record');
    const count = dv.getUint16(eocd + 10, true);
    let p = dv.getUint32(eocd + 16, true);
    const names = [];
    for (let i = 0; i < count; i++) {
      if (dv.getUint32(p, true) !== 0x02014b50) throw new Error('bad central directory record');
      const nlen = dv.getUint16(p + 28, true);
      names.push(new TextDecoder().decode(bytes.subarray(p + 46, p + 46 + nlen)));
      p += 46 + nlen + dv.getUint16(p + 30, true) + dv.getUint16(p + 32, true);
    }
    return names;
  }

  function unzipEntry(bytes, wanted) {
    const dv = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const count = dv.getUint16(bytes.length - 22 + 10, true) || 0;
    // walk the central directory for the name, then read its local header
    let p = -1;
    for (let i = bytes.length - 22; i >= 0; i--) if (dv.getUint32(i, true) === 0x06054b50) { p = i; break; }
    if (p < 0) throw new Error('not a zip');
    let cd = dv.getUint32(p + 16, true);
    for (let i = 0; i < count; i++) {
      const nlen = dv.getUint16(cd + 28, true);
      const name = new TextDecoder().decode(bytes.subarray(cd + 46, cd + 46 + nlen));
      const csize = dv.getUint32(cd + 20, true);
      const loff = dv.getUint32(cd + 42, true);
      if (name === wanted) {
        const lname = dv.getUint16(loff + 26, true);
        const lext = dv.getUint16(loff + 28, true);
        const start = loff + 30 + lname + lext;
        return { name, data: bytes.subarray(start, start + csize) };
      }
      cd += 46 + nlen + dv.getUint16(cd + 30, true) + dv.getUint16(cd + 32, true);
    }
    throw new Error(`zip: '${wanted}' not found`);
  }

  /* ==========================================================================
     LANGUAGES — the targets the export dialog offers (order as in the menu)
     `family` picks the emitter (the two C# entries share one, JS/TS/Node too).
     `id` picks the workspace scaffold (project files, .vscode settings).
     ========================================================================== */
  const LANGUAGES = [
    { id: 'csharp-net48', label: 'C# (.NET Framework 4.8)', short: 'C# .NET 4.8',
      family: 'cs', ext: '.cs', vscodeLang: 'csharp', lib: 'OpenCvSharp4',
      recommend: ['ms-dotnettools.csdevkit', 'ms-dotnettools.csharp'], runtime: 'Ops.cs' },
    { id: 'csharp-net10', label: 'C# (.NET 10+)', short: 'C# .NET 10',
      family: 'cs', ext: '.cs', vscodeLang: 'csharp', lib: 'OpenCvSharp4',
      recommend: ['ms-dotnettools.csdevkit', 'ms-dotnettools.csharp'], runtime: 'Ops.cs' },
    { id: 'javascript', label: 'JavaScript', short: 'JavaScript',
      family: 'js', ext: '.js', vscodeLang: 'javascript', lib: 'opencv.js (cv)',
      recommend: ['dbaeumer.vscode-eslint', 'esbenp.prettier-vscode'], runtime: 'ops.js' },
    { id: 'typescript', label: 'TypeScript', short: 'TypeScript', def: true,
      family: 'js', ext: '.ts', vscodeLang: 'typescript', lib: 'opencv.js (cv)',
      recommend: ['dbaeumer.vscode-eslint', 'esbenp.prettier-vscode'], runtime: 'ops.ts' },
    { id: 'nodejs-ts', label: 'NodeJS (TypeScript)', short: 'NodeJS TS',
      family: 'js', ext: '.ts', vscodeLang: 'typescript', lib: 'opencv (node bindings)',
      recommend: ['dbaeumer.vscode-eslint', 'esbenp.prettier-vscode'], runtime: 'ops.ts' },
    { id: 'python', label: 'Python', short: 'Python',
      family: 'py', ext: '.py', vscodeLang: 'python', lib: 'opencv-python (cv2)',
      recommend: ['ms-python.python', 'ms-python.vscode-pylance'], runtime: 'ops.py' },
    { id: 'c', label: 'C', short: 'C',
      family: 'c', ext: '.c', vscodeLang: 'c', lib: 'OpenCV C API',
      recommend: ['ms-vscode.cpptools'], runtime: 'ops.c' },
    { id: 'rust', label: 'Rust', short: 'Rust',
      family: 'rs', ext: '.rs', vscodeLang: 'rust', lib: 'opencv crate',
      recommend: ['rust-lang.rust-analyzer'], runtime: 'ops.rs' },
  ];
  const DEFAULT_LANGUAGE_ID = (LANGUAGES.find(l => l.def) || LANGUAGES[0]).id;
  const language = id => LANGUAGES.find(l => l.id === id) || LANGUAGES.find(l => l.id === DEFAULT_LANGUAGE_ID);

  /* ==========================================================================
     NAMES — HALCON identifiers in the target's convention
     ========================================================================== */
  const pascal = s => String(s).split('_').filter(Boolean)
    .map(w => w[0].toUpperCase() + w.slice(1)).join('');
  const camel = s => { const p = pascal(s); return p ? p[0].toLowerCase() + p.slice(1) : p; };
  const sanitizeId = s => String(s).replace(/[^A-Za-z0-9_]/g, '_').replace(/^([0-9])/, '_$1') || 'workspace';

  /* A HALCON parameter is often called `Object`, `String` or `Image`.  Names are
     kept exactly as the program spells them (the body refers to them by that
     name), and only a name that collides with a C# keyword is escaped with the
     @-prefix.  The other families need nothing: `object` and `string` are plain
     identifiers there. */
  const CS_KEYWORDS = new Set(('abstract as base bool break byte case catch char checked class const continue decimal ' +
    'default delegate do double else enum event explicit extern false finally fixed float for foreach goto if implicit in ' +
    'int interface internal is lock long namespace new null object operator out override params private protected public ' +
    'readonly ref return sbyte sealed short sizeof stackalloc static string struct switch this throw true try typeof ' +
    'uint ulong unchecked unsafe ushort using virtual void volatile while dynamic var value').split(' '));
  const csName = s => { const n = String(s); return CS_KEYWORDS.has(n) ? '@' + n : n; };

  /* the function a HALCON operator becomes in the generated runtime */
  function opFn(op, family) {
    switch (family) {
      case 'cs': return pascal(op);
      case 'js': return camel(op);
      case 'c':  return 'ovs_' + op;
      default:   return op;                     // py, rs keep the HALCON snake name
    }
  }
  /* how a call site names it (module-qualified) */
  function opTarget(op, family) {
    switch (family) {
      case 'cs': return 'Ops.' + pascal(op);
      case 'js': return 'ops.' + camel(op);
      case 'c':  return 'ovs_' + op;
      case 'rs': return 'ops::' + op;
      default:   return op;                     // py imports from ops
    }
  }
  function procFn(name, family) {
    switch (family) {
      case 'cs': return pascal(name);
      case 'js': return camel(name);
      case 'c':  return sanitizeId(name);
      default:   return name;
    }
  }

  /* ==========================================================================
     EXPRESSIONS — a best-effort HALCON -> target rewrite
     String literals are pulled out first (so no keyword/operator rewrite can
     touch their text), then |Tuple|, the intrinsic functions and the operators
     are mapped, and the strings are restored in the target's quoting.
     ========================================================================== */
  const OPWORD = {
    cs: { and: '&&', or: '||', not: '!' },
    js: { and: '&&', or: '||', not: '!' },
    c:  { and: '&&', or: '||', not: '!' },
    rs: { and: '&&', or: '||', not: '!' },
    py: { and: 'and', or: 'or', not: 'not' },
  };
  const LEN = {
    cs: x => `(${x}).Length`,
    js: x => `(${x}).length`,
    py: x => `len(${x})`,
    c:  x => `ovs_len(${x})`,
    rs: x => `(${x}).len()`,
  };
  /* intrinsic HALCON functions -> the target's maths */
  const INTRINSICS = {
    cs: {
      rad: a => `((${a[0]}) * Math.PI / 180.0)`, deg: a => `((${a[0]}) * 180.0 / Math.PI)`,
      abs: a => `Math.Abs(${a[0]})`, fabs: a => `Math.Abs(${a[0]})`,
      sqrt: a => `Math.Sqrt(${a[0]})`, sin: a => `Math.Sin(${a[0]})`,
      cos: a => `Math.Cos(${a[0]})`, tan: a => `Math.Tan(${a[0]})`,
      atan2: a => `Math.Atan2(${a[0]}, ${a[1]})`,
      min: a => `Math.Min(${a[0]}, ${a[1]})`, max: a => `Math.Max(${a[0]}, ${a[1]})`,
      round: a => `Math.Round(${a[0]})`, floor: a => `Math.Floor(${a[0]})`, ceil: a => `Math.Ceiling(${a[0]})`,
      int: a => `(int)(${a[0]})`, real: a => `(double)(${a[0]})`, str: a => `(${a[0]}).ToString()`,
    },
    js: {
      rad: a => `((${a[0]}) * Math.PI / 180)`, deg: a => `((${a[0]}) * 180 / Math.PI)`,
      abs: a => `Math.abs(${a[0]})`, fabs: a => `Math.abs(${a[0]})`,
      sqrt: a => `Math.sqrt(${a[0]})`, sin: a => `Math.sin(${a[0]})`,
      cos: a => `Math.cos(${a[0]})`, tan: a => `Math.tan(${a[0]})`,
      atan2: a => `Math.atan2(${a[0]}, ${a[1]})`,
      min: a => `Math.min(${a[0]}, ${a[1]})`, max: a => `Math.max(${a[0]}, ${a[1]})`,
      round: a => `Math.round(${a[0]})`, floor: a => `Math.floor(${a[0]})`, ceil: a => `Math.ceil(${a[0]})`,
      int: a => `Math.trunc(${a[0]})`, real: a => `Number(${a[0]})`, str: a => `String(${a[0]})`,
    },
    py: {
      rad: a => `math.radians(${a[0]})`, deg: a => `math.degrees(${a[0]})`,
      abs: a => `abs(${a[0]})`, fabs: a => `abs(${a[0]})`,
      sqrt: a => `math.sqrt(${a[0]})`, sin: a => `math.sin(${a[0]})`,
      cos: a => `math.cos(${a[0]})`, tan: a => `math.tan(${a[0]})`,
      atan2: a => `math.atan2(${a[0]}, ${a[1]})`,
      min: a => `min(${a[0]}, ${a[1]})`, max: a => `max(${a[0]}, ${a[1]})`,
      round: a => `round(${a[0]})`, floor: a => `math.floor(${a[0]})`, ceil: a => `math.ceil(${a[0]})`,
      int: a => `int(${a[0]})`, real: a => `float(${a[0]})`, str: a => `str(${a[0]})`,
    },
    c: {
      rad: a => `((${a[0]}) * M_PI / 180.0)`, deg: a => `((${a[0]}) * 180.0 / M_PI)`,
      abs: a => `fabs(${a[0]})`, fabs: a => `fabs(${a[0]})`,
      sqrt: a => `sqrt(${a[0]})`, sin: a => `sin(${a[0]})`,
      cos: a => `cos(${a[0]})`, tan: a => `tan(${a[0]})`,
      atan2: a => `atan2(${a[0]}, ${a[1]})`,
      min: a => `fmin(${a[0]}, ${a[1]})`, max: a => `fmax(${a[0]}, ${a[1]})`,
      round: a => `round(${a[0]})`, floor: a => `floor(${a[0]})`, ceil: a => `ceil(${a[0]})`,
      int: a => `((int)(${a[0]}))`, real: a => `((double)(${a[0]}))`, str: a => `ovs_str(${a[0]})`,
    },
    rs: {
      rad: a => `(${a[0]}).to_radians()`, deg: a => `(${a[0]}).to_degrees()`,
      abs: a => `(${a[0]}).abs()`, fabs: a => `(${a[0]}).abs()`,
      sqrt: a => `(${a[0]}).sqrt()`, sin: a => `(${a[0]}).sin()`,
      cos: a => `(${a[0]}).cos()`, tan: a => `(${a[0]}).tan()`,
      atan2: a => `(${a[0]}).atan2(${a[1]})`,
      min: a => `f64::min(${a[0]}, ${a[1]})`, max: a => `f64::max(${a[0]}, ${a[1]})`,
      round: a => `(${a[0]}).round()`, floor: a => `(${a[0]}).floor()`, ceil: a => `(${a[0]}).ceil()`,
      int: a => `(${a[0]} as i64)`, real: a => `(${a[0]} as f64)`, str: a => `(${a[0]}).to_string()`,
    },
  };

  function splitTop(s) {
    const out = [];
    let cur = '', q = false, depth = 0;
    for (const ch of String(s)) {
      if (ch === "'") q = !q;
      if (!q) {
        if (ch === '[' || ch === '(') depth++;
        else if (ch === ']' || ch === ')') depth = Math.max(0, depth - 1);
      }
      if (ch === ',' && !q && depth === 0) { out.push(cur.trim()); cur = ''; }
      else cur += ch;
    }
    if (cur.trim() !== '' || out.length) out.push(cur.trim());
    return out;
  }

  /* HALCON string literal -> the target's quoting */
  function hString(raw, family) {
    const body = String(raw).slice(1, -1).replace(/''/g, "'");
    if (family === 'py') return `'${body.replace(/\\/g, '\\\\').replace(/'/g, "\\'")}'`;
    return `"${body.replace(/\\/g, '\\\\').replace(/"/g, '\\"')}"`;
  }

  /* replace every call to a known intrinsic; unknown calls are left alone */
  function mapIntrinsics(s, family) {
    const table = INTRINSICS[family] || {};
    let out = '', i = 0;
    while (i < s.length) {
      const m = /^[A-Za-z_]\w*/.exec(s.slice(i));
      if (m && s[i + m[0].length] === '(' && table[m[0].toLowerCase()]) {
        const name = m[0].toLowerCase();
        let depth = 0, j = i + m[0].length, end = -1;
        for (; j < s.length; j++) {
          if (s[j] === '(') depth++;
          else if (s[j] === ')') { depth--; if (depth === 0) { end = j; break; } }
        }
        if (end > 0) {
          const args = splitTop(s.slice(i + m[0].length + 1, end)).map(a => mapIntrinsics(a, family));
          out += table[name](args);
          i = end + 1;
          continue;
        }
      }
      out += s[i++];
    }
    return out;
  }

  /* HALCON's [a, b, c] builds a tuple; every target spells the literal its own way */
  function tupleLit(items, family) {
    const body = items.join(', ');
    switch (family) {
      case 'cs': return items.length ? `new dynamic[] { ${body} }` : 'new dynamic[0]';
      case 'rs': return `vec![${body}]`;
      case 'c':
        if (!items.length) return '(double[]){ 0 }';
        return items.some(x => /^"/.test(x.trim())) ? `(const char *[]){ ${body} }` : `(double[]){ ${body} }`;
      default: return `[${body}]`;
    }
  }

  /* rewrite the [ … ] literals of an expression, innermost parts first */
  function mapTuples(s, family) {
    let out = '', i = 0;
    while (i < s.length) {
      if (s[i] === "'") {                                   // never touch a string literal
        const end = s.indexOf("'", i + 1);
        const stop = end < 0 ? s.length : end + 1;
        out += s.slice(i, stop);
        i = stop;
        continue;
      }
      if (s[i] !== '[') { out += s[i++]; continue; }
      let depth = 0, end = -1;
      for (let j = i; j < s.length; j++) {
        if (s[j] === '[') depth++;
        else if (s[j] === ']') { depth--; if (depth === 0) { end = j; break; } }
      }
      if (end < 0) { out += s[i++]; continue; }
      const items = splitTop(s.slice(i + 1, end)).filter(x => x !== '').map(x => translateExpr(x, family));
      out += tupleLit(items, family);
      i = end + 1;
    }
    return out;
  }

  /* HALCON's + concatenates as soon as one side is a string.  JavaScript and C#
     have that operator; the others need a call, and Python also has to convert
     the non-string side (a str and a number cannot be added there). */
  const STR_PART = /^\u0000\d+\u0000$/;          // a string literal, still a placeholder

  function mapStringConcat(s, family) {
    if (family === 'js' || family === 'cs') return s;
    /* split the top level on '+' and rewrite the parentheses on the way */
    const parts = [];
    let buf = '', cur = '', i = 0;
    while (i < s.length) {
      const ch = s[i];
      if (ch === '(') {
        let d = 0, end = -1;
        for (let j = i; j < s.length; j++) {
          if (s[j] === '(') d++;
          else if (s[j] === ')') { d--; if (d === 0) { end = j; break; } }
        }
        if (end < 0) { cur += ch; buf += ch; i++; continue; }
        const inner = '(' + mapStringConcat(s.slice(i + 1, end), family) + ')';
        cur += inner; buf += inner;
        i = end + 1;
        continue;
      }
      if (ch === '+') { parts.push(cur); cur = ''; i++; continue; }
      cur += ch; buf += ch; i++;
    }
    parts.push(cur);
    const ops = parts.map(p => p.trim()).filter(Boolean);
    if (ops.length < 2 || !ops.some(p => STR_PART.test(p))) return buf;
    const isStr = p => STR_PART.test(p);
    if (family === 'py') return ops.map(p => isStr(p) ? p : `str(${p})`).join(' + ');
    if (family === 'rs') return `format!("${'{}'.repeat(ops.length)}", ${ops.join(', ')})`;
    if (family === 'c') return `ovs_cat(${ops.length}, ${ops.map(p => isStr(p) ? p : `ovs_str(${p})`).join(', ')})`;
    return ops.join(' + ');
  }

  function translateExpr(expr, family) {
    let work = String(expr == null ? '' : expr).trim();
    if (!work) return work;
    work = mapTuples(work, family);
    /* pull the string literals out so nothing below can rewrite their text */
    const strings = [];
    work = work.replace(/'([^']|'')*'/g, m => { strings.push(m); return `\u0000${strings.length - 1}\u0000`; });
    work = work.replace(/\|([^|]+)\|/g, (_, x) => LEN[family](translateExpr(x, family)));
    work = mapIntrinsics(work, family);
    const w = OPWORD[family];
    work = work.replace(/\b(and|or|not)\b/gi, m => w[m.toLowerCase()]);
    if (family !== 'py') work = work.replace(/!\s+/g, '!');   // 'not X' -> '!X', not '! X'
    work = work.replace(/<>|#/g, '!=');
    work = work.replace(/([^<>=!:%/*+\-])=([^=])/g, '$1==$2');   // '=' is comparison, ':=' assignment
    work = mapStringConcat(work, family);
    work = work.replace(/\u0000(\d+)\u0000/g, (_, i) => hString(strings[+i], family));
    return work.trim();
  }

  /* ==========================================================================
     PROGRAM MODEL — lines -> statements
     ========================================================================== */
  function parseCall(text) {
    const m = /^\s*([A-Za-z_]\w*)\s*\(([\s\S]*)\)\s*$/.exec(text);
    if (!m) return null;
    return { op: m[1], args: splitTop(m[2]) };
  }

  function parseBody(lines) {
    const out = [];
    for (const raw of (lines || [])) {
      const text = String(raw);
      if (!text.trim()) { out.push({ kind: 'blank' }); continue; }
      if (/^\s*\*/.test(text)) { out.push({ kind: 'comment', text: text.replace(/^\s*\*\s?/, '').trimEnd() }); continue; }
      const t = text.trim();
      let m;
      if ((m = /^for\s+([A-Za-z_]\w*)\s*:=\s*(.+?)\s+to\s+(.+?)(?:\s+by\s+(.+))?$/i.exec(t)))
        { out.push({ kind: 'for', name: m[1], from: m[2].trim(), to: m[3].trim(), by: m[4] ? m[4].trim() : null }); continue; }
      if (/^endfor$/i.test(t)) { out.push({ kind: 'endfor' }); continue; }
      if ((m = /^while\s*\((.*)\)$/i.exec(t))) { out.push({ kind: 'while', cond: m[1] }); continue; }
      if (/^endwhile$/i.test(t)) { out.push({ kind: 'endwhile' }); continue; }
      if (/^repeat$/i.test(t)) { out.push({ kind: 'repeat' }); continue; }
      if ((m = /^until\s*\((.*)\)$/i.exec(t))) { out.push({ kind: 'until', cond: m[1] }); continue; }
      if ((m = /^if\s*\((.*)\)$/i.exec(t))) { out.push({ kind: 'if', cond: m[1] }); continue; }
      if ((m = /^elseif\s*\((.*)\)$/i.exec(t))) { out.push({ kind: 'elseif', cond: m[1] }); continue; }
      if (/^else$/i.test(t)) { out.push({ kind: 'else' }); continue; }
      if (/^endif$/i.test(t)) { out.push({ kind: 'endif' }); continue; }
      if (/^break$/i.test(t)) { out.push({ kind: 'break' }); continue; }
      if (/^continue$/i.test(t)) { out.push({ kind: 'continue' }); continue; }
      if (/^return\b/i.test(t)) { out.push({ kind: 'return' }); continue; }
      if (/^stop\b/i.test(t)) { out.push({ kind: 'stop' }); continue; }
      if ((m = /^([A-Za-z_]\w*)\s*:=\s*([\s\S]+)$/.exec(t)))
        { out.push({ kind: 'assign', target: m[1], expr: m[2].trim() }); continue; }
      const c = parseCall(t);
      if (c) { out.push({ kind: 'call', op: c.op, args: c.args }); continue; }
      out.push({ kind: 'raw', text: t });
    }
    return out;
  }

  /* a procedure parameter in one normalised shape, whichever form it came in */
  function normalizeParam(p) {
    if (Array.isArray(p))
      return { name: p[0], dir: p[1] === 'output' ? 'output' : 'input', type: p[2] === 'iconic' ? 'iconic' : 'control' };
    return { name: p.name, dir: p.dir === 'out' ? 'output' : 'input', type: p.type === 'iconic' ? 'iconic' : 'control' };
  }

  function buildModel(procedures, opinfo) {
    const procs = Object.keys(procedures || {}).map(name => ({
      name,
      params: (procedures[name].params || []).map(normalizeParam),
      stmts: parseBody(procedures[name].lines || []),
    }));
    const entry = (procedures && procedures.main) ? 'main' : (procs[0] ? procs[0].name : null);
    /* The IDE keeps one scope for the whole program, so a procedure without a
       parameter list may read a variable that another one produced.  In the
       export such a name has to come from somewhere, so it becomes a parameter
       of the generated function — except for the entry point, which cannot
       take any. */
    const declared = Object.fromEntries(procs.map(p => [p.name, p.params]));
    for (const p of procs) {
      if (p.params.length || p.name === entry) continue;
      const vars = procedureVars(p, op => (opinfo && opinfo[op] && opinfo[op].params)
        ? opinfo[op].params.map(normalizeParam) : (declared[op] || null));
      p.params = vars.free.map(name => ({ name, dir: 'input', type: vars.iconic.has(name) ? 'iconic' : 'control' }));
      p.inferred = p.params.length > 0;
      p.programVars = vars.free;
    }
    return {
      procedures: procs,
      byName: Object.fromEntries(procs.map(p => [p.name, p])),
      entry,
      opinfo: opinfo || {},
    };
  }

  /* ==========================================================================
     SHARED PROGRAM VARIABLES
     ========================================================================== */
  /* HALCON words that look like identifiers but are not names */
  const HALCON_WORDS = new Set(['and', 'or', 'not', 'div', 'mod', 'true', 'false']);
  const INTRINSIC_NAMES = new Set(Object.keys(INTRINSICS.cs));   // the same names in every family

  /* every name an expression mentions: literals and f(…) calls are removed */
  function identifiersIn(text) {
    let s = String(text).replace(/'([^']|'')*'/g, ' ');      // string literals
    s = s.replace(/\|[^|]*\|/g, ' ');                         // |Tuple| — the tuple length
    s = s.replace(/[A-Za-z_]\w*\s*(?=\()/g, ' ');             // f(…): an intrinsic or an operator
    const out = [];
    for (const m of s.matchAll(/[A-Za-z_]\w*/g))
      if (!HALCON_WORDS.has(m[0]) && !INTRINSIC_NAMES.has(m[0]) && !out.includes(m[0])) out.push(m[0]);
    return out;
  }

  /* the names a procedure reads without assigning them (= the program
     variables it relies on), in the order it first mentions them */
  function procedureVars(proc, paramsOf) {
    const assigned = new Set(), used = [], iconic = new Set();
    const use = text => {
      for (const n of identifiersIn(text)) if (!used.includes(n)) used.push(n);
    };
    const walk = stmts => {
      for (const st of stmts) {
        switch (st.kind) {
          case 'assign': assigned.add(st.target); use(st.expr); break;
          case 'call': {
            const params = paramsOf(st.op);
            /* the emitter maps at most one argument per declared parameter and
               uses the declared name when an output slot holds a literal, so the
               scan of the variables follows the same rules */
            (params ? st.args.slice(0, params.length) : st.args).forEach((text, i) => {
              const p = params && params[i];
              const name = String(text).trim();
              if (isIdent(name)) {
                if (p && p.dir === 'output') assigned.add(name);
                else if (!used.includes(name)) used.push(name);
                if (p && p.type === 'iconic') iconic.add(name);
              } else if (p && p.dir === 'output') {
                if (p.name) assigned.add(p.name);
              } else use(text);
            });
            break;
          }
          case 'if': case 'elseif': case 'while': case 'until': use(st.cond); break;
          case 'for': assigned.add(st.name); use(st.from); use(st.to); if (st.by) use(st.by); break;
          case 'raw': use(st.text); break;
          default: break;
        }
      }
    };
    walk(proc.stmts);
    return { free: used.filter(n => !assigned.has(n)), iconic };
  }

  /* the parameter list of a callee: OPINFO for an operator, the interface for
     a user procedure, null for an operator this build does not know */
  function paramsFor(model, op) {
    const info = model.opinfo[op];
    if (info && info.params) return info.params.map(normalizeParam);
    if (model.byName[op]) return model.byName[op].params;
    return null;
  }

  /* ==========================================================================
     EMITTERS — one pass over the model, per language family
     ========================================================================== */
  const INDENT = '    ';

  function emitSource(model, lang, opts) {
    const usedOps = new Map();               // op -> { ins, outs } (first call wins)
    const env = { family: lang.family, lang, model, usedOps, opts, moduleName: opts.moduleName };
    const main = emitEntryFile(env);         // fills usedOps first
    return { main, runtime: emitRuntime(env), entryName: model.entry };
  }

  function indent(ctx) { return INDENT.repeat(Math.max(0, ctx.level)); }

  function emitStmt(st, ctx) {
    const ind = indent(ctx);
    const f = ctx.family;
    switch (st.kind) {
      case 'blank': return [''];
      case 'comment': return [`${ind}${f === 'py' ? '#' : '//'} ${st.text}`];
      case 'raw': return [`${ind}${f === 'py' ? '#' : '//'} ${st.text}  (raw HALCON statement)`];

      case 'if':
        ctx.level++;
        return f === 'py' ? [`${ind}if ${translateExpr(st.cond, f)}:`] : [`${ind}if (${translateExpr(st.cond, f)}) {`];
      case 'elseif': {
        ctx.level--;
        const c = translateExpr(st.cond, f);
        const line = f === 'py' ? `${indent(ctx)}elif ${c}:` : `${indent(ctx)}} else if (${c}) {`;
        ctx.level++;
        return [line];
      }
      case 'else': {
        ctx.level--;
        const line = f === 'py' ? `${indent(ctx)}else:` : `${indent(ctx)}} else {`;
        ctx.level++;
        return [line];
      }
      case 'endif':
        ctx.level--;
        return f === 'py' ? [] : [`${indent(ctx)}}`];

      case 'while':
        ctx.level++;
        return f === 'py' ? [`${ind}while ${translateExpr(st.cond, f)}:`] : [`${ind}while (${translateExpr(st.cond, f)}) {`];
      case 'endwhile':
        ctx.level--;
        return f === 'py' ? [] : [`${indent(ctx)}}`];

      case 'repeat':
        ctx.level++;
        if (f === 'py') return [`${ind}while True:`];
        if (f === 'rs') return [`${ind}loop {`];
        return [`${ind}do {`];
      case 'until': {
        ctx.level--;
        const c = translateExpr(st.cond, f);
        const line = f === 'py' ? `${indent(ctx)}if ${c}: break`
          : f === 'rs' ? `${indent(ctx)}if ${c} { break; }`
            : `${indent(ctx)}} while (!(${c}));`;
        return [line];
      }

      case 'for': {
        const from = translateExpr(st.from, f), to = translateExpr(st.to, f), by = st.by ? translateExpr(st.by, f) : null;
        ctx.level++;
        if (f === 'py') return [`${ind}for ${st.name} in range(${from}, (${to}) + 1${by ? `, ${by}` : ''}):`];
        if (f === 'rs') return [`${ind}for ${st.name} in (${from}..=${to})${by ? `.step_by(${by} as usize)` : ''} {`];
        const decl = f === 'c' ? 'int ' : declType(ctx, st.name, 'control', true);
        const inc = by ? ` += ${by}` : '++';
        return [`${ind}for (${decl}${st.name} = ${from}; ${st.name} <= ${to}; ${st.name}${inc}) {`];
      }
      case 'endfor':
        ctx.level--;
        return f === 'py' ? [] : [`${indent(ctx)}}`];

      case 'break': return [f === 'py' ? `${ind}break` : `${ind}break;`];
      case 'continue': return [f === 'py' ? `${ind}continue` : `${ind}continue;`];
      case 'stop': return [`${ind}${f === 'py' ? 'pass  # stop () — HDevelop breakpoint' : '// stop () — HDevelop breakpoint'}`];
      case 'return': return [];                 // the trailing one is emitted as a real return

      case 'assign': {
        const expr = translateExpr(st.expr, f);
        return emitAssign(ctx, [st.target], expr, [inferType(st.expr)]);
      }
      case 'call': return emitCall(st, ctx);
      default: return [];
    }
  }

  /* HALCON expression -> the target's type for a C-style declaration */
  function inferType(expr) {
    const e = String(expr).trim();
    if (/^'/.test(e)) return 'string';
    if (/^-?\d/.test(e) || /^\(/.test(e)) return 'number';
    return 'any';
  }

  /* declare a name without a value, for the mixed destructuring case */
  function declareBare(ctx, name, type) {
    const f = ctx.family;
    ctx.declared.add(name);
    if (f === 'cs') return `${csSigType(type)} ${csName(name)};`;
    if (f === 'js') return `let ${name};`;
    if (f === 'rs') return `let mut ${name}: ${rsSigType(type)};`;
    return `${name} = undefined;`;
  }

  function declType(ctx, name, type, forceDecl) {
    const already = ctx.declared.has(name);
    if (already && !forceDecl) return '';
    ctx.declared.add(name);
    const f = ctx.family;
    if (f === 'cs') return 'var ';
    if (f === 'js') return 'let ';
    if (f === 'rs') return 'let ';
    if (f === 'c') return type === 'string' ? 'const char *' : (type === 'number' ? 'double ' : 'HTuple ');
    return '';                                  // py declares by assignment
  }

  /* A call argument is not always a name — `disp_message (W, 'hi', 12)`.  It can
     only become a parameter name when it is an identifier; anything else gets a
     numbered one, so the generated signature stays valid. */
  const IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;
  const isIdent = text => IDENT.test(String(text).trim());
  const safeName = (text, i) => isIdent(text) ? String(text).trim() : `arg${i + 1}`;

  /* set one or more targets from a call/expression */
  function emitAssign(ctx, targets, call, types) {
    const f = ctx.family;
    const ind = indent(ctx);
    const tgt = t => f === 'cs' ? csName(t) : t;    // a C# keyword needs the @-prefix
    const und = targets.filter(t => !ctx.declared.has(t));
    let line;
    if (targets.length === 1) {
      const t = targets[0];
      line = und.length ? `${declType(ctx, t, types[0])}${tgt(t)} = ${call};` : `${tgt(t)} = ${call};`;
      if (f === 'py') line = `${t} = ${call}`;
      return [ind + line];
    }
    /* several outputs at once.  A variable may already exist (the same operator
       is often called again in a loop), so only the new ones are declared. */
    if (f === 'py') {
      targets.forEach(t => ctx.declared.add(t));
      return [`${ind}${targets.join(', ')} = ${call}`];
    }
    if (f === 'c') {
      const decls = targets.map((t, i) => `${declType(ctx, t, types[i])}${t};`);
      return [...decls.map(d => ind + d), `${ind}${call};`];
    }
    const fresh = targets.filter(t => !ctx.declared.has(t));
    if (!fresh.length) {
      /* every target exists: a plain destructuring assignment.  JavaScript
         needs the parentheses around one. */
      if (f === 'js') return [`${ind}([${targets.map(tgt).join(', ')}] = ${call});`];
      return [`${ind}(${targets.map(tgt).join(', ')}) = ${call};`];
    }
    if (fresh.length !== targets.length) {
      /* mixed: declare the missing ones first, then destructure into all */
      const decls = fresh.map(t => declareBare(ctx, t, types[targets.indexOf(t)]));
      const rest = emitAssign(ctx, targets, call, types)[0].trimStart();
      return [...decls.map(d => ind + d), ind + rest];
    }
    targets.forEach(t => ctx.declared.add(t));
    if (f === 'rs') return [`${ind}let (${targets.join(', ')}) = ${call};`];
    if (f === 'cs') return [`${ind}var (${targets.map(tgt).join(', ')}) = ${call};`];
    return [`${ind}let [${targets.join(', ')}] = ${call};`];
  }

  /* C# — a single string literal / number / `new …` expression has a static
     type; anything else may hold a `dynamic` value. */
  const CS_NAME_ARG = /^"(?:[^"\\]|\\.)*"$/;
  const CS_NUM_ARG = /^-?\d+(\.\d+)?$/;
  const CS_NEW_ARG = /^new\s/;

  /* Passing a `dynamic` value to an operator makes the whole call dynamically
     bound, and C# cannot deconstruct a dynamically bound call (`CS8133`) — so
     every value of unknown type is pinned to the parameter's declared type,
     which keeps the call statically bound and its tuple known. */
  function csPinArg(text, type) {
    if (CS_NAME_ARG.test(text) || CS_NUM_ARG.test(text) || CS_NEW_ARG.test(text)) return text;
    const cast = type === 'iconic' ? 'Mat' : 'object';
    return isIdent(text) ? `(${cast})${text}` : `(${cast})(${text})`;
  }

  function emitCall(st, ctx) {
    const f = ctx.family, ind = indent(ctx);
    const isUser = !!ctx.model.byName[st.op];
    const params = paramsFor(ctx.model, st.op);
    /* The operator signature is the authority.  A hand-written call may pass
       more arguments than the operator takes — surplus ones cannot be mapped
       to a parameter and are dropped, like the IDE drops them. */
    const callArgs = params ? st.args.slice(0, params.length) : st.args;
    const specs = callArgs.map((text, i) => {
      const p = (params && params[i]) || { name: null, dir: 'input', type: 'control' };
      return { text, dir: p.dir, type: p.type, name: p.name };
    });
    const outs = specs.filter(s => s.dir === 'output');
    const ins = specs.filter(s => s.dir === 'input');
    const argsIn = ins.map(s => {
      const text = translateExpr(s.text, f);
      return f === 'cs' ? csPinArg(text, s.type) : text;
    });
    const target = isUser ? procFn(st.op, f) : opTarget(st.op, f);
    /* an output slot must hold a name: `open_framegrabber (…, -1, AcqHandle)`
       put a literal in the handle's place — fall back to the declared name */
    const outName = (o, i) => isIdent(o.text) ? String(o.text).trim() : (o.name || safeName(o.text, i));

    if (!isUser) {
      if (!ctx.usedOps.has(st.op)) {
        ctx.usedOps.set(st.op, {
          ins: ins.map((s, i) => ({ name: s.name || safeName(s.text, i), type: s.type })),
          outs: outs.map((s, i) => ({ name: s.name || safeName(s.text, i), type: s.type })),
        });
      }
      if (!params) {                            // unknown operator: everything it
        const spec = ctx.usedOps.get(st.op);    // passes is taken as an input
        spec.ins = st.args.map((a, i) => ({ name: safeName(a, i), type: 'control' }));
        spec.outs = [];
      }
    }

    /* C passes outputs by address, so its functions never return one */
    if (f === 'c') {
      const outDecls = outs.map((o, i) => `${o.type === 'iconic' ? 'Hobject' : 'HTuple'} ${outName(o, i)};`);
      outs.forEach((o, i) => ctx.declared.add(outName(o, i)));
      const callArgs2 = [...outs.map((o, i) => '&' + outName(o, i)), ...argsIn];
      return [...outDecls.map(d => ind + d), `${ind}${target}(${callArgs2.join(', ')});`];
    }

    const call = `${target}(${argsIn.join(', ')})`;
    if (!outs.length) return [`${ind}${call}${f === 'py' ? '' : ';'}`];
    return emitAssign(ctx, outs.map(outName), call, outs.map(o => o.type));
  }

  /* the value(s) a procedure hands back — its output parameters */
  function emitReturns(ctx) {
    const f = ctx.family;
    if (f === 'c') return [];                   // out parameters, nothing to return
    const outs = ctx.outNames;
    if (!outs.length) return [];
    const ind = indent(ctx);
    if (outs.length === 1) {
      if (f === 'py') return [`${ind}return ${outs[0]}`];
      return [`${ind}return ${outs[0]};`];
    }
    if (f === 'py') return [`${ind}return ${outs.join(', ')}`];
    if (f === 'js') return [`${ind}return [${outs.join(', ')}];`];
    if (f === 'rs') return [`${ind}return (${outs.join(', ')});`];
    return [`${ind}return (${outs.join(', ')});`];
  }

  /* the C type of a control/iconic value in a signature */
  const cSigType = type => type === 'iconic' ? 'Hobject' : 'HTuple';
  const csSigType = type => type === 'iconic' ? 'Mat' : 'dynamic';
  const rsSigType = type => type === 'iconic' ? 'Mat' : 'f64';

  function retSig(outs, family) {
    if (!outs.length) return null;             // no outputs: void / no return value
    if (family === 'cs') return outs.length === 1 ? csSigType(outs[0].type) : '(' + outs.map(o => `${csSigType(o.type)} ${o.name}`).join(', ') + ')';
    if (family === 'rs') return outs.length === 1 ? rsSigType(outs[0].type) : '(' + outs.map(o => rsSigType(o.type)).join(', ') + ')';
    return '';
  }

  function emitProcedure(proc, bodyFor, family, baseLevel = 0) {
    const ins = proc.params.filter(p => p.dir === 'input');
    const outs = proc.params.filter(p => p.dir === 'output');
    const body = bodyFor(proc);
    const fn = procFn(proc.name, family);
    const ind = INDENT.repeat(Math.max(0, baseLevel));
    const comment = family === 'py' ? '#' : '//';
    const note = proc.inferred ? ' — the program variables it reads became parameters' : '';
    const lines = [`${ind}${comment} ${procSignature(proc)}${note}`];
    switch (family) {
      case 'cs':
        lines.push(`${ind}static ${retSig(outs, 'cs') || 'void'} ${fn}(${ins.map(p => `${csSigType(p.type)} ${csName(p.name)}`).join(', ')})`);
        lines.push(`${ind}{`);
        break;
      case 'js':
        lines.push(`${ind}function ${fn}(${ins.map(p => p.name).join(', ')}) {`);
        break;
      case 'py':
        lines.push(`def ${fn}(${ins.map(p => p.name).join(', ')}):`);
        break;
      case 'c':
        lines.push(`${ind}static void ${fn}(${[...outs.map(o => `${cSigType(o.type)} *${o.name}`), ...ins.map(p => `${cSigType(p.type)} ${p.name}`)].join(', ')})`);
        lines.push(`${ind}{`);
        break;
      case 'rs': {
        const r = retSig(outs, 'rs');
        lines.push(`${ind}fn ${fn}(${ins.map(p => `${p.name}: ${rsSigType(p.type)}`).join(', ')})${r ? ' -> ' + r : ''} {`);
        break;
      }
    }
    lines.push(...body);
    lines.push((family === 'py') ? '' : `${ind}}`);
    return lines;
  }

  function procSignature(proc) {
    const g = [[], [], [], []];
    for (const p of proc.params) {
      const gi = p.type === 'iconic' ? (p.dir === 'output' ? 1 : 0) : (p.dir === 'output' ? 3 : 2);
      g[gi].push(p.name);
    }
    return `${proc.name} (${g.map(x => x.join(', ')).join(' : ')})`;
  }
  /* ==========================================================================
     RUNTIME STUBS — one file per language, from the operators actually called
     ========================================================================== */
  const DISPLAY = /^(dev_|disp_)/;

  /* a couple of operators map straight onto the target's library; the rest are
     TODO stubs so the shape of the program survives without a vision API that
     this server-side generator could not possibly know. */
  const CORE = {
    cs: {
      /* the mapped operators are written relative to the member they replace:
         the emitter re-indents every line of the snippet (see runtimeStubCs) */
      read_image: (op, s) => `public static Mat ReadImage(string fileName) => Cv2.ImRead(fileName, ImreadModes.Grayscale);`,
      threshold: (op, s) => [
        `public static ${retSig(s.outs, 'cs') || 'void'} ${opFn('threshold', 'cs')}(${s.ins.map(i => `${csSigType(i.type)} ${csName(i.name)}`).join(', ')})`,
        '{',
        `${INDENT}var region = new Mat();`,
        `${INDENT}Cv2.Threshold(${csName(s.ins[0].name)}, region, (double)${csName(s.ins[1].name)}, (double)${csName(s.ins[2].name)}, ThresholdTypes.Binary);`,
        `${INDENT}return region;`,
        '}',
      ].join('\n'),
    },
  };

  function emitRuntime(env) {
    const { lang, usedOps } = env;
    const f = lang.family;
    const ops = [...usedOps.keys()].sort();
    if (f === 'c') return emitRuntimeC(env, ops);
    const ind = INDENT;
    const lines = [];
    if (f === 'cs') lines.push('using System;', 'using OpenCvSharp;', '', `namespace ${env.moduleName}.Runtime`, '{', `${ind}/// <summary>HALCON-style operators used by the exported program.</summary>`, `${ind}public static class Ops`, `${ind}{`);
    if (f === 'js') lines.push('// Runtime shim for the exported program.', "// TODO: load opencv.js and replace the stubs with real calls.", '', '/* global cv */', '');
    if (f === 'rs') lines.push('// Runtime shim for the exported program.', '// TODO: replace the stubs with real calls into the opencv crate.', '#![allow(dead_code)]', '');

    /* the stubs are written at the level of a top-level declaration; C# wraps
       them in namespace + class, so the whole block moves one level in */
    const inner = [];
    let first = true;
    for (const op of ops) {
      const s = usedOps.get(op);
      if (!first) inner.push('');
      first = false;
      if (f === 'cs') inner.push(...runtimeStubCs(op, s));
      else if (f === 'js') inner.push(...runtimeStubJs(op, s, lang));
      else if (f === 'py') inner.push(...runtimeStubPy(op, s, lang));
      else if (f === 'rs') inner.push(...runtimeStubRs(op, s));
    }
    if (!ops.length) inner.push('// (the program calls no operators)');
    if (f === 'cs') lines.push(...inner.map(l => l ? INDENT + l : l), `${ind}}`, '}');
    else lines.push(...inner);
    return lines.join('\n') + '\n';
  }

  function runtimeStubCs(op, s) {
    const ind = INDENT, ind2 = INDENT + INDENT;
    const sig = `// ${op} (${[...s.outs.map(o => o.name), ...s.ins.map(i => i.name)].join(', ')})`;
    const args = s.ins.map(i => `${csSigType(i.type)} ${csName(i.name)}`).join(', ');
    if (DISPLAY.test(op)) {
      /* a display operator shows nothing in an exported program, but it may still
         hand a handle back to the caller — keep the signature and return a null */
      return [`${ind}${sig}`,
        `${ind}public static ${s.outs.length ? 'dynamic' : 'void'} ${opFn(op, 'cs')}(${args})`,
        `${ind}{`, `${ind2}// display operator: no console output in an exported program`,
        ...(s.outs.length ? [`${ind2}return null;`] : []),
        `${ind}}`];
    }
    const core = CORE.cs[op];
    /* the mapped operators are written with their own relative indentation, so
       every line of the snippet has to move with the member it belongs to */
    if (core) return [`${ind}${sig}`, ...core(op, s).split('\n').map(l => l ? ind + l : l)];
    const ret = s.outs.length === 0 ? 'void' : (s.outs.length === 1 ? csSigType(s.outs[0].type) : `(${s.outs.map(o => `${csSigType(o.type)} ${o.name}`).join(', ')})`);
    return [`${ind}${sig}`,
      `${ind}public static ${ret} ${opFn(op, 'cs')}(${args})`,
      `${ind2}=> throw new NotImplementedException("${op} — implement with OpenCvSharp");`];
  }

  function runtimeStubJs(op, s, lang) {
    const sig = `// ${op} (${[...s.outs.map(o => o.name), ...s.ins.map(i => i.name)].join(', ')})`;
    const args = s.ins.map(i => i.name).join(', ');
    /* a TypeScript stub is annotated: the body only throws, so without a return
       type the caller would see `never` and every use of the result is flagged */
    const ts = lang.ext === '.ts';
    const ret = !ts ? '' : (s.outs.length === 0 ? ': void' : (s.outs.length === 1 ? ': any' : ': any[]'));
    if (DISPLAY.test(op)) return [`${sig}`, `export function ${opFn(op, 'js')}(${args})${ret} {`, `${INDENT}// display operator: no console output in an exported program`, `}`];
    return [`${sig}`,
      `export function ${opFn(op, 'js')}(${args})${ret} {`,
      `${INDENT}throw new Error("${op} is not implemented yet — implement it with ${lang.lib}");`,
      `}`];
  }

  function runtimeStubPy(op, s, lang) {
    const sig = `# ${op} (${[...s.outs.map(o => o.name), ...s.ins.map(i => i.name)].join(', ')})`;
    const args = s.ins.map(i => i.name).join(', ');
    if (DISPLAY.test(op)) return [sig, `def ${opFn(op, 'py')}(${args}):`, `${INDENT}pass  # display operator: no console output in an exported program`];
    return [sig, `def ${opFn(op, 'py')}(${args}):`, `${INDENT}raise NotImplementedError("${op} — implement it with ${lang.lib}")`];
  }

  function runtimeStubRs(op, s) {
    const ind = INDENT;
    const sig = `/// ${op} (${[...s.outs.map(o => o.name), ...s.ins.map(i => i.name)].join(', ')})`;
    const args = s.ins.map(i => `${i.name}: ${rsSigType(i.type)}`).join(', ');
    const ret = s.outs.length === 0 ? '' : ` -> ${s.outs.length === 1 ? rsSigType(s.outs[0].type) : '(' + s.outs.map(o => rsSigType(o.type)).join(', ') + ')'}`;
    if (DISPLAY.test(op)) return [sig, `pub fn ${opFn(op, 'rs')}(${args}) {`, `${ind}// display operator: no console output in an exported program`, '}'];
    return [sig, `pub fn ${opFn(op, 'rs')}(${args})${ret} {`, `${ind}unimplemented!("${op} — implement it with the opencv crate")`, '}'];
  }

  /* C is out-parameter style: the runtime header and implementation are one
     signature, outputs first. */
  function emitRuntimeC(env, ops) {
    const headerSig = (op, s) => `void ovs_${op}(${[...s.outs.map(x => `${cSigType(x.type)} *${x.name}`), ...s.ins.map(i => `${cSigType(i.type)} ${i.name}`)].join(', ')})`;
    const hdr = ['/* Runtime declarations for the exported program. */',
      '#ifndef OVS_OPS_H', '#define OVS_OPS_H', '',
      '/* Minimal HALCON-like handle/value types. */',
      'typedef struct OvsObject *Hobject;', 'typedef struct OvsTuple *HTuple;',
      'typedef struct OvsObject *OvsObj;', '',
      'double ovs_len(OvsObj obj);', 'const char *ovs_str(double value);',
      'HTuple ovs_cat(int count, ...);', ''];
    const impl = ['/* Runtime stubs for the exported program. */',
      '#include "ops.h"', '', '#include <stddef.h>', '',
      '/* helpers the generated statements use */',
      'double ovs_len(OvsObj obj) { (void)obj; return 0; }',
      'const char *ovs_str(double value) { (void)value; return ""; }',
      'HTuple ovs_cat(int count, ...) { (void)count; return 0; }', ''];
    for (const op of ops) {
      const s = env.usedOps.get(op);
      const sig = headerSig(op, s);
      hdr.push(sig + ';');
      impl.push(sig + ' {');
      impl.push(INDENT + (DISPLAY.test(op) ? '/* display operator: no console output */' : `/* TODO: implement with ${env.lang.lib} */`));
      impl.push('}');
      impl.push('');
    }
    hdr.push('', '#endif /* OVS_OPS_H */');
    return { header: hdr.join('\n') + '\n', impl: impl.join('\n') };
  }

  /* ==========================================================================
     ENTRY FILES — the program itself, per language
     ========================================================================== */
  function emitEntryFile(env) {
    const { family: f, model, moduleName } = env;
    const mainProc = model.byName[model.entry] || null;
    const otherProcs = model.procedures.filter(p => p !== mainProc);
    const ind = INDENT;
    /* C# keeps the procedures inside namespace + class, so its members sit two
       levels in; every other family puts them at the top level of the file. */
    const memberBase = f === 'cs' ? 2 : 0;
    const memberInd = INDENT.repeat(memberBase);
    const bodyInd = INDENT.repeat(memberBase + 1);
    const body = proc => {
      const ctx = {
        family: f, model, lang: env.lang, usedOps: env.usedOps, level: memberBase + 1,
        /* the input parameters already exist, so assigning to one of them must
           not declare it again */
        declared: new Set(proc.params.filter(p => p.dir === 'input').map(p => p.name)),
        outNames: proc.params.filter(p => p.dir === 'output').map(p => p.name),
      };
      const lines = [];
      if (proc === mainProc && proc.programVars && proc.programVars.length) {
        /* the entry point cannot take parameters, so a variable it only reads is
           not defined by anything — say so instead of leaving a stray name */
        const mark = f === 'py' ? '#' : '//';
        lines.push(`${indent(ctx)}${mark} TODO: nothing in the program sets ${proc.programVars.join(', ')}`);
      }
      for (const st of proc.stmts) lines.push(...emitStmt(st, ctx));
      lines.push(...emitReturns(ctx));
      return lines;
    };
    const method = proc => {
      if (proc === mainProc && proc.params.filter(p => p.dir === 'input').length === 0) {
        /* the entry procedure becomes the entry point of the program */
        if (f === 'cs') return [`${memberInd}static void Main(string[] args)`, `${memberInd}{`, ...body(proc), `${memberInd}}`];
        if (f === 'py') return [`def main():`, ...body(proc)];
        if (f === 'js') return [`function main() {`, ...body(proc), `}`, '', 'main();'];
        if (f === 'c') return [`int main(void)`, `{`, ...body(proc), `${bodyInd}return 0;`, `}`];
        if (f === 'rs') return [`fn main() {`, ...body(proc), `}`];
      }
      return emitProcedure(proc, () => body(proc), f, memberBase);
    };

    const ordered = [...(mainProc ? [mainProc] : []), ...otherProcs];
    const lines = [];
    if (f === 'cs') {
      lines.push('using System;', 'using OpenCvSharp;', `using ${moduleName}.Runtime;`, '', `namespace ${moduleName}`, '{', `${ind}/// <summary>Program exported from OpenCVisionStudio.</summary>`, `${ind}internal static class Program`, `${ind}{`);
      ordered.forEach((p, i) => { if (i) lines.push(''); lines.push(...method(p)); });
      lines.push(`${ind}}`, '}');
    } else if (f === 'js') {
      lines.push('// Program exported from OpenCVisionStudio.', "import * as ops from './ops.js';", '');
      ordered.forEach((p, i) => { if (i) lines.push(''); lines.push(...method(p)); });
    } else if (f === 'py') {
      lines.push('# Program exported from OpenCVisionStudio.', 'import math', 'from ops import *', '');
      ordered.forEach((p, i) => { if (i) lines.push(''); lines.push(...method(p)); });
      lines.push('', "if __name__ == '__main__':", `${ind}main()`);
    } else if (f === 'c') {
      lines.push('/* Program exported from OpenCVisionStudio. */', '#include "ops.h"', '#include <math.h>', '');
      ordered.forEach((p, i) => { if (i) lines.push(''); lines.push(...method(p)); });
    } else if (f === 'rs') {
      lines.push('// Program exported from OpenCVisionStudio.', 'mod ops;', 'use opencv::core::Mat;', 'use std::f64::consts::PI;', '');
      ordered.forEach((p, i) => { if (i) lines.push(''); lines.push(...method(p)); });
    }
    return lines.join('\n') + '\n';
  }

  /* ==========================================================================
     WORKSPACE — project files, .vscode, README
     ========================================================================== */
  function vscodeSettings(lang) {
    const s = { 'files.defaultLanguage': lang.vscodeLang, 'editor.formatOnSave': true };
    const tab = lang.vscodeLang === 'typescript' || lang.vscodeLang === 'javascript' ? 2 : 4;
    s[`[${lang.vscodeLang}]`] = { 'editor.tabSize': tab, 'editor.insertSpaces': true };
    if (lang.vscodeLang === 'csharp') s['dotnet.server.useOmnisharp'] = false;
    if (lang.vscodeLang === 'python') s['python.analysis.typeCheckingMode'] = 'basic';
    if (lang.vscodeLang === 'c') s['C_Cpp.default.cStandard'] = 'c11';
    return s;
  }
  function launchConfig(lang, name) {
    const id = lang.id;
    let program, args = [], cwd = '${workspaceFolder}';
    if (lang.family === 'cs') program = `\${workspaceFolder}/bin/Debug/${lang.id === 'csharp-net48' ? 'net48' : 'net10.0'}/${sanitizeId(name)}.dll`;
    else if (id === 'python') program = '${workspaceFolder}/main.py';
    else if (id === 'javascript') program = '${workspaceFolder}/src/index.js';
    else if (id === 'typescript' || id === 'nodejs-ts') program = '${workspaceFolder}/dist/index.js';
    else if (id === 'rust') program = '${workspaceFolder}/target/debug/' + sanitizeId(name) + (process_placeholder());
    else program = '${workspaceFolder}/' + sanitizeId(name);
    return {
      version: '0.2.0',
      configurations: [{
        name: `Run ${name}`, type: lang.family === 'cs' ? 'coreclr' : (id === 'python' ? 'python' : 'node'),
        request: 'launch', program, args, cwd,
        ...(id === 'rust' ? { type: 'cppdbg' } : {}),
        console: 'integratedTerminal',
      }],
    };
  }
  /* the executable extension of the host, only used for the Rust launch path */
  function process_placeholder() { return ''; }

  function tasksConfig(lang, name) {
    const id = lang.id;
    let cmd, args;
    if (lang.family === 'cs') { cmd = 'dotnet'; args = ['build']; }
    else if (id === 'python') { cmd = 'python'; args = ['main.py']; }
    else if (id === 'javascript') { cmd = 'node'; args = ['src/index.js']; }
    else if (id === 'typescript' || id === 'nodejs-ts') { cmd = 'npx'; args = ['tsc', '-p', '.']; }
    else if (id === 'rust') { cmd = 'cargo'; args = ['build']; }
    else { cmd = 'make'; args = []; }
    return {
      version: '2.0.0',
      tasks: [{ label: `build ${name}`, type: 'shell', command: cmd, args, group: { kind: 'build', isDefault: true }, problemMatcher: [] }],
    };
  }

  function readme(lang, name, model, emitted) {
    const procNames = model.procedures.map(p => p.name).join(', ');
    const lines = [
      `# ${name}`,
      '',
      `A VS Code workspace exported from **OpenCVisionStudio** for **${lang.label}**.`,
      '',
      `- Language: ${lang.label}`,
      `- Runtime library: ${lang.lib}`,
      `- Entry procedure: ${model.entry || '(none)'}`,
      `- Procedures: ${procNames || '(none)'}`,
      '',
      '## Open in VS Code',
      '',
      'Open this folder (the one that contains `.vscode/`) with **File ▸ Open Folder…**.',
      `The workspace asks for the ${lang.label} extension on first open (see`,
      '`.vscode/extensions.json`) and `settings.json` sets the editor language to',
      `${lang.vscodeLang}.`,
      '',
      '## What is translated',
      '',
      'The program structure is translated faithfully: procedures become functions,',
      'their HALCON interface becomes the parameter/return list, and if/for/while/',
      'repeat, assignments and calls are written in the target language.',
      '',
      `Operators become calls into \`${lang.runtime}\`. That runtime implements the`,
      'operators this build can map onto the target library and leaves the rest as',
      '**TODO stubs** that carry the HALCON signature — search the runtime file for',
      '`TODO` / `unimplemented` / `NotImplementedException`.',
      '',
      'The export is a starting point, not a build product: it is not meant to',
      'compile as-is, and the TODOs mark exactly where the real work goes.',
      '',
    ];
    return lines.join('\n');
  }

  function gitignore(lang) {
    const common = ['.DS_Store', 'Thumbs.db'];
    if (lang.family === 'cs') common.push('bin/', 'obj/');
    if (lang.family === 'js') common.push('node_modules/', 'dist/', '*.log');
    if (lang.family === 'py') common.push('__pycache__/', '*.pyc', '.venv/', 'venv/');
    if (lang.family === 'c') common.push('*.o', '*.exe', 'build/');
    if (lang.family === 'rs') common.push('target/');
    return common.join('\n') + '\n';
  }

  function editorconfig() {
    return ['root = true', '', '[*]', 'charset = utf-8', 'end_of_line = lf',
      'insert_final_newline = true', 'trim_trailing_whitespace = true', ''].join('\n');
  }

  /* the language-specific project + source files */
  function emitWorkspace(lang, model, name, opts) {
    const moduleName = sanitizeId(name);
    const src = emitSource(model, lang, Object.assign({}, opts, { moduleName }));
    const files = [];
    const add = (path, data) => files.push({ path, data });
    const pascal = sanitizeId(name);

    switch (lang.id) {
      case 'csharp-net48':
      case 'csharp-net10': {
        const tfm = lang.id === 'csharp-net48' ? 'net48' : 'net10.0';
        add('Program.cs', src.main);
        add('Ops.cs', src.runtime);
        add(`${pascal}.csproj`, [
          '<Project Sdk="Microsoft.NET.Sdk">', '', '  <PropertyGroup>',
          '    <OutputType>Exe</OutputType>', `    <TargetFramework>${tfm}</TargetFramework>`,
          '    <LangVersion>latest</LangVersion>',
          '    <ImplicitUsings>disable</ImplicitUsings>', '    <RootNamespace>' + moduleName + '</RootNamespace>',
          '  </PropertyGroup>', '', '  <ItemGroup>',
          '    <PackageReference Include="OpenCvSharp4" Version="4.10.0.20241107" />',
          '    <PackageReference Include="OpenCvSharp4.runtime.win" Version="4.10.0.20241107" />',
          /* the `dynamic` of the generated stubs is compiled by the C# runtime
             binder, which .NET Framework does not reference by default */
          ...(tfm === 'net48' ? ['    <Reference Include="Microsoft.CSharp" />'] : []),
          '  </ItemGroup>', '', '</Project>', ''].join('\n'));
        break;
      }
      case 'javascript':
        add('src/index.js', src.main);
        add('src/ops.js', src.runtime);
        add('package.json', JSON.stringify({
          name: moduleName, version: '0.1.0', type: 'module',
          scripts: { start: 'node src/index.js' }, dependencies: { 'opencv.js': '^1.0.0' },
        }, null, 2) + '\n');
        break;
      case 'typescript':
      case 'nodejs-ts':
        add('src/index.ts', src.main);
        add('src/ops.ts', src.runtime);
        add('package.json', JSON.stringify({
          name: moduleName, version: '0.1.0', type: 'module',
          scripts: { build: 'tsc', start: 'node dist/index.js' },
          ...(lang.id === 'nodejs-ts' ? { engines: { node: '>=20' } } : {}),
          dependencies: {}, devDependencies: { typescript: '^5.6.0' },
        }, null, 2) + '\n');
        add('tsconfig.json', JSON.stringify({
          compilerOptions: { target: 'ES2022', module: 'ES2022', moduleResolution: 'bundler',
            outDir: 'dist', rootDir: 'src', strict: false, esModuleInterop: true, skipLibCheck: true },
          include: ['src'],
        }, null, 2) + '\n');
        break;
      case 'python':
        add('main.py', src.main);
        add('ops.py', src.runtime);
        add('requirements.txt', 'opencv-python\nnumpy\n');
        break;
      case 'c':
        add('main.c', src.main);
        add('ops.h', src.runtime.header);
        add('ops.c', src.runtime.impl);
        add('Makefile', [
          'CC ?= cc', 'CFLAGS ?= -std=c11 -Wall -Wextra -I.', '',
          `${sanitizeId(name)}: main.c ops.c ops.h`, '\t$(CC) $(CFLAGS) -o $@ main.c ops.c -lm', '',
          'clean:', '\trm -f ' + sanitizeId(name), ''].join('\n'));
        break;
      case 'rust':
        add('src/main.rs', src.main);
        add('src/ops.rs', src.runtime);
        add('Cargo.toml', [
          '[package]', `name = "${sanitizeId(name).toLowerCase().replace(/_/g, '-')}"`, 'version = "0.1.0"',
          'edition = "2021"', '', '[dependencies]', 'opencv = "0.94"', ''].join('\n'));
        break;
    }
    return files;
  }

  function buildWorkspace(languageId, procedures, opts = {}) {
    const lang = language(languageId);
    const name = String(opts.workspaceName || 'opencvs-workspace').trim() || 'opencvs-workspace';
    const model = buildModel(procedures, opts.opinfo);
    const root = name + '/';
    const files = [];
    const add = (p, data) => files.push({ path: root + p, data });
    add('.vscode/settings.json', JSON.stringify(vscodeSettings(lang), null, 2) + '\n');
    add('.vscode/extensions.json', JSON.stringify({ recommendations: lang.recommend }, null, 2) + '\n');
    add('.vscode/launch.json', JSON.stringify(launchConfig(lang, name), null, 2) + '\n');
    add('.vscode/tasks.json', JSON.stringify(tasksConfig(lang, name), null, 2) + '\n');
    add('.editorconfig', editorconfig());
    add('.gitignore', gitignore(lang));
    for (const f of emitWorkspace(lang, model, name, opts)) add(f.path, f.data);
    add('README.md', readme(lang, name, model, null));
    return { language: lang, workspaceName: name, files };
  }

  return { LANGUAGES, DEFAULT_LANGUAGE_ID, language, zip, unzipNames, unzipEntry, crc32,
           buildModel, buildWorkspace, translateExpr, parseBody, splitTop };
})();

/* node export for the smoke test (tools/test-export.js) */
if (typeof module !== 'undefined' && module.exports) {
  module.exports = { ExportKit };
}
