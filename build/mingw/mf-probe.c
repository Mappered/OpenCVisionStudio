/*
 * Media Foundation probe.
 *
 * Answers one question before anyone writes a backend: can the MinGW-w64
 * toolchain this project standardised on actually compile and link Media
 * Foundation code? MF is normally consumed with MSVC and the Windows SDK, so
 * this is proven rather than assumed.
 *
 * It also exercises the camera-control discovery paths that a webcam backend
 * would need for set_framegrabber_param, printing which of them a given device
 * actually supports. On a CI runner there are no devices, and that is fine:
 * the point of the CI run is that this compiles, links and exits cleanly.
 *
 * Written in C on purpose - the eventual shim will be C, to avoid dragging a
 * C++ runtime into a MinGW-built native addon.
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>

/* dshow.h first: it brings in strmif.h, which declares IAMCameraControl and
 * IAMVideoProcAmp. Including it after the MF headers trips over their shared
 * definitions. */
#include <dshow.h>

#include <mfapi.h>
#include <mfidl.h>
#include <mfobjects.h>
#include <mfreadwrite.h>

#include <stdio.h>

static const char *hr_text(HRESULT hr)
{
	switch (hr) {
	case S_OK: return "ok";
	case E_NOINTERFACE: return "E_NOINTERFACE";
	case E_NOTIMPL: return "E_NOTIMPL";
	case E_POINTER: return "E_POINTER";
	case E_INVALIDARG: return "E_INVALIDARG";
	case MF_E_INVALIDREQUEST: return "MF_E_INVALIDREQUEST";
	case MF_E_UNSUPPORTED_BYTESTREAM_TYPE: return "MF_E_UNSUPPORTED_BYTESTREAM_TYPE";
	default: return "other";
	}
}

static void report_camera_control(IAMCameraControl *control)
{
	static const struct { const char *name; long property; } properties[] = {
		{ "exposure", CameraControl_Exposure },
		{ "focus",    CameraControl_Focus },
		{ "zoom",     CameraControl_Zoom },
		{ "iris",     CameraControl_Iris },
		{ "pan",      CameraControl_Pan },
		{ "tilt",     CameraControl_Tilt },
		{ "roll",     CameraControl_Roll },
	};

	for (size_t i = 0; i < sizeof(properties) / sizeof(properties[0]); i++) {
		long min = 0, max = 0, step = 0, def = 0, caps = 0;
		long value = 0, flags = 0;
		HRESULT hr = control->lpVtbl->GetRange(control, properties[i].property,
		                                      &min, &max, &step, &def, &caps);
		if (FAILED(hr)) {
			printf("      %-9s unavailable (%s)\n", properties[i].name, hr_text(hr));
			continue;
		}
		HRESULT read = control->lpVtbl->Get(control, properties[i].property, &value, &flags);
		printf("      %-9s range=[%ld..%ld] step=%ld default=%ld caps=0x%lx current=%ld%s\n",
		       properties[i].name, min, max, step, def, caps, value,
		       FAILED(read) ? " (read failed)" : "");
	}
}

static void report_video_proc_amp(IAMVideoProcAmp *amp)
{
	static const struct { const char *name; long property; } properties[] = {
		{ "brightness",   VideoProcAmp_Brightness },
		{ "contrast",     VideoProcAmp_Contrast },
		{ "saturation",   VideoProcAmp_Saturation },
		{ "hue",          VideoProcAmp_Hue },
		{ "sharpness",    VideoProcAmp_Sharpness },
		{ "gamma",        VideoProcAmp_Gamma },
		{ "gain",         VideoProcAmp_Gain },
		{ "white_balance", VideoProcAmp_WhiteBalance },
	};

	for (size_t i = 0; i < sizeof(properties) / sizeof(properties[0]); i++) {
		long min = 0, max = 0, step = 0, def = 0, caps = 0;
		long value = 0, flags = 0;
		HRESULT hr = amp->lpVtbl->GetRange(amp, properties[i].property,
		                                   &min, &max, &step, &def, &caps);
		if (FAILED(hr)) {
			printf("      %-13s unavailable (%s)\n", properties[i].name, hr_text(hr));
			continue;
		}
		HRESULT read = amp->lpVtbl->Get(amp, properties[i].property, &value, &flags);
		printf("      %-13s range=[%ld..%ld] step=%ld default=%ld caps=0x%lx current=%ld%s\n",
		       properties[i].name, min, max, step, def, caps, value,
		       FAILED(read) ? " (read failed)" : "");
	}
}

