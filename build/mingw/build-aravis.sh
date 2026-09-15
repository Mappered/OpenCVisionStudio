#!/usr/bin/env bash
# ---------------------------------------------------------------------------
# Build the vendored Aravis with MinGW-w64 GCC. No meson. No cmake.
#
# This is a hand translation of what aravis/meson.build does, so the output is
# the same library that meson would have produced:
#
#   src/arvapi.h.in           -> arvapi.h            (@ARV_API@)
#   src/arvfeatures.h.in      -> arvfeatures.h       (USB on; V4L2, event,
#                                                     packet socket, fast
#                                                     heartbeat off)
#   src/arvparamsprivate.h.in -> arvparamsprivate.h  (#mesondefine ...)
#   src/arvversion.h.in       -> arvversion.h
#   gnome.mkenums_simple      -> arvenumtypes.{h,c}, arvenumtypesprivate.{h,c}
#   gnome.compile_resources   -> arvresources.{c,h}
#   library('aravis-<api>')   -> libaravis-<api>-0.dll + libaravis-<api>.dll.a
#   executable('arv-tool-<api>') and friends
#
# The enum type files are load bearing, not decoration: library sources call
# generated macros such as ARV_TYPE_GVCP_PACKET_TYPE, which only exist if
# glib-mkenums scanned the same header sets meson scans (public headers into
# arvenumtypes.h, *private.h into arvenumtypesprivate.h).
#
# The source list is parsed out of src/meson.build so upstream additions are
# picked up automatically. Excluded are the four files that define main() (the
# tools, built separately below) and the v4l2 backend, which is disabled here.
#
# Usage:
#   build-aravis.sh [source-dir] [install-prefix]
# Defaults: <repo>/aravis and <repo>/build/mingw/out
# ---------------------------------------------------------------------------
set -euo pipefail

script_dir=$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)
repo_root=$(cd -- "$script_dir/../.." && pwd)

src_dir=${1:-$repo_root/aravis}
prefix=${2:-$repo_root/build/mingw/out}

top_meson="$src_dir/meson.build"
src_meson="$src_dir/src/meson.build"
src_src="$src_dir/src"

[ -f "$top_meson" ] || { echo "error: not an Aravis source tree (no meson.build): $src_dir" >&2; exit 1; }
[ -f "$src_meson" ] || { echo "error: missing $src_meson" >&2; exit 1; }

for tool in gcc glib-mkenums glib-compile-resources pkg-config; do
	command -v "$tool" >/dev/null 2>&1 || { echo "error: $tool not found in PATH (are you in an MSYS2 MINGW64 shell?)" >&2; exit 1; }
done

work_dir=${BUILD_DIR:-$repo_root/build/mingw/work}
obj_dir="$work_dir/obj"
gen_dir="$work_dir/gen"
# Guard the one destructive step: never clean a directory we did not expect.
case "$work_dir" in
	*/build/mingw/work) rm -rf "$work_dir" ;;
	*) echo "error: refusing to clean unexpected work dir: $work_dir" >&2; exit 1 ;;
esac
mkdir -p "$obj_dir" "$gen_dir" "$prefix/bin" "$prefix/lib/pkgconfig"

# ---------------------------------------------------------------------------
# Versions, read from the same place meson reads them
# ---------------------------------------------------------------------------
version=$(sed -n "s/.*, *version: *'\([^']*\)'.*/\1/p" "$top_meson" | head -n1)
api=$(sed -n "s/.*aravis_api_version *= *'\([^']*\)'.*/\1/p" "$top_meson" | head -n1)
[ -n "$version" ] || { echo "error: cannot parse project version from $top_meson" >&2; exit 1; }
[ -n "$api" ]     || { echo "error: cannot parse aravis_api_version from $top_meson" >&2; exit 1; }

IFS='.' read -r v_major v_minor v_micro _rest <<<"$version"
include_dir="$prefix/include/aravis-$api"
mkdir -p "$include_dir"

echo "aravis $version (api $api), prefix $prefix"

# ---------------------------------------------------------------------------
# Dependency flags
# ---------------------------------------------------------------------------
# zlib is listed explicitly because arvzip.c calls into it directly and
# pkg-config --libs does not pull private dependencies transitively.
devel_pkgs="glib-2.0 gobject-2.0 gio-2.0 gmodule-2.0 libxml-2.0 libusb-1.0 zlib"
read -r -a dep_cflags <<<"$(pkg-config --cflags $devel_pkgs)"
read -r -a dep_libs   <<<"$(pkg-config --libs   $devel_pkgs)"

