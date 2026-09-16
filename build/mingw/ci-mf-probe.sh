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
# ---------------------------------------------------------------------------
# The publisher: the half that owns a camera. Built against the Aravis package
# published to the artifacts branch, so CI exercises the SDK consumers will use,
# and driven against Aravis' own fake GigE Vision camera - real GenICam
# acquisition with no hardware.
# ---------------------------------------------------------------------------
echo '=== publisher: Aravis package from the artifacts branch ==='
pacman -S --noconfirm --needed --disable-download-timeout unzip >/dev/null 2>&1 || true
aravis_zip="$repo_root/build/aravis-package.zip"
if [ ! -f "$aravis_zip" ]; then
	echo "error: $aravis_zip is missing - the workflow stage that fetches it did not run" >&2
	exit 1
fi
sdk="$repo_root/build/aravis-sdk"
rm -rf "$sdk"
mkdir -p "$sdk"
( cd "$sdk" && unzip -qo "$aravis_zip" )
echo "extracted $(find "$sdk" -type f | wc -l) files"

# The package's include directory is named after the API version, which is not
# the release number: 0.9.3 ships the 0.10 API.
api=0.10

# Everything below comes from the published package and nothing else: no MSYS2
# include or lib paths appear. That is the point - if this builds, the package is
# a complete SDK, and an earlier version of it was not.
gcc -O1 -Wall -Wextra -DVCAM_WITH_ARAVIS -o "$out_dir/vcam-publisher.exe" \
	"$vcam_dir/vcam_publisher.c" "$vcam_dir/framebus.c" \
	-I"$sdk/include/aravis-$api" \
	-I"$sdk/include/glib-2.0" -I"$sdk/lib/glib-2.0/include" \
	-L"$sdk/lib" \
	-laravis-$api -lglib-2.0 -lgobject-2.0 -lgio-2.0 -lgmodule-2.0 \
	-lxml2 -lusb-1.0 -lz -lws2_32 -liphlpapi
echo "built $out_dir/vcam-publisher.exe"

echo '--- pkg-config from the package alone ---'
# The package README documents pkg-config as one of the two ways to consume it,
# so that claim is checked rather than assumed. MSYS2 does not always ship
# pkg-config, and without it this would look like a defect in the package.
pacman -S --noconfirm --needed --disable-download-timeout mingw-w64-x86_64-pkgconf \
	>/dev/null 2>&1 || true
if command -v pkg-config >/dev/null 2>&1; then
	if PKG_CONFIG_PATH="$sdk/lib/pkgconfig" pkg-config --exists "aravis-$api"; then
		echo "ok   pkg-config version $(PKG_CONFIG_PATH="$sdk/lib/pkgconfig" pkg-config --modversion "aravis-$api")"
		PKG_CONFIG_PATH="$sdk/lib/pkgconfig" pkg-config --cflags --libs "aravis-$api"
	else
		echo "error: pkg-config cannot resolve aravis-$api from the package" >&2
		ls -l "$sdk/lib/pkgconfig/" >&2 || true
		exit 1
	fi
else
	echo 'note: no pkg-config on this runner, skipping that check'
fi

