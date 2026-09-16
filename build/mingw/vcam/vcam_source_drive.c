/*
 * Drives the media source the way the frame server would, without the frame
 * server.
 *
 * Why this exists: the frame server decides whether to adopt a source, and on
 * the machines available here it has not yet adopted ours, so everything
 * downstream of that decision - does the source start, does it attach to the
 * frame bus, does a sample come out carrying the camera's pixels - has been
 * unproven. This harness takes the frame server out of the loop: it creates the
 * media source by CLSID, asks it for a presentation descriptor, starts it,
 * requests samples, and checks the pixels that come back against a frame it
 * published itself.
 *
 * So it separates two questions that have been tangled since the start:
 * whether our media source works, and whether this machine will host a virtual
 * camera.
 */

#define CINTERFACE
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfobjects.h>
#include <mferror.h>
#include <propidl.h>
#include <stdio.h>
#include <string.h>

#include "framebus.h"
#include "vcam_clsid.h"
#include "vcam_yuv.h"

/* A pattern no generated frame would produce, so a sample carrying it can only
 * have come from the bus. */
#define MARK_R 0x11u
#define MARK_G 0x22u
#define MARK_B 0x33u

static void fill_marked(unsigned char *pixels, unsigned long long index)
{
	size_t i;
	size_t count = (size_t)VCAM_FRAME_WIDTH * VCAM_FRAME_HEIGHT;

	for (i = 0; i < count; i++) {
		pixels[i * 4 + 0] = (unsigned char)(MARK_R + (index & 0xFF));
		pixels[i * 4 + 1] = MARK_G;
		pixels[i * 4 + 2] = MARK_B;
		pixels[i * 4 + 3] = 0xFF;
	}
}

/* The stream arrives in a MENewStream / MEUpdatedStream event, which is how
 * Media Foundation hands a stream to whoever started the source. */
static IMFMediaStream *stream_from_event(IMFMediaEvent *event)
{
	PROPVARIANT value;
	IMFMediaStream *stream = NULL;

	PropVariantInit(&value);
	if (SUCCEEDED(IMFMediaEvent_GetValue(event, &value)) && value.vt == VT_UNKNOWN &&
	    value.punkVal)
		value.punkVal->lpVtbl->QueryInterface(value.punkVal, &IID_IMFMediaStream,
		                                      (void **)&stream);
	PropVariantClear(&value);
	return stream;
}