# Mirrors meson's GCC branch of cc_export_define for a shared build, plus
# -fvisibility=hidden so only the public API is exported.
arv_api='extern __attribute__ ((visibility ("default")))'

cflags=(
	-O2
	-DNDEBUG
	-DARAVIS_COMPILATION
	-D_WIN32_WINNT=0x0601
	-fvisibility=hidden
	-I"$gen_dir"
	-I"$src_src"
	"${dep_cflags[@]}"
)
system_libs=(-lws2_32 -liphlpapi)

# ---------------------------------------------------------------------------
# Configure-file replacements (meson's @VAR@ and #mesondefine forms)
# ---------------------------------------------------------------------------
sed "s|@ARV_API@|$arv_api|" "$src_src/arvapi.h.in" > "$gen_dir/arvapi.h"

sed -e 's|@ARAVIS_HAS_USB@|1|' \
    -e 's|@ARAVIS_HAS_V4L2@|0|' \
    -e 's|@ARAVIS_HAS_PACKET_SOCKET@|0|' \
    -e 's|@ARAVIS_HAS_EVENT@|0|' \
    -e 's|@ARAVIS_HAS_FAST_HEARTBEAT@|0|' \
    "$src_src/arvfeatures.h.in" > "$gen_dir/arvfeatures.h"

sed 's|#mesondefine ARV_GV_STREAM_NUM_BUFFERS|#define ARV_GV_STREAM_NUM_BUFFERS 16|' \
    "$src_src/arvparamsprivate.h.in" > "$gen_dir/arvparamsprivate.h"

sed -e "s|@ARAVIS_VERSION@|$version|" \
    -e "s|@ARAVIS_API_VERSION@|$api|" \
    -e "s|@ARAVIS_MAJOR_VERSION@|$v_major|" \
    -e "s|@ARAVIS_MINOR_VERSION@|$v_minor|" \
    -e "s|@ARAVIS_MICRO_VERSION@|$v_micro|" \
    "$src_src/arvversion.h.in" > "$gen_dir/arvversion.h"

for generated in arvapi.h arvfeatures.h arvparamsprivate.h arvversion.h; do
	[ -s "$gen_dir/$generated" ] || { echo "error: failed to generate $generated" >&2; exit 1; }
done
if grep -q '@ARV\|@ARAVIS' "$gen_dir"/*.h; then
	echo "error: unsubstituted placeholder left in a generated header" >&2
	grep -n '@ARV\|@ARAVIS' "$gen_dir"/*.h >&2
	exit 1
fi

# ---------------------------------------------------------------------------
# Enum types (gnome.mkenums_simple equivalent)
# ---------------------------------------------------------------------------
# Public header set: everything vendored except private headers. The split
# matches meson's library_headers vs library_private_headers, and it matters:
# sources include arvenumtypes.h or arvenumtypesprivate.h accordingly.
mapfile -t public_headers < <(cd "$src_src" && ls arv*.h | grep -v 'private\.h$' | sort)
mapfile -t private_headers < <(cd "$src_src" && ls *private.h | grep -v 'v4l2' | sort)

[ "${#public_headers[@]}" -gt 10 ]  || { echo "error: unexpected public header count" >&2; exit 1; }
[ "${#private_headers[@]}" -gt 5 ]  || { echo "error: unexpected private header count" >&2; exit 1; }

enum_header_fhead() { printf '#ifndef %s\n#define %s\n\n#include <arvapi.h>\n\nG_BEGIN_DECLS\n' "$1" "$1"; }
enum_header_ftail()  { printf '\nG_END_DECLS\n\n#endif\n'; }

generate_enum_types() {
	local header_out=$1 header_guard=$2 source_out=$3 source_include=$4
	shift 4
	local inputs=("$@")

	{
		enum_header_fhead "$header_guard"
		glib-mkenums \
			--fprod "\n/* enumerations from \"@filename@\" */\n" \
			--vhead "GType @enum_name@_get_type (void) G_GNUC_CONST;\n#define @ENUMPREFIX@_TYPE_@ENUMSHORT@ (@enum_name@_get_type ())\n" \
			"${inputs[@]}"
		enum_header_ftail
	} > "$header_out"

	glib-mkenums \
		--fhead "#include <arvapi.h>\n#include \"$source_include\"\n\n#define C_ENUM(v) ((gint) v)\n#define C_FLAGS(v) ((guint) v)\n" \
		--fprod "\n/* enumerations from \"@filename@\" */\n" \
		--vhead "static const G@Type@Value _@enum_name@_values[] = {\n" \
		--vprod "  { C_@TYPE@ (@VALUENAME@), \"@VALUENAME@\", \"@valuenick@\" },\n" \
		--vtail "  { 0, NULL, NULL }\n};\n\nGType\n@enum_name@_get_type (void)\n{\n  static gsize type_id = 0;\n\n  if (g_once_init_enter (&type_id)) {\n    GType id = g_@type@_register_static (\"@EnumName@\", _@enum_name@_values);\n    g_once_init_leave (&type_id, id);\n  }\n\n  return type_id;\n}\n\n" \
		"${inputs[@]}" > "$source_out"
}

