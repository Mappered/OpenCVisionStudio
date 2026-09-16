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
echo '--- module scan (no call, cannot crash) ---'
"$out_dir/mf-vcam-dyn.exe" || echo "warning: module scan exited non-zero" >&2
vcam_line=$("$out_dir/mf-vcam-dyn.exe" 2>/dev/null | grep '^VCAM_PROBE ' | tail -n1 || true)
echo "scan line: ${vcam_line:-none}"

# Separate invocation for the call: if our hand-written signature is wrong this
# can fault, and that fault is itself the finding - it must not destroy the scan
# output above.
echo '--- call attempt (may fault if our declaration is wrong) ---'
"$out_dir/mf-vcam-dyn.exe" --call || echo "warning: the call attempt exited non-zero - inspect the lines above"
call_line=$("$out_dir/mf-vcam-dyn.exe" --call 2>/dev/null | grep '^VCAM_PROBE ' | tail -n1 || true)
echo "call line: ${call_line:-none}"

# Independent check, straight off the filesystem: which system module contains
# the export name at all? Dynamic resolution can only fail if the string is
# genuinely absent, and this distinguishes "wrong module" from "not on this OS".
echo '=== which system modules mention MFCreateVirtualCamera? ==='
system32=${SYSTEMROOT:-C:\\Windows}/System32
found_module=0
for dll in "$system32"/mf*.dll "$system32"/windows.media*.dll; do
	[ -f "$dll" ] || continue
	if grep -qa 'MFCreateVirtualCamera' "$dll" 2>/dev/null; then
		echo "ok   $(basename "$dll") contains the name"
		found_module=1
	fi
done
[ "$found_module" -eq 1 ] || echo 'no system module contains the name MFCreateVirtualCamera'

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
	{
		echo ''
		echo '### Dynamic virtual camera resolution'
		echo ''
		echo '```'
		echo "${vcam_line:-VCAM_PROBE (no output)}"
		echo "${call_line:-call attempt produced no result}"
		echo '```'
		echo ''
		echo 'A module scan line means some system module exports the API on this OS.'
		echo 'A call line with any HRESULT means our own declarations reached it;'
		echo 'E_ACCESSDENIED is the expected answer for an unpackaged process and'
		echo 'confirms the signature matches. A crash or silence on the call means the'
		echo 'declaration does not match the ABI and must be revised.'
	} >> "$GITHUB_STEP_SUMMARY"
fi

# ---------------------------------------------------------------------------
# Does a created virtual camera become enumerable as a capture device? This is
# the gate between holding an object and applications being able to see a
# webcam, and it needs no camera and no GUI.
# ---------------------------------------------------------------------------
vcam_dir="$repo_root/build/mingw/vcam"

echo '=== building the virtual camera media source ==='
gcc -O1 -Wall -Wextra -shared -o "$out_dir/vcamsource.dll" "$vcam_dir/vcamsource.c" \
	"$vcam_dir/framebus.c" \
	-Wl,--out-implib,"$out_dir/libvcamsource.dll.a" \
	-lmf -lmfplat -lmfuuid -lole32 -loleaut32 -luuid -lstrmiids -static-libgcc
echo "built $out_dir/vcamsource.dll"

# ---------------------------------------------------------------------------
# The frame bus is the part of the virtual camera pipeline that CI can prove
# outright: real frames reaching the media source, independent of whether this
# Windows SKU's frame server will bring a software camera up.
# ---------------------------------------------------------------------------
echo '=== frame bus round trip ==='
# Checked inside vcam-read.exe rather than as a separate binary: the round trip
# is what matters, and a separate test executable would not start on this
# runner (exit 127, no loader message) for reasons unrelated to the bus.

