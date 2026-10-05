#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# CI entry point for the OpenCV WASM package (opencv.js [+ opencv_js.wasm]).
#
# Runs on a Linux runner, driven by .github/workflows/build-opencv-wasm.yml.
# Host OS is irrelevant when the target is wasm32, and emscripten is far better
# supported here than under MSYS2.
#
# Everything is a plain command: no GitHub Actions, by repository policy.
#
# IMPORTANT: the workflow does NOT check this repository out. It fetches this
# one file with `git show <recipe-ref>:build/wasm/ci-opencv-wasm.sh`, so any
# helper it needs has to be inlined below. Do not split it into sibling files
# without teaching the workflow to fetch them too.
#
# Usage:
#   ci-opencv-wasm.sh <opencv-src-dir> <repo-root> <staging-dir> <dist-dir> \
#                     [modules] [simd] [emsdk-version] [threads] [single-file] [imgcodecs]
#
#   modules        BUILD_LIST, default core,imgproc. `js` is always appended.
#   simd           default true   - --simd: CV_ENABLE_INTRINSICS=ON + -msimd128
#   emsdk-version  default 6.0.9  - the emscripten that last built this source
#   threads        default false  - --threads: pthreads, needs COOP/COEP on the host
#   single-file    default false  - one .js with the wasm base64-embedded
#   imgcodecs      default true   - build the codecs and bind cv.imdecode/imencode
#
# Environment knobs:
#   WASM_INITIAL_MEMORY  initial linear memory, default 128MB
#   WASM_MAX_MEMORY      ceiling for heap growth,  default 2GB
#   EMSDK_DIR            where to clone/activate emsdk, default $HOME/emsdk
#
# The performance profile - what each knob buys and what it costs - is written
# up in README.md, section "WASM performance profile".
# ---------------------------------------------------------------------------
set -euo pipefail

opencv_dir=${1:?usage: ci-opencv-wasm.sh <opencv-src-dir> <repo-root> <staging> <dist> [modules] [simd] [emsdk] [threads] [single-file] [imgcodecs]}
repo_root=${2:?missing repo root}
staging=${3:?missing staging dir}
dist=${4:?missing dist dir}
modules=${5:-core,imgproc}
simd=${6:-true}
emsdk_version=${7:-6.0.9}
threads=${8:-false}
single_file=${9:-false}
imgcodecs=${10:-true}

for flag in simd threads single_file imgcodecs; do
	value=${!flag}
	case "$value" in
		true|false) ;;
		*) echo "error: $flag must be true or false, got '$value'" >&2; exit 1 ;;
	esac
done

# A pthread build spawns worker scripts next to the main script, so it cannot be
# folded into a single file. Emscripten only says so deep inside the link step,
# so fail here instead, where the message can explain itself.
if [ "$threads" = true ] && [ "$single_file" = true ]; then
	echo 'error: threads=true requires single-file=false' >&2
	echo '       a pthread build emits a separate worker script; it cannot be embedded.' >&2
	exit 1
fi

[ -f "$opencv_dir/platforms/js/build_js.py" ] || { echo "error: not an OpenCV source tree: $opencv_dir" >&2; exit 1; }
for tool in python3 node zip; do
	command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool not found" >&2; exit 1; }
done

