/*
 * Windows 11 virtual camera: dynamic resolution probe.
 *
 * MinGW-w64's headers predate MFCreateVirtualCamera, so the API cannot be
 * linked against. It does not need to be: the OS exports it from mfplat.dll, so
 * LoadLibrary + GetProcAddress reaches it with declarations of our own. That
 * keeps the MinGW-only toolchain rule intact and degrades cleanly on Windows 10,
 * where the export is simply absent.
 *
 * The value of this probe is that it CALLS the function. A plausible HRESULT -
 * E_ACCESSDENIED because a runner has no package identity - proves our
 * hand-written signature and enum values match the real ABI. A crash or a
 * nonsensical code would prove they do not, which is exactly the day of
 * debugging this is meant to avoid.
 *
 * Last line is machine readable so CI can forward it to the job summary.
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
/* WIN32_LEAN_AND_MEAN keeps OLE/COM out of windows.h, and CoInitializeEx lives
 * here. Needed because the virtual camera API requires a COM apartment. */
#include <objbase.h>
#include <stdio.h>

/* Documented values. Only the software camera source type exists today. */
typedef enum {
	MFVirtualCameraType_SoftwareCameraSource = 0
} MFVirtualCameraType;

typedef enum {
	MFVirtualCameraLifetime_Session = 0,
	MFVirtualCameraLifetime_System = 1
} MFVirtualCameraLifetime;

typedef enum {
	MFVirtualCameraAccess_CurrentUser = 0,
	MFVirtualCameraAccess_AllUsers = 1
} MFVirtualCameraAccess;

/* IUnknown is always the first three vtable entries, so a minimal declaration
 * is enough to release whatever the call hands back. */
typedef struct IMFVirtualCamera IMFVirtualCamera;

typedef struct IMFVirtualCameraVtbl {
	HRESULT (WINAPI *QueryInterface)(IMFVirtualCamera *This, const IID *riid, void **ppv);
	ULONG   (WINAPI *AddRef)(IMFVirtualCamera *This);
	ULONG   (WINAPI *Release)(IMFVirtualCamera *This);
} IMFVirtualCameraVtbl;

struct IMFVirtualCamera {
	const IMFVirtualCameraVtbl *lpVtbl;
};

typedef HRESULT (WINAPI *MFCreateVirtualCameraFn)(
	MFVirtualCameraType type,
	MFVirtualCameraLifetime lifetime,
	MFVirtualCameraAccess access,
	LPCWSTR friendlyName,
	LPCWSTR sourceId,
	void *attributes,
	IMFVirtualCamera **virtualCamera);

typedef LONG (WINAPI *RtlGetVersionFn)(PRTL_OSVERSIONINFOW);

/* Local copy of the structure, to avoid depending on winternl.h details. */
typedef struct {
	ULONG dwOSVersionInfoSize;
	ULONG dwMajorVersion;
	ULONG dwMinorVersion;
	ULONG dwBuildNumber;
	ULONG dwPlatformId;
	WCHAR szCSDVersion[128];
} probe_osversioninfo;

int main(void)
{
	unsigned long build = 0;
	HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
	if (ntdll) {
		RtlGetVersionFn rtl_get_version =
			(RtlGetVersionFn)(void *)GetProcAddress(ntdll, "RtlGetVersion");
		if (rtl_get_version) {
			probe_osversioninfo info;
			ZeroMemory(&info, sizeof(info));
			info.dwOSVersionInfoSize = sizeof(info);
			if (rtl_get_version((PRTL_OSVERSIONINFOW)&info) == 0)
				build = info.dwBuildNumber;
		}
	}
	printf("Windows build: %lu%s\n", build, build >= 22621 ? " (11 22H2 or later)" : " (pre-22H2)");

	HMODULE mfplat = LoadLibraryW(L"mfplat.dll");
	printf("LoadLibraryW(\"mfplat.dll\"): %p\n", (void *)mfplat);
	if (!mfplat) {
		printf("VCAM_PROBE exported=0 hr=0x00000000 build=%lu\n", build);
		return 0;
	}

	MFCreateVirtualCameraFn create =
		(MFCreateVirtualCameraFn)(void *)GetProcAddress(mfplat, "MFCreateVirtualCamera");
	printf("GetProcAddress(\"MFCreateVirtualCamera\"): %p\n", (void *)create);
	if (!create) {
		printf("virtual camera API is not exported by this Windows build\n");
		printf("VCAM_PROBE exported=0 hr=0x00000000 build=%lu\n", build);
		FreeLibrary(mfplat);
		return 0;
	}
	printf("virtual camera API is exported\n");

	HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
	printf("CoInitializeEx: 0x%08lx\n", (unsigned long)hr);

	IMFVirtualCamera *camera = NULL;
	HRESULT created = create(MFVirtualCameraType_SoftwareCameraSource,
	                         MFVirtualCameraLifetime_Session,
	                         MFVirtualCameraAccess_CurrentUser,
	                         L"OpenCVisionStudio Dynamic Probe",
	                         L"{2a1b1f8e-6f5c-4b7a-9d3e-8f0c1d2e3f40}",
	                         NULL,
	                         &camera);
	printf("MFCreateVirtualCamera(SoftwareCameraSource, Session, CurrentUser) = 0x%08lx\n",
	       (unsigned long)created);

	if (created == E_ACCESSDENIED) {
		printf("  E_ACCESSDENIED: the API answered, and the process has no package identity.\n");
		printf("  That is the documented behaviour for an unpackaged caller, and it means\n");
		printf("  our hand-written signature matches the real ABI.\n");
	} else if (SUCCEEDED(created) && camera) {
		printf("  virtual camera object created\n");
		camera->lpVtbl->Release(camera);
	} else if (created == E_INVALIDARG) {
		printf("  E_INVALIDARG: the call reached the API but was rejected - inspect the\n");
		printf("  argument order and enum values before building on this.\n");
	}

	CoUninitialize();
	FreeLibrary(mfplat);

	printf("VCAM_PROBE exported=1 hr=0x%08lx build=%lu\n", (unsigned long)created, build);
	return 0;
}
