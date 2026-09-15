# Build artifacts

Prebuilt dependencies produced by CI. Consumers download these so they
need neither cmake nor a toolchain of their own.

| Package | Version | Platform | Modules | Toolchain | Built (UTC) |
|---|---|---|---|---|---|
| aravis | 0.9.3 | win-x64 |  | x86_64-w64-mingw32, gcc 16.2.0 | 09/15/2026 21:51:57 |
| opencv | 4.14.0 | win-x64 | core | x86_64-w64-mingw32, gcc 16.2.0, cmake 4.4.3 | 09/15/2026 22:15:06 |

## How to consume

```sh
git fetch origin artifacts
git show origin/artifacts:manifest.json
git archive --remote=origin artifacts opencv/4.14.0/win-x64 | tar -x
```

Pin the commit of this branch, not the branch name, for a reproducible
build. Each BUILDINFO.json records the toolchain, the subtree tree hash
and the exact module list the package was built from.
