/*
 * Reads a frame from the virtual camera, the way an application would.
 *
 * This is the end-to-end check for the whole path: it enumerates Media
 * Foundation devices, finds ours by name, activates it, negotiates RGB32, and
 * pulls one sample. Everything it does goes through the frame server, so a
 * successful read proves the published camera is real, that the media source
 * DLL was activated from its CLSID, and that frames are flowing.
 *
 * No camera and no GUI are involved, which is what makes this usable in CI.
 */

/* CINTERFACE and COBJMACROS must be defined before the Media Foundation headers
 * are pulled in, otherwise the IFoo_Method(...) helpers never exist and every
 * call looks like an implicit declaration. */
#define CINTERFACE
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfobjects.h>
#include <mfreadwrite.h>
#include <mferror.h>
#include <stdio.h>
#include <string.h>
#include <wchar.h>

#include "mfvcam.h"
#include "vcam_clsid.h"

/* Without a debugger, the faulting module and offset are the difference between
 * guessing and knowing. The frame server activates our CLSID inside this
 * process, so a fault here may be our media source or Windows' own code. */
static LONG WINAPI crash_handler(EXCEPTION_POINTERS *info)
{
	HMODULE module = NULL;
	wchar_t module_path[MAX_PATH] = L"<unknown>";
	void *address = NULL;

	if (info && info->ExceptionRecord) {
		address = (void *)info->ExceptionRecord->ExceptionAddress;
		if (address &&
		    GetModuleHandleExW(GET_MODULE_HANDLE_EX_FLAG_FROM_ADDRESS |
		                       GET_MODULE_HANDLE_EX_FLAG_UNCHANGED_REFCOUNT,
		                       (LPCWSTR)address, &module) && module) {
			GetModuleFileNameW(module, module_path, MAX_PATH);
		}
		fprintf(stderr, "CRASH code=0x%08lx address=%p module=",
		        (unsigned long)info->ExceptionRecord->ExceptionCode, address);
		fwprintf(stderr, L"%ls\n", module_path);
		if (info->ExceptionRecord->NumberParameters >= 2) {
			fprintf(stderr, "CRASH access=%p\n",
			        (void *)info->ExceptionRecord->ExceptionInformation[1]);
		}
		fflush(stderr);
	}
	return EXCEPTION_EXECUTE_HANDLER;
}

