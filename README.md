# Build artifacts

Prebuilt dependencies produced by CI. Consumers download these so they
need neither cmake nor a toolchain of their own.

| Package | Version | Flavour | Platform | Modules | Toolchain | Built (UTC) |
|---|---|---|---|---|---|---|
| aravis | 0.9.3 | - | win-x64 | - | x86_64-w64-mingw32, gcc 16.2.0 | 2026-09-16T00:33:27Z |
| opencv | 4.14.0 | - | wasm32 | core,imgproc | emscripten 6.0.9 (4e4223852a0835923411059a3929907d7df1232e), python3 3.12.3 | 2026-09-15T22:33:01Z |
| opencv | 4.14.0 | core-imgproc-simd-imgcodecs | wasm32 | core,imgproc | emscripten 6.0.9 (4e4223852a0835923411059a3929907d7df1232e), python3 3.12.3 | 2026-10-06T05:31:50Z |
| opencv | 4.14.0 | - | win-x64 | core | x86_64-w64-mingw32, gcc 16.2.0, cmake 4.4.3 | 2026-09-15T22:15:06Z |
| vcam | 0.1.0 | - | win-x64 | IMFActivate media source, IMFMediaSourceEx, RGB32 640x480; Aravis publisher (GigE Vision/USB3 Vision) over the shared-memory frame bus | x86_64-w64-mingw32, gcc 16.2.0 (see the probe run for exact versions) | 2026-09-16T02:18:30Z |

## How to consume

```sh
git fetch origin artifacts
git show origin/artifacts:manifest.json
# The table above lists every path, flavour by flavour:
git archive --remote=origin artifacts opencv/4.14.0/win-x64 | tar -x
git archive --remote=origin artifacts opencv/4.14.0/wasm32/core-imgproc-simd-imgcodecs | tar -x
```

A wasm package built without single-file ships `opencv.js` next to
`opencv_js.wasm` and the two must stay together; `BUILDINFO.json` in the
same directory records the modules, the flags, the emscripten version
and the wasm features that are actually present in the binary. A
pthreads flavour additionally needs `Cross-Origin-Opener-Policy:
same-origin` and `Cross-Origin-Embedder-Policy: require-corp` on the
host that serves it.

Pin the commit of this branch, not the branch name, for a reproducible
build.
