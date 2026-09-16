# OpenCVisionStudio — Roadmap

An HDevelop-style IDE for a machine-vision scripting language. The language is
HDevelop's: HALCON operator names, iconic/control parameter model, tuple
semantics. The execution layer is OpenCV. Image acquisition is Aravis.

## Locked decisions

| Decision | Choice |
|---|---|
| Application shell | Electron (main / preload / renderer) |
| Acquisition | **Aravis** — mandatory; both transports required: GigE Vision (GVSP) and USB3 Vision (U3V) over libusb |
| Webcam source | **Media Foundation** for UVC cameras, exposed under HALCON's `'DirectShow'` interface name so programs written for it run unmodified. Not DirectShow itself: deprecated, and its COM plumbing buys nothing here |
| Browser target | OpenCV WASM from the `wasm32` artifact. **Aravis is never built for wasm** — it is an I/O library, and wasm has no sockets, no libusb and no GenTL |
| Toolchain | **MinGW-w64 (gcc) end to end.** Aravis is built by `build/mingw/build-aravis.sh` — no meson, no cmake. The N-API addon must therefore be MinGW-built too |
| Windows camera driver | Zadig + **libusb-win32** (`libusb0.sys`). **libusbK is rejected** — it produced bugchecks on team hardware. GenTL consumer kept as fallback |
| Vision execution | OpenCV behind a backend interface (`ref` → `opencvjs` → `native`) |
| Operator metadata | One registry, single source of truth |
| Language core | DOM-free, Electron-free, testable with `node --test` |

Open: (a) do we also *emit* OpenCV C++/Python source, or only execute through
OpenCV? Recommendation is both — the emitter is nearly free once the registry
exists. (b) How faithful must numerics and HALCON error codes be?
Recommendation is strict on types/domains/error codes, approximate on float
rounding.

## Process topology

```
Electron main
  ├── renderer/           UI only: editor, windows, canvas, no Node access
  ├── utilityProcess: vision   interpreter + variables + OpenCV backend
  └── utilityProcess: camera   Aravis N-API addon, frame pump
```

- Interpreter emits an event stream (`op.enter`, `op.exit`, `var.set`, `error`)
  consumed by the renderer. No DOM knowledge inside the language core.
- Frames cross process boundaries as transferable `ArrayBuffer`s. Never JSON.
- Stop = terminate the worker. A 20 MP `threshold` must not freeze the UI.
- A CLI entry point runs a `.hdev` program headless, so the same core serves
  batch inspection and CI.

## Value model (build this early, retrofitting is brutal)

- `Image { data, depth, domain }` — byte/int2/uint2/real, plus the domain mask
  that later operators must respect.
- `Region { runLengths }` canonical, with derived mask and contour views.
  Run-length makes set algebra, area and centroid exact; masks are materialized
  only at the OpenCV boundary.
- `XLD { contour, attribs }` — no OpenCV equivalent, hand-implemented.
- Tuples with HALCON typing and broadcast rules; integer vs real division;
  empty-tuple propagation.
- Row/Column is y/x. The swap happens at the backend boundary and nowhere else.

## Grabber backends

One interface, four implementations. The language only ever sees
`open_framegrabber`, `grab_image`, `set_framegrabber_param` and friends; the
interface string in the first argument picks the backend, exactly as HALCON
does it.

| Backend | Transport | Where it runs | Notes |
|---|---|---|---|
| Aravis | GigE Vision, USB3 Vision | native utility process | the product path; both transports required |
| Media Foundation | UVC webcams | native utility process | HALCON-compatible name `'DirectShow'`, modern API underneath |
| File | image sequences on disk | anywhere, including the browser | pure JS; the demo and CI path with no hardware |
| WebSocket bridge | a camera owned by another process | browser | later, if the page needs live frames |

Capability matrix, not a footnote: an operator's lowering is per backend.
`read_image` is the first example — natively it goes through imgcodecs, in the
browser it cannot, because the opencv.js whitelist exposes no imgcodecs module
and images arrive as canvas/`ImageData`. Every registry entry therefore carries
a capability flag per backend, and the emitter must refuse rather than
mis-lower.

