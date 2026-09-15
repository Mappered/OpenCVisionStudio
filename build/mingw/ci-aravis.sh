#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# CI entry point for the Aravis package: install the MINGW64 toolchain and
# dependencies with pacman, build Aravis, validate the package, then zip it.
#
# Runs inside MSYS2 bash, driven by .github/workflows/build-aravis.yml. No
# GitHub actions are involved anywhere, by requirement of the repository's
# action policy, so this is plain commands end to end.
#
# Usage: ci-aravis.sh <aravis-src-dir> <repo-root> <staging-dir> <dist-dir>
# ---------------------------------------------------------------------------
set -euo pipefail

aravis_dir=${1:?usage: ci-aravis.sh <aravis-src-dir> <repo-root> <staging-dir> <dist-dir>}
repo_root=${2:?missing repo root}
staging=${3:?missing staging dir}
dist=${4:?missing dist dir}

# The MSYS2 root is whatever the workflow located; its MINGW64 toolchain has to
# be first on PATH so gcc, pkg-config and glib-* come from there.
export PATH=/mingw64/bin:$PATH

echo '=== toolchain ==='
gcc -dumpmachine
gcc -dumpversion

echo '=== dependencies (pacman) ==='
pacman -Sy --noconfirm --disable-download-timeout
pacman -S --noconfirm --needed --disable-download-timeout \
	mingw-w64-x86_64-gcc \
	mingw-w64-x86_64-glib2 \
	mingw-w64-x86_64-libxml2 \
	mingw-w64-x86_64-zlib \
	mingw-w64-x86_64-libusb \
	mingw-w64-x86_64-pkgconf \
	zip

echo '=== build ==='
bash "$repo_root/build/mingw/build-aravis.sh" "$aravis_dir" "$staging"

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
check 'Aravis runtime DLL'      'bin/libaravis-*-0.dll'
check 'Aravis import library'   'lib/libaravis-*.dll.a'
check 'arv.h header'            'include/aravis-*/arv.h'
check 'generated arvapi.h'      'include/aravis-*/arvapi.h'
check 'generated arvfeatures.h' 'include/aravis-*/arvfeatures.h'
check 'pkg-config file'         'lib/pkgconfig/aravis-*.pc'
check 'arv-tool'                'bin/arv-tool-*.exe'
check 'fake GV camera tool'     'bin/arv-fake-gv-camera-*.exe'
check 'glib runtime DLL'        'bin/libglib-2.0-0.dll'
check 'libusb runtime DLL'      'bin/libusb-1.0.dll'

# Every non-system dependency of the DLL has to sit next to it, otherwise the
# package only runs on machines that happen to have MSYS2 installed.
echo '--- runtime dependency closure ---'
if command -v ldd >/dev/null 2>&1; then
	while IFS= read -r dep; do
		[ -n "$dep" ] || continue
		if [ -f "$staging/bin/$dep" ]; then
			echo "ok   dep: $dep"
		else
			echo "MISS dep (not copied): $dep"
			fail=1
		fi
	done < <(ldd "$staging"/bin/libaravis-*-0.dll \
		| awk '{print $1}' \
		| grep -E '^(libglib|libgobject|libgio|libgmodule|libxml2|libusb|libintl|libpcre2|libffi|libiconv|libz|zlib|libwinpthread|libgcc)' \
		| sort -u || true)
else
	echo 'warning: ldd unavailable, skipping closure check'
fi
[ "$fail" -eq 0 ] || { echo 'package is incomplete'; exit 1; }

echo '=== package ==='
version=$(sed -n 's/.*"version": *"\([^"]*\)".*/\1/p' "$staging/BUILDINFO.json" | head -n1)
[ -n "$version" ] || { echo 'error: cannot read version from BUILDINFO.json' >&2; exit 1; }
name="aravis-$version-${PLATFORM_TAG:-win-x64}"
mkdir -p "$dist"
rm -f "$dist/$name.zip"
( cd "$staging" && zip -q -r "$dist/$name.zip" . )
cp "$staging/BUILDINFO.json" "$dist/"
( cd "$dist" && sha256sum "$name.zip" > SHA256SUMS )
ls -l "$dist"
cat "$dist/SHA256SUMS"
cat "$dist/BUILDINFO.json"