# ---------------------------------------------------------------------------
# Version, from the same file upstream's cmake reads
# ---------------------------------------------------------------------------
version_file="$opencv_dir/modules/core/include/opencv2/core/version.hpp"
major=$(sed -n 's/^#define CV_VERSION_MAJOR[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$version_file" | head -n1)
minor=$(sed -n 's/^#define CV_VERSION_MINOR[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$version_file" | head -n1)
patch=$(sed -n 's/^#define CV_VERSION_REVISION[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$version_file" | head -n1)
status=$(sed -n 's/^#define CV_VERSION_STATUS[[:space:]]*"\([^"]*\)".*/\1/p' "$version_file" | head -n1)
[ -n "$major" ] && [ -n "$minor" ] && [ -n "$patch" ] \
	|| { echo "error: cannot parse CV_VERSION_* from $version_file" >&2; exit 1; }
version="$major.$minor.$patch"

# Package flavour: one version can legitimately be published more than once
# with different flags, so every flavour needs its own path on the artifacts
# branch instead of overwriting the previous one. A token appears only when its
# feature is on, so the name stays short while the set of tokens still
# identifies the build uniquely; BUILDINFO.json spells the booleans out.
flavor="$(printf '%s' "$modules" | tr ',' '-')"
if [ "$simd" = true ]; then flavor="$flavor-simd"; fi
if [ "$threads" = true ]; then flavor="$flavor-threads"; fi
if [ "$single_file" = true ]; then flavor="$flavor-single"; fi
if [ "$imgcodecs" = true ]; then flavor="$flavor-imgcodecs"; fi
name="opencv-$version-wasm32-$flavor"

echo "opencv $version$status (wasm32): package $name"
echo "  modules=$modules simd=$simd imgcodecs=$imgcodecs threads=$threads" \
	"single_file=$single_file emsdk=$emsdk_version"

# ---------------------------------------------------------------------------
# Emscripten
# ---------------------------------------------------------------------------
echo '=== emsdk ==='
emsdk_dir=${EMSDK_DIR:-$HOME/emsdk}
if [ ! -d "$emsdk_dir/.git" ]; then
	git clone --depth 1 https://github.com/emscripten-core/emsdk.git "$emsdk_dir"
fi
"$emsdk_dir/emsdk" install "$emsdk_version"
"$emsdk_dir/emsdk" activate "$emsdk_version"
# shellcheck disable=SC1091
source "$emsdk_dir/emsdk_env.sh"
command -v emcc >/dev/null 2>&1 || { echo 'error: emcc not on PATH after emsdk activate' >&2; exit 1; }
emcc --version | head -n1
python3 --version
node --version

# ---------------------------------------------------------------------------
# Prepare the tree and the build arguments
# ---------------------------------------------------------------------------
echo '=== configure ==='
build_dir="$repo_root/build/opencv-wasm"
case "$build_dir" in
	*/build/opencv-wasm) rm -rf "$build_dir" ;;
	*) echo "error: refusing to clean unexpected build dir: $build_dir" >&2; exit 1 ;;
esac
mkdir -p "$build_dir" "$staging" "$dist"

# --- linear memory ---------------------------------------------------------
# OpenCV hard codes the memory settings on the js target's link line:
#   modules/js/CMakeLists.txt: -s TOTAL_MEMORY=128MB -s WASM_MEM_MAX=1GB -s ALLOW_MEMORY_GROWTH=1
# They live in LINK_FLAGS, which cmake places *after* everything reachable from
# build_js.py's command line, so they cannot be overridden from outside - the
# line is rewritten in place instead. The rewrite is verified, so an upstream
# change to that line fails loudly rather than being silently ignored.
#
# Why bother: 1 GB is a real ceiling for 20 MP working sets (each 8-bit plane is
# ~19.5 MB, and cv::blur/dyn_threshold allocate temporaries), and each heap
# growth copies the whole heap. The same flags upstream uses are kept, only the
# ceiling moves; WASM_MEM_MAX rather than MAXIMUM_MEMORY because that is the
# spelling this OpenCV's CMakeLists uses and the one the current package was
# proven to build with.
initial_memory=${WASM_INITIAL_MEMORY:-128MB}
maximum_memory=${WASM_MAX_MEMORY:-2GB}
memory_line='-s TOTAL_MEMORY=128MB -s WASM_MEM_MAX=1GB -s ALLOW_MEMORY_GROWTH=1'
js_cmake="$opencv_dir/modules/js/CMakeLists.txt"
if grep -qF -- "$memory_line" "$js_cmake"; then
	sed -i "s|-s TOTAL_MEMORY=128MB -s WASM_MEM_MAX=1GB|-s TOTAL_MEMORY=$initial_memory -s WASM_MEM_MAX=$maximum_memory|" "$js_cmake"
	grep -qF -- "-s WASM_MEM_MAX=$maximum_memory" "$js_cmake" \
		|| { echo "error: memory patch did not take: $js_cmake" >&2; exit 1; }
	echo "memory: initial $initial_memory, max $maximum_memory"
else
	echo "warning: memory line not found in $js_cmake - upstream memory settings kept" >&2
	echo "warning: wanted: $memory_line" >&2
fi

# --- JS binding whitelist --------------------------------------------------
# Upstream's list is used as-is. build_js.py hard codes
# -DBUILD_opencv_imgcodecs=OFF, and imgcodecs is not in the whitelist either, so
# enabling the codecs means adding the two entry points as well - otherwise the
# module is compiled and never bound, which is pure payload. The patched list is
# derived from upstream's file at build time and never hand-maintained, so it
# cannot drift. The result is staged, so the exact list used ships with the
# package.
config="$opencv_dir/platforms/js/opencv_js.config.py"
if [ "$imgcodecs" = true ]; then
	config="$staging/opencv_js.config.py"
	python3 - "$opencv_dir/platforms/js/opencv_js.config.py" "$config" <<'PY'
import re, sys

source, target = sys.argv[1], sys.argv[2]
text = open(source).read()
patched, count = re.subn(r'white_list = makeWhiteList\(\[',
                         'white_list = makeWhiteList([imgcodecs, ', text)
if count != 1:
    raise SystemExit('cannot patch %s: makeWhiteList call not found' % source)
with open(target, 'w') as handle:
    handle.write("imgcodecs = {'': ['imdecode', 'imencode']}\n" + patched)
print('whitelist: added imgcodecs.imdecode / imgcodecs.imencode')
PY
fi

build_args=(--build_wasm --config "$config")
[ "$single_file" = true ] || build_args+=(--disable_single_file)
[ "$simd" = true ] && build_args+=(--simd)
[ "$threads" = true ] && build_args+=(--threads)

# The js bindings module must be in BUILD_LIST. build_js.py sets
# -DBUILD_opencv_js=ON, but an explicit BUILD_LIST that omits it drops the
# module, and with it the opencv.js target - which then fails late as
# "No rule to make target 'opencv.js'". Modules listed here are the ones
# compiled; the whitelist config decides which functions get bound.
build_list="$modules"
for extra in js imgcodecs; do
	if [ "$extra" != imgcodecs ] || [ "$imgcodecs" = true ]; then
		case ",$build_list," in
			*",$extra,"*) ;;
			*) build_list="$build_list,$extra" ;;
		esac
	fi