## Windows virtual camera (Aravis to webcam)

Goal: expose a libusb-win32 / Aravis camera to other applications as a normal
camera device, using the Windows 11 user-mode virtual camera API rather than a
kernel driver. Findings below are measured, not assumed - each one came from a
CI run of `build/mingw/mf-vcam-dyn.c` (see the Probe Media Foundation workflow).

| Question | Answer |
|---|---|
| Does MinGW-w64 ship `mfvirtualcamera.h`? | **No.** MSYS2's headers (14.0.0) predate the API, so it cannot be linked against |
| Does MinGW build Media Foundation at all? | **Yes** - headers and import libraries all present, C/COM path works |
| Where is the export, if not in mfplat? | **`mfsensorgroup.dll`**. `mfplat`, `mfcore`, `mf`, `mfreadwrite`, `mfmediaengine` and `windows.media` all say no. Documentation claiming mfplat is wrong |
| Can we reach it without headers? | **Yes** - `LoadLibraryW` + `GetProcAddress`, with our own declarations |
| Does the declaration match the ABI? | **Yes** - verified by calling it. The real prototype has **8** parameters: `(type, lifetime, access, friendlyName, sourceId, const GUID* categories, ULONG categoryCount, IMFVirtualCamera** out)`. A 7-parameter guess with an attributes object faulted, which is how this was caught |
| Is package identity required? | **Not for `Lifetime_Session` + `Access_CurrentUser`** - creation succeeded in an unpackaged CI process, contrary to the assumption that a sparse MSIX is a hard prerequisite |
| Capability detection | `MFIsVirtualCameraTypeSupported(SoftwareCameraSource)` returns S_OK with supported=TRUE |
| `IMFVirtualCamera` IID | `1C08A864-EF6C-4C75-AF59-5F2D68DA9563` |
| Method order | `AddDeviceSourceInfo`, `AddProperty`, `AddRegistryEntry`, `Start`, `Stop`, `Remove`, `GetMediaSource`, `SendCameraProperty`, `CreateSyncEvent`, `CreateSyncSemaphore`, `Shutdown` |

The media source that makes applications see a camera, as measured:

| Question | Answer |
|---|---|
| What does `sourceId` name? | A **CLSID string**. Media Foundation activates it in-process even for `Lifetime_Session`/`Access_CurrentUser`, and the object must answer **`IMFActivate`**; `ActivateObject` then hands out the source, which must also answer **`IMFMediaSourceEx`** `{3C9B2EB9-86D5-4514-A394-F56664F9F0D8}` |
| With nothing registered under that CLSID? | `Start` fails with `REGDB_E_CLASSNOTREG` - that is how "the CLSID is what `Start` needs" was established |
| A stream without `MF_DEVICESTREAM_STREAM_CATEGORY` = `PINNAME_VIDEO_CAPTURE`? | the frame server refuses the source, before it ever calls `Start` on it |
| MinGW headers for any of this? | no `mfvirtualcamera.h`, no `MF_DEVICESTREAM_*` keys, and no `IMFGetService`/`IKsControl` at all - all declared by hand |
| Which interfaces does the pipeline ask a source for? | `IMFActivate`, `IMFMediaSourceEx`, `IMFMediaSource`, then by name `IMFGetService` `{FA993888-4383-415A-A930-DD472A8CF6F7}` (answer `MF_E_UNSUPPORTED_SERVICE`) and `IKsControl` `{28F54685-06FD-11D2-B27A-00A0C9223196}` (answer `ERROR_SET_NOT_FOUND`). It also asks for `IMFCollection`, which the working reference does not implement either |
| Why did the media source crash the frame server? | **our vtable was two slots too wide.**  `QueueEventParamVar`/`QueueEventParamUnk` belong to `IMFMediaEventQueue`, not to `IMFMediaEventGenerator`; with them in the generator every `IMFMediaSource` method sat two slots late, so the pipeline's `GetSourceAttributes` (slot 10) landed in `Pause`. Returning `S_OK` there without filling the caller's out-parameters is what faulted inside `FrameServerMonitorClient.dll`, and returning anything else is why `Start` echoed `Pause`'s result. MinGW's own headers - four generator methods - were right all along |
| Where do frames come from? | a shared-memory frame bus (double-buffered, sequence-flipped, named event), so the process that owns the camera and the media source inside the frame server never share a library, only memory |

