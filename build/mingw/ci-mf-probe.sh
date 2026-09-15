#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Build and run the Media Foundation probe inside MSYS2.
#
# The question it answers: does the MinGW-w64 toolchain build and link Media
# Foundation code? MF is a Microsoft API normally consumed with MSVC and the
# Windows SDK, and this project is MinGW-only by decision, so if this fails the
# webcam backend needs a different approach entirely.
#
# Usage: ci-mf-probe.sh <repo-root>
# ---------------------------------------------------------------------------
set -euo pipefail

repo_root=${1:?usage: ci-mf-probe.sh <repo-root>}
source_file="$repo_root/build/mingw/mf-probe.c"
out_dir="$repo_root/build/mf-probe"

[ -f "$source_file" ] || { echo "error: missing $source_file" >&2; exit 1; }

export PATH=/mingw64/bin:$PATH

echo '=== toolchain ==='
pacman -Sy --noconfirm --disable-download-timeout
pacman -S --noconfirm --needed --disable-download-timeout mingw-w64-x86_64-gcc
gcc -dumpmachine
gcc -dumpversion

echo '=== do the Media Foundation headers exist in this toolchain? ==='
found=0
for header in mfapi.h mfidl.h mfobjects.h mfreadwrite.h dshow.h strmif.h; do
	if [ -f "/mingw64/include/$header" ]; then
		echo "ok   $header"
		found=$((found + 1))
	else
		echo "MISS $header"
	fi
done
[ "$found" -ge 5 ] || { echo 'Media Foundation headers are not available in this MinGW toolchain' >&2; exit 1; }

echo "=== which import libraries are present? ==="
for library in libmf.a libmfplat.a libmfreadwrite.a libmfuuid.a libole32.a liboleaut32.a libuuid.a libstrmiids.a; do
	if [ -f "/mingw64/lib/$library" ] || [ -f "/mingw64/lib/$library.dll.a" ]; then
		echo "ok   $library"
	else
		echo "MISS $library"
	fi
done

# Which import library actually exports each entry point we need? MF splits its
# API across mf.dll and mfplat.dll, and guessing wrong shows up as an undefined
# reference at link time. Report it instead of guessing.
echo '=== locating Media Foundation entry points ==='
for symbol in MFStartup MFCreateAttributes MFEnumDeviceSources MFGetService; do
	hits=""
	for library in /mingw64/lib/libmf.a /mingw64/lib/libmfplat.a /mingw64/lib/libmfreadwrite.a; do
		[ -f "$library" ] || continue
		if nm -g --defined-only "$library" 2>/dev/null | grep -Eq "[ _]${symbol}$"; then
			hits="$hits $(basename "$library")"
		fi
	done
	echo "  $symbol ->${hits:- not found in any import library}"
done

echo '=== build ==='
mkdir -p "$out_dir"
gcc -O1 -Wall -Wextra -o "$out_dir/mf-probe.exe" "$source_file" \
	-lmf -lmfplat -lmfreadwrite -lmfuuid -lole32 -loleaut32 -luuid -lstrmiids
echo "linked $out_dir/mf-probe.exe"

echo '=== run (a runner has no cameras; zero devices is success) ==='
"$out_dir/mf-probe.exe"

# ---------------------------------------------------------------------------
# Windows 11 user-mode virtual camera API. Reported rather than enforced: an
# older MinGW without the header is a fact to plan around, not a build failure.
# ---------------------------------------------------------------------------
echo '=== Windows 11 virtual camera API (MFCreateVirtualCamera) ==='
vcam_header=0
vcam_symbol=0
if [ -f /mingw64/include/mfvirtualcamera.h ]; then
	echo 'ok   mfvirtualcamera.h'
	vcam_header=1
else
	echo 'MISS mfvirtualcamera.h - this MinGW predates the API'
fi
for library in /mingw64/lib/libmfplat.a /mingw64/lib/libmf.a; do
	[ -f "$library" ] || continue
	if nm -g --defined-only "$library" 2>/dev/null | grep -Eq '[ _]MFCreateVirtualCamera$'; then
		echo "ok   MFCreateVirtualCamera in $(basename "$library")"
		vcam_symbol=1
	fi
done
[ "$vcam_symbol" -eq 1 ] || echo 'MISS MFCreateVirtualCamera in the import libraries'

if [ "$vcam_header" -eq 1 ]; then
	echo '=== build and run the virtual camera probe ==='
	gcc -O1 -Wall -Wextra -o "$out_dir/mf-vcam-probe.exe" "$repo_root/build/mingw/mf-vcam-probe.c" \
		-lmf -lmfplat -lmfuuid -lole32 -loleaut32 -luuid
	"$out_dir/mf-vcam-probe.exe" || echo "warning: virtual camera probe exited non-zero" >&2
else
	echo 'skipping the virtual camera probe: the header is not available'
fi

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
	{
		echo ''
		echo '### Media Foundation virtual camera'
		echo ''
		echo "- \`mfvirtualcamera.h\` in this MinGW: **$vcam_header**"
		echo "- \`MFCreateVirtualCamera\` import symbol: **$vcam_symbol**"
	} >> "$GITHUB_STEP_SUMMARY"
fi

# ---------------------------------------------------------------------------
# Dynamic resolution: the header shortage does not matter if the OS exports the
# function. This build needs no MF headers at all, so it always runs.
# ---------------------------------------------------------------------------
echo '=== Windows 11 virtual camera via dynamic resolution ==='
gcc -O1 -Wall -Wextra -o "$out_dir/mf-vcam-dyn.exe" "$repo_root/build/mingw/mf-vcam-dyn.c" -lole32
"$out_dir/mf-vcam-dyn.exe" || echo "warning: dynamic virtual camera probe exited non-zero" >&2
vcam_line=$("$out_dir/mf-vcam-dyn.exe" 2>/dev/null | grep '^VCAM_PROBE ' | tail -n1 || true)
echo "probe line: ${vcam_line:-none}"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
	{
		echo ''
		echo '### Dynamic virtual camera resolution'
		echo ''
		echo '```'
		echo "${vcam_line:-VCAM_PROBE (no output)}"
		echo '```'
		echo ''
		echo 'exported=1 with any HRESULT means the OS offers the API and our own'
		echo 'declarations reached it. E_ACCESSDENIED is the expected answer for an'
		echo 'unpackaged process and confirms the signature matches.'
	} >> "$GITHUB_STEP_SUMMARY"
fi

echo 'Media Foundation probe passed'