done

# -DCMAKE_CXX_STANDARD=17 is required, not cosmetic: recent emscripten needs
# C++17 for Embind and OpenCV still defaults to C++11, which aborts the
# configure step with an explicit error.
#
# -DCMAKE_*_FLAGS_RELEASE pins the release optimisation. CMAKE_BUILD_TYPE is
# already Release, but the flags are re-asserted because the observable flags of
# the shipped module show -O2 winning in places. Both words travel as one argv
# element, so cmake sees a single -D whose value contains a space.
cmake_options=(
	"-DBUILD_LIST=$build_list"
	-DCMAKE_CXX_STANDARD=17
	-DBUILD_TESTS=OFF
	-DBUILD_PERF_TESTS=OFF
	-DBUILD_EXAMPLES=OFF
	"-DCMAKE_C_FLAGS_RELEASE=-O3 -DNDEBUG"
	"-DCMAKE_CXX_FLAGS_RELEASE=-O3 -DNDEBUG"
)
if [ "$imgcodecs" = true ]; then
	cmake_options+=(
		-DBUILD_opencv_imgcodecs=ON
		# Bundled codecs, compiled into wasm. This is what lets a caller hand
		# encoded bytes to cv.imdecode instead of going image -> canvas ->
		# getImageData -> matFromImageData, which is the single most expensive
		# step in the IDE's read_image path.
		-DWITH_JPEG=ON
		-DWITH_PNG=ON
	)
fi
for option in "${cmake_options[@]}"; do
	build_args+=(--cmake_option="$option")
done
echo "build list: $build_list"
printf 'build args:'; printf ' %q' "${build_args[@]}"; printf '\n'