What CI proves now: registration, creation, the whole interface contract above
(the pipeline walks it and stops only on policy), plus the publisher half end to
end - a continuous Aravis acquisition at ~25 fps from Aravis' own fake GigE
Vision camera, read back by a second process at the geometry the media source
advertises (a 512x512 sensor arrives letterboxed in 640x480 RGB32 rather than
sheared).

The media source's own half is proven too, and without the frame server: a
harness (`vcam_source_drive.c`, shipped as `vcam-sourcedrive.exe`) creates the
source by CLSID, asks for its presentation descriptor, starts it, requests
samples and reads them back. Publishing a frame with a mark no generator would
produce, the sample comes out byte-exact (1228800 bytes, `first_pixel=132233ff`);
and with nothing of its own on the bus while Aravis is streaming, the sample is
the camera's own letterboxed frame. So "Aravis frames become Media Foundation
samples of the advertised type" is measured, not assumed - what the frame server
still has to agree to is only that this source is a camera.

What is left is one elevated run on a Windows 11 client, and it is an access
question rather than a code question. The frame server CoCreates the media
source *inside its own service process*, which cannot read HKCU, so the class
must be registered machine-wide; without that `IMFVirtualCamera::Start` returns
`ERROR_PATH_NOT_FOUND` (0x80070003), the signature measured here. On a Windows
**Server** runner the same call returns `E_ACCESSDENIED` because the runner's
camera privacy policy denies access to unpublished apps. Both are named by the
reader now, so its output says which one is in the way. The kit is on the
`artifacts` branch at `vcam/0.1.0/win-x64/`: `run-verify.cmd` registers,
creates, enumerates and reads a frame in one elevated click, `run-live.cmd`
does the same for a live publisher, `run-stop.cmd` undoes it.

## Milestones

| # | Deliverable | Proof |
|---|---|---|
| M0 | Baseline committed; `renderer/`, `main/`, `preload.js`, `package.json`; `node --test` harness, no runtime deps | `npm start` opens the existing IDE in Electron; tests pass headless |
| M1 | Language core: assignment, expressions, tuples, `if/for/while/break/continue/try-catch`, procedures, `return/stop/exit` | a ~200-line `.hdev` program with procedures runs; hand-checked variable state |
| M2 | Operator registry + HALCON-style diagnostics (`H_ERR_*` with operator and parameter index) | registry alone drives Operator Window tabs and completions; `OPINFO` deleted |
| M3 | Value model: region algebra, domain semantics, tuples, connectivity | union/intersection/difference/complement/area/centroid match hand-computed values, incl. holes and diagonal-touching pixels |
| M4 | ~40 operators via the reference backend (blob pipeline) | the current printer-chip demo reproduces today's hardcoded output exactly — this is the regression anchor |
| M5 | IDE wiring: run/step/run-to-cursor/stop, live variable window, graphics from Region/Image, error window with codes, per-op timings | stepping keeps all four windows consistent; Stop interrupts mid-op |
| M6 | **Aravis feasibility spike** — long lead time, start early; covers both transports (GV and U3V/libusb) | fake GigE camera streams with no hardware; a real U3V camera enumerates and streams; protocol dispatch proven |
| M7 | Aravis addon + HALCON framegrabber operators | `open_framegrabber`/`grab_image`/`set_framegrabber_param` against real GigE *and* USB3 cameras |
| M8 | OpenCV.js backend in the vision process, custom build from the `external/OpenCV` subtree (`imgproc`, `features2d`, `calib3d`, `dnn`) | backend swap is one line; results match `ref` within tolerance |
| M9 | Emitter: IR → OpenCV C++ and Python, step-synced code window | emitted C++ compiles and reproduces corpus results |
| M10 | Real `.hdev` text open/save + unsupported-operator report ranked by frequency | importing a real program lists the next operators to implement, in order |
| M11 | Media Foundation webcam backend. Step 0 is a CI probe: prove MinGW's MF headers and import libraries actually build and link something that enumerates devices | enumeration and pixel-format conversion covered in CI; frame capture verified on a machine with a webcam, since runners have none |
| M12 | Aravis to webcam: user-mode virtual camera. API reached by dynamic resolution (headers predate it), media source implemented and published | CI-proven: Aravis to frame bus to a second process, live and continuously, at 640x480 RGB32; and the frame server walking the whole media-source contract without a fault. Outstanding: one elevated run on a Windows 11 client to see the camera appear - blocked on machine-wide registration, not on code. Kit: `artifacts:vcam/0.1.0/win-x64/` |

