OpenCVisionStudio virtual camera - test kit
==========================================

What this is
  A Windows 11 user-mode virtual camera. A media source (vcamsource.dll)
  is registered under a CLSID; the virtual camera names that CLSID as its
  source id, and Media Foundation activates it to pull frames. Frames are
  generated synthetically for now; the Aravis frame bus replaces the
  generator behind the same interfaces.

How to run it (Windows 11, elevated command prompt)
  1. vcam-register.exe register vcamsource.dll
     Registers the media source under HKCU and HKLM. The frame server
     reads HKLM, so elevation is required.
  2. vcam-read.exe
     Creates the virtual camera, starts it, enumerates Media Foundation
     devices, reads one frame, then removes the camera again.
  3. Open the Windows Camera app while vcam-read.exe is running and look
     for "OpenCVisionStudio Virtual Camera".
  4. vcam-register.exe unregister      (cleanup)

Reading the result
  * "IMFVirtualCamera::Start: 0x00000000" plus "VCAM_READ ... sample_bytes=16384"
    means the whole path works: the camera was published and delivered a frame.
  * The media source runs inside the frame server process, so it traces to
    vcamsource.dll.log next to the DLL. That file names every call the frame
    server makes into it.
  * On a Windows Server SKU the frame server faults inside its own
    FrameServerMonitorClient.dll before the camera comes up. That is a
    platform gap, not a defect in this kit: run it on a Windows 11 client.
