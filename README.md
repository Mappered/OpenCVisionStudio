# OpenCVisionStudio

VibeCoding playground for OpenCV + Aravis + MachineVision IDE

This branch (`workflows`) is the **build branch**. It holds the CI workflows,
the build recipes they run and the upstream subtrees they build from. It has no
application code: the IDE lives on `Develop`, and prebuilt dependencies are
published to `artifacts`.

---

## Why this branch exists

The application needs two prebuilt binaries it cannot reasonably ask a user to
build: OpenCV (native and wasm32) and Aravis. Both are large native builds whose
artifacts depend only on the upstream source and the toolchain, never on the
application code. Building them in CI and publishing the result to `artifacts`
means a fresh clone of `Develop` works with no cmake, no MSYS2 and no
emscripten, and it means the OpenCV in the browser is built from source instead
of being a pinned blob nobody can reproduce.

**Nothing here uses a GitHub Action.** emsdk is a `git clone` plus a shell
script, the checkout is `git`, publishing is `git`. Every step is a plain
command that runs identically on a laptop.

## Branch map

| Branch | Holds |
|---|---|
| `workflows` (**default**) | this build branch: workflows, recipes, subtrees |
| `Develop` | the application (the IDE) |
| `artifacts` | published packages — the only branch consumers download from |
| `external/OpenCV` | upstream OpenCV, as a subtree |
| `external/Aravis` | upstream Aravis, as a subtree |
| `page` | the GitHub Pages site |
| `Master` | released application code |

## Workflows

| Workflow | Recipe | Runs on | Produces |
|---|---|---|---|
| `build-opencv-wasm.yml` | `build/wasm/ci-opencv-wasm.sh` | ubuntu | `opencv/<version>/wasm32/<flavour>/` |
| `build-opencv.yml` | `build/mingw/ci-opencv.sh` | windows | `opencv/<version>/win-x64/`, then calls the wasm workflow |
| `build-aravis.yml` | `build/mingw/ci-aravis.sh` | windows | `aravis/<version>/win-x64/` |
| `probe-mf.yml` | `build/mingw/ci-mf-probe.sh` | windows | Media Foundation probe results |
| `create-release.yml` | — | ubuntu | a GitHub release |
| `update-subtrees.yml` | — | ubuntu | refreshes `external/*` from upstream |

### How a workflow finds its recipe

A workflow checks out **nothing** — that would be slow and would drag the whole
tree into a job that needs one shell script. Instead it fetches the single
recipe file from the ref the workflow itself was dispatched from:

```sh
git init --quiet .
git fetch --quiet --depth 1 origin "${{ github.ref_name }}"
recipe_commit=$(git rev-parse FETCH_HEAD)
git show "${recipe_commit}:build/wasm/ci-opencv-wasm.sh" > build/wasm/ci-opencv-wasm.sh
```

**Consequence:** a recipe must be committed to the branch it runs on. Dispatch
`build-opencv-wasm.yml` from `workflows` and it runs `workflows`'s recipe; the
same workflow file dispatched from a feature branch runs that branch's recipe,
which is how a recipe change is tested without touching the default branch.

**Second consequence:** a recipe has to be self-contained. Nothing else is
fetched, so a recipe that needs a helper has to inline it — which is why the wasm
recipe writes its verifier and smoke test out as heredocs.

### The build chain

`build-opencv.yml` (windows, the native package) ends by calling
`build-opencv-wasm.yml` as a reusable workflow, so one dispatch produces both the
native and the browser artifact from the same source commit:

```text
update-subtrees.yml ──► build-opencv.yml ──► build-opencv-wasm.yml
   (refresh source)        (win-x64)             (wasm32, needs the native job)
```

Two details make that chain safe:

* the native build's `modules` input is its **own** `BUILD_LIST` and is *not*
  forwarded — a wasm package without imgproc has no `cv.blur`. The wasm leg has
  its own `wasm_modules` (default `core,imgproc`).
* `wasm_simd` defaults to `true` on both paths, so a native build never publishes
  a non-SIMD browser package by accident. `imgcodecs`, `threads`, `single_file`
  and `emsdk_version` take their defaults from the reusable workflow.

Every call is a `workflow_call` rather than a push trigger because the jobs push
with `GITHUB_TOKEN`, and GitHub does not start runs for events that token causes.

## The source subtree

`external/OpenCV` and `external/Aravis` are subtrees, so upstream history stays
out of this repository while the exact source stays in it. Each build records
the subtree tree hash it used:

```sh
git rev-parse 'HEAD:opencv'    # -> BUILDINFO.json "subtree_tree"
```

To refresh from upstream, dispatch `update-subtrees.yml`. To build a *specific*
source, dispatch a build workflow with `source_ref` set to the branch or tag
holding it — a build does not have to use the subtree on this branch.

## Consuming a published package