# ---------------------------------------------------------------------------
# Build
# ---------------------------------------------------------------------------
echo '=== build ==='
( cd "$opencv_dir" && python3 platforms/js/build_js.py "$build_dir" "${build_args[@]}" )

# ---------------------------------------------------------------------------
# Stage
# ---------------------------------------------------------------------------
echo '=== stage ==='
stage_files=(opencv.js)
[ "$single_file" = true ] || stage_files+=(opencv_js.wasm)
fail=0
for artifact in "${stage_files[@]}"; do
	if [ -f "$build_dir/bin/$artifact" ]; then
		cp -f "$build_dir/bin/$artifact" "$staging/"
		echo "ok   staged $artifact ($(stat -c%s "$staging/$artifact") bytes)"
	else
		echo "MISS $artifact in $build_dir/bin"
		fail=1
	fi
done
[ "$fail" -eq 0 ] || { echo 'build produced no usable artifact'; exit 1; }
cp -f "$config" "$staging/opencv_js.config.py"

# ---------------------------------------------------------------------------
# Verify the artifact really has the features that were asked for
# ---------------------------------------------------------------------------
# This is the difference between "the build succeeded" and "the build is what we
# ordered". clang records the enabled target features in a `target_features`
# custom section, and nothing in this pipeline rewrites the wasm afterwards (no
# wasm-opt/binaryen pass), so the section is authoritative: a module built
# without -msimd128 does not contain '+simd128'. For a single-file build the
# same bytes are checked after unwrapping the embedded base64.
echo '=== verify ==='
cat > "$staging/opencv-wasm-verify.js" <<'JS'
// Usage: opencv-wasm-verify.js <opencv.js> <opencv_js.wasm|-> <simd> <imgcodecs>
const fs = require('fs');

const [jsPath, wasmPath, wantSimd, wantCodecs] = process.argv.slice(2);
const js = fs.readFileSync(jsPath, 'utf8');

// A single-file build is a ~11 MB script embedding a ~8 MB base64 blob.
// Matching that with a regex is not possible: V8 aborts with "Maximum call
// stack size exceeded" on a multi-megabyte quantified match. The text is
// scanned character by character instead, and every long candidate is decoded
// until one starts with the wasm magic.
function embeddedModule(text) {
    const isBase64 = (code) =>
        (code >= 65 && code <= 90) || (code >= 97 && code <= 122) ||
        (code >= 48 && code <= 57) || code === 43 || code === 47 || code === 61;
    let start = -1;
    for (let i = 0; i <= text.length; i++) {
        if (i < text.length && isBase64(text.charCodeAt(i))) {
            if (start < 0) start = i;
            continue;
        }
        if (start >= 0 && i - start >= 4096) {
            const candidate = Buffer.from(text.slice(start, i), 'base64');
            if (candidate.subarray(0, 4).toString('hex') === '0061736d') return candidate;
        }
        start = -1;
    }
    return null;
}

let bytes = null;
if (wasmPath && wasmPath !== '-' && fs.existsSync(wasmPath)) {
    bytes = fs.readFileSync(wasmPath);
    console.log('wasm: separate file, ' + bytes.length + ' bytes');
} else {
    bytes = embeddedModule(js);
    if (!bytes) {
        console.error('FAIL: no separate wasm and no embedded wasm payload found');
        process.exit(1);
    }
    console.log('wasm: embedded, ' + bytes.length + ' bytes');
}
if (bytes.subarray(0, 4).toString('hex') !== '0061736d') {
    console.error('FAIL: payload is not a wasm module');
    process.exit(1);
}

function leb(data, at) {
    let result = 0, shift = 0, byte;
    do { byte = data[at++]; result |= (byte & 0x7f) << shift; shift += 7; } while (byte & 0x80);
    return [result >>> 0, at];
}
function name(data, at) {
    const [length, start] = leb(data, at);
    return [data.toString('latin1', start, start + length), start + length];
}
// Walk the section table to the `target_features` custom section (id 0).
function targetFeatures(data) {
    let at = 8;
    while (at < data.length) {
        const id = data[at++];
        const [size, start] = leb(data, at);
        const end = start + size;
        if (id === 0) {
            const [sectionName, payload] = name(data, start);
            if (sectionName === 'target_features') {
                const features = [];
                let cursor = payload;
                while (cursor < end) {
                    const prefix = String.fromCharCode(data[cursor++]);
                    const [feature, next] = name(data, cursor);
                    features.push(prefix + feature);
                    cursor = next;
                }
                return features;
            }
        }
        at = end;
    }
    return null;
}