int main(int argc, char **argv)
{
	CLSID clsid;
	IMFActivate *activate = NULL;
	IMFMediaSource *source = NULL;
	IMFPresentationDescriptor *descriptor = NULL;
	IMFMediaEventGenerator *source_events = NULL;
	IMFMediaStream *stream = NULL;
	IMFStreamDescriptor *stream_descriptor = NULL;
	IMFMediaTypeHandler *handler = NULL;
	IMFMediaType *media_type = NULL;
	GUID subtype = GUID_NULL;
	UINT64 frame_size = 0;
	PROPVARIANT start;
	VcamFrameBus bus;
	unsigned char *marked = NULL;
	unsigned samples = 0;
	unsigned bytes = 0;
	unsigned expected_bytes = 0;
	unsigned char first_pixel[4] = { 0, 0, 0, 0 };
	int bus_ready = 0;
	int self_publish = 1;
	int ok = 0;
	HRESULT hr;
	unsigned i;

	setvbuf(stdout, NULL, _IONBF, 0);

	/* --no-publish reads whatever somebody else is publishing, which is how this
	 * is used to show that a live camera's frames reach the media source. */
	if (argc > 1 && strcmp(argv[1], "--no-publish") == 0)
		self_publish = 0;

	if (FAILED(CoInitializeEx(NULL, COINIT_MULTITHREADED))) {
		printf("SOURCE_DRIVE ok=0 stage=com_init\n");
		return 1;
	}
	MFStartup(MF_VERSION, MFSTARTUP_FULL);

	/* Publish first: the media source attaches to the bus when it delivers its
	 * first sample, and the mapping has to outlive this loop. */
	if (self_publish) {
		marked = (unsigned char *)malloc(VCAM_FRAME_BYTES);
		if (!marked) {
			printf("SOURCE_DRIVE ok=0 stage=alloc\n");
			return 1;
		}
		if (framebus_create(&bus, VCAM_FRAME_WIDTH, VCAM_FRAME_HEIGHT)) {
			bus_ready = 1;
			for (i = 0; i < 3; i++) {
				fill_marked(marked, i);
				framebus_publish(&bus, marked, i);
			}
			printf("published 3 marked frames on the bus\n");
		} else {
			printf("note: could not publish on the bus (%lu)\n", (unsigned long)GetLastError());
		}
	} else {
		printf("reading whatever is on the bus (no publisher of our own)\n");
	}

	if (FAILED(CLSIDFromString(VCAM_SOURCE_CLSID_STRING, &clsid))) {
		printf("SOURCE_DRIVE ok=0 stage=clsid\n");
		return 1;
	}

	hr = CoCreateInstance(&clsid, NULL, CLSCTX_INPROC_SERVER, &IID_IMFActivate, (void **)&activate);
	printf("CoCreateInstance(IMFActivate): 0x%08lx\n", (unsigned long)hr);
	if (FAILED(hr))
		goto done;

	hr = IMFActivate_ActivateObject(activate, &IID_IMFMediaSource, (void **)&source);
	printf("ActivateObject(IMFMediaSource): 0x%08lx\n", (unsigned long)hr);
	if (FAILED(hr))
		goto done;

	hr = IMFMediaSource_CreatePresentationDescriptor(source, &descriptor);
	printf("CreatePresentationDescriptor: 0x%08lx\n", (unsigned long)hr);
	if (FAILED(hr))
		goto done;

	{
		BOOL selected = FALSE;
		hr = IMFPresentationDescriptor_GetStreamDescriptorByIndex(descriptor, 0, &selected,
		                                                          &stream_descriptor);
	}
	if (FAILED(hr) ||
	    FAILED(IMFStreamDescriptor_GetMediaTypeHandler(stream_descriptor, &handler)) ||
	    FAILED(IMFMediaTypeHandler_GetCurrentMediaType(handler, &media_type))) {
		printf("SOURCE_DRIVE ok=0 stage=media_type\n");
		goto done;
	}
	IMFMediaType_GetGUID(media_type, &MF_MT_SUBTYPE, &subtype);
	IMFMediaType_GetUINT64(media_type, &MF_MT_FRAME_SIZE, &frame_size);
	/* What a sample has to be follows from the negotiated subtype, not from
	 * what the bus carries. */
	if (IsEqualIID(&subtype, &MFVideoFormat_YUY2))
		expected_bytes = VCAM_FRAME_WIDTH * VCAM_FRAME_HEIGHT * 2u;
	else if (IsEqualIID(&subtype, &MFVideoFormat_RGB32))
		expected_bytes = VCAM_FRAME_BYTES;
	printf("media type: %lux%lu subtype=%s sample_bytes=%u\n",
	       (unsigned long)(frame_size >> 32), (unsigned long)(frame_size & 0xFFFFFFFFu),
	       IsEqualIID(&subtype, &MFVideoFormat_YUY2) ? "YUY2" :
	       IsEqualIID(&subtype, &MFVideoFormat_RGB32) ? "RGB32" :
	       IsEqualIID(&subtype, &MFVideoFormat_NV12) ? "NV12" : "other",
	       expected_bytes);

	PropVariantInit(&start);
	hr = IMFMediaSource_Start(source, descriptor, &GUID_NULL, &start);
	printf("IMFMediaSource::Start: 0x%08lx\n", (unsigned long)hr);
	if (FAILED(hr))
		goto done;

	hr = IMFMediaSource_QueryInterface(source, &IID_IMFMediaEventGenerator,
	                                   (void **)&source_events);
	if (FAILED(hr)) {
		printf("source is not an event generator: 0x%08lx\n", (unsigned long)hr);
		goto done;
	}

	/* MESourceStarted plus the stream: whichever of MENewStream /
	 * MEUpdatedStream arrives is the stream to request samples from. */
	for (i = 0; i < 8 && !stream; i++) {
		IMFMediaEvent *event = NULL;
		MediaEventType type = 0;
		if (FAILED(IMFMediaEventGenerator_GetEvent(source_events, MF_EVENT_FLAG_NO_WAIT, &event)))
			break;
		IMFMediaEvent_GetType(event, &type);
		printf("  source event %lu\n", (unsigned long)type);
		if (type == MENewStream || type == MEUpdatedStream)
			stream = stream_from_event(event);
		IMFMediaEvent_Release(event);
	}
	if (!stream) {
		printf("SOURCE_DRIVE ok=0 stage=no_stream\n");
		goto done;
	}

	/* Ask for frames and read them back. */
	for (i = 0; i < 3; i++) {
		IMFMediaEvent *event = NULL;
		IMFSample *sample = NULL;
		IMFMediaBuffer *buffer = NULL;
		PROPVARIANT value;
		MediaEventType type = 0;
		BYTE *data = NULL;
		DWORD length = 0;

		PropVariantInit(&value);
		if (FAILED(IMFMediaStream_RequestSample(stream, NULL))) {
			printf("  RequestSample %u failed\n", i);
			break;
		}
		if (FAILED(IMFMediaEventGenerator_GetEvent((IMFMediaEventGenerator *)stream,
		                                            MF_EVENT_FLAG_NO_WAIT, &event))) {
			printf("  no sample event for %u\n", i);
			break;
		}
		IMFMediaEvent_GetType(event, &type);
		if (type != MEMediaSample) {
			printf("  stream event %lu instead of a sample\n", (unsigned long)type);
			IMFMediaEvent_Release(event);
			continue;
		}
		if (SUCCEEDED(IMFMediaEvent_GetValue(event, &value)) && value.vt == VT_UNKNOWN &&
		    value.punkVal &&
		    SUCCEEDED(value.punkVal->lpVtbl->QueryInterface(value.punkVal, &IID_IMFSample,
		                                                   (void **)&sample)) &&
		    SUCCEEDED(IMFSample_GetBufferByIndex(sample, 0, &buffer)) &&
		    SUCCEEDED(IMFMediaBuffer_Lock(buffer, &data, NULL, &length))) {
			if (samples == 0) {
				bytes = (unsigned)length;
				memcpy(first_pixel, data, sizeof(first_pixel));
			}
			samples++;
			IMFMediaBuffer_Unlock(buffer);
		}
		PropVariantClear(&value);
		if (buffer)
			IMFMediaBuffer_Release(buffer);
		if (sample)
			IMFSample_Release(sample);
		IMFMediaEvent_Release(event);
	}

	ok = samples > 0 && (expected_bytes == 0 || bytes == expected_bytes);
	/* With our own mark on the bus the pixels have to be that mark; without it,
	 * the frame is somebody else's and only its size can be judged here. The
	 * mark is checked in whatever format the type asked for, using the same
	 * conversion the source used - the newest published frame is index 2, which
	 * is the one a live stream delivers. */
	if (ok && self_publish) {
		if (IsEqualIID(&subtype, &MFVideoFormat_YUY2)) {
			unsigned char y, u, v;
			vcam_rgb_to_yuv(MARK_R + 2u, MARK_G, MARK_B, &y, &u, &v);
			ok = first_pixel[0] == y && first_pixel[2] == y &&
			     first_pixel[1] == u && first_pixel[3] == v;
		} else {
			ok = first_pixel[0] == (unsigned char)(MARK_R + 2u) &&
			     first_pixel[1] == MARK_G && first_pixel[2] == MARK_B;
		}
	}
	printf("sample bytes=%u first_pixel=%02x%02x%02x%02x\n", bytes,
	       first_pixel[0], first_pixel[1], first_pixel[2], first_pixel[3]);
	printf("SOURCE_DRIVE ok=%d samples=%u bus=%d\n", ok, samples, bus_ready);

done:
	if (stream)
		IMFMediaStream_Release(stream);
	if (source_events)
		IMFMediaEventGenerator_Release(source_events);
	if (media_type)
		IMFMediaType_Release(media_type);
	if (handler)
		IMFMediaTypeHandler_Release(handler);
	if (stream_descriptor)
		IMFStreamDescriptor_Release(stream_descriptor);
	if (descriptor)
		IMFPresentationDescriptor_Release(descriptor);
	if (source) {
		IMFMediaSource_Stop(source);
		IMFMediaSource_Shutdown(source);
		IMFMediaSource_Release(source);
	}
	if (activate)
		IMFActivate_Release(activate);
	if (bus_ready)
		framebus_close(&bus);
	free(marked);
	MFShutdown();
	CoUninitialize();
	printf("SOURCE_DRIVE final ok=%d\n", ok);
	return ok ? 0 : 1;
}
