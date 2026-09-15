#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# CI entry point for the OpenCV package.
#
# Unlike Aravis, OpenCV is built with its own upstream build system: cmake is
# installed inside the MSYS2 environment by this script and exists nowhere else
# - not on developer machines, and not as a GitHub Action (the repository only
# allows actions owned by Mappered). The result is the upstream-supported
# configuration, including real CPU dispatch, rather than a hand translation
# of a 10k line CMake system.
#
# Usage: ci-opencv.sh <opencv-src-dir> <repo-root> <staging-dir> <dist-dir> [modules]
# The source dir is the vendored `opencv/` tree (it contains CMakeLists.txt).
# ---------------------------------------------------------------------------
set -euo pipefail

opencv_dir=${1:?usage: ci-opencv.sh <opencv-src-dir> <repo-root> <staging-dir> <dist-dir> [modules]}
repo_root=${2:?missing repo root}
staging=${3:?missing staging dir}
dist=${4:?missing dist dir}
modules=${5:-${OPENCV_MODULES:-core}}

[ -f "$opencv_dir/CMakeLists.txt" ] || { echo "error: not an OpenCV source tree: $opencv_dir" >&2; exit 1; }

export PATH=/mingw64/bin:$PATH

echo '=== dependencies (pacman) ==='
pacman -Sy --noconfirm --disable-download-timeout
pacman -S --noconfirm --needed --disable-download-timeout \
	mingw-w64-x86_64-gcc \
	mingw-w64-x86_64-cmake \
	mingw-w64-x86_64-ninja \
	zip

echo '=== toolchain ==='
command -v gcc >/dev/null 2>&1 || { echo 'error: gcc not on PATH after pacman install' >&2; exit 1; }
command -v cmake >/dev/null 2>&1 || { echo 'error: cmake not on PATH after pacman install' >&2; exit 1; }
gcc -dumpmachine
gcc -dumpversion
cmake --version | head -n1
ninja --version