## Aravis integration

Vendored version: 0.9.3, API `aravis-0.10`, meson build. Dependencies:
`glib ≥ 2.58`, `gobject`, `gio`, `libxml2`, `zlib`, `gmodule`; on Windows also
`ws2_32` and `iphlpapi`.

Both transports are in-tree and required:

- GigE Vision — `arvgvcp` (control), `arvgvsp` (stream), `arvgvdevice`,
  `arvgvinterface`, `arvgvstream`.
- USB3 Vision — `arvuvcp` (control), `arvuvsp` (stream), `arvuvdevice`,
  `arvuvinterface`, `arvuvstream`. This is the libusb path.

**`libusb-1.0` is a hard dependency**, not an optional extra:

```
usb_dep = dependency ('libusb-1.0', required: get_option ('usb'))   # option('usb', value: 'auto')
```

The build does not use meson at all. `build/mingw/build-aravis.sh` is a hand
translation of `aravis/meson.build` and is the source of truth for how the
vendored tree is compiled:

- configure files: `arvapi.h`, `arvfeatures.h` (USB on; V4L2, event, packet
  socket, fast heartbeat off), `arvparamsprivate.h`
  (`ARV_GV_STREAM_NUM_BUFFERS` 16), `arvversion.h`
- `glib-mkenums` twice — public headers into `arvenumtypes.{h,c}`, `*private.h`
  into `arvenumtypesprivate.{h,c}`. This split is load bearing: library sources
  call generated macros such as `ARV_TYPE_GVCP_PACKET_TYPE`, which only exist if
  the same header sets are scanned
- `glib-compile-resources` for `arvresources.xml` — the fake camera XML the
  library looks up at `/org/aravis/arv-fake-camera.xml`
- source list parsed out of `src/meson.build`, minus the four files that define
  `main()` (the tools) and the v4l2 backend, so upstream additions are picked up
  automatically instead of being silently dropped
- links `libaravis-0.10-0.dll` plus `libaravis-0.10.dll.a` and the tools
  (`arv-tool`, `arv-camera-test`, `arv-fake-gv-camera`), then copies the runtime
  DLL closure found by `ldd` so the package is self-contained

Anything that changes in upstream's meson files has to be mirrored there, so the
script fails loudly (unsubstituted placeholder, missing source, empty enum
header, missing expected file) rather than producing a subtly wrong library.
`-Dusb=enabled` is baked in as `ARAVIS_HAS_USB 1`; a build without libusb is not
possible. Keep `ARV_GV_STREAM_NUM_BUFFERS` at 16 or higher for packet-loss
headroom.

Verified in-tree API surface:

