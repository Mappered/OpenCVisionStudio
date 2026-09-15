/*
 * Windows 11 user-mode virtual camera probe.
 *
 * Phase 1 of "expose a libusb-win32 / Aravis camera as a webcam" is the
 * MFCreateVirtualCamera API, which needs no kernel driver - but does need a
 * packaged app identity. Before designing around it, answer the toolchain
 * question: does MinGW-w64 ship mfvirtualcamera.h and the import symbol?
 *
 * Deliberately does NOT call MFCreateVirtualCamera. Taking the symbol's address
 * proves it exists and links without guessing a signature from memory; the
 * exact prototype comes from the header when the real implementation starts.
 * On a runner the call would fail with E_ACCESSDENIED anyway, because an
 * unpackaged process has no identity, and that is an expected answer rather
 * than a useful test.
 */

#define COBJMACROS
#define INITGUID
#define WIN32_LEAN_AND_MEAN
#include <windows.h>

#include <mfapi.h>
#include <mfidl.h>
#include <mfobjects.h>
#include <mfvirtualcamera.h>

#include <stdio.h>

int main(void)
{
	printf("mfvirtualcamera.h: present in this toolchain\n");
	printf("  MFVirtualCameraType_SoftwareCameraSource = %d\n",
	       (int)MFVirtualCameraType_SoftwareCameraSource);
	printf("  MFVirtualCameraLifetime_Session = %d\n",
	       (int)MFVirtualCameraLifetime_Session);
	printf("  MFVirtualCameraLifetime_System = %d\n",
	       (int)MFVirtualCameraLifetime_System);
	printf("  MFVirtualCameraAccess_CurrentUser = %d\n",
	       (int)MFVirtualCameraAccess_CurrentUser);

	/* Link-time proof that the import library exports it. */
	void *symbol = (void *)(uintptr_t)MFCreateVirtualCamera;
	printf("MFCreateVirtualCamera symbol = %p\n", symbol);

	HRESULT hr = MFStartup(MF_VERSION, MFSTARTUP_LITE);
	printf("MFStartup: 0x%08lx\n", (unsigned long)hr);
	if (FAILED(hr)) {
		printf("virtual camera probe: MFStartup failed\n");
		return 1;
	}
	MFShutdown();

	printf("virtual camera probe: API is available to this toolchain\n");
	return 0;
}
