OpenCVisionStudio virtual camera - Aravis to webcam kit
======================================================

What this is
  A Windows 11 user-mode virtual camera. A media source (vcamsource.dll)
  is registered under a CLSID; the virtual camera names that CLSID as its
  source id, and Media Foundation activates it to pull frames.

  Frames come from a camera. vcam-publisher.exe owns it through Aravis
  (GigE Vision and USB3 Vision) and writes frames into a shared-memory
  bus; the media source reads that bus from inside the frame server. If
  nothing is publishing, the media source generates its own pattern, so
  the camera still comes up on a machine with no camera attached.

Live camera as a webcam (Windows 11)
  1. run-live.cmd
     Asks for elevation, registers the media source, lists the cameras
     Aravis can see, and starts publishing in its own window. Give it a
     camera index to pick a specific one:  run-live.cmd 1
  2. Open the Windows Camera app and choose "OpenCVisionStudio Virtual
     Camera". Frames, resolution and frame rate are shown in the
     publisher window.
  3. run-stop.cmd when you are done: stops the publisher and removes the
     registration again.

Testing without a camera
  vcam-publisher.exe --synthetic --run
  publishes generated frames through the same path, so the webcam can be
  opened before a camera is on the desk. Nothing else changes.

Other pieces of the kit
  vcam-read.exe        creates the camera, starts it, enumerates Media
                       Foundation devices, reads one frame, removes the
                       camera. This is what CI runs; useful as a check.
  vcam-register.exe    register/unregister the media source by hand.
  arv-tool-0.10.exe    Aravis own tool: "arv-tool-0.10.exe list" shows
                       what the GV/USB3 stack sees.
  arv-fake-gv-camera-0.10.exe
                       a fake GigE Vision camera, for a machine with no
                       camera at all. Start it, then run-live.cmd.

Reading the result
  * The publisher window printing "aravis: N frames in M ms (X fps)" means
    a real camera is streaming into the bus.
  * The media source runs inside the frame server process, so it traces to
    vcamsource.dll.log next to the DLL. That file names every call the
    frame server makes into it, and whether the bus was found.
  * Camera images are scaled to the camera geometry the media source
    advertises (640x480 RGB32) with the aspect ratio preserved, so a
    512x512 or 1920x1080 sensor arrives letterboxed rather than sheared.
  * vcamsource.dll.log.from-ci.txt is the trace from the CI run.
  * On a Windows Server SKU the frame server faults inside its own
    FrameServerMonitorClient.dll before the camera comes up. That is a
    platform gap, not a defect in this kit: run it on Windows 11.
