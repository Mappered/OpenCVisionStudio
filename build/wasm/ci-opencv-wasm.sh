#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# CI entry point for the OpenCV WASM package (opencv.js + opencv_js.wasm).
#
# Runs on a Linux runner, driven by .github/workflows/build-opencv-wasm.yml,
# which the Windows native workflow calls. Host OS is irrelevant when the target
# is wasm32, and emscripten is far better supported here than under MSYS2.
#
# Everything is a plain command: no GitHub Actions, by repository policy.
#
# Usage: ci-opencv-wasm.sh <opencv-src-dir> <repo-root> <staging-dir> <dist-dir> \
#                           [modules] [simd] [emsdk-version]
# ---------------------------------------------------------------------------
set -euo pipefail

opencv_dir=${1:?usage: ci-opencv-wasm.sh <opencv-src-dir> <repo-root> <staging> <dist> [modules] [simd] [emsdk]}
repo_root=${2:?missing repo root}
staging=${3:?missing staging dir}
dist=${4:?missing dist dir}
modules=${5:-core,imgproc}
simd=${6:-false}
emsdk_version=${7:-latest}

[ -f "$opencv_dir/platforms/js/build_js.py" ] || { echo "error: not an OpenCV source tree: $opencv_dir" >&2; exit 1; }
command -v python3 >/dev/null 2>&1 || { echo 'error: python3 not found' >&2; exit 1; }
command -v node >/dev/null 2>&1 || { echo 'error: node not found' >&2; exit 1; }
command -v zip >/dev/null 2>&1 || { echo 'error: zip not found' >&2; exit 1; }

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
echo "opencv $version$status (wasm32), modules: $modules, simd: $simd, emsdk: $emsdk_version"

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
# Build
# ---------------------------------------------------------------------------
echo '=== build ==='
build_dir="$repo_root/build/opencv-wasm"
case "$build_dir" in
	*/build/opencv-wasm) rm -rf "$build_dir" ;;
	*) echo "error: refusing to clean unexpected build dir: $build_dir" >&2; exit 1 ;;
esac
mkdir -p "$build_dir" "$staging" "$dist"

build_args=(--build_wasm --disable_single_file --config "$opencv_dir/platforms/js/opencv_js.config.py")
[ "$simd" = "true" ] && build_args+=(--simd)
for option in "-DBUILD_LIST=$modules" -DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF; do
	build_args+=(--cmake_option="$option")
done

( cd "$opencv_dir" && python3 platforms/js/build_js.py "$build_dir" "${build_args[@]}" )

# ---------------------------------------------------------------------------
# Stage, validate, smoke test
# ---------------------------------------------------------------------------
echo '=== stage ==='
fail=0
for artifact in opencv.js opencv_js.wasm; do
	if [ -f "$build_dir/bin/$artifact" ]; then
		cp -f "$build_dir/bin/$artifact" "$staging/"
		echo "ok   staged $artifact ($(stat -c%s "$staging/$artifact") bytes)"
	else
		echo "MISS $artifact in $build_dir/bin"
		fail=1
	fi
done
[ "$fail" -eq 0 ] || { echo 'build produced no usable artifact'; exit 1; }
cp -f "$opencv_dir/platforms/js/opencv_js.config.py" "$staging/opencv_js.config.py"

echo '=== smoke test (node) ==='
cat > "$staging/opencv-wasm-smoke.js" <<'EOF'
const path = require('path');
const cv = require(path.join(__dirname, 'opencv.js'));

cv.onRuntimeInitialized = () => {
    try {
        const m = cv.matFromArray(2, 3, cv.CV_32F, [1, 2, 3, 4, 5, 6]);
        const values = Array.from(m.data32F);
        const ok = m.rows === 2 && m.cols === 3 && values.length === 6 && values[5] === 6;
        console.log('opencv.js | rows=' + m.rows + ' cols=' + m.cols + ' data=' + values.join(','));
        m.delete();
        console.log(ok ? 'OK' : 'FAIL');
        process.exit(ok ? 0 : 1);
    } catch (error) {
        console.error('smoke test threw:', error);
        process.exit(1);
    }
};
EOF
( cd "$staging" && node opencv-wasm-smoke.js )
echo 'smoke test passed'

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
emcc_version=$(emcc --version | head -n1 | sed 's/^emcc[^0-9]*//')
cat > "$staging/BUILDINFO.json" <<EOF
{
  "package": "opencv",
  "version": "$version",
  "status": "$status",
  "platform": "wasm32",
  "modules": "$modules",
  "simd": $simd,
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
name="opencv-$version-wasm32"
rm -f "$dist/$name.zip"
( cd "$staging" && zip -q -r "$dist/$name.zip" . )
cp "$staging/BUILDINFO.json" "$dist/"
( cd "$dist" && sha256sum "$name.zip" > SHA256SUMS )
ls -l "$dist"
cat "$dist/BUILDINFO.json"