static void inspect_device(IMFActivate *activate, unsigned index)
{
	WCHAR *name = NULL;
	UINT32 name_length = 0;
	if (SUCCEEDED(IMFActivate_GetAllocatedString(activate,
	                                             &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME,
	                                             &name, &name_length))) {
		wprintf(L"  [%u] %ls\n", index, name);
		CoTaskMemFree(name);
	} else {
		wprintf(L"  [%u] (unnamed device)\n", index);
	}

	IMFMediaSource *source = NULL;
	HRESULT hr = IMFActivate_ActivateObject(activate, &IID_IMFMediaSource, (void **)&source);
	if (FAILED(hr) || !source) {
		printf("      activate failed: %s\n", hr_text(hr));
		return;
	}

	/* Path 1: the source implements the DirectShow-era control interfaces
	 * directly. This is what most UVC sources do. */
	IAMCameraControl *camera_control = NULL;
	hr = IMFMediaSource_QueryInterface(source, &IID_IAMCameraControl, (void **)&camera_control);
	printf("      QueryInterface(IAMCameraControl): %s\n", hr_text(hr));
	if (SUCCEEDED(hr) && camera_control) {
		report_camera_control(camera_control);
		IAMCameraControl_Release(camera_control);
	}

	IAMVideoProcAmp *video_proc_amp = NULL;
	hr = IMFMediaSource_QueryInterface(source, &IID_IAMVideoProcAmp, (void **)&video_proc_amp);
	printf("      QueryInterface(IAMVideoProcAmp): %s\n", hr_text(hr));
	if (SUCCEEDED(hr) && video_proc_amp) {
		report_video_proc_amp(video_proc_amp);
		IAMVideoProcAmp_Release(video_proc_amp);
	}

	/* Path 2: the documented MF route, asking the service provider for the
	 * same interfaces. Devices differ in which path answers, which is exactly
	 * why the probe tries both. */
	IAMCameraControl *service_control = NULL;
	hr = MFGetService((IUnknown *)source, &IID_IAMCameraControl, &IID_IAMCameraControl,
	                  (void **)&service_control);
	printf("      MFGetService(IAMCameraControl): %s\n", hr_text(hr));
	if (SUCCEEDED(hr) && service_control) {
		IAMCameraControl_Release(service_control);
	}

	IMFMediaSource_Release(source);
}

int main(void)
{
	HRESULT hr = CoInitializeEx(NULL, COINIT_MULTITHREADED);
	printf("CoInitializeEx: %s (0x%08lx)\n", hr_text(hr), (unsigned long)hr);

	hr = MFStartup(MF_VERSION, MFSTARTUP_LITE);
	printf("MFStartup: %s (0x%08lx)\n", hr_text(hr), (unsigned long)hr);
	if (FAILED(hr)) {
		printf("MF probe: FAILED at MFStartup\n");
		return 1;
	}

	IMFAttributes *attributes = NULL;
	hr = MFCreateAttributes(&attributes, 2);
	if (FAILED(hr)) {
		printf("MFCreateAttributes failed: %s\n", hr_text(hr));
		MFShutdown();
		return 1;
	}
	IMFAttributes_SetGUID(attributes, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
	                      &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);

	IMFActivate **devices = NULL;
	UINT32 device_count = 0;
	hr = MFEnumDeviceSources(attributes, &devices, &device_count);
	printf("MFEnumDeviceSources: %s (0x%08lx), devices=%u\n",
	       hr_text(hr), (unsigned long)hr, (unsigned)device_count);
	if (FAILED(hr)) {
		IMFAttributes_Release(attributes);
		MFShutdown();
		printf("MF probe: FAILED at MFEnumDeviceSources\n");
		return 1;
	}

	for (UINT32 i = 0; i < device_count; i++) {
		inspect_device(devices[i], i);
		IMFActivate_Release(devices[i]);
	}

	CoTaskMemFree(devices);
	IMFAttributes_Release(attributes);
	MFShutdown();
	CoUninitialize();

	printf("MF probe: ok (devices=%u)\n", (unsigned)device_count);
	return 0;
}
