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

Three things the server will not accept, all measured:

- **RGB32 is not a capture format.** The working reference advertises only
  NV12, YUY2 and MJPG, and the frame server synthesises the rest from whatever
  the source declares. The source now advertises **YUY2** first and converts the
  bus's RGB32 into it (RGB32 stays as a second type, because it is the bus's own
  format and the harness reads it). The harness reads 614400 bytes and the live
  camera's letterbox converts to Y=16, U=V=128, which is black.
- **The activator must not announce things.** A source type and an
  associated-cameras answer were being set on the activator when a crash was
  blamed on a missing attribute; that crash turned out to be our vtable. With
  them gone the pipeline asks for the key, is told `MF_E_ATTRIBUTENOTFOUND`, and
  carries on - which is what the reference does.
- **Leftover cameras are not the problem, either.** `MFCreateVirtualCamera`
  re-opens a camera with the same parameters, so the reader now calls `Remove`
  first and creates again; that was checked on the runner and changed nothing.

The pipeline's own probes are now named rather than guessed at, because the
source logs every one: as it brings a camera up it asks for **IMFMediaStream2**
and **IKsControl** on the source, for `GetService(GUID_NULL, riid)` with two
interfaces that appear in no public header, and for
`PROPSETID_VIDCAP_CAMERACONTROL` / `KSPROPERTY_CAMERACONTROL_PRIVACY` as a GET.
The stream now answers IMFMediaStream2 and IKsControl as well (the reference
does), and the privacy property answers **FALSE** with four bytes instead of
"no such property" - a source whose privacy state cannot be read is not the same
as a source with no privacy switch. On the Server runner `Start` still returns
MF_E_SHUTDOWN and the frame server service still never loads the media source, so
none of those was the last piece there.

Conclusion after all of it: the source now matches the working reference on
every axis this project can observe - formats, attributes, interfaces, state
transitions, property answers - and the data path is proven on a real Windows 11
client, un-elevated. What has never run is the one combination that needs the
machine owner: **Windows 11 client + elevated**, where the class can be
registered machine-wide and the frame server service can be opened at all.

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
   **Decided for metrology (browser build): implemented** in `js/metrology.js`
   — model operators (`create_metrology_model`, the
   `add_metrology_object_*_measure` family, `set/get_metrology_model_param`,
   `set/get/reset_metrology_object_param`, `set_metrology_model_image_size`,
   `apply_metrology_model`,
   `get_metrology_object_result/result_contour/model_contour/measures/indices/num_instances`,
   `clear/copy`), hand-built 1-D measure + robust fitting on raw gray
   arrays, and an HDevelop-style graphics-window overlay (measure regions,
   edge points, fitted contours, per-instance score; toolbar toggle). See
   "Metrology" below. Not implemented there: the fuzzy-measure family
   (`add_metrology_object_fuzzy_measure`,
   `set/get/reset_metrology_object_fuzzy_param`) and
   `read/write_metrology_model`. `calib_*` and OCR remain unimplemented.
   **Partly closed:** an unknown operator no longer fails silently — the
   first use of a name that is neither an implemented operator nor a
   control-flow keyword is reported in the History window
   (`<op>: not implemented in this build — line skipped.`), so an
   unimplemented HALCON operator is visible instead of being invisible.
   Turning that into a hard stop (HDevelop raises an error) is still open.

## Program files (.odev / .hdev)

File → Open Program…, Save Program and Save Program As… read and write the
whole program — every procedure in one text file (`js/app.js`).

- **`.odev` is the default.** Save writes a `.odev` name unless the name
  already carries an extension; the file picker offers `.hdev` as the
  alternative. A program is stored in the project's plain-text format: each
  procedure is introduced by a `* procedure: <name>` header line — the same
  format the dev server's `program.ovs` uses, so a saved file can be dropped
  in as the working file of `tools/serve.js` and edited externally.
- **`.hdev` files are read.** `procedure <name> (...)` … `endprocedure`
  blocks become procedures, the code before the first `procedure` line
  becomes `main`, and a file without any procedure header (a bare operator
  list) loads as `main`.