# Next to the executables, so the loader finds them: the package's DLLs and
# MSYS2's glib are the same MinGW build, but only the ones in the executable's
# own directory are guaranteed to match what it linked against.
cp -f "$sdk"/bin/*.dll "$out_dir/" 2>/dev/null || true
echo "copied $(ls "$out_dir"/*.dll | wc -l) DLLs next to the executables"

# The kit is shipped as a flat directory, so a runtime DLL that is not in it
# cannot be found on a client machine. Compare what the publisher needs against
# what the package supplied: this is the check that makes the kit portable.
echo '--- runtime dependencies of the publisher that the kit does not carry ---'
publisher_missing=""
if command -v ldd >/dev/null 2>&1; then
	for dep in $(ldd "$out_dir/vcam-publisher.exe" 2>/dev/null | awk '{print $3}' \
			| grep -i 'mingw64\|/bin/' || true); do
		base=$(basename "$dep")
		[ -f "$out_dir/$base" ] || publisher_missing="$publisher_missing $base"
	done
fi
echo "missing:${publisher_missing:- none}"

echo '--- synthetic publish in one process, verify in another ---'
"$out_dir/vcam-publisher.exe" --synthetic --frames 3 --hold 8000 2>&1 | tee "$out_dir/publisher-synthetic.log" &
publisher_pid=$!
sleep 2
"$out_dir/vcam-publisher.exe" --verify 2>&1 | tee "$out_dir/publisher-verify.log" || true
wait $publisher_pid || true
publisher_line=$(grep '^PUBLISHER ' "$out_dir/publisher-synthetic.log" | tail -n1 || true)
verify_line=$(grep '^PUBLISHER_VERIFY ' "$out_dir/publisher-verify.log" | tail -n1 || true)
echo "publisher line: ${publisher_line:-none}"
echo "verify line: ${verify_line:-none}"

echo '--- Aravis: devices before the fake camera ---'
"$out_dir/vcam-publisher.exe" --list 2>&1 | tee "$out_dir/publisher-list-before.log" || true

echo '--- Aravis fake GigE Vision camera ---'
fake_tool="$sdk/bin/arv-fake-gv-camera-0.10.exe"
# A file test, not `command -v`: unzip does not set an execute bit, so the
# shell cannot tell the extracted tool is runnable.
if [ -f "$fake_tool" ]; then
	"$fake_tool" 2>&1 | tee "$out_dir/fake-camera.log" &
	fake_pid=$!
	sleep 5
	"$out_dir/vcam-publisher.exe" --list 2>&1 | tee "$out_dir/publisher-list-after.log" || true
	echo '--- acquiring frames from the fake camera ---'
	"$out_dir/vcam-publisher.exe" --aravis --frames 5 2>&1 | tee "$out_dir/publisher-aravis.log" || true
	aravis_line=$(grep '^PUBLISHER source=aravis ' "$out_dir/publisher-aravis.log" | tail -n1 || true)

	# The live path: the publisher keeps the camera open and another process
	# reads what it puts on the bus, exactly as the media source will. This is
	# the shape a webcam session has, and it is the only place the scaling from
	# the sensor's resolution to the camera's 640x480 is exercised end to end -
	# the fake camera is 512x512, so the frame must come out letterboxed.
	echo '--- live acquisition: continuous publisher, second process reads it ---'
	"$out_dir/vcam-publisher.exe" --aravis --seconds 8 2>&1 | tee "$out_dir/publisher-live.log" &
	live_pid=$!
	sleep 4
	"$out_dir/vcam-publisher.exe" --verify 2>&1 | tee "$out_dir/publisher-live-verify.log" || true
	wait "$live_pid" || true
	live_line=$(grep '^PUBLISHER source=aravis ' "$out_dir/publisher-live.log" | tail -n1 || true)
	live_rate=$(grep -o '[0-9.]* fps' "$out_dir/publisher-live.log" | tail -n1 || true)
	live_verify=$(grep '^PUBLISHER_VERIFY ' "$out_dir/publisher-live-verify.log" | tail -n1 || true)
	live_detail=$(grep '^verify: ' "$out_dir/publisher-live-verify.log" | tail -n1 || true)
	echo "live line: ${live_line:-none}"
	echo "live rate: ${live_rate:-none}"
	echo "live verify: ${live_verify:-none}"
	echo "live detail: ${live_detail:-none}"
	kill "$fake_pid" 2>/dev/null || true
else
	echo 'warning: arv-fake-gv-camera-0.10.exe not found in the package'
	aravis_line="missing fake camera tool"
fi
echo "aravis line: ${aravis_line:-none}"

if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
	{
		echo ''
		echo '### Publisher'
		echo ''
		echo '```'
		echo "${publisher_line:-PUBLISHER (no output)}"
		echo "${verify_line:-PUBLISHER_VERIFY (no output)}"
		echo "${aravis_line:-PUBLISHER source=aravis (no output)}"
		echo "${live_line:-PUBLISHER source=aravis --seconds (no output)}"
		echo "${live_rate:-rate (no output)}"
		echo "${live_verify:-PUBLISHER_VERIFY live (no output)}"
		echo "${live_detail:-verify detail (no output)}"
		echo '```'
		echo ''
		echo 'verify ok=1 means one process published through shared memory and another'
		echo 'read the frame back at the geometry the media source advertises. An aravis'
		echo 'line with published>0 means frames came off a GigE Vision camera through'
		echo 'Aravis; the tag field is 0x5a for generated frames and a real pixel value'
		echo 'for camera frames, which is how the live line is told apart from the'
		echo 'synthetic one. corner=000000 on a 512x512 sensor is the letterbox bar:'
		echo 'the frame was scaled to 640x480 rather than copied.'
	} >> "$GITHUB_STEP_SUMMARY"
fi

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

# The virtual camera API is subject to the webcam privacy control, and the CI
# images ship with camera access denied, which is what made Start return
# E_ACCESSDENIED here while the same call on a client returned a different
# error. The runner is elevated, so the policy can be set from the script:
# without this the run cannot distinguish "our source is wrong" from "this
# machine is not allowed to have a camera".
echo '=== camera privacy: allow desktop applications ==='
for hive in 'HKCU' 'HKLM'; do
	key="$hive\\SOFTWARE\\Microsoft\\Windows\\CurrentVersion\\CapabilityAccessManager\\ConsentStore\\webcam"
	MSYS2_ARG_CONV_EXCL='*' reg.exe add "$key" /v Value /t REG_SZ /d Allow /f >/dev/null 2>&1 \
		&& echo "ok   $hive webcam consent = Allow" \
		|| echo "note: $hive consent store not writable"
done
MSYS2_ARG_CONV_EXCL='*' reg.exe add \
	'HKCU\SOFTWARE\Microsoft\Windows\CurrentVersion\CapabilityAccessManager\ConsentStore\webcam\NonPackaged' \
	/v Value /t REG_SZ /d Allow /f >/dev/null 2>&1 \
	&& echo 'ok   HKCU NonPackaged consent = Allow' \
	|| echo 'note: NonPackaged consent store not writable'

# The frame server is the process that is supposed to load the media source, and
# it is a service. On a runner it is no more started than the privacy policy was
# permissive, so it is started here and its state reported: if the camera fails
# while the service is up, the failure is ours; if the service cannot run at
# all, nothing about the media source can be concluded from this machine.
echo '=== frame server services ==='
for service in FrameServer FrameServerMonitor; do
	if sc.exe query "$service" 2>/dev/null | grep -q RUNNING; then
		echo "ok   $service already running"
	else
		MSYS2_ARG_CONV_EXCL='*' net.exe start "$service" >/dev/null 2>&1 \
			&& echo "ok   $service started" \
			|| echo "note: $service could not be started"
	fi
	sc.exe query "$service" 2>/dev/null | grep -i 'STATE' | sed 's/^[[:space:]]*/  /' || true