Every package directory on `artifacts` contains the archive, `SHA256SUMS`, the
licence texts and a `BUILDINFO.json` naming the modules, the flags, the
toolchain and the wasm features actually present in the binary.

```sh
git fetch origin artifacts
git show origin/artifacts:manifest.json                       # every package
git archive --remote=origin artifacts opencv/4.14.0/wasm32/core-imgproc-simd-imgcodecs | tar -x
```

Pin the **commit** of `artifacts`, not the branch name, for a reproducible build.

---

## WASM performance profile

The wasm32 package is built for browser machine vision on 20 MP class images,
which is a memory- and bandwidth-bound workload rather than an arithmetic one.
The defaults reflect that: **SIMD on, image codecs on, pthreads off, one file
per module set, `-O3`, a 2 GB heap ceiling.** Each knob, what it buys, and what
it costs:

### SIMD — on by default

`build_js.py --simd` sets `-DCV_ENABLE_INTRINSICS=ON` and `-msimd128`, which
switches OpenCV's universal intrinsics onto WASM SIMD128
(`core/cv_cpu_dispatch.h` defines `CV_WASM_SIMD`, `intrin.hpp` selects
`intrin_wasm.hpp`, and `CV_SIMD128` becomes 1). Without the flag the same header
compiles intrinsics out entirely — it is not an optimisation level, it is a
different code path. The module that has been vendored so far was built without
it.

Cost: the module will refuse to instantiate on a browser without SIMD support
(all current browsers have it), and the wasm gets somewhat larger. Verified, not
assumed: the recipe reads the `target_features` custom section out of the wasm
and fails the build if `+simd128` is absent when SIMD was requested. Nothing in
this pipeline runs `wasm-opt`/binaryen afterwards, so that section is
authoritative.

### Image codecs — on by default

`--cmake_option -DWITH_JPEG=ON -DWITH_PNG=ON -DBUILD_opencv_imgcodecs=ON` builds
libjpeg-turbo, libpng and zlib into the module and binds `cv.imdecode` /
`cv.imencode` — two entry points upstream leaves out of the js whitelist, so the
recipe adds them to `opencv_js.config.py` at build time and stages the patched
list into the package, so the exact list used always ships with it.

This is the single biggest win available in the read path. Upstream's
`cv.imread` accepts only a canvas or an `HTMLImageElement` and goes through
`getImageData` + `matFromImageData`, i.e. it round-trips the pixels through the
DOM and paints two canvases; on a 20 MP frame that is hundreds of milliseconds
and several hundred MB of peak canvas memory. With `cv.imdecode` the encoded
bytes go straight into wasm and are decoded there.

Cost: the module grows by roughly 0.3–0.6 MB, and making use of it requires the
application to hand over encoded bytes rather than a canvas.

### pthreads — off by default

`build_js.py --threads` sets `-DWITH_PTHREADS_PF=ON` and
`-s USE_PTHREADS=1 -s PTHREAD_POOL_SIZE=4`, which puts `cv::parallel_for_` behind
the heavy kernels (`blur`, `resize`, `warpAffine`, the morphology filters).

It is off by default for two reasons, both host-side: the page has to be
cross-origin isolated (`Cross-Origin-Opener-Policy: same-origin` **and**
`Cross-Origin-Embedder-Policy: require-corp` on every document and subresource),
and the worker pool needs `SharedArrayBuffer`, so the heap is shared and cannot
grow the way it can without threads. A build that needs `crossOriginIsolated`
and is served without those headers fails to instantiate at all, so this is a
deliberate opt-in, never a default. `BUILDINFO.json` records the requirement in
`host_requirements`.

`threads=true` requires `single_file=false`: a pthread build emits a separate
worker script, which cannot be base64-embedded into one file. The recipe rejects
that combination up front rather than letting it fail late in the link step.

### Single file — off by default

Emscripten's `SINGLE_FILE=1` embeds the wasm in `opencv.js` as base64, so
`opencv.js` is one ~11 MB script instead of a ~3 MB script plus an ~8 MB wasm.
That was the right default when the only consumer was a static page with no
control over its headers, and it stays available (`single_file=true`) for that
case.

It is off by default here because base64 inflation is about a third of the wasm
size, the whole payload has to be parsed as one JavaScript string, and the
browser has to decompress and decode it before the module can start — all of
which shows up as load time on every visit and as one more copy of the module in
memory.

A package built this way ships `opencv.js` **and** `opencv_js.wasm`, and the two
must stay in the same directory: the loader requests the wasm relative to the
script. Serving it as `application/wasm` lets the browser stream-compile it
instead of falling back to `ArrayBuffer` instantiation, which the dev server
used by the application already does.

### Memory — 128 MB initial, 2 GB ceiling

OpenCV hard codes its memory settings on the js target's link line:

```
modules/js/CMakeLists.txt: -s TOTAL_MEMORY=128MB -s WASM_MEM_MAX=1GB -s ALLOW_MEMORY_GROWTH=1
```