const features = targetFeatures(bytes);
console.log('target_features: ' + (features === null ? '(none)' : features.join(' ')));
const hasSimd = features !== null && features.indexOf('+simd128') !== -1;
if (wantSimd === 'true' && !hasSimd) {
    console.error('FAIL: simd requested but the module does not declare +simd128');
    process.exit(1);
}
if (wantSimd === 'false' && hasSimd) {
    console.log('note: simd not requested, module still declares +simd128');
}
// Both names are only in the glue when the patched whitelist took effect, so
// requiring both keeps a stray mention of one from passing as a binding.
if (wantCodecs === 'true' && !(/\bimdecode\b/.test(js) && /\bimencode\b/.test(js))) {
    console.error('FAIL: imgcodecs requested but cv.imdecode/cv.imencode are not bound');
    process.exit(1);
}
if (!/\bimread\b/.test(js)) {
    console.error('FAIL: cv.imread is not bound in opencv.js');
    process.exit(1);
}
console.log('verify OK');
JS
wasm_input='-'
[ "$single_file" = true ] || wasm_input="$staging/opencv_js.wasm"
verify_out=$(node "$staging/opencv-wasm-verify.js" "$staging/opencv.js" "$wasm_input" "$simd" "$imgcodecs" 2>&1) || {
	printf '%s\n' "$verify_out"
	echo 'wasm verification failed'; exit 1
}
printf '%s\n' "$verify_out"
wasm_features=$(printf '%s\n' "$verify_out" | sed -n 's/^target_features: //p' | head -n1)

# ---------------------------------------------------------------------------
# Smoke test: a real module load plus one kernel per risky compile flag
# ---------------------------------------------------------------------------
echo '=== smoke test (node) ==='
cat > "$staging/opencv-wasm-smoke.js" <<'JS'
const path = require('path');

// A 1x1 PNG. Decoding it from bytes proves the imgcodecs path end to end,
// including the bundled libpng - the reason this option exists is to stop
// routing images through a canvas.
const PNG_1X1 = 'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';

// MODULARIZE=1 makes opencv.js a factory returning a promise in current
// emscripten, while older output exports the module object immediately, so
// both shapes are accepted. The timeout keeps a hung runtime from quietly
// eating the job's time budget.
const loaded = require(path.join(__dirname, 'opencv.js'));

function ready(cv) {
    if (typeof cv.Mat === 'function') return Promise.resolve(cv);
    return new Promise((resolve, reject) => {
        const timer = setTimeout(() => reject(new Error('runtime did not initialise in 120s')), 120000);
        cv.onRuntimeInitialized = () => { clearTimeout(timer); resolve(cv); };
    });
}

function check(cv) {
    const checks = [];
    const cleanup = [];
    try {
        const m = cv.matFromArray(2, 3, cv.CV_32F, [1, 2, 3, 4, 5, 6]);
        cleanup.push(m);
        const values = Array.from(m.data32F);
        checks.push(['matFromArray', m.rows === 2 && m.cols === 3 && values[5] === 6]);

        // Exercised whatever the flags: catches a broken baseline build.
        const src = cv.Mat.ones(64, 64, cv.CV_8UC1);
        const blurred = new cv.Mat();
        cleanup.push(src, blurred);
        cv.blur(src, blurred, new cv.Size(3, 3));
        checks.push(['blur', blurred.rows === 64 && blurred.cols === 64 && blurred.ucharPtr(32, 32)[0] === 1]);

        if (typeof cv.imdecode === 'function') {
            const png = Buffer.from(PNG_1X1, 'base64');
            const encoded = cv.matFromArray(png.length, 1, cv.CV_8U, Array.from(png));
            const flags = typeof cv.IMREAD_GRAYSCALE === 'number' ? cv.IMREAD_GRAYSCALE : 0;
            const decoded = cv.imdecode(encoded, flags);
            cleanup.push(encoded, decoded);
            checks.push(['imdecode(png)', decoded.rows === 1 && decoded.cols === 1]);
        } else {
            console.log('imdecode: not bound (imgcodecs disabled)');
        }
    } catch (error) {
        console.error('smoke test threw:', error);
        process.exit(1);
    }
    let ok = true;
    for (const [name, passed] of checks) {
        console.log((passed ? 'ok   ' : 'FAIL ') + name);
        if (!passed) ok = false;
    }
    for (const item of cleanup) { try { item.delete(); } catch (error) { /* already gone */ } }
    console.log(ok ? 'OK' : 'FAIL');
    process.exit(ok ? 0 : 1);
}