```c
arv_update_device_list / arv_get_n_devices / arv_get_device_id
arv_get_device_protocol / arv_get_interface_id    // 'GigEVision' | 'USB3Vision' | 'GenTL' | 'Fake'
arv_camera_is_gv_device / arv_camera_is_uv_device
arv_camera_new
arv_camera_create_stream
arv_stream_start_acquisition / arv_stream_stop_acquisition
arv_stream_timeout_pop_buffer (stream, timeout)   // present — poll, don't signal
arv_buffer_get_image_data
arv_buffer_get_n_parts / get_part_data / get_part_pixel_format  // multipart and chunk data
arv_buffer_get_frame_id / get_status / get_system_timestamp
arv_stream_get_statistics / arv_stream_get_info_*_by_name        // evidence for soak tests
arv_device_set_*_feature_value                    // generic GenICam feature access
```

Design rules:

- **Poll, don't signal.** Use `arv_stream_timeout_pop_buffer` on a dedicated
  worker thread. Signal callbacks fire on a GLib thread, and foreign threads may
  not touch the V8 heap without `napi_threadsafe_function`; polling avoids both
  the GLib main loop and that hazard entirely.
- **N-API, not NAN.** `node-addon-api` binaries are ABI-stable across Node and
  Electron versions, so no per-Electron `@electron/rebuild` dance.
- **Frame path:** Aravis buffer → one copy into an owned `Mat` → transfer the
  `ArrayBuffer` to the vision process. Zero JSON, zero base64.
- **GError discipline:** every `GError**` out-param needs `g_error_free`, mapped
  to a HALCON-style error with the failing operator and parameter index.
- **GenICam features map cleanly:** `arv_device_set_*_feature_value` by feature
  name is the same abstraction as HALCON's `set_framegrabber_param`.
- **Transport-agnostic above the addon.** `arv_get_device_protocol` selects the
  HALCON interface string and nothing else branches on transport; the operator
  layer sees one `AcqHandle`.
- **Hotplug: poll, don't listen.** libusb-1.0's libusb0 path does not deliver
  dependable hotplug notifications on Windows, so the device picker re-enumerates
  (`arv_update_device_list`) on a ~2 s timer instead of subscribing to events.
- **Linux permissions:** ship `src/aravis.rules` (udev) so U3V devices are
  reachable without root.
- **Test without hardware:** the tree builds `arv-fake-gv-camera-0.10`, plus
  `arv-tool-0.10` and `arv-camera-test-0.10` for diagnosis. This covers GV only
  — see Risks.

### Driver stability

Established empirically on the team's hardware: binding cameras with **libusbK**
produced bugchecks under load; **libusb-win32** has been stable in the identical
role. The kernel driver is therefore treated as part of the product's support
matrix, not an interchangeable implementation detail. Never "upgrade" the driver
without repeating the soak protocol below.

Record every validated configuration in `docs/support-matrix.md`:

| Field | Why it matters |
|---|---|
| Camera model + firmware | U3V protocol quirks are firmware-versioned |
| Windows build | driver stacks change between OS releases |
| Driver + version (`libusb0.sys`) | the variable that produced a bugcheck |
| libusb version (`libusb_get_version`) | the libusb0 path is libusb's oldest Windows backend |
| Zadig version | reproducibility of the binding procedure |
| Aravis version + build flags | `-Dusb=enabled`, buffer counts, packet size |

If a bugcheck recurs, keep the minidump from `C:\Windows\Minidump` and analyse it
in WinDbg before attributing blame — the faulting module distinguishes a libusb0
fault from Aravis' transfer pattern from another filter in the device stack.
Since Aravis only calls libusb, a crash can originate in our usage pattern too,
and the dump is the only artifact that settles it.

### Soak and stress criteria

"One frame streamed" proves nothing about a kernel-mode data path. M6 and M7 are
accepted only after, at production resolution and frame rate:

1. multi-hour continuous acquisition with dropped-frame count inside budget,
2. N start/stop acquisition cycles,
3. device unplug/replug, with the polling enumerator recovering on its own,
4. a system sleep/resume cycle.