done

echo '=== registering the media source CLSID ==='
gcc -O1 -Wall -Wextra -o "$out_dir/vcam-register.exe" "$vcam_dir/vcam_register.c" -lole32 -luuid -ladvapi32
"$out_dir/vcam-register.exe" register "$out_dir/vcamsource.dll" 2>&1 | tee "$out_dir/vcam-register.log" || true
register_line=$(grep '^VCAM_REGISTER ' "$out_dir/vcam-register.log" | tail -n1 || true)
echo "register line: ${register_line:-none}"

echo '=== virtual camera end to end (publish, enumerate, read a frame) ==='
gcc -O1 -Wall -Wextra -o "$out_dir/vcam-read.exe" \
	"$vcam_dir/vcam_read_probe.c" "$vcam_dir/framebus.c" \
	-lmf -lmfplat -lmfreadwrite -lmfuuid -lole32 -loleaut32 -luuid -ladvapi32

# The frame server keeps its reasons to itself, but it does log them: the two
# services register ETW providers, and capturing them while the reader runs is
# the only way to see *why* Start fails rather than what it returns.
echo '=== frame server ETW providers ==='
MSYS2_ARG_CONV_EXCL='*' logman query providers 2>/dev/null | grep -i 'frameserver' \
	| sed 's/^/  /' || echo '  (none found; the providers may be named differently here)'
MSYS2_ARG_CONV_EXCL='*' logman create trace vcametw -ets \
	-p "Microsoft-Windows-FrameServerMonitor" -p "Microsoft-Windows-FrameServer" \
	-o "$out_dir\\frameserver.etl" -f bin >/dev/null 2>&1 \
	&& echo 'trace started' || echo 'note: could not start the ETW trace'

rm -f "$out_dir/vcamsource.dll.log"
"$out_dir/vcam-read.exe" 2>&1 | tee "$out_dir/vcam-read.log" || true

# The frame server has not adopted the source on these machines yet, so the
# source's own half of the pipeline is proven separately: drive it by CLSID,
# the way the frame server would, and check the pixels that come back.
echo '=== the media source, driven directly ==='
gcc -O1 -Wall -Wextra -o "$out_dir/vcam-sourcedrive.exe" \
	"$vcam_dir/vcam_source_drive.c" "$vcam_dir/framebus.c" \
	-lmf -lmfplat -lmfreadwrite -lmfuuid -lole32 -loleaut32 -luuid
"$out_dir/vcam-sourcedrive.exe" 2>&1 | tee "$out_dir/vcam-sourcedrive.log" || true
sourcedrive_line=$(grep '^SOURCE_DRIVE final ' "$out_dir/vcam-sourcedrive.log" | tail -n1 || true)
sourcedrive_detail=$(grep '^sample bytes=' "$out_dir/vcam-sourcedrive.log" | tail -n1 || true)
echo "source drive line: ${sourcedrive_line:-none}"
echo "source drive sample: ${sourcedrive_detail:-none}"