# The frame server loads this DLL; anything it depends on that is not a Windows
# system library has to travel with it.
echo '--- non-system dependencies of the media source ---'
if command -v ldd >/dev/null 2>&1; then
	non_system=$(ldd "$out_dir/vcamsource.dll" | awk '{print $1" -> "$3}' | grep -vi 'system32\|/windows/' || true)
	echo "${non_system:-none}"
fi

echo '=== registering the media source CLSID ==='
gcc -O1 -Wall -Wextra -o "$out_dir/vcam-register.exe" "$vcam_dir/vcam_register.c" -lole32 -luuid -ladvapi32
"$out_dir/vcam-register.exe" register "$out_dir/vcamsource.dll" 2>&1 | tee "$out_dir/vcam-register.log" || true
register_line=$(grep '^VCAM_REGISTER ' "$out_dir/vcam-register.log" | tail -n1 || true)
echo "register line: ${register_line:-none}"

echo '=== virtual camera end to end (publish, enumerate, read a frame) ==='
gcc -O1 -Wall -Wextra -o "$out_dir/vcam-read.exe" \
	"$vcam_dir/vcam_read_probe.c" "$vcam_dir/framebus.c" \
	-lmf -lmfplat -lmfreadwrite -lmfuuid -lole32 -loleaut32 -luuid
rm -f "$out_dir/vcamsource.dll.log"
"$out_dir/vcam-read.exe" 2>&1 | tee "$out_dir/vcam-read.log" || true
read_line=$(grep '^VCAM_READ ' "$out_dir/vcam-read.log" | tail -n1 || true)
framebus_line=$(grep '^FRAMEBUS_SELFCHECK ' "$out_dir/vcam-read.log" | tail -n1 || true)
echo "read line: ${read_line:-none}"
echo "frame bus line: ${framebus_line:-none}"

# The media source runs inside the frame server's process, so it traces to a
# file next to the DLL. That trace is the only view we get of what the server
# does with our object.
echo '--- media source trace ---'
if [ -f "$out_dir/vcamsource.dll.log" ]; then
	cat "$out_dir/vcamsource.dll.log"
else
	echo '(no trace: the media source was never loaded)'
fi

echo '=== unregistering (leave the runner clean) ==='
"$out_dir/vcam-register.exe" unregister || true

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
	{
		echo ''
		echo '### Virtual camera end to end'
		echo ''
		echo '```'
		echo "${register_line:-VCAM_REGISTER (no output)}"
		echo "${read_line:-VCAM_READ (no output)}"
		echo "${framebus_line:-FRAMEBUS_SELFCHECK (no output)}"
		echo '```'
		echo ''
		echo 'found=1 means the camera was enumerated by Media Foundation, and'
		echo 'sample_bytes>0 means a frame was delivered through the frame server to'
		echo 'this reader. Both together are the end-to-end proof.'
	} >> "$GITHUB_STEP_SUMMARY"
fi

echo '=== virtual camera publish probe ==='
gcc -O1 -Wall -Wextra -o "$out_dir/vcam-publish.exe" \
	"$repo_root/build/mingw/vcam/vcam_publish_probe.c" \
	-lmf -lmfplat -lmfreadwrite -lmfuuid -lole32 -loleaut32 -luuid
"$out_dir/vcam-publish.exe" 2>&1 | tee "$out_dir/vcam-publish.log" || true
pub_line=$(grep '^VCAM_PUBLISH ' "$out_dir/vcam-publish.log" | tail -n1 || true)
echo "publish line: ${pub_line:-none}"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
	{
		echo ''
		echo '### Virtual camera publish probe'
		echo ''
		echo '```'
		echo "${pub_line:-VCAM_PUBLISH (no output)}"
		echo '```'
		echo ''
		echo 'visible=1 means Media Foundation enumerated the virtual camera as a'
		echo 'capture device after Start. A failing Start tells us the media source'
		echo 'must be registered under that CLSID before the camera can come up.'
	} >> "$GITHUB_STEP_SUMMARY"
fi

echo 'Media Foundation probe passed'