# ---------------------------------------------------------------------------
# Version, read from the same file upstream's cmake reads
# ---------------------------------------------------------------------------
version_file="$opencv_dir/modules/core/include/opencv2/core/version.hpp"
[ -f "$version_file" ] || { echo "error: cannot find $version_file" >&2; exit 1; }
major=$(sed -n 's/^#define CV_VERSION_MAJOR[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$version_file" | head -n1)
minor=$(sed -n 's/^#define CV_VERSION_MINOR[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$version_file" | head -n1)
patch=$(sed -n 's/^#define CV_VERSION_REVISION[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$version_file" | head -n1)
status=$(sed -n 's/^#define CV_VERSION_STATUS[[:space:]]*"\([^"]*\)".*/\1/p' "$version_file" | head -n1)
[ -n "$major" ] && [ -n "$minor" ] && [ -n "$patch" ] \
	|| { echo "error: cannot parse CV_VERSION_* from $version_file" >&2; exit 1; }

version="$major.$minor.$patch"
# Windows library naming: major + two digit minor + patch, e.g. 4.14.0 -> 4140.
suffix="$major$(printf '%02d' "$minor")$patch"
soversion="$major$(printf '%02d' "$minor")"
echo "opencv $version$status (library suffix $suffix), modules: $modules"

# ---------------------------------------------------------------------------
# Configure and build
# ---------------------------------------------------------------------------
build_dir="$repo_root/build/opencv/cmake"
case "$build_dir" in
	*/build/opencv/cmake) rm -rf "$build_dir" ;;
	*) echo "error: refusing to clean unexpected build dir: $build_dir" >&2; exit 1 ;;
esac
mkdir -p "$build_dir" "$staging" "$dist"

cmake -S "$opencv_dir" -B "$build_dir" -G Ninja \
	-DCMAKE_BUILD_TYPE=Release \
	-DCMAKE_INSTALL_PREFIX="$staging" \
	-DCMAKE_C_COMPILER=gcc \
	-DCMAKE_CXX_COMPILER=g++ \
	-DBUILD_LIST="$modules" \
	-DBUILD_SHARED_LIBS=ON \
	-DOPENCV_GENERATE_PKGCONFIG=ON \
	-DBUILD_TESTS=OFF -DBUILD_PERF_TESTS=OFF -DBUILD_EXAMPLES=OFF \
	-DBUILD_opencv_apps=OFF -DBUILD_DOCS=OFF -DBUILD_JAVA=OFF \
	-DBUILD_opencv_java=OFF -DBUILD_opencv_python3=OFF -DBUILD_opencv_js=OFF \
	-DWITH_IPP=OFF -DWITH_OPENCL=OFF -DWITH_TBB=OFF -DWITH_OPENMP=OFF \
	-DWITH_CUDA=OFF -DWITH_FFMPEG=OFF -DWITH_GTK=OFF -DWITH_VTK=OFF \
	-DWITH_1394=OFF -DWITH_GSTREAMER=OFF -DWITH_PROTOBUF=OFF -DWITH_QUIRC=OFF \
	-DWITH_OPENEXR=OFF -DWITH_JASPER=OFF -DWITH_WEBP=OFF -DWITH_TIFF=OFF \
	-DWITH_GDAL=OFF -DWITH_GDCM=OFF -DWITH_AVIF=OFF -DWITH_JPEGXL=OFF \
	-DWITH_JPEG=ON -DWITH_PNG=ON -DBUILD_ZLIB=ON -DBUILD_JPEG=ON -DBUILD_PNG=ON \
	-DCPU_DISPATCH='SSE4_1;AVX2' \
	-DENABLE_PRECOMPILED_HEADERS=OFF

echo '=== build ==='
cmake --build "$build_dir" --parallel "$(nproc)"

echo '=== install ==='
cmake --install "$build_dir"

# ---------------------------------------------------------------------------
# Normalise the layout: our packages always expose bin/, lib/, include/.
# MinGW installs there already, but do not assume it.
# ---------------------------------------------------------------------------
mkdir -p "$staging/bin" "$staging/lib" "$staging/include"
relocated=0
while IFS= read -r f; do
	target="$staging/bin/$(basename "$f")"
	[ "$f" = "$target" ] && continue
	mv -f "$f" "$target"
	relocated=$((relocated + 1))
done < <(find "$staging" -name 'libopencv_*.dll' -not -path "$staging/bin/*")
while IFS= read -r f; do
	target="$staging/lib/$(basename "$f")"
	[ "$f" = "$target" ] && continue
	mv -f "$f" "$target"
	relocated=$((relocated + 1))
done < <(find "$staging" -name 'libopencv_*.dll.a' -not -path "$staging/lib/*")
echo "relocated $relocated file(s) into bin/ and lib/"

# ---------------------------------------------------------------------------
# Validate, including a real smoke test: compile a program against the import
# library and run it. This is what catches an empty export table, which is
# exactly how the Aravis DLL first failed.
# ---------------------------------------------------------------------------
echo '=== validate ==='
fail=0
check() {
	local label=$1 pattern=$2 hits=()
	while IFS= read -r hit; do [ -n "$hit" ] && hits+=("$hit"); done < <(compgen -G "$staging/$pattern" || true)
	if [ "${#hits[@]}" -gt 0 ]; then
		echo "ok   $label: ${hits[0]}#staging/"
	else
		echo "MISS $label ($pattern)"
		fail=1
	fi
}
check 'core runtime DLL'    "bin/libopencv_core$suffix.dll"
check 'core import library' "lib/libopencv_core$suffix.dll.a"
check 'core header'         'include/opencv2/core.hpp'
check 'opencv_modules.hpp'  'include/opencv2/opencv_modules.hpp'
check 'pkg-config file'     'lib/pkgconfig/opencv4.pc'
[ "$fail" -eq 0 ] || { echo 'package is incomplete'; exit 1; }

echo '=== smoke test ==='
smoke_dir="$repo_root/build/opencv/smoke"
mkdir -p "$smoke_dir"
cat > "$smoke_dir/smoke.cpp" <<'EOF'
#include <opencv2/core.hpp>
#include <cstdio>

int main()
{
    cv::Mat m = (cv::Mat_<float>(2, 3) << 1, 2, 3, 4, 5, 6);
    cv::Scalar total = cv::sum(m);
    const double expected = 21.0;
    std::printf("opencv %s | %dx%d type=%d | sum=%.1f\n",
                CV_VERSION, m.rows, m.cols, m.type(), total[0]);
    if (total[0] != expected) {
        std::printf("FAIL: expected sum %.1f\n", expected);
        return 1;
    }
    std::printf("OK\n");
    return 0;
}
EOF

smoke_exe="$staging/bin/opencv-smoke.exe"
g++ -std=c++17 -O1 "$smoke_dir/smoke.cpp" \
	-I"$staging/include" -L"$staging/lib" \
	-o "$smoke_exe" -lopencv_core"$suffix"
"$smoke_exe"
echo 'smoke test passed'

# ---------------------------------------------------------------------------
# Licences for what we redistribute (OpenCV and its bundled third parties)
# ---------------------------------------------------------------------------
echo '=== licenses ==='
licenses_dir="$staging/licenses"
mkdir -p "$licenses_dir"
copy_license() {
	local name=$1 path=$2
	if [ -f "$path" ]; then
		cp -f "$path" "$licenses_dir/$name"
	else
		echo "warning: no licence text at $path" >&2
	fi
}
copy_license opencv.txt      "$opencv_dir/LICENSE"
copy_license libjpeg-turbo.txt "$opencv_dir/3rdparty/libjpeg-turbo/LICENSE.md"
copy_license libpng.txt      "$opencv_dir/3rdparty/libpng/LICENSE"
copy_license zlib.txt        "$opencv_dir/3rdparty/zlib/LICENSE"
copy_license zlib-ng.txt     "$opencv_dir/3rdparty/zlib-ng/LICENSE.md"
ls "$licenses_dir"

# ---------------------------------------------------------------------------
# BUILDINFO.json and package
# ---------------------------------------------------------------------------
cat > "$staging/BUILDINFO.json" <<EOF
{
  "package": "opencv",
  "version": "$version",
  "status": "$status",
  "soversion": "$soversion",
  "library_suffix": "$suffix",
  "platform": "${PLATFORM_TAG:-win-x64}",
  "modules": "$modules",
  "toolchain": "$(gcc -dumpmachine), gcc $(gcc -dumpversion), cmake $(cmake --version | head -n1 | awk '{print $3}')",
  "built_utc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source_commit": "${BUILD_SOURCE_COMMIT:-unknown}",
  "source_ref": "${BUILD_SOURCE_REF:-unknown}",
  "subtree_tree": "${BUILD_SUBTREE_TREE:-unknown}",
  "run_url": "${GITHUB_SERVER_URL:-}${GITHUB_REPOSITORY:+/$GITHUB_REPOSITORY}${GITHUB_RUN_ID:+/actions/runs/$GITHUB_RUN_ID}",
  "dependencies": {}
}
EOF

echo '=== package ==='
name="opencv-$version-${PLATFORM_TAG:-win-x64}"
rm -f "$dist/$name.zip"
( cd "$staging" && zip -q -r "$dist/$name.zip" . )
cp "$staging/BUILDINFO.json" "$dist/"
( cd "$dist" && sha256sum "$name.zip" > SHA256SUMS )
ls -l "$dist"
cat "$dist/BUILDINFO.json"
