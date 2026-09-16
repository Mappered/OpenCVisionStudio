# Build artifacts

Prebuilt dependencies produced by CI. Consumers download these so they
need neither meson nor a GLib build of their own.

| Package | Version | Platform | Modules | Toolchain | Built (UTC) |
|---|---|---|---|---|---|
| aravis | 0.9.3 | win-x64 | - | x86_64-w64-mingw32, gcc 16.2.0 | 09/16/2026 00:33:27 |
| opencv | 4.14.0 | wasm32 | core,imgproc | emscripten 6.0.9 (4e4223852a0835923411059a3929907d7df1232e), python3 3.12.3 | 09/15/2026 22:33:01 |
| opencv | 4.14.0 | win-x64 | core | x86_64-w64-mingw32, gcc 16.2.0, cmake 4.4.3 | 09/15/2026 22:15:06 |
| vcam | 0.1.0 | win-x64 | IMFActivate media source, IMFMediaSourceEx, RGB32 640x480 | x86_64-w64-mingw32, gcc 16.2.0 (see the probe run for exact versions) | 09/16/2026 00:29:26 |

## How to consume

```sh
git fetch origin artifacts
git show origin/artifacts:manifest.json
git archive --remote=origin artifacts aravis/<version>/win-x64 | tar -x
```

Pin the commit of this branch, not the branch name, for a reproducible
build. Each BUILDINFO.json records the toolchain, the subtree tree hash
and the dependency versions the package was built from.