- **Opening** rebuilds the procedure list from the file (the procedure combo
  in the Program Window follows it), shows the file name in the caption and
  title bar, remembers it for the next Save, and drops the variables,
  graphics contents and execution state of the old program. With the dev
  server running, the opened program also becomes the working program
  (`program.ovs`).
- **New Program** clears the program to a single empty `main` procedure after
  a confirmation.
- **Saving writes your program, not the sample.** Untouched demo procedures
  (the IDE's built-in `detect_features`, `acquire_demo`, `metrology_demo`,
  `display_demo` text) are left out of a saved file; `main` is always written,
  and a procedure appears as soon as its text differs from the built-in sample
  (or was opened from a file). The log message reports how many demo procedures
  were dropped. The dev server's `program.ovs` still receives the complete
  program, so external-editor sync keeps working unchanged.
- **Entering an operator** writes HDevelop's defaults for the optional
  parameters and leaves the required ones as placeholders, with the caret (or
  Monaco's first Tab stop) on the first of them. The Parameters tab of the
  Operator Window shows those defaults, dimmed, for every argument the program
  line does not pass (`opInsertEntries` / `opArgText` in `js/app.js`).

## Program editor (active line, breakpoints)

Both editors (the classic textarea overlay and Monaco) draw the same two
markers, and both keep them correct while the text changes.

- **Active line.** The green ▶ marker is the program counter: F5/F6 move it,
  Stop leaves it where it stopped. Clicking a line only moves the caret
  (`state.cursor`), never the program counter.
- **Editing above the marker.** Because the counter is a line number, an edit
  above it would leave it pointing at a renumbered line. `edEditAnchor()`
  diffs the old and new text and, when the first changed line is above the
  counter, moves the counter up to that line. Edits at or below it leave the
  counter alone.
- **Breakpoints.** Clicking a gutter number (or Monaco's glyph margin) toggles
  a breakpoint for that procedure/line; the dot is drawn in the gutter
  (`.bp-dot`) and in the glyph margin (`.mbp`).

## Stopping on an invalid line

A processor that skips a line it cannot run and then continues with stale data
is worse than one that stops, so the engine refuses to walk past a line it
cannot execute. Three things can go wrong, and all three end the run the same
way: the line is marked, execution stops and a message box explains why.

| Class | Example | Reported reason |
| --- | --- | --- |
| Malformed line | `threshold (Image, Region, 128, 255` | `no closing ')'` |
| Unknown operator | `totally_unknown_op (A, B)` | `not implemented in this build` |
| Operator raises | `area_center (Missing, A, R, C)` | `iconic object 'Missing' is not defined` |

- **`lineProblem()`** (`js/app.js`) decides whether a line is runnable: `null`
  means fine (blank line, `*` comment, a well-formed call, or a bare control
  keyword such as `endif` — including the alternate spellings like
  `for Index := 0 to 5` that carry no parentheses). Anything else is invalid.
- **`isExecutable()`** counts an invalid line as executable on purpose, so
  `nextExecutable()` walks the program counter **onto** it instead of stepping
  over it — F5, F6 and Run to cursor all land on the bad line rather than
  running past it. (Run to cursor still stops *before* the cursor line, exactly
  like a breakpoint there.)
- **`haltLine()`** is the single reporting point: it records
  `state.errorLine = { proc, line, text }`, appends to the error window,
  writes an `err` line to the History, sets `state.pc = null` and raises
  `showModal('Invalid program line', …)` with the operator, the reason, the
  procedure/line and the offending source line in a `pre.errline` block. If
  the failing procedure is not the one on screen (a `return` from a called
  procedure) the editor switches to it first.
- **The message box stops the run.** Its button reads *Go to line* instead of
  OK and closes the box with the caret on the offending line; `closeModal()`
  puts the label back to OK so the help boxes are unaffected.
- **Marker.** The offending line gets a red gutter row (`.gl.error`) with an ✖
  (`err-mark`) in the classic editor, and the whole-line `merr` /
  `merr-arrow` decoration in Monaco. The status bar reads `Error at line N`
  until the next reset or run. The marker is bound to the line *text*, so
  editing that line (or replacing the program) drops it.
- **Undefined variables.** `ctx.iconic()` now raises
  `iconic object 'X' is not defined` instead of letting an operator fail on a
  property of `undefined` (HALCON's "variable is not initialized"), so the
  third class of failure also reports something a user can act on.

## Reset (F2) — releasing runtime handles

F2 (Reset Program) tears down everything a run created, so the next F5 starts
from the state of a freshly loaded program. `clearRunState()` (`js/app.js`) is
the single place that does it; `doReset()` and the `newProgram` / `openProgram`
/ server-reload paths all go through it.

| What | Where it lives | Released by |
| --- | --- | --- |
| Iconic variables (and their `cv.Mat` pixel data) | `state.iconic` | `rec.dispose()`, then `clear()` |
| Control variables (window, model, acquisition handles) | `state.ctrl` | `clear()` |
| Metrology models and object indices | `MetrologyCore.models` | `Metrology.disposeAll()` |
| Remembered overlay dimensions | `lastApplyDims` | `Metrology.disposeAll()` |
| Acquired camera streams | `GRABBERS` | `disposeGrabbers()` — stops the `MediaStreamTrack`s |
| Spawned graphics windows | `GFX.wins`, `WM.recs`, window stacks, taskbar | `gfxCloseSpawned()` |

- **Handles restart at 1.** `Metrology.disposeAll()` resets the module's model
  and object counters and `disposeGrabbers()` resets the acquisition counter,
  so a re-run reports the same handle numbers as the first run instead of
  drifting upward; `GFX.seq` goes back to 1 (the next `dev_open_window` is
  handle 2 again).
- **The docked graphics window survives** (handle 1), but is emptied: its
  display history, metrology overlay, part rectangle, zoom rubber band and the
  plot binding are reset, and the display parameters go back to the defaults.
- **Camera released.** `open_framegrabber` keeps a live `MediaStream`; a reset
  stops its tracks and drops the video element, so the camera light goes out
  even when the program never reached `close_framegrabber`.
- **Misc.** `state.selectedVar`, `state.selectedCtrl`, `mainGfx.plotVar` and
  `mainGfx.drag` are cleared, as are the unknown-operator set and the
  error-line marker (`state.errorLine`) of the last stopped run.
- **Kept on purpose.** The program text; the file-backed image registry
  (`IMAGE_SOURCES`) — an uploaded image is data the user picked, not a runtime
  handle, so `read_image` still finds it after a reset; the watch list, the
  breakpoints and the History / error window (HDevelop keeps them too).

## Reading image files (read_image)

`read_image` returns an image that is looked up by name in a small registry
(`js/opencv_ops.js`, `IMAGE_SOURCES`) — the same string the program line puts
in `FileName`.

- **Built-in image.** `'printer_chip'` is synthesized in the browser
  (`buildChipImage` in `js/app.js`) and registered at startup, so the demo
  program runs without any file on disk. Any other name that has not been
  loaded falls back to that image and logs a warning instead of failing.
- **Loading a file from disk.** The Parameters tab of `read_image` in the
  Operator Window shows an **Image file** list plus a **Load file…** button
  next to the `FileName` parameter (`js/app.js`: `openImageFile`,
  `readImageFile`, `setImageSource`, `imageSourceBar`). A picked PNG/JPG/BMP/
  GIF/TIFF/WebP is decoded into a canvas, registered under its own file name
  (files larger than 2048 px are scaled down), the name is written into
  `FileName` with an in-place argument edit (`argSpans`), and the line is read
  immediately so the image appears in the graphics window. The list keeps
  every file of the session, so switching back and forth needs no re-picking.
- **Format.** As with the built-in image, files are converted to gray, byte
  via OpenCV — the pixel format the operators (and the metrology model)
  expect; `get_image_size` reports the loaded dimensions.
- **Session only.** The canvas lives in memory, not in `localStorage`, so a
  reloaded program that names an uploaded file falls back to the built-in
  image (with the warning above) until the file is picked again.

## Graphics windows and the variable window

The graphics and variable windows follow HDevelop's model closely enough
that HDevelop programs run unmodified (`js/app.js`; display operators in
`js/opencv_ops.js`).

- **Display history per window.** Every graphics window keeps an ordered
  history of what was displayed since the last clear (HDevelop's redraw
  list). `dev_display` accumulates: displaying a full image first clears the
  history, displaying regions/XLD appends. A resize or a redraw replays the
  whole history, and each entry keeps the display parameters that were in
  effect when it was drawn.
- **Active window.** `dev_open_window` opens and activates; the new window
  becomes the target of `dev_display`, of `disp_message` with an explicit
  handle and of the automatically displayed operator results. The toolbar
  lamp marks the active window (green accent on its title bar); clicking the
  lamp or calling `dev_set_window` activates another one. The docked window
  (handle 1) exists from the start, exactly like HDevelop's "Graphics
  Window" and cannot be closed — `dev_close_window` on it warns and clears it
  instead, while `dev_close_window`/`close_window` on an unknown handle is a
  named error.
- **Display parameters.** `dev_set_color` (named colours and
  `#rrggbb`/`#rrggbbaa`), `dev_set_colored` (3/6/12), `dev_set_draw`
  (`'fill'`/`'margin'`), `dev_set_line_width` and `dev_set_part` (with
  HDevelop's reset rule when `Row1 > Row2` or `Col1 > Col2`) persist across
  operators and are inherited by windows opened later. Region overlays are
  re-rendered with the current colour/draw mode and XLD contours are stroked
  with the current colour and width. `dev_set_paint` and `dev_set_lut` are
  accepted with a warning (only the default paint mode is implemented).
- **Automatic display.** `dev_update_window ('on'|'off')` (on by default, as
  in HDevelop) displays the iconic outputs of every executed operator in the
  active window, so a program without explicit `dev_display` still shows its
  results.
- **`disp_message`.** All arguments are honoured: coordinate system,
  `Row`/`Column`, colour and the box toggle.
- **Display primitives.** `disp_cross`, `disp_line`, `disp_arrow`,
  `disp_circle`, `disp_ellipse`, `disp_rectangle1`, `disp_rectangle2` and
  `disp_polygon` draw straight into a window's history instead of producing
  an iconic result, so they survive a resize or a redraw like everything
  else displayed: each call pushes one primitive with the display parameters
  that are in effect (`dev_set_color`/`dev_set_draw`/`dev_set_line_width`)
  and is replayed with them. Coordinates are control tuples in image
  coordinates (Row, Column), `disp_rectangle2`/`disp_ellipse` take their
  `Phi` in radians measured from the column axis like the rest of the build,
  and Display (window handle) `0` or an empty argument means the active
  window — as in HDevelop. The handle is validated: an unknown one is a
  named error, never a silently drawn nothing. `disp_obj`, `disp_region` and
  `disp_image` are the object-first aliases of `dev_display` and share its
  history rule (an image clears it, a region/XLD appends). Demo procedure:
  `display_demo` (all eight primitives plus the generators below, in two
  windows).
- **Variable window.** Iconic variables carry a thumbnail, and each one
  shows the handle(s) of the window(s) it is displayed in (`▣ 2`), which is
  HDevelop's display-window reference. Double-click (or the Display button)
  sends the selected variable to the active window; clearing a variable
  removes it from every window.
- **`dev_open_window` background.** Named colours, gray values `0…255`,
  packed RGB and `-1` ("no background", rendered as the IDE's dark backdrop).

## Numeric arguments and expressions

Numeric control arguments are evaluated the way HDevelop writes them
(`MetrologyUI.numVal` in `js/metrology.js`):

- literals (`128`, `-2.5`), quoted numbers (`'128'`) and control variables,
  including a tuple element (`Radius`, `Radius[0]`);
- expressions over them with `+ - * / %` and parentheses
  (`640/2`, `Height*0.5`, `(Width + 160) / 2`);
- the mathematical intrinsics `rad`/`deg`, `abs`/`fabs`, `ceil`, `floor`,
  `round`, `int`/`trunc`, `sqrt`, `exp`, `log`/`lg`/`log10`, `sin`, `cos`,
  `tan`, `asin`, `acos`, `atan`, `atan2`, `min`, `max`, `pow`, plus the
  constants `PI` and `E`.

The expression is parsed by a small hand-written parser — no `eval`/`Function`
— so a STRING argument (file name, generic parameter, colour) is never
mistaken for code: anything the parser cannot read simply yields the
operator's fallback value. `numArg` in `js/opencv_ops.js` delegates to the
same evaluator, so the `dev_*` operators accept expressions as well.

## Region and XLD generators

HDevelop programs usually build their shapes from parameters rather than
from an image, and most of that vocabulary now exists here as well.

- **Regions** (masks, so they need OpenCV): `gen_rectangle1`, `gen_rectangle2`,
  `gen_circle`, `gen_ellipse`, `gen_region_line`, `gen_region_polygon` and
  `gen_region_polygon_filled`. Coordinates are control tuples (one region per
  tuple element), the region is rasterised into the image size the IDE is
  working on, and an output name may be omitted to get an anonymous region,
  exactly like in HDevelop.
- **XLD contours** (pure JS, DOM-free, covered by the tests):
  `gen_cross_contour_xld`, `gen_rectangle2_contour_xld` and
  `gen_contour_region_xld`, next to the existing `gen_circle_contour_xld`,
  `gen_ellipse_contour_xld` and `gen_contour_polygon_xld`. They take
  HDevelop's arguments, with two departures worth knowing:
  `gen_circle_contour_xld` honours the `Resolution` argument (the point
  spacing of the sampled arc) as in HALCON, and
  `gen_cross_contour_xld` additionally fills the control outputs
  `CenterRow`/`CenterCol`/`AngleOut`, which HDevelop itself does not return
  (`Angle` is normalised into `[0, π)`, the range a cross is
  symmetric over). `gen_contour_region_xld` traces the border pixels of a
  region — the outermost ones, plus, with Mode or Algorithm `'border_holes'`,
  the inner border the region puts around each of its holes; `MaxNumPoints`
  subsamples and `ClippingEndPoints` shortens each contour.

Demo procedure: `display_demo` draws one shape in all three forms — as a
`disp_*` primitive, as a generated region and as a generated XLD contour.

## Metrology

Implemented in the HTML demo; the engine (`MetrologyCore` in
`js/metrology.js`) is DOM-free and covered by `tools/test-metrology.js`
(`tools/node/node tools/test-metrology.js`, 109 checks: the engine plus the
operator argument parsing).

- **Measurement** — measure rectangles of half sizes `measure_length1`
  (perpendicular to the contour, i.e. the direction the gray profile is
  scanned in; default 20) and `measure_length2` (tangential; default 5),
  as in HALCON. They are placed along the nominal contour `measure_distance`
  apart (0 — the default — means `measure_length1`). In each region the gray
  profile across the contour is Gaussian-smoothed (`measure_sigma`) and
  scanned for subpixel edge positions with amplitude ≥ `measure_threshold`,
  filtered by `measure_transition` / `measure_select`. The regions belong to
  the model: they are created by `add_metrology_object_*_measure` and
  rebuilt when a layout parameter changes, so
  `get_metrology_object_measures` returns them as XLD before
  `apply_metrology_model` has run — then with empty measure tuples, because
  the edge coordinates belong to the last apply and are empty until it has
  run. After the apply the same call yields the edge positions found on the
  profiles.
- **Fitting** — per-instance robust extraction: deterministic minimal-sample
  seeding (circle/line) so parallel edge groups don't collapse, then
  median-pruning refits (`max_iterations`); score = supporting measures /
  total measures, thresholded by `min_score`, up to `num_instances`.
  line = orthogonal regression; circle = Kasa + Gauss-Newton; ellipse =
  Levenberg-Marquardt on explicit parameters (normalized to Ra ≥ Rb);
  rectangle2 = per-side plane medians at an orientation found by a robust
  π/2 angle search (a moment/PCA seed alone is only accurate when the point
  count matches the side lengths).
- **XLD fitting** — `fit_line/circle/ellipse/rectangle2_contour_xld` follow
  the HDevelop signatures (including `ClippingEndPoints` and the
  `MaxClosureDist` argument of the closed shapes); line endpoints follow the
  contour order, closed shapes report the `PointOrder` they were given.
- **GUI** — `apply_metrology_model` draws into the active graphics window
  (works in every `dev_open_window` spawn); the graphics toolbar has a
  metrology show/hide toggle. The fitted contour of a result comes from
  `get_metrology_object_result_contour` (HDevelop's operator for it) or from
  this build's older `get_metrology_object_result` form, which additionally
  returns it as the iconic output, so either result can be fed straight into
  the `fit_*_contour_xld` family. `get_metrology_object_model_contour`
  returns the nominal geometry as XLD, sampled by its `Resolution` argument
  (1.5, as in HDevelop), and `get_metrology_object_result_contour` the fitted
  shape of one instance, sampled the same way.
  Demo procedure: `metrology_demo`
  (fitted die rectangle 130×90, fiducial circle r=26, caliper line on the die
  edge, then a re-fit of the circle contour).
- **Approximations** (per the roadmap's "approximate on float rounding"
  stance): 2-D only (`camera_param`/`plane_pose`
  stored but not applied), `MaxClosureDist` accepted without effect, and
  `rand_seed` accepted without effect (fitting is deterministic).
- **Signature notes** — iconic outputs come first, as in HALCON.
  `add_metrology_object_generic` takes HDevelop's
  `(MetrologyHandle, Shape, ShapeParam, MeasureLength1, MeasureLength2,
  MeasureSigma, MeasureThreshold, GenParamName, GenParamValue : Index)` —
  the `ShapeParam` values of all shapes are concatenated, one object is
  created per shape, and surplus values are warned about — and the older
  build form (one shape name plus its parameters per call) is still
  accepted. `get_metrology_object_measures` likewise takes HDevelop's
  `(Contours, MetrologyHandle, Index, Transition, Row, Column)`, returning
  the measure regions as XLD plus the matched edge coordinates, and still
  accepts the earlier `(MetrologyHandle, Index, Transition, Row, Column)`
  without the iconic output. `reset_metrology_object_param` always restores
  every parameter to its HALCON default (HDevelop's signature is
  `(MetrologyHandle, Index)`); as an extension it also takes a
  `GenParamName` tuple and then resets only those parameters (the plural
  spelling `reset_metrology_object_params` is kept as an alias).
  `get_metrology_object_result` takes HDevelop's
  `(MetrologyHandle, Index, Instance, GenParamName, GenParamValue :
  Parameter)` — `GenParamName` 'result_type' with `GenParamValue`
  'all_param' / 'score' / a single parameter name, or 'used_edges' with
  'row' / 'column' / 'amplitude' (the edges the measure regions of the last
  apply contributed) — and still accepts the earlier build form
  `(Contours, MetrologyHandle, Index, Instance, ResultType, GenParamName,
  Result)`, which additionally returns the fitted contour(s) as the iconic
  output; the two middle arguments of that form are classified automatically
  (an object index is either a number or 'all'). `set_metrology_model_param`
  does not reject the 2-D-only `camera_param` / `plane_pose` but warns.
  The metrology objects are numbered from 0 per model, as in HALCON — the
  index is not a session-wide counter, so the first object of a fresh model
  is always `0` and `get_metrology_object_indices` returns `[0, 1, …]`. The
  Operator Window and the Parameters tab show HALCON's documented default
  for every input control parameter (`Index` = 'all' — `0` for
  `get_metrology_object_result`, `get_metrology_object_result_contour`,
  `get_metrology_object_model_contour` and
  `get_metrology_object_num_instances` — `Transition` = 'all',
  `Resolution` = 1.5, `MeasureLength1` = 20, …), and as in HDevelop an
  argument written as `[]` uses that default instead of being an error.
8. **Trademark and docs.** Reimplementing HALCON's names and signatures is a
   normal compatibility surface. Copying MVTec's help text into the UI is not.