Those live in `LINK_FLAGS`, which cmake places *after* anything a build script
can pass on the command line, so they cannot be overridden from `build_js.py` —
the recipe rewrites the line in the source tree instead, and verifies the
rewrite, so an upstream change to that line fails the build loudly instead of
being silently ignored.

The ceiling matters more than it sounds: each 8-bit plane of a 20 MP frame is
about 19.5 MB, `cv::blur` and `cv::dyn_threshold` allocate temporaries of the
same size, and **every heap growth copies the whole heap**. 1 GB was a real wall;
2 GB leaves room for a full multi-plane pipeline. The initial 128 MB is kept
because it only decides when the first growth happens.

### Optimisation — `-O3 -DNDEBUG`

`build_js.py` fixes `CMAKE_BUILD_TYPE=Release`, but the observable flags of the
shipped module showed `-O2` in places, so the recipe passes
`-DCMAKE_C_FLAGS_RELEASE="-O3 -DNDEBUG"` and the CXX equivalent explicitly. Both
words travel as one argument, so cmake sees a single `-D`.

Test and example targets are switched off (`-DBUILD_TESTS=OFF`
`-DBUILD_PERF_TESTS=OFF` `-DBUILD_EXAMPLES=OFF`) — they are not shipped and they
cost build time. `-DCMAKE_CXX_STANDARD=17` is required rather than cosmetic:
recent emscripten needs C++17 for Embind and OpenCV still defaults to C++11.

### What the build verifies before publishing

A build that merely succeeded is not a build that is what was ordered, so the
recipe refuses to package unless:

1. every artifact exists (`opencv.js`, plus `opencv_js.wasm` when not
   single-file);
2. the wasm really declares `+simd128` when SIMD was requested, read out of the
   `target_features` section of the actual binary (unwrapped from the base64
   payload for a single-file build);
3. `cv.imdecode` and `cv.imencode` are bound in the glue when image codecs were
   requested, and `cv.imread` is present either way;
4. the module loads in node and runs a real kernel (`cv.blur` over a 64×64
   matrix, checking a pixel), plus a 1×1 PNG decoded through `cv.imdecode` when
   the codecs are in — which proves the codec path end to end, bundled libpng
   included;
5. the exact whitelist config used is staged into the package.

## Building the wasm package

```sh
# defaults: SIMD + image codecs, core and imgproc, two files, emscripten 6.0.9
gh workflow run build-opencv-wasm.yml --ref workflows

# a profile that still fits in one file
gh workflow run build-opencv-wasm.yml --ref workflows \
  -f simd=false -f imgcodecs=false -f single_file=true

# pthreads, for a host that serves COOP/COEP
gh workflow run build-opencv-wasm.yml --ref workflows -f threads=true
```

| Input | Default | Meaning |
|---|---|---|
| `source_ref` | `external/OpenCV` | branch/tag carrying the `opencv/` subtree |
| `modules` | `core,imgproc` | `BUILD_LIST`; `js` and `imgcodecs` are appended |
| `simd` | `true` | `-msimd128` + `CV_ENABLE_INTRINSICS=ON` |
| `threads` | `false` | `-DWITH_PTHREADS_PF=ON`, needs COOP/COEP on the host |
| `single_file` | `false` | embed the wasm in `opencv.js` |
| `imgcodecs` | `true` | bundle the codecs, bind `cv.imdecode`/`cv.imencode` |
| `emsdk_version` | `6.0.9` | the emscripten that last built this source |
| `publish` | `true` | push the package to `artifacts` |

Each flavour is published to its own path — `opencv/<version>/wasm32/<flavour>/`
— because two dispatches with different flags are both legitimate. The same
version can therefore be published many times without one package overwriting
another. A hosted runner needs up to a few hours for a full build, so the job
allows 330 minutes. It refreshes `manifest.json` and `README.md` on `artifacts`
from every package present, so one package's build never drops another's entry.

### Vendoring a published package into the application

```sh
gh api -H "Accept: application/vnd.github.raw" \
  'repos/Mappered/OpenCVisionStudio/contents/manifest.json?ref=artifacts' > manifest.json
# pick a flavour, then fetch its directory
git fetch origin artifacts
git checkout origin/artifacts -- opencv/4.14.0/wasm32/core-imgproc-simd-imgcodecs
```

Copy `opencv.js` and, for a non-single-file build, `opencv_js.wasm` into
`vendor/` on `Develop` — **both**, unchanged, side by side. Then confirm what
actually arrived before trusting it:

```sh
node -e "const s=require('fs').readFileSync('vendor/opencv.js','utf8');
         console.log('simd:', /+simd128/.test(s), 'imdecode:', /\bimdecode\b/.test(s))"
```

and compare the wasm's `target_features` with the `wasm_features` field of the
`BUILDINFO.json` that came with it. The load order in `index.html` is
`vendor/opencv.js` before anything that uses `cv`.