( cd "$src_src" && generate_enum_types \
	"$gen_dir/arvenumtypes.h" ARVENUMTYPES_H \
	"$gen_dir/arvenumtypes.c" arvenumtypes.h \
	"${public_headers[@]}" )

( cd "$src_src" && generate_enum_types \
	"$gen_dir/arvenumtypesprivate.h" ARVENUMTYPESPRIVATE_H \
	"$gen_dir/arvenumtypesprivate.c" arvenumtypesprivate.h \
	"${private_headers[@]}" )

# Both files must contain declarations, and a known enum macro must exist in one
# of them - that is what catches a wrong public/private header split.
for enum_header in arvenumtypes.h arvenumtypesprivate.h; do
	grep -q '_get_type (void)' "$gen_dir/$enum_header" \
		|| { echo "error: $enum_header contains no enum declarations" >&2; exit 1; }
done
grep -q 'ARV_TYPE_GVCP_PACKET_TYPE' "$gen_dir/arvenumtypes.h" "$gen_dir/arvenumtypesprivate.h" \
	|| { echo "error: glib-mkenums did not produce ARV_TYPE_GVCP_PACKET_TYPE" >&2; exit 1; }

# ---------------------------------------------------------------------------
# GResources (gnome.compile_resources equivalent)
# ---------------------------------------------------------------------------
( cd "$src_src" && glib-compile-resources \
	--sourcedir=. \
	--c-name arvresources \
	--generate-header --header="$gen_dir/arvresources.h" \
	--generate-source --target="$gen_dir/arvresources.c" \
	arvresources.xml )

# ---------------------------------------------------------------------------
# Library sources
# ---------------------------------------------------------------------------
exclude_re='^(arvtool|arvtest|arvcameratest|arvfakegvcamera|arvv4l2[a-z0-9_]*)\.c$'
mapfile -t sources < <(sed -n "s/^[[:space:]]*'\([a-zA-Z0-9_]*\.c\)',*[[:space:]]*$/\1/p" "$src_meson" \
	| sort -u | grep -vE "$exclude_re")

[ "${#sources[@]}" -gt 60 ] || { echo "error: parsed only ${#sources[@]} sources from $src_meson" >&2; exit 1; }
for s in "${sources[@]}"; do
	[ -f "$src_src/$s" ] || { echo "error: source listed in meson.build is missing: $s" >&2; exit 1; }
done
for required in arvmisc.c arvuvdevice.c arvuvcp.c arvgvfakecamera.c; do
	printf '%s\n' "${sources[@]}" | grep -qx "$required" \
		|| { echo "error: expected library source not in list: $required" >&2; exit 1; }
done
echo "compiling ${#sources[@]} library sources"

compile() {
	local src=$1 out=$2
	gcc "${cflags[@]}" -c "$src" -o "$out"
}

objects=()
for s in "${sources[@]}"; do
	o="$obj_dir/${s%.c}.o"
	compile "$src_src/$s" "$o"
	objects+=("$o")
done
compile "$gen_dir/arvenumtypes.c" "$obj_dir/arvenumtypes.o"
compile "$gen_dir/arvenumtypesprivate.c" "$obj_dir/arvenumtypesprivate.o"
compile "$gen_dir/arvresources.c" "$obj_dir/arvresources.o"
objects+=("$obj_dir/arvenumtypes.o" "$obj_dir/arvenumtypesprivate.o" "$obj_dir/arvresources.o")

# ---------------------------------------------------------------------------
# Link the library
# ---------------------------------------------------------------------------
dll="$prefix/bin/libaravis-$api-0.dll"
implib="$prefix/lib/libaravis-$api.dll.a"