Use the stream statistics (`arv_stream_get_statistics`,
`arv_stream_get_info_*_by_name`) and per-buffer `frame_id` gaps as the evidence —
they also feed the IDE's acquisition-rate readout, so the same plumbing serves
both purposes.

Interface string mapping for the acquisition ops:

| HALCON | Aravis |
|---|---|
| `open_framegrabber ('GigEVision2', …, 'Device', Device)` | `arv_camera_new (device_id)` |
| `open_framegrabber ('USB3Vision', …, 'Device', Device)` | `arv_camera_new (device_id)`, U3V interface |
| `open_framegrabber ('GenICamTL', …, 'Device', Path.cti)` | Aravis GenTL consumer (`src/gentl/`) |
| `grab_image` / `grab_image_async` | start stream, `timeout_pop_buffer` |
| `set_framegrabber_param (…, 'Gain', v)` | `arv_device_set_*_feature_value` |
| `close_framegrabber` | stop acquisition, unref stream, unref camera |

## Risks

1. **Windows GigE bandwidth.** The packet-socket path is Linux-only, so on
   Windows Aravis uses ordinary UDP sockets; at high resolution/fps you need the
   vendor's GigE filter driver and jumbo frames, or you lose packets. Test a real
   camera at production resolution and frame rate in the first week — this is the
   single largest schedule risk and it is cheap to falsify early.
2. **Windows USB3 Vision driver binding — decided: Zadig + libusb-win32.** Cameras
   are already bound to `libusb0.sys` with Zadig, so native U3V is the primary
   Windows path and the GenTL consumer is the fallback for machines that must keep
   the vendor driver installed. Remaining operational items:
   (a) libusb-1.0 reaches `libusb0.sys` devices through its dedicated libusb0
   path, the oldest of its three Windows backends — pin the libusb version and
   verify sustained bulk throughput at production resolution rather than assuming
   it; (b) hotplug is unreliable on that path, hence polling (see Design rules);
   (c) while a camera is bound to libusb the vendor SDK stops seeing it, and
   HALCON's own USB3Vision interface likely needs its own driver binding too —
   verify before planning A/B comparisons against real HALCON on one machine;
   (d) Zadig is fine for internal use, but shipping to customers wants a signed
   INF plus `pnputil`/DevCon in the installer rather than "go run this external
   tool"; (e) **do not ship libusbK** — it bugchecked on team hardware while
   libusb-win32 was stable in the identical role, so the driver choice is
   empirical and must be re-validated through the soak protocol, not revisited
   casually.
3. **No fake USB3 Vision camera.** The tree builds a fake GigE camera
   (`arv-fake-gv-camera-0.10`), but the generic fake device is not registered as a
   U3V device, so the libusb path can only be exercised on real hardware. Budget a
   physical camera for QA or accept manual-only coverage for that transport.
4. **Maintaining a build that upstream does not have.** MinGW compiling the
   vendored tree without meson or cmake means `build/mingw/build-aravis.sh` has to
   track `aravis/meson.build` across subtree updates: new configure files, new
   mkenums header sets, new sources. The script parses the source list rather
   than hard-coding it and asserts on every generated artifact, so drift fails
   the build instead of shipping a wrong library — but a subtree update is not
   done until that workflow is green. GLib and friends still come from MSYS2
   pacman packages; only Aravis itself is compiled here.
5. **USB3 throughput through libusb.** The Windows libusb backend is not a
   high-performance USB stack; confirm sustained frame rate at production
   resolution before assuming U3V on Windows is viable at full speed.
6. **First real npm dependencies.** Electron and electron-builder need network
   access, unlike today's vendored `tools/node`.
7. **Operators with no OpenCV equivalent.** `find_shape_model` is a project, not
   a binding; likewise the `measure_*` metrology family, `calib_*`, and OCR.
   Decide explicitly whether to implement, approximate, or refuse them — and
   make the refusal a clear, named error, not a silent no-op.
8. **Trademark and docs.** Reimplementing HALCON's names and signatures is a
   normal compatibility surface. Copying MVTec's help text into the UI is not.
