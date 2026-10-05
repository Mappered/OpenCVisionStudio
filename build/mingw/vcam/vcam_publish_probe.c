/*
 * Virtual camera publish probe.
 *
 * Previous probes established that the API is reachable and that we can create
 * an IMFVirtualCamera. This one asks the next question: once a camera has been
 * created and Start() has been called, does Media Foundation enumerate it as a
 * capture device? That is the gate between "we hold an object" and "applications
 * can see a webcam", and it is answerable in CI with no camera and no GUI.
 *
 * sourceId is a CLSID string: it names the COM media source that the frame
 * server activates to pull frames. Nothing is registered under this CLSID yet,
 * so Start() may well fail - which is itself the finding, because it tells us
 * whether the media source must be registered before the camera can come up, or
 * whether the camera appears first and the source is only needed to deliver
 * frames.
 *
 * Every step's HRESULT is printed separately so the log names the failing call.
 * Last line is machine readable for the CI summary.
 */

#include "mfvcam.h"

#include <stdio.h>
#include <wchar.h>

/* Our own source identity. The GUID is arbitrary but must be stable: it is what
 * the frame server uses to find the media source that feeds this camera. */
static const wchar_t *kSourceId = L"{8F2B1E4C-3D6A-4A21-9C7E-5B0D8A3F6C11}";
static const wchar_t *kFriendlyName = L"OpenCVisionStudio Virtual Camera";
static const wchar_t *kNameNeedle = L"OpenCVisionStudio";

static void print_wide(const wchar_t *text)
{
	char narrow[256];
	int written = WideCharToMultiByte(CP_UTF8, 0, text, -1, narrow, sizeof(narrow) - 1, NULL, NULL);
	if (written <= 0)
		narrow[0] = '\0';
	else
		narrow[written] = '\0';
	fputs(narrow, stdout);
}

/* Returns how many video capture devices Media Foundation reports, and whether
 * one of them is ours. */
static void enumerate_devices(UINT32 *count_out, int *found_out)
{
	IMFAttributes *attributes = NULL;
	IMFActivate **devices = NULL;
	UINT32 count = 0;

	*count_out = 0;
	*found_out = 0;

	if (FAILED(MFCreateAttributes(&attributes, 1)))
		return;
	IMFAttributes_SetGUID(attributes, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
	                      &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);

	if (SUCCEEDED(MFEnumDeviceSources(attributes, &devices, &count))) {
		*count_out = count;
		for (UINT32 i = 0; i < count; i++) {
			WCHAR *name = NULL;
			UINT32 name_length = 0;
			printf("    device %u: ", (unsigned)i);
			if (SUCCEEDED(IMFActivate_GetAllocatedString(
					devices[i], &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &name, &name_length)) && name) {
				print_wide(name);
				if (wcsstr(name, kNameNeedle))
					*found_out = 1;
				CoTaskMemFree(name);
			} else {
				printf("(no friendly name)");
			}
			printf("\n");
			IMFActivate_Release(devices[i]);
		}
		CoTaskMemFree(devices);
	}
	IMFAttributes_Release(attributes);
}

int main(void)
{
	setvbuf(stdout, NULL, _IONBF, 0);

	HRESULT apartment = CoInitializeEx(NULL, COINIT_MULTITHREADED);
	printf("CoInitializeEx: 0x%08lx\n", (unsigned long)apartment);

	HRESULT hr = MFStartup(MF_VERSION, MFSTARTUP_LITE);
	printf("MFStartup: 0x%08lx\n", (unsigned long)hr);
	if (FAILED(hr)) {
		printf("VCAM_PUBLISH created=0 started=0 before=0 after=0 visible=0\n");
		return 1;
	}

	PFN_MFCreateVirtualCamera create = vcam_resolve_create();
	printf("resolve MFCreateVirtualCamera: %s\n", create ? "ok" : "not found");
	if (!create) {
		printf("VCAM_PUBLISH created=0 started=0 before=0 after=0 visible=0\n");
		MFShutdown();
		return 1;
	}

	PFN_MFIsVirtualCameraTypeSupported is_supported = vcam_resolve_supported();
	if (is_supported) {
		BOOL supported = FALSE;
		HRESULT supported_hr = is_supported(MFVirtualCameraType_SoftwareCameraSource, &supported);
		printf("MFIsVirtualCameraTypeSupported: 0x%08lx supported=%d\n",
		       (unsigned long)supported_hr, (int)supported);
	}

	UINT32 before = 0;
	int found_before = 0;
	printf("devices before creating the virtual camera:\n");
	enumerate_devices(&before, &found_before);

	printf("creating virtual camera with sourceId ");
	print_wide(kSourceId);
	printf("\n");

	IMFVirtualCamera *camera = NULL;
	HRESULT created = create(MFVirtualCameraType_SoftwareCameraSource,
	                         MFVirtualCameraLifetime_Session,
	                         MFVirtualCameraAccess_CurrentUser,
	                         kFriendlyName,
	                         kSourceId,
	                         NULL,
	                         0,
	                         &camera);
	printf("MFCreateVirtualCamera: 0x%08lx\n", (unsigned long)created);
	if (FAILED(created) || !camera) {
		printf("VCAM_PUBLISH created=0 started=0 before=%u after=0 visible=0\n", (unsigned)before);
		MFShutdown();
		return 1;
	}

	HRESULT started = IMFVirtualCamera_Start(camera, NULL);
	printf("IMFVirtualCamera::Start: 0x%08lx\n", (unsigned long)started);

	UINT32 after = 0;
	int found_after = 0;
	printf("devices after Start:\n");
	enumerate_devices(&after, &found_after);

	HRESULT stopped = IMFVirtualCamera_Stop(camera);
	printf("IMFVirtualCamera::Stop: 0x%08lx\n", (unsigned long)stopped);
	HRESULT removed = IMFVirtualCamera_Remove(camera);
	printf("IMFVirtualCamera::Remove: 0x%08lx\n", (unsigned long)removed);
	HRESULT shutdown = IMFVirtualCamera_Shutdown(camera);
	printf("IMFVirtualCamera::Shutdown: 0x%08lx\n", (unsigned long)shutdown);
	IMFVirtualCamera_Release(camera);

	MFShutdown();

	printf("VCAM_PUBLISH created=%d started=%d before=%u after=%u visible=%d\n",
	       SUCCEEDED(created) ? 1 : 0, SUCCEEDED(started) ? 1 : 0,
	       (unsigned)before, (unsigned)after, found_after);
	return 0;
}