int main(void)
{
	IMFAttributes *attributes = NULL;
	IMFActivate **devices = NULL;
	UINT32 device_count = 0;
	IMFActivate *target = NULL;
	IMFMediaSource *source = NULL;
	IMFSourceReader *reader = NULL;
	IMFMediaType *requested = NULL;
	IMFSample *sample = NULL;
	DWORD stream_flags = 0;
	LONGLONG timestamp = 0;
	UINT32 found = 0;
	UINT32 sample_bytes = 0;
	BYTE first_pixel[4] = { 0, 0, 0, 0 };
	HRESULT hr;
	IMFVirtualCamera *virtual_camera = NULL;
	PFN_MFCreateVirtualCamera create_vcam = NULL;
	HRESULT created = E_FAIL;
	HRESULT started = E_FAIL;

	setvbuf(stdout, NULL, _IONBF, 0);
	setvbuf(stderr, NULL, _IONBF, 0);
	SetUnhandledExceptionFilter(crash_handler);

	hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
	printf("CoInitializeEx: 0x%08lx\n", (unsigned long)hr);
	hr = MFStartup(MF_VERSION, MFSTARTUP_LITE);
	printf("MFStartup: 0x%08lx\n", (unsigned long)hr);
	if (FAILED(hr)) {
		printf("VCAM_READ devices=0 found=0 sample_bytes=0\n");
		return 1;
	}

	/* Publish the camera first, exactly as the publishing application will. */
	create_vcam = vcam_resolve_create();
	if (!create_vcam) {
		printf("MFCreateVirtualCamera not resolvable\n");
		printf("VCAM_READ devices=0 found=0 sample_bytes=0\n");
		MFShutdown();
		return 1;
	}
	created = create_vcam(MFVirtualCameraType_SoftwareCameraSource,
	                      MFVirtualCameraLifetime_Session,
	                      MFVirtualCameraAccess_CurrentUser,
	                      VCAM_FRIENDLY_NAME,
	                      VCAM_SOURCE_CLSID_STRING,
	                      NULL, 0, &virtual_camera);
	printf("MFCreateVirtualCamera: 0x%08lx\n", (unsigned long)created);
	if (FAILED(created) || !virtual_camera) {
		printf("VCAM_READ devices=0 found=0 sample_bytes=0\n");
		MFShutdown();
		return 1;
	}
	started = IMFVirtualCamera_Start(virtual_camera, NULL);
	printf("IMFVirtualCamera::Start: 0x%08lx\n", (unsigned long)started);
	if (FAILED(started)) {
		printf("camera did not start; is the media source registered under %ls?\n",
		       VCAM_SOURCE_CLSID_STRING);
		IMFVirtualCamera_Shutdown(virtual_camera);
		IMFVirtualCamera_Release(virtual_camera);
		MFShutdown();
		printf("VCAM_READ devices=0 found=0 sample_bytes=0\n");
		return 1;
	}

	hr = MFCreateAttributes(&attributes, 1);
	if (SUCCEEDED(hr))
		hr = IMFAttributes_SetGUID(attributes, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
		                           &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
	if (SUCCEEDED(hr))
		hr = MFEnumDeviceSources(attributes, &devices, &device_count);
	printf("MFEnumDeviceSources: 0x%08lx devices=%u\n", (unsigned long)hr, (unsigned)device_count);
	if (FAILED(hr)) {
		printf("VCAM_READ devices=%u found=0 sample_bytes=0\n", (unsigned)device_count);
		return 1;
	}

	for (UINT32 i = 0; i < device_count; i++) {
		WCHAR *name = NULL;
		UINT32 name_length = 0;
		if (SUCCEEDED(IMFActivate_GetAllocatedString(
				devices[i], &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, &name, &name_length)) && name) {
			wprintf(L"  device %u: %ls\n", (unsigned)i, name);
			if (wcsstr(name, L"OpenCVisionStudio")) {
				target = devices[i];
				IMFActivate_AddRef(target);
				found = 1;
			}
			CoTaskMemFree(name);
		}
		IMFActivate_Release(devices[i]);
	}
	CoTaskMemFree(devices);
	IMFAttributes_Release(attributes);

	if (!target) {
		printf("virtual camera not enumerated\n");
		printf("VCAM_READ devices=%u found=0 sample_bytes=0\n", (unsigned)device_count);
		MFShutdown();
		return 1;
	}

	hr = IMFActivate_ActivateObject(target, &IID_IMFMediaSource, (void **)&source);
	printf("ActivateObject(IMFMediaSource): 0x%08lx\n", (unsigned long)hr);
	IMFActivate_Release(target);
	if (FAILED(hr)) {
		printf("VCAM_READ devices=%u found=1 sample_bytes=0\n", (unsigned)device_count);
		MFShutdown();
		return 1;
	}

	hr = MFCreateSourceReaderFromMediaSource(source, NULL, &reader);
	printf("MFCreateSourceReaderFromMediaSource: 0x%08lx\n", (unsigned long)hr);
	if (SUCCEEDED(hr)) {
		hr = MFCreateMediaType(&requested);
		if (SUCCEEDED(hr))
			hr = IMFMediaType_SetGUID(requested, &MF_MT_MAJOR_TYPE, &MFMediaType_Video);
		if (SUCCEEDED(hr))
			hr = IMFMediaType_SetGUID(requested, &MF_MT_SUBTYPE, &MFVideoFormat_RGB32);
		if (SUCCEEDED(hr))
			hr = IMFSourceReader_SetCurrentMediaType(reader, MF_SOURCE_READER_FIRST_VIDEO_STREAM, NULL, requested);
		printf("SetCurrentMediaType(RGB32): 0x%08lx\n", (unsigned long)hr);
	}

	if (SUCCEEDED(hr)) {
		hr = IMFSourceReader_ReadSample(reader, MF_SOURCE_READER_FIRST_VIDEO_STREAM, 0,
		                                NULL, &stream_flags, &timestamp, &sample);
		printf("ReadSample: 0x%08lx flags=0x%08lx timestamp=%lld\n",
		       (unsigned long)hr, (unsigned long)stream_flags, (long long)timestamp);
	}

	if (SUCCEEDED(hr) && sample) {
		IMFMediaBuffer *buffer = NULL;
		hr = IMFSample_ConvertToContiguousBuffer(sample, &buffer);
		if (SUCCEEDED(hr)) {
			BYTE *data = NULL;
			DWORD current_length = 0;
			hr = IMFMediaBuffer_Lock(buffer, &data, NULL, &current_length);
			if (SUCCEEDED(hr) && data) {
				sample_bytes = current_length;
				memcpy(first_pixel, data, sizeof(first_pixel));
				printf("frame: %u bytes, first pixel B=%u G=%u R=%u A=%u\n",
				       (unsigned)current_length, first_pixel[0], first_pixel[1],
				       first_pixel[2], first_pixel[3]);
				IMFMediaBuffer_Unlock(buffer);
			}
		}
		if (buffer)
			IMFMediaBuffer_Release(buffer);
	}

	if (sample)
		IMFSample_Release(sample);
	if (requested)
		IMFMediaType_Release(requested);
	if (reader)
		IMFSourceReader_Release(reader);
	if (source)
		IMFMediaSource_Shutdown(source), IMFMediaSource_Release(source);

	/* Leave nothing behind: a session camera disappears on removal, and the
	 * next CI run must start from a clean state. */
	printf("IMFVirtualCamera::Stop: 0x%08lx\n", (unsigned long)IMFVirtualCamera_Stop(virtual_camera));
	printf("IMFVirtualCamera::Remove: 0x%08lx\n", (unsigned long)IMFVirtualCamera_Remove(virtual_camera));
	printf("IMFVirtualCamera::Shutdown: 0x%08lx\n", (unsigned long)IMFVirtualCamera_Shutdown(virtual_camera));
	IMFVirtualCamera_Release(virtual_camera);
	MFShutdown();

	printf("VCAM_READ devices=%u found=%u sample_bytes=%u first_pixel=%u,%u,%u,%u\n",
	       (unsigned)device_count, (unsigned)found, (unsigned)sample_bytes,
	       first_pixel[0], first_pixel[1], first_pixel[2], first_pixel[3]);
	return sample_bytes ? 0 : 1;
}