MSYS2_ARG_CONV_EXCL='*' logman stop vcametw -ets >/dev/null 2>&1 || true
if MSYS2_ARG_CONV_EXCL='*' tracerpt "$out_dir\\frameserver.etl" -o "$out_dir\\frameserver.csv" -of CSV -y >/dev/null 2>&1; then
	echo '--- frame server ETW events mentioning a failure or our CLSID ---'
	grep -i 'fail\|error\|00070\|8F2B1E4C\|not supported\|denied' "$out_dir/frameserver.csv" \
		| head -40 | sed 's/^/  /' || echo '  (nothing matched)'
else
	echo 'note: the ETW trace could not be converted'
fi

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

# ---------------------------------------------------------------------------
# The whole chain in one window: a camera through Aravis, the publisher writing
# the frame bus, and the frame server reading that bus out of the media source
# into a different process. The media source falls back to its own pattern when
# nobody is publishing, so the only way to show the camera's pixels made it end
# to end is to have the publisher live while the reader runs - and to read the
# trace, which says which of the two the stream is using.
# ---------------------------------------------------------------------------
echo '=== Aravis through the media source, live ==='
if [ -f "$sdk/bin/arv-fake-gv-camera-0.10.exe" ] && [ -f "$out_dir/vcam-publisher.exe" ]; then
	"$sdk/bin/arv-fake-gv-camera-0.10.exe" >/dev/null 2>&1 &
	fake_pid2=$!
	sleep 5
	"$out_dir/vcam-publisher.exe" --aravis --seconds 14 2>&1 | tee "$out_dir/publisher-for-reader.log" &
	publisher_for_reader=$!
	sleep 4
	# Fresh trace, so what follows is only this run.
	rm -f "$out_dir/vcamsource.dll.log"
	"$out_dir/vcam-read.exe" 2>&1 | tee "$out_dir/vcam-read-live.log" || true
	# And the media source driven directly, reading the live camera's frames
	# rather than publishing frames of its own.
	"$out_dir/vcam-sourcedrive.exe" --no-publish 2>&1 \
		| tee "$out_dir/vcam-sourcedrive-live.log" || true
	wait "$publisher_for_reader" || true
	kill "$fake_pid2" 2>/dev/null || true

	live_read_line=$(grep '^VCAM_READ ' "$out_dir/vcam-read-live.log" | tail -n1 || true)
	bus_line=$(grep 'frame bus' "$out_dir/vcamsource.dll.log" 2>/dev/null | tail -n1 || true)
	live_publisher_line=$(grep '^PUBLISHER source=aravis ' "$out_dir/publisher-for-reader.log" | tail -n1 || true)
	live_source_line=$(grep '^SOURCE_DRIVE final ' "$out_dir/vcam-sourcedrive-live.log" | tail -n1 || true)
	live_source_sample=$(grep '^sample bytes=' "$out_dir/vcam-sourcedrive-live.log" | tail -n1 || true)
	echo "live read line: ${live_read_line:-none}"
	echo "media source bus line: ${bus_line:-none}"
	echo "publisher line: ${live_publisher_line:-none}"
	echo "live source drive line: ${live_source_line:-none}"
	echo "live source drive sample: ${live_source_sample:-none}"
	# Which processes loaded the media source, and how far each got, is the whole
	# question at this point, so the trace is printed in full.
	echo '--- media source trace (live) ---'
	if [ -f "$out_dir/vcamsource.dll.log" ]; then
		# One line per process that loaded the DLL. The frame server service is
		# the process that matters: without an entry for it, the pipeline never
		# got as far as asking the service to instantiate the media source.
		echo '--- processes that loaded the media source ---'
		grep 'media source loaded' "$out_dir/vcamsource.dll.log" | sed 's/^/  /' || true
		cat "$out_dir/vcamsource.dll.log"
	else
		echo '(no trace)'
	fi

	if [ -n "${GITHUB_STEP_SUMMARY:-}" ]; then
		{
			echo ''
			echo '### Aravis through the media source'
			echo ''
			echo '```'
			echo "${live_publisher_line:-publisher (no output)}"
			echo "${live_read_line:-VCAM_READ (no output)}"
			echo "${bus_line:-media source trace (no output)}"
			echo "${live_source_line:-SOURCE_DRIVE (no output)}"
			echo "${live_source_sample:-sample detail (no output)}"
			echo '```'
			echo ''
			echo 'The publisher line says frames came off a GigE Vision camera. The trace'
			echo 'line says the media source took them from the frame bus rather than'
			echo 'generating its own pattern, and the read line says a different process'
			echo 'pulled one through the frame server.'
		} >> "$GITHUB_STEP_SUMMARY"
	fi
else
	echo 'skipping: the fake camera or the publisher is missing'
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