Promise.resolve(typeof loaded === 'function' ? loaded() : loaded).then(ready).then(check).catch((error) => {
    console.error('smoke test failed:', error);
    process.exit(1);
});
JS
( cd "$staging" && node opencv-wasm-smoke.js )
echo 'smoke test passed'

# ---------------------------------------------------------------------------
# Licenses
# ---------------------------------------------------------------------------
echo '=== licenses ==='
mkdir -p "$staging/licenses"
cp -f "$opencv_dir/LICENSE" "$staging/licenses/opencv.txt"
for pair in "libjpeg-turbo:3rdparty/libjpeg-turbo/LICENSE.md" "libpng:3rdparty/libpng/LICENSE" "zlib:3rdparty/zlib/LICENSE"; do
	name=${pair%%:*}
	path=${pair#*:}
	if [ -f "$opencv_dir/$path" ]; then
		cp -f "$opencv_dir/$path" "$staging/licenses/$name.txt"
	else
		echo "warning: no licence text at $opencv_dir/$path" >&2
	fi
done
ls "$staging/licenses"

# ---------------------------------------------------------------------------
# BUILDINFO.json and package
# ---------------------------------------------------------------------------
if [ "$threads" = true ]; then
	host_requirements='crossOriginIsolated: Cross-Origin-Opener-Policy: same-origin + Cross-Origin-Embedder-Policy: require-corp'
else
	host_requirements='none'
fi
emcc_version=$(emcc --version | head -n1 | sed 's/^emcc[^0-9]*//')
cat > "$staging/BUILDINFO.json" <<EOF
{
  "package": "opencv",
  "version": "$version",
  "status": "$status",
  "platform": "wasm32",
  "flavor": "$flavor",
  "package_file": "$name.zip",
  "modules": "$modules",
  "build_list": "$build_list",
  "simd": $simd,
  "threads": $threads,
  "single_file": $single_file,
  "imgcodecs": $imgcodecs,
  "optimization": "-O3 -DNDEBUG",
  "wasm_features": "$wasm_features",
  "initial_memory": "$initial_memory",
  "maximum_memory": "$maximum_memory",
  "host_requirements": "$host_requirements",
  "config": "platforms/js/opencv_js.config.py",
  "toolchain": "emscripten $emcc_version, python3 $(python3 --version | awk '{print $2}')",
  "built_utc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source_commit": "${BUILD_SOURCE_COMMIT:-unknown}",
  "source_ref": "${BUILD_SOURCE_REF:-unknown}",
  "subtree_tree": "${BUILD_SUBTREE_TREE:-unknown}",
  "run_url": "${GITHUB_SERVER_URL:-}${GITHUB_REPOSITORY:+/$GITHUB_REPOSITORY}${GITHUB_RUN_ID:+/actions/runs/$GITHUB_RUN_ID}",
  "dependencies": {}
}
EOF

echo '=== package ==='
rm -f "$dist/$name.zip"
( cd "$staging" && zip -q -r "$dist/$name.zip" . )
cp "$staging/BUILDINFO.json" "$dist/"
( cd "$dist" && sha256sum "$name.zip" > SHA256SUMS )
ls -l "$dist"
cat "$dist/BUILDINFO.json"