gcc -shared -o "$dll" "${objects[@]}" \
	-Wl,--out-implib,"$implib" \
	"${dep_libs[@]}" "${system_libs[@]}"

[ -f "$dll" ]    || { echo "error: $dll was not produced" >&2; exit 1; }
[ -f "$implib" ] || { echo "error: $implib was not produced" >&2; exit 1; }
echo "linked $dll"

# ---------------------------------------------------------------------------
# Tools (meson builds these unconditionally and installs them into bin/)
# ---------------------------------------------------------------------------
build_tool() {
	local name=$1 main=$2
	local exe="$prefix/bin/$name-$api.exe"
	gcc "${cflags[@]}" "$src_src/$main" -o "$exe" \
		-L"$prefix/lib" -laravis-"$api" "${dep_libs[@]}" "${system_libs[@]}"
	echo "linked $exe"
}

build_tool arv-tool          arvtool.c
build_tool arv-camera-test   arvcameratest.c
build_tool arv-fake-gv-camera arvfakegvcamera.c

# ---------------------------------------------------------------------------
# Headers and pkg-config metadata
# ---------------------------------------------------------------------------
for h in "${public_headers[@]}"; do
	cp -f "$src_src/$h" "$include_dir/"
done
cp -f "$gen_dir/arvapi.h" "$gen_dir/arvfeatures.h" "$gen_dir/arvversion.h" "$include_dir/"

cat > "$prefix/lib/pkgconfig/aravis-$api.pc" <<EOF
prefix=$prefix
exec_prefix=\${prefix}
libdir=\${exec_prefix}/lib
includedir=\${prefix}/include

Name: Aravis
Description: Camera control and image acquisition library
Version: $version
Requires: glib-2.0 gobject-2.0 gio-2.0
Requires.private: libxml-2.0
Libs: -L\${libdir} -laravis-$api
Cflags: -I\${includedir}/aravis-$api
EOF

# ---------------------------------------------------------------------------
# Runtime dependencies: rather than guessing glib's transitive DLL set, ask the
# dynamic loader which ones the freshly built binaries actually need.
# ---------------------------------------------------------------------------
if command -v ldd >/dev/null 2>&1; then
	deps=$( { ldd "$dll" "$prefix/bin/arv-tool-$api.exe" 2>/dev/null || true; } \
		| awk '{print $3}' \
		| grep -E '^/(mingw64|ucrt64|clang64)/' \
		| sort -u || true )
	for dep in $deps; do
		cp -f "$dep" "$prefix/bin/"
	done
	echo "copied $(wc -w <<<"${deps:- }") runtime DLLs"
else
	echo "warning: ldd not available, runtime DLLs were not collected" >&2
fi

# ---------------------------------------------------------------------------
# BUILDINFO.json
# ---------------------------------------------------------------------------
dep_versions() {
	local out=""
	for p in glib-2.0 libxml-2.0 libusb-1.0 zlib; do
		v=$(pkg-config --modversion "$p" 2>/dev/null || echo unknown)
		[ -n "$out" ] && out="$out,"
		out="$out\"$p\": \"$v\""
	done
	printf '%s' "$out"
}

cat > "$prefix/BUILDINFO.json" <<EOF
{
  "package": "aravis",
  "version": "$version",
  "api_version": "$api",
  "platform": "${PLATFORM_TAG:-mingw64}",
  "toolchain": "$(gcc -dumpmachine), gcc $(gcc -dumpversion)",
  "built_utc": "$(date -u +%Y-%m-%dT%H:%M:%SZ)",
  "source_commit": "${BUILD_SOURCE_COMMIT:-${GITHUB_SHA:-unknown}}",
  "source_ref": "${BUILD_SOURCE_REF:-${GITHUB_REF_NAME:-unknown}}",
  "subtree_tree": "$(git -C "$repo_root" rev-parse 'HEAD:aravis' 2>/dev/null || echo unknown)",
  "run_url": "${GITHUB_SERVER_URL:-}${GITHUB_REPOSITORY:+/$GITHUB_REPOSITORY}${GITHUB_RUN_ID:+/actions/runs/$GITHUB_RUN_ID}",
  "dependencies": { $(dep_versions) }
}
EOF

echo "--- installed ---"
find "$prefix" -maxdepth 2 -type f | sed "s|$prefix/||" | sort | head -n 40
echo "--- done: $version, api $api ---"
