# Build artifacts

Prebuilt dependencies produced by CI. Consumers download these so they
need neither meson nor a GLib build of their own.

| Package | Version | Platform | Toolchain | Built (UTC) |
|---|---|---|---|---|
| aravis | 0.9.3 | win-x64 | x86_64-w64-mingw32, gcc 16.2.0 | 09/15/2026 21:51:57 |

## How to consume

```sh
git fetch origin artifacts
git show origin/artifacts:manifest.json
git archive --remote=origin artifacts aravis/<version>/win-x64 | tar -x
```

Pin the commit of this branch, not the branch name, for a reproducible
build. Each BUILDINFO.json records the toolchain, the subtree tree hash
and the dependency versions the package was built from.
