/*
 * Windows 11 virtual camera: dynamic resolution probe.
 *
 * MinGW-w64's headers predate MFCreateVirtualCamera, so the API cannot be
 * linked against. It does not need to be: if the OS exports it, LoadLibrary +
 * GetProcAddress reaches it with declarations of our own. That keeps the
 * MinGW-only rule intact and degrades cleanly on Windows builds without the API.
 *
 * The first run of this probe found the export missing from mfplat.dll on
 * Windows build 26100, so the probe now scans every module that could plausibly
 * own it and reports which one does. It then CALLS the function through our
 * hand-written signature: a plausible HRESULT (E_ACCESSDENIED for an unpackaged
 * caller) proves the signature and enum values match the real ABI, which is the
 * expensive thing to discover later.
 *
 * Last line is machine readable so CI can forward it to the job summary.
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
/* WIN32_LEAN_AND_MEAN keeps OLE/COM out of windows.h, and CoInitializeEx lives
 * here. Needed because the virtual camera API requires a COM apartment. */
#include <objbase.h>
#include <stdio.h>
#include <string.h>

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

typedef LONG (WINAPI *RtlGetVersionFn)(void *);

typedef struct {
	ULONG dwOSVersionInfoSize;
	ULONG dwMajorVersion;
	ULONG dwMinorVersion;
	ULONG dwBuildNumber;
	ULONG dwPlatformId;
	WCHAR szCSDVersion[128];
} probe_osversioninfo;

/* Every module that could plausibly own the virtual camera entry point. MF
 * forwards a lot of its surface between mfplat, mfcore and mf, and Server SKUs
 * omit some consumer media features entirely - which is what the first probe
 * run suggested. */
static const wchar_t *candidate_modules[] = {
	L"mfplat.dll",
	L"mfcore.dll",
	L"mf.dll",
	L"mfsensorgroup.dll",
	L"mfreadwrite.dll",
	L"mfmediaengine.dll",
	L"windows.media.dll",
};

/* Wide module names are converted by hand: relying on %ls inside the narrow
 * printf is one of the things that made the first version crash before it
 * printed a single line. */
static void print_wide(const wchar_t *text)
{
	char narrow[128];
	int written = WideCharToMultiByte(CP_UTF8, 0, text, -1, narrow, sizeof(narrow) - 1, NULL, NULL);
	if (written <= 0)
		narrow[0] = '\0';
	else
		narrow[written] = '\0';
	fputs(narrow, stdout);
}

int main(int argc, char **argv)
{
	/* Unbuffered: when this probe crashes, buffered output vanishes and takes
	 * the diagnosis with it. */
	setvbuf(stdout, NULL, _IONBF, 0);

	int do_call = 0;
	for (int i = 1; i < argc; i++) {
		if (strcmp(argv[i], "--call") == 0)
			do_call = 1;
	}

	unsigned long build = 0;
	HMODULE ntdll = GetModuleHandleW(L"ntdll.dll");
	if (ntdll) {
		RtlGetVersionFn rtl_get_version =
			(RtlGetVersionFn)(void *)GetProcAddress(ntdll, "RtlGetVersion");
		if (rtl_get_version) {
			probe_osversioninfo info;
			ZeroMemory(&info, sizeof(info));
			info.dwOSVersionInfoSize = sizeof(info);
			if (rtl_get_version(&info) == 0)
				build = info.dwBuildNumber;
		}
	}
	printf("Windows build: %lu%s\n", build, build >= 22621 ? " (11 22H2 or later)" : " (pre-22H2)");

	printf("scanning for the MFCreateVirtualCamera export:\n");
	MFCreateVirtualCameraFn create = NULL;
	const wchar_t *owner = NULL;
	for (size_t i = 0; i < sizeof(candidate_modules) / sizeof(candidate_modules[0]); i++) {
		HMODULE module = LoadLibraryW(candidate_modules[i]);
		if (!module) {
		printf("  ");
		print_wide(candidate_modules[i]);
		printf(" not present on this system\n");
		continue;
	}
	FARPROC symbol = GetProcAddress(module, "MFCreateVirtualCamera");
	if (symbol) {
		printf("  ");
		print_wide(candidate_modules[i]);
		printf(" EXPORTS MFCreateVirtualCamera at %p\n", (void *)symbol);
		if (!create) {
			create = (MFCreateVirtualCameraFn)(void *)symbol;
			owner = candidate_modules[i];
		}
	} else {
		printf("  ");
		print_wide(candidate_modules[i]);
		printf(" no such export\n");
	}
	}

	if (!create) {
		printf("no module on this system exports MFCreateVirtualCamera\n");
		printf("VCAM_PROBE exported=0 module=none hr=0x00000000 build=%lu\n", build);
		return 0;
	}
	printf("using ");
	print_wide(owner);
	printf("\n");

	if (!do_call) {
		printf("module scan only; pass --call to attempt MFCreateVirtualCamera\n");
		printf("VCAM_PROBE exported=1 module=found hr=0x00000000 build=%lu\n", build);
		return 0;
	}
	printf("calling MFCreateVirtualCamera (a crash here means our declaration does not match the ABI)\n");

	HRESULT apartment = CoInitializeEx(NULL, COINIT_MULTITHREADED);
	printf("CoInitializeEx: 0x%08lx\n", (unsigned long)apartment);

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
		printf("  E_ACCESSDENIED: the API answered, and this process has no package identity.\n");
		printf("  Documented behaviour for an unpackaged caller, and it means our signature\n");
		printf("  and enum values match the real ABI.\n");
	} else if (created == E_INVALIDARG) {
		printf("  E_INVALIDARG: the call reached the API but was rejected - revisit the\n");
		printf("  argument order and enum values before building on this.\n");
	} else if (SUCCEEDED(created) && camera) {
		printf("  virtual camera object created\n");
		camera->lpVtbl->Release(camera);
	}

	CoUninitialize();
	printf("VCAM_PROBE exported=1 module=present hr=0x%08lx build=%lu\n",
	       (unsigned long)created, build);
	return 0;
}
