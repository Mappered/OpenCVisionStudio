/*
 * OpenCVisionStudio virtual camera media source.
 *
 * The COM object the Windows frame server activates, by CLSID, when an
 * application opens our virtual camera. It is what turns "we hold an
 * IMFVirtualCamera" into "applications can see a webcam": with nothing
 * registered under the CLSID passed as sourceId, IMFVirtualCamera::Start fails
 * with REGDB_E_CLASSNOTREG, which is how that requirement was established.
 *
 * Frames are generated synthetically on purpose. It keeps the whole path
 * provable in CI with no hardware and no GUI - publish, enumerate, read a frame
 * - and it leaves one clean seam for the Aravis frame bus: replacing
 * fill_pattern with a shared-memory read changes nothing else.
 *
 * The interfaces are declared in vcam_media_interfaces.h rather than taken from
 * MinGW's headers, whose IMFMediaStreamVtbl is missing the queue-parameter
 * methods our object must expose.
 */

#define INITGUID
#define CINTERFACE
#define COBJMACROS
#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <objbase.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfobjects.h>
#include <mferror.h>
#include <stdio.h>
#include <string.h>

#include "vcam_clsid.h"
#include "vcam_media_interfaces.h"

/* {8F2B1E4C-3D6A-4A21-9C7E-5B0D8A3F6C11} */
static const CLSID CLSID_VcamMediaSource = {
	0x8F2B1E4C, 0x3D6A, 0x4A21, { 0x9C, 0x7E, 0x5B, 0x0D, 0x8A, 0x3F, 0x6C, 0x11 }
};

/* The event queues want a "no extended type" GUID. GUID_NULL is not visible in
 * this toolchain's headers, and an all-zero GUID is what it means. Exposed as a
 * pointer because every use site passes it as REFGUID. */
static const GUID kNullGuidValue = { 0, 0, 0, { 0, 0, 0, 0, 0, 0, 0, 0 } };
#define kNullGuid (&kNullGuidValue)

static HMODULE g_module = NULL;
static LONG g_object_count = 0;

typedef struct VcamSource VcamSource;
typedef struct VcamStream VcamStream;

/* ------------------------------------------------------------------ */
/* Trace                                                              */
/* ------------------------------------------------------------------ */

/* The media source runs inside the frame server's process, so its stdout would
 * never reach our CI log. Writing to a file the probe can print afterwards is
 * what makes the server's behaviour observable at all - and that trace is how
 * we learn which interfaces it asks for. */
static FILE *g_log = NULL;

static void vcam_log_open(void)
{
	wchar_t path[MAX_PATH];
	DWORD length;

	if (g_log)
		return;
	length = GetEnvironmentVariableW(L"VCAM_LOG_FILE", path, MAX_PATH);
	if (length == 0 || length >= MAX_PATH) {
		/* Default: alongside the DLL. The frame server is a separate process
		 * that never inherits our environment, but it can always write next to
		 * the module it loaded, and CI knows that path. */
		DWORD module_length = GetModuleFileNameW(g_module, path, MAX_PATH);
		if (module_length == 0 || module_length >= MAX_PATH - 5)
			return;
		wcscat(path, L".log");
	}
	g_log = _wfopen(path, L"a");
}

static const char *iid_name(REFIID riid)
{
	if (IsEqualIID(riid, &IID_IUnknown)) return "IUnknown";
	if (IsEqualIID(riid, &IID_IClassFactory)) return "IClassFactory";
	if (IsEqualIID(riid, &IID_IMFMediaSource)) return "IMFMediaSource";
	if (IsEqualIID(riid, &IID_IMFMediaStream)) return "IMFMediaStream";
	if (IsEqualIID(riid, &IID_IMFMediaEventGenerator)) return "IMFMediaEventGenerator";
	if (IsEqualIID(riid, &IID_IMFAttributes)) return "IMFAttributes";
	if (IsEqualIID(riid, &IID_IMFGetService)) return "IMFGetService";
	if (IsEqualIID(riid, &IID_IMFShutdown)) return "IMFShutdown";
	/* Several interfaces the frame server may ask for - IMFMediaSourceEx,
	 * IMFSampleAllocatorControl, IMFRealTimeClient, IMFQualityAdvise - are not
	 * declared in this toolchain's headers, so they fall through to "(other)"
	 * and the logged GUID identifies them. */
	return "(other)";
}

static void vcam_log(const char *format, ...)
{
	va_list args;
	vcam_log_open();
	if (!g_log)
		return;
	va_start(args, format);
	vfprintf(g_log, format, args);
	va_end(args);
	fputc('\n', g_log);
	fflush(g_log);
}

static void vcam_log_iid(const char *what, REFIID riid, HRESULT hr)
{
	vcam_log("%s riid=%s {%08lx-%04x-%04x} -> 0x%08lx", what, iid_name(riid),
	         (unsigned long)riid->Data1, (unsigned)riid->Data2, (unsigned)riid->Data3,
	         (unsigned long)hr);
}

/* ------------------------------------------------------------------ */
/* Synthetic frame generator                                          */
/* ------------------------------------------------------------------ */

/* RGB32 in Media Foundation is BGRA byte order, and the pattern advances with
 * each frame so a reader can tell frames apart. */
static void fill_pattern(BYTE *pixels, UINT64 frame_index)
{
	const UINT32 bar_width = 40;
	UINT32 bar_x;

	if (frame_index == 0)
		bar_x = 0;
	else
		bar_x = (UINT32)((frame_index * 7) % (VCAM_FRAME_WIDTH + bar_width));

	for (UINT32 y = 0; y < VCAM_FRAME_HEIGHT; y++) {
		BYTE *row = pixels + (size_t)y * VCAM_FRAME_WIDTH * 4;
		for (UINT32 x = 0; x < VCAM_FRAME_WIDTH; x++) {
			BYTE *pixel = row + (size_t)x * 4;
			const int in_bar = (x >= bar_x && x < bar_x + bar_width);
			pixel[0] = in_bar ? 0xE0 : (BYTE)(x & 0xFF);                  /* blue */
			pixel[1] = in_bar ? 0xE0 : (BYTE)(y & 0xFF);                  /* green */
			pixel[2] = in_bar ? 0xE0 : (BYTE)((frame_index * 3) & 0xFF);  /* red */
			pixel[3] = 0xFF;                                              /* alpha */
		}
	}
}

/* The SDK's MAKELONG-style media-type helpers are not declared in this
 * toolchain, and they are two lines each. */
static HRESULT set_attribute_size(IMFMediaType *type, REFGUID key, UINT32 width, UINT32 height)
{
	return IMFMediaType_SetUINT64(type, key, ((UINT64)width << 32) | height);
}

static HRESULT set_attribute_ratio(IMFMediaType *type, REFGUID key, UINT32 numerator, UINT32 denominator)
{
	return IMFMediaType_SetUINT64(type, key, ((UINT64)numerator << 32) | denominator);
}

/* ------------------------------------------------------------------ */
/* Event generation, shared by source and stream                      */
/* ------------------------------------------------------------------ */

typedef struct EventPlumbing {
	IMFMediaEventQueue *queue;
	DWORD *state;    /* 1 stopped, 2 started, 3 paused, 4 shutdown */
} EventPlumbing;

static HRESULT plumbing_get_event(EventPlumbing *p, DWORD flags, IMFMediaEvent **event)
{
	if (*p->state == 4)
		return MF_E_SHUTDOWN;
	return IMFMediaEventQueue_GetEvent(p->queue, flags, event);
}

static HRESULT plumbing_begin_get_event(EventPlumbing *p, IMFAsyncCallback *callback, IUnknown *state)
{
	if (*p->state == 4)
		return MF_E_SHUTDOWN;
	return IMFMediaEventQueue_BeginGetEvent(p->queue, callback, state);
}

static HRESULT plumbing_end_get_event(EventPlumbing *p, IMFAsyncResult *result, IMFMediaEvent **event)
{
	if (*p->state == 4)
		return MF_E_SHUTDOWN;
	return IMFMediaEventQueue_EndGetEvent(p->queue, result, event);
}

/* IMFMediaEventGenerator::QueueEvent takes the event's parts; the queue's own
 * QueueEvent takes a constructed event. Different interfaces, different shapes,
 * which is what the first compile of this file got wrong. */
static HRESULT plumbing_queue_event(EventPlumbing *p, MediaEventType type, REFGUID extended_type,
                                    HRESULT status, IMFMediaEvent *event)
{
	IMFMediaEvent *constructed = NULL;
	HRESULT hr;

	if (*p->state == 4)
		return MF_E_SHUTDOWN;
	if (event) {
		IMFMediaEvent_AddRef(event);
		constructed = event;
	} else {
		hr = MFCreateMediaEvent(type, extended_type, status, NULL, &constructed);
		if (FAILED(hr))
			return hr;
	}
	hr = IMFMediaEventQueue_QueueEvent(p->queue, constructed);
	IMFMediaEvent_Release(constructed);
	return hr;
}

static HRESULT plumbing_queue_param_var(EventPlumbing *p, MediaEventType type, REFGUID extended_type,
                                        HRESULT status, const PROPVARIANT *value)
{
	if (*p->state == 4)
		return MF_E_SHUTDOWN;
	return IMFMediaEventQueue_QueueEventParamVar(p->queue, type, extended_type, status, value);
}

static HRESULT plumbing_queue_param_unk(EventPlumbing *p, MediaEventType type, REFGUID extended_type,
                                        HRESULT status, IUnknown *value)
{
	if (*p->state == 4)
		return MF_E_SHUTDOWN;
	return IMFMediaEventQueue_QueueEventParamUnk(p->queue, type, extended_type, status, value);
}

/* ------------------------------------------------------------------ */
/* Stream                                                             */
/* ------------------------------------------------------------------ */

struct VcamStream {
	const VcamMediaStreamVtbl *lpVtbl;
	LONG refcount;
	DWORD state;
	IMFMediaEventQueue *queue;
	VcamSource *source;
	IMFStreamDescriptor *descriptor;
	UINT64 frame_index;
};

static void stream_destroy(VcamStream *self)
{
	if (self->queue) {
		IMFMediaEventQueue_Shutdown(self->queue);
		IMFMediaEventQueue_Release(self->queue);
	}
	if (self->descriptor)
		IMFStreamDescriptor_Release(self->descriptor);
	free(self);
}

static void stream_release_internal(VcamStream *self)
{
	if (InterlockedDecrement(&self->refcount) == 0) {
		stream_destroy(self);
		InterlockedDecrement(&g_object_count);
	}
}

static HRESULT STDMETHODCALLTYPE stream_query_interface(void *This, REFIID riid, void **out)
{
	VcamStream *self = (VcamStream *)This;
	HRESULT hr = E_NOINTERFACE;
	if (!out)
		return E_POINTER;
	*out = NULL;
	if (IsEqualIID(riid, &IID_IUnknown) || IsEqualIID(riid, &IID_IMFMediaEventGenerator) ||
	    IsEqualIID(riid, &IID_IMFMediaStream)) {
		*out = self;
		InterlockedIncrement(&self->refcount);
		hr = S_OK;
	}
	vcam_log_iid("stream QueryInterface", riid, hr);
	return hr;
}

static ULONG STDMETHODCALLTYPE stream_add_ref(void *This)
{
	return (ULONG)InterlockedIncrement(&((VcamStream *)This)->refcount);
}

static ULONG STDMETHODCALLTYPE stream_release(void *This)
{
	VcamStream *self = (VcamStream *)This;
	LONG remaining = InterlockedDecrement(&self->refcount);
	if (remaining == 0) {
		stream_destroy(self);
		InterlockedDecrement(&g_object_count);
	}
	return (ULONG)remaining;
}

static HRESULT STDMETHODCALLTYPE stream_get_event(void *This, DWORD flags, IMFMediaEvent **event)
{
	VcamStream *self = (VcamStream *)This;
	EventPlumbing p = { self->queue, &self->state };
	return plumbing_get_event(&p, flags, event);
}

static HRESULT STDMETHODCALLTYPE stream_begin_get_event(void *This, IMFAsyncCallback *callback, IUnknown *state)
{
	VcamStream *self = (VcamStream *)This;
	EventPlumbing p = { self->queue, &self->state };
	return plumbing_begin_get_event(&p, callback, state);
}

static HRESULT STDMETHODCALLTYPE stream_end_get_event(void *This, IMFAsyncResult *result, IMFMediaEvent **event)
{
	VcamStream *self = (VcamStream *)This;
	EventPlumbing p = { self->queue, &self->state };
	return plumbing_end_get_event(&p, result, event);
}

static HRESULT STDMETHODCALLTYPE stream_queue_event(void *This, MediaEventType type, REFGUID extended_type,
                                                    HRESULT status, IMFMediaEvent *event)
{
	VcamStream *self = (VcamStream *)This;
	EventPlumbing p = { self->queue, &self->state };
	return plumbing_queue_event(&p, type, extended_type, status, event);
}

static HRESULT STDMETHODCALLTYPE stream_queue_param_var(void *This, MediaEventType type, REFGUID extended_type,
                                                        HRESULT status, const PROPVARIANT *value)
{
	VcamStream *self = (VcamStream *)This;
	EventPlumbing p = { self->queue, &self->state };
	return plumbing_queue_param_var(&p, type, extended_type, status, value);
}

static HRESULT STDMETHODCALLTYPE stream_queue_param_unk(void *This, MediaEventType type, REFGUID extended_type,
                                                        HRESULT status, IUnknown *value)
{
	VcamStream *self = (VcamStream *)This;
	EventPlumbing p = { self->queue, &self->state };
	return plumbing_queue_param_unk(&p, type, extended_type, status, value);
}

static HRESULT STDMETHODCALLTYPE stream_get_media_source(void *This, IMFMediaSource **source)
{
	VcamStream *self = (VcamStream *)This;
	if (!source)
		return E_POINTER;
	*source = (IMFMediaSource *)self->source;
	IMFMediaSource_AddRef(*source);
	return S_OK;
}

static HRESULT STDMETHODCALLTYPE stream_get_stream_descriptor(void *This, IMFStreamDescriptor **descriptor)
{
	VcamStream *self = (VcamStream *)This;
	if (!descriptor)
		return E_POINTER;
	*descriptor = self->descriptor;
	IMFStreamDescriptor_AddRef(*descriptor);
	return S_OK;
}

/* One frame per request, which is what a live source does. */
static HRESULT STDMETHODCALLTYPE stream_request_sample(void *This, IUnknown *token)
{
	VcamStream *self = (VcamStream *)This;
	IMFMediaBuffer *buffer = NULL;
	IMFSample *sample = NULL;
	BYTE *pixels = NULL;
	HRESULT hr;

	vcam_log("stream RequestSample (#%llu)", (unsigned long long)self->frame_index);

	if (self->state == 4)
		return MF_E_SHUTDOWN;
	if (self->state != 2)
		return MF_E_INVALIDREQUEST;

	hr = MFCreateMemoryBuffer(VCAM_FRAME_BYTES, &buffer);
	if (FAILED(hr))
		return hr;
	hr = IMFMediaBuffer_Lock(buffer, &pixels, NULL, NULL);
	if (FAILED(hr)) {
		IMFMediaBuffer_Release(buffer);
		return hr;
	}
	fill_pattern(pixels, self->frame_index++);
	IMFMediaBuffer_Unlock(buffer);
	IMFMediaBuffer_SetCurrentLength(buffer, VCAM_FRAME_BYTES);

	hr = MFCreateSample(&sample);
	if (SUCCEEDED(hr))
		hr = IMFSample_AddBuffer(sample, buffer);
	if (SUCCEEDED(hr)) {
		const LONGLONG duration = 10000000LL / VCAM_FRAME_FPS;
		IMFSample_SetSampleTime(sample, (LONGLONG)(self->frame_index - 1) * duration);
		IMFSample_SetSampleDuration(sample, duration);
		if (token)
			IMFSample_SetUnknown(sample, &MFSampleExtension_Token, token);
	}
	if (SUCCEEDED(hr)) {
		EventPlumbing p = { self->queue, &self->state };
		hr = plumbing_queue_param_unk(&p, MEMediaSample, kNullGuid, S_OK, (IUnknown *)sample);
	}

	if (sample)
		IMFSample_Release(sample);
	IMFMediaBuffer_Release(buffer);
	return hr;
}

static const VcamMediaStreamVtbl vcam_stream_vtbl = {
	.generator = {
		.QueryInterface = stream_query_interface,
		.AddRef = stream_add_ref,
		.Release = stream_release,
		.GetEvent = stream_get_event,
		.BeginGetEvent = stream_begin_get_event,
		.EndGetEvent = stream_end_get_event,
		.QueueEvent = stream_queue_event,
		.QueueEventParamVar = stream_queue_param_var,
		.QueueEventParamUnk = stream_queue_param_unk,
	},
	.GetMediaSource = stream_get_media_source,
	.GetStreamDescriptor = stream_get_stream_descriptor,
	.RequestSample = stream_request_sample,
};

/* ------------------------------------------------------------------ */
/* Source                                                             */
/* ------------------------------------------------------------------ */

struct VcamSource {
	const VcamMediaSourceVtbl *lpVtbl;
	LONG refcount;
	DWORD state;
	IMFMediaEventQueue *queue;
	IMFPresentationDescriptor *descriptor;
	IMFStreamDescriptor *stream_descriptor;
	VcamStream *stream;
};

static void source_destroy(VcamSource *self)
{
	if (self->stream) {
		stream_release_internal(self->stream);
		self->stream = NULL;
	}
	if (self->queue) {
		IMFMediaEventQueue_Shutdown(self->queue);
		IMFMediaEventQueue_Release(self->queue);
	}
	if (self->descriptor)
		IMFPresentationDescriptor_Release(self->descriptor);
	if (self->stream_descriptor)
		IMFStreamDescriptor_Release(self->stream_descriptor);
	free(self);
}

static HRESULT STDMETHODCALLTYPE source_query_interface(void *This, REFIID riid, void **out)
{
	VcamSource *self = (VcamSource *)This;
	HRESULT hr = E_NOINTERFACE;
	if (!out)
		return E_POINTER;
	*out = NULL;
	if (IsEqualIID(riid, &IID_IUnknown) || IsEqualIID(riid, &IID_IMFMediaEventGenerator) ||
	    IsEqualIID(riid, &IID_IMFMediaSource)) {
		*out = self;
		InterlockedIncrement(&self->refcount);
		hr = S_OK;
	}
	vcam_log_iid("source QueryInterface", riid, hr);
	return hr;
}

static ULONG STDMETHODCALLTYPE source_add_ref(void *This)
{
	return (ULONG)InterlockedIncrement(&((VcamSource *)This)->refcount);
}

static ULONG STDMETHODCALLTYPE source_release(void *This)
{
	VcamSource *self = (VcamSource *)This;
	LONG remaining = InterlockedDecrement(&self->refcount);
	if (remaining == 0) {
		source_destroy(self);
		InterlockedDecrement(&g_object_count);
	}
	return (ULONG)remaining;
}

static HRESULT STDMETHODCALLTYPE source_get_event(void *This, DWORD flags, IMFMediaEvent **event)
{
	VcamSource *self = (VcamSource *)This;
	EventPlumbing p = { self->queue, &self->state };
	return plumbing_get_event(&p, flags, event);
}

static HRESULT STDMETHODCALLTYPE source_begin_get_event(void *This, IMFAsyncCallback *callback, IUnknown *state)
{
	VcamSource *self = (VcamSource *)This;
	EventPlumbing p = { self->queue, &self->state };
	return plumbing_begin_get_event(&p, callback, state);
}

static HRESULT STDMETHODCALLTYPE source_end_get_event(void *This, IMFAsyncResult *result, IMFMediaEvent **event)
{
	VcamSource *self = (VcamSource *)This;
	EventPlumbing p = { self->queue, &self->state };
	return plumbing_end_get_event(&p, result, event);
}

static HRESULT STDMETHODCALLTYPE source_queue_event(void *This, MediaEventType type, REFGUID extended_type,
                                                    HRESULT status, IMFMediaEvent *event)
{
	VcamSource *self = (VcamSource *)This;
	EventPlumbing p = { self->queue, &self->state };
	return plumbing_queue_event(&p, type, extended_type, status, event);
}

static HRESULT STDMETHODCALLTYPE source_queue_param_var(void *This, MediaEventType type, REFGUID extended_type,
                                                        HRESULT status, const PROPVARIANT *value)
{
	VcamSource *self = (VcamSource *)This;
	EventPlumbing p = { self->queue, &self->state };
	return plumbing_queue_param_var(&p, type, extended_type, status, value);
}

static HRESULT STDMETHODCALLTYPE source_queue_param_unk(void *This, MediaEventType type, REFGUID extended_type,
                                                        HRESULT status, IUnknown *value)
{
	VcamSource *self = (VcamSource *)This;
	EventPlumbing p = { self->queue, &self->state };
	return plumbing_queue_param_unk(&p, type, extended_type, status, value);
}

static HRESULT STDMETHODCALLTYPE source_get_characteristics(void *This, DWORD *characteristics)
{
	(void)This;
	if (!characteristics)
		return E_POINTER;
	*characteristics = MFMEDIASOURCE_IS_LIVE;
	vcam_log("source GetCharacteristics -> MFMEDIASOURCE_IS_LIVE");
	return S_OK;
}

/* One video stream: RGB32, 640x480, 30 fps. */
static HRESULT source_build_presentation(VcamSource *self)
{
	IMFMediaType *media_type = NULL;
	IMFMediaTypeHandler *handler = NULL;
	HRESULT hr;

	if (self->descriptor)
		return S_OK;

	hr = MFCreateMediaType(&media_type);
	if (SUCCEEDED(hr))
		hr = IMFMediaType_SetGUID(media_type, &MF_MT_MAJOR_TYPE, &MFMediaType_Video);
	if (SUCCEEDED(hr))
		hr = IMFMediaType_SetGUID(media_type, &MF_MT_SUBTYPE, &MFVideoFormat_RGB32);
	if (SUCCEEDED(hr))
		hr = set_attribute_size(media_type, &MF_MT_FRAME_SIZE, VCAM_FRAME_WIDTH, VCAM_FRAME_HEIGHT);
	if (SUCCEEDED(hr))
		hr = set_attribute_ratio(media_type, &MF_MT_FRAME_RATE, VCAM_FRAME_FPS, 1);
	if (SUCCEEDED(hr))
		hr = set_attribute_ratio(media_type, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
	if (SUCCEEDED(hr))
		hr = IMFMediaType_SetUINT32(media_type, &MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
	if (SUCCEEDED(hr))
		hr = MFCreateStreamDescriptor(0, 1, &media_type, &self->stream_descriptor);
	if (SUCCEEDED(hr))
		hr = IMFStreamDescriptor_GetMediaTypeHandler(self->stream_descriptor, &handler);
	if (SUCCEEDED(hr))
		hr = IMFMediaTypeHandler_SetCurrentMediaType(handler, media_type);
	if (SUCCEEDED(hr))
		hr = MFCreatePresentationDescriptor(1, &self->stream_descriptor, &self->descriptor);
	if (SUCCEEDED(hr))
		hr = IMFPresentationDescriptor_SelectStream(self->descriptor, 0);

	if (handler)
		IMFMediaTypeHandler_Release(handler);
	if (media_type)
		IMFMediaType_Release(media_type);
	return hr;
}

static HRESULT STDMETHODCALLTYPE source_create_presentation_descriptor(void *This, IMFPresentationDescriptor **descriptor)
{
	VcamSource *self = (VcamSource *)This;
	HRESULT hr;
	if (!descriptor)
		return E_POINTER;
	if (self->state == 4)
		return MF_E_SHUTDOWN;
	hr = source_build_presentation(self);
	if (FAILED(hr))
		return hr;
	*descriptor = self->descriptor;
	IMFPresentationDescriptor_AddRef(*descriptor);
	vcam_log("source CreatePresentationDescriptor -> ok (%dx%d RGB32)", VCAM_FRAME_WIDTH, VCAM_FRAME_HEIGHT);
	return S_OK;
}

static HRESULT source_create_stream(VcamSource *self)
{
	HRESULT hr;
	if (self->stream)
		return S_OK;
	hr = source_build_presentation(self);
	if (FAILED(hr))
		return hr;
	self->stream = (VcamStream *)calloc(1, sizeof(VcamStream));
	if (!self->stream)
		return E_OUTOFMEMORY;
	hr = MFCreateEventQueue(&self->stream->queue);
	if (FAILED(hr)) {
		free(self->stream);
		self->stream = NULL;
		return hr;
	}
	self->stream->lpVtbl = &vcam_stream_vtbl;
	self->stream->refcount = 1;
	self->stream->state = 1;
	self->stream->source = self;
	self->stream->descriptor = self->stream_descriptor;
	IMFStreamDescriptor_AddRef(self->stream_descriptor);
	self->stream->frame_index = 0;
	InterlockedIncrement(&g_object_count);
	return S_OK;
}

static HRESULT STDMETHODCALLTYPE source_start(void *This, IMFPresentationDescriptor *descriptor,
                                              const GUID *time_format, const PROPVARIANT *start_position)
{
	VcamSource *self = (VcamSource *)This;
	EventPlumbing p;
	HRESULT hr;

	(void)descriptor;
	(void)time_format;

	vcam_log("source Start (state=%lu)", (unsigned long)self->state);

	if (self->state == 4)
		return MF_E_SHUTDOWN;

	hr = source_create_stream(self);
	if (FAILED(hr))
		return hr;

	p.queue = self->queue;
	p.state = &self->state;

	hr = plumbing_queue_param_unk(&p, MENewStream, kNullGuid, S_OK, (IUnknown *)self->stream);
	if (SUCCEEDED(hr))
		hr = plumbing_queue_param_unk(&p, MEUpdatedStream, kNullGuid, S_OK, (IUnknown *)self->stream);
	if (SUCCEEDED(hr))
		hr = plumbing_queue_param_var(&p, MESourceStarted, kNullGuid, S_OK, start_position);
	if (SUCCEEDED(hr)) {
		self->state = 2;
		self->stream->state = 2;
		hr = plumbing_queue_param_var(&p, MEStreamStarted, kNullGuid, S_OK, start_position);
	}
	vcam_log("source Start -> 0x%08lx", (unsigned long)hr);
	return hr;
}

static HRESULT STDMETHODCALLTYPE source_stop(void *This)
{
	VcamSource *self = (VcamSource *)This;
	EventPlumbing p;
	vcam_log("source Stop (state=%lu)", (unsigned long)self->state);
	if (self->state == 4)
		return MF_E_SHUTDOWN;
	if (self->state == 1)
		return MF_E_INVALIDREQUEST;
	self->state = 1;
	p.queue = self->queue;
	p.state = &self->state;
	if (self->stream) {
		self->stream->state = 1;
		plumbing_queue_param_var(&p, MEStreamStopped, kNullGuid, S_OK, NULL);
	}
	return plumbing_queue_param_var(&p, MESourceStopped, kNullGuid, S_OK, NULL);
}

static HRESULT STDMETHODCALLTYPE source_pause(void *This)
{
	VcamSource *self = (VcamSource *)This;
	EventPlumbing p;
	vcam_log("source Pause (state=%lu)", (unsigned long)self->state);
	if (self->state == 4)
		return MF_E_SHUTDOWN;
	if (self->state != 2)
		return MF_E_INVALIDREQUEST;
	self->state = 3;
	p.queue = self->queue;
	p.state = &self->state;
	if (self->stream) {
		self->stream->state = 3;
		plumbing_queue_param_var(&p, MEStreamPaused, kNullGuid, S_OK, NULL);
	}
	return plumbing_queue_param_var(&p, MESourcePaused, kNullGuid, S_OK, NULL);
}

static HRESULT STDMETHODCALLTYPE source_shutdown(void *This)
{
	VcamSource *self = (VcamSource *)This;
	vcam_log("source Shutdown");
	self->state = 4;
	if (self->stream) {
		self->stream->state = 4;
		if (self->stream->queue)
			IMFMediaEventQueue_Shutdown(self->stream->queue);
	}
	if (self->queue)
		IMFMediaEventQueue_Shutdown(self->queue);
	return S_OK;
}

static const VcamMediaSourceVtbl vcam_source_vtbl = {
	.generator = {
		.QueryInterface = source_query_interface,
		.AddRef = source_add_ref,
		.Release = source_release,
		.GetEvent = source_get_event,
		.BeginGetEvent = source_begin_get_event,
		.EndGetEvent = source_end_get_event,
		.QueueEvent = source_queue_event,
		.QueueEventParamVar = source_queue_param_var,
		.QueueEventParamUnk = source_queue_param_unk,
	},
	.GetCharacteristics = source_get_characteristics,
	.CreatePresentationDescriptor = source_create_presentation_descriptor,
	.Start = source_start,
	.Stop = source_stop,
	.Pause = source_pause,
	.Shutdown = source_shutdown,
};

static HRESULT vcam_source_create(IUnknown *outer, REFIID riid, void **out)
{
	VcamSource *self;
	HRESULT hr;
	if (outer)
		return CLASS_E_NOAGGREGATION;
	self = (VcamSource *)calloc(1, sizeof(VcamSource));
	if (!self)
		return E_OUTOFMEMORY;
	self->lpVtbl = &vcam_source_vtbl;
	self->refcount = 1;
	self->state = 1;
	hr = MFCreateEventQueue(&self->queue);
	if (FAILED(hr)) {
		free(self);
		return hr;
	}
	InterlockedIncrement(&g_object_count);
	hr = source_query_interface(self, riid, out);
	source_release(self);
	return hr;
}

/* ------------------------------------------------------------------ */
/* Activator                                                          */
/* ------------------------------------------------------------------ */

/* Media Foundation asks the CLSID for IMFActivate, not for the media source
 * directly: the object is an *activator*, an IMFAttributes whose
 * ActivateObject produces the source. That was established by tracing the frame
 * server's QueryInterface calls - it asked for IID_IMFActivate and we answered
 * E_NOINTERFACE, which surfaced as E_NOINTERFACE from
 * IMFVirtualCamera::Start. */

typedef struct VcamActivator {
	const VcamActivatorVtbl *lpVtbl;
	LONG refcount;
	IMFAttributes *attributes;
	VcamSource *source;
} VcamActivator;

/* The attribute methods are forwarded to a real IMFAttributes rather than
 * reimplemented: the storage rules are not our business, only the identity. */
#define ACTIVATOR_ATTR_FORWARD(name, decl, call) \
	static HRESULT STDMETHODCALLTYPE activator_##name decl \
	{ \
		VcamActivator *self = (VcamActivator *)This; \
		return IMFAttributes_##name call; \
	}

ACTIVATOR_ATTR_FORWARD(GetItem, (IMFAttributes *This, REFGUID key, PROPVARIANT *value), (self->attributes, key, value))
ACTIVATOR_ATTR_FORWARD(GetItemType, (IMFAttributes *This, REFGUID key, MF_ATTRIBUTE_TYPE *type), (self->attributes, key, type))
ACTIVATOR_ATTR_FORWARD(CompareItem, (IMFAttributes *This, REFGUID key, REFPROPVARIANT value, BOOL *result), (self->attributes, key, value, result))
ACTIVATOR_ATTR_FORWARD(Compare, (IMFAttributes *This, IMFAttributes *theirs, MF_ATTRIBUTES_MATCH_TYPE match, BOOL *result), (self->attributes, theirs, match, result))
ACTIVATOR_ATTR_FORWARD(GetUINT32, (IMFAttributes *This, REFGUID key, UINT32 *value), (self->attributes, key, value))
ACTIVATOR_ATTR_FORWARD(GetUINT64, (IMFAttributes *This, REFGUID key, UINT64 *value), (self->attributes, key, value))
ACTIVATOR_ATTR_FORWARD(GetDouble, (IMFAttributes *This, REFGUID key, double *value), (self->attributes, key, value))
ACTIVATOR_ATTR_FORWARD(GetGUID, (IMFAttributes *This, REFGUID key, GUID *value), (self->attributes, key, value))
ACTIVATOR_ATTR_FORWARD(GetStringLength, (IMFAttributes *This, REFGUID key, UINT32 *length), (self->attributes, key, length))
ACTIVATOR_ATTR_FORWARD(GetString, (IMFAttributes *This, REFGUID key, LPWSTR value, UINT32 size, UINT32 *length), (self->attributes, key, value, size, length))
ACTIVATOR_ATTR_FORWARD(GetAllocatedString, (IMFAttributes *This, REFGUID key, LPWSTR *value, UINT32 *length), (self->attributes, key, value, length))
ACTIVATOR_ATTR_FORWARD(GetBlobSize, (IMFAttributes *This, REFGUID key, UINT32 *size), (self->attributes, key, size))
ACTIVATOR_ATTR_FORWARD(GetBlob, (IMFAttributes *This, REFGUID key, UINT8 *buffer, UINT32 size, UINT32 *blob_size), (self->attributes, key, buffer, size, blob_size))
ACTIVATOR_ATTR_FORWARD(GetAllocatedBlob, (IMFAttributes *This, REFGUID key, UINT8 **buffer, UINT32 *size), (self->attributes, key, buffer, size))
ACTIVATOR_ATTR_FORWARD(GetUnknown, (IMFAttributes *This, REFGUID key, REFIID riid, LPVOID *value), (self->attributes, key, riid, value))
ACTIVATOR_ATTR_FORWARD(SetItem, (IMFAttributes *This, REFGUID key, REFPROPVARIANT value), (self->attributes, key, value))
ACTIVATOR_ATTR_FORWARD(DeleteItem, (IMFAttributes *This, REFGUID key), (self->attributes, key))
ACTIVATOR_ATTR_FORWARD(DeleteAllItems, (IMFAttributes *This), (self->attributes))
ACTIVATOR_ATTR_FORWARD(SetUINT32, (IMFAttributes *This, REFGUID key, UINT32 value), (self->attributes, key, value))
ACTIVATOR_ATTR_FORWARD(SetUINT64, (IMFAttributes *This, REFGUID key, UINT64 value), (self->attributes, key, value))
ACTIVATOR_ATTR_FORWARD(SetDouble, (IMFAttributes *This, REFGUID key, double value), (self->attributes, key, value))
ACTIVATOR_ATTR_FORWARD(SetGUID, (IMFAttributes *This, REFGUID key, REFGUID value), (self->attributes, key, value))
ACTIVATOR_ATTR_FORWARD(SetString, (IMFAttributes *This, REFGUID key, LPCWSTR value), (self->attributes, key, value))
ACTIVATOR_ATTR_FORWARD(SetBlob, (IMFAttributes *This, REFGUID key, const UINT8 *buffer, UINT32 size), (self->attributes, key, buffer, size))
ACTIVATOR_ATTR_FORWARD(SetUnknown, (IMFAttributes *This, REFGUID key, IUnknown *value), (self->attributes, key, value))
ACTIVATOR_ATTR_FORWARD(LockStore, (IMFAttributes *This), (self->attributes))
ACTIVATOR_ATTR_FORWARD(UnlockStore, (IMFAttributes *This), (self->attributes))
ACTIVATOR_ATTR_FORWARD(GetCount, (IMFAttributes *This, UINT32 *count), (self->attributes, count))
ACTIVATOR_ATTR_FORWARD(GetItemByIndex, (IMFAttributes *This, UINT32 index, GUID *key, PROPVARIANT *value), (self->attributes, index, key, value))
ACTIVATOR_ATTR_FORWARD(CopyAllItems, (IMFAttributes *This, IMFAttributes *destination), (self->attributes, destination))

static HRESULT vcam_activator_create(IUnknown *outer, REFIID riid, void **out);

static HRESULT STDMETHODCALLTYPE activator_query_interface(IMFAttributes *This, REFIID riid, void **out)
{
	VcamActivator *self = (VcamActivator *)This;
	HRESULT hr = E_NOINTERFACE;
	if (!out)
		return E_POINTER;
	*out = NULL;
	if (IsEqualIID(riid, &IID_IUnknown) || IsEqualIID(riid, &IID_IMFAttributes) ||
	    IsEqualIID(riid, &IID_IMFActivate)) {
		*out = self;
		InterlockedIncrement(&self->refcount);
		hr = S_OK;
	}
	vcam_log_iid("activator QueryInterface", riid, hr);
	return hr;
}

static ULONG STDMETHODCALLTYPE activator_add_ref(IMFAttributes *This)
{
	return (ULONG)InterlockedIncrement(&((VcamActivator *)This)->refcount);
}

static ULONG STDMETHODCALLTYPE activator_release(IMFAttributes *This)
{
	VcamActivator *self = (VcamActivator *)This;
	LONG remaining = InterlockedDecrement(&self->refcount);
	if (remaining == 0) {
		if (self->source) {
			source_shutdown((void *)self->source);
			source_release((void *)self->source);
		}
		if (self->attributes)
			IMFAttributes_Release(self->attributes);
		free(self);
		InterlockedDecrement(&g_object_count);
	}
	return (ULONG)remaining;
}

static HRESULT STDMETHODCALLTYPE activator_activate_object(void *This, REFIID riid, void **ppv)
{
	VcamActivator *self = (VcamActivator *)This;
	HRESULT hr;

	if (!ppv)
		return E_POINTER;
	*ppv = NULL;

	vcam_log_iid("activator ActivateObject", riid, S_OK);

	if (!self->source) {
		IUnknown *unknown = NULL;
		hr = vcam_source_create(NULL, &IID_IUnknown, (void **)&unknown);
		if (FAILED(hr)) {
			vcam_log("activator ActivateObject: creating the source failed 0x%08lx", (unsigned long)hr);
			return hr;
		}
		/* vcam_source_create hands back an IUnknown; same object. */
		self->source = (VcamSource *)unknown;
	}

	hr = source_query_interface(self->source, riid, ppv);
	vcam_log("activator ActivateObject -> 0x%08lx", (unsigned long)hr);
	return hr;
}

static HRESULT STDMETHODCALLTYPE activator_shutdown_object(void *This)
{
	VcamActivator *self = (VcamActivator *)This;
	vcam_log("activator ShutdownObject");
	if (self->source)
		source_shutdown((void *)self->source);
	return S_OK;
}

static HRESULT STDMETHODCALLTYPE activator_detach_object(void *This)
{
	(void)This;
	vcam_log("activator DetachObject");
	return S_OK;
}

static const VcamActivatorVtbl vcam_activator_vtbl = {
	.attributes = {
		.QueryInterface = activator_query_interface,
		.AddRef = activator_add_ref,
		.Release = activator_release,
		.GetItem = activator_GetItem,
		.GetItemType = activator_GetItemType,
		.CompareItem = activator_CompareItem,
		.Compare = activator_Compare,
		.GetUINT32 = activator_GetUINT32,
		.GetUINT64 = activator_GetUINT64,
		.GetDouble = activator_GetDouble,
		.GetGUID = activator_GetGUID,
		.GetStringLength = activator_GetStringLength,
		.GetString = activator_GetString,
		.GetAllocatedString = activator_GetAllocatedString,
		.GetBlobSize = activator_GetBlobSize,
		.GetBlob = activator_GetBlob,
		.GetAllocatedBlob = activator_GetAllocatedBlob,
		.GetUnknown = activator_GetUnknown,
		.SetItem = activator_SetItem,
		.DeleteItem = activator_DeleteItem,
		.DeleteAllItems = activator_DeleteAllItems,
		.SetUINT32 = activator_SetUINT32,
		.SetUINT64 = activator_SetUINT64,
		.SetDouble = activator_SetDouble,
		.SetGUID = activator_SetGUID,
		.SetString = activator_SetString,
		.SetBlob = activator_SetBlob,
		.SetUnknown = activator_SetUnknown,
		.LockStore = activator_LockStore,
		.UnlockStore = activator_UnlockStore,
		.GetCount = activator_GetCount,
		.GetItemByIndex = activator_GetItemByIndex,
		.CopyAllItems = activator_CopyAllItems,
	},
	.ActivateObject = activator_activate_object,
	.ShutdownObject = activator_shutdown_object,
	.DetachObject = activator_detach_object,
};

static HRESULT vcam_activator_create(IUnknown *outer, REFIID riid, void **out)
{
	VcamActivator *self;
	HRESULT hr;

	if (outer)
		return CLASS_E_NOAGGREGATION;
	self = (VcamActivator *)calloc(1, sizeof(VcamActivator));
	if (!self)
		return E_OUTOFMEMORY;
	self->lpVtbl = &vcam_activator_vtbl;
	self->refcount = 1;
	hr = MFCreateAttributes(&self->attributes, 2);
	if (FAILED(hr)) {
		free(self);
		return hr;
	}
	/* A friendly name is cheap and makes the object identifiable while
	 * debugging; the real identity is the CLSID. */
	IMFAttributes_SetString(self->attributes, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, VCAM_FRIENDLY_NAME);
	InterlockedIncrement(&g_object_count);
	hr = activator_query_interface((IMFAttributes *)self, riid, out);
	activator_release((IMFAttributes *)self);
	return hr;
}

/* ------------------------------------------------------------------ */
/* Class factory                                                      */
/* ------------------------------------------------------------------ */

typedef struct VcamClassFactory {
	const IClassFactoryVtbl *lpVtbl;
	LONG refcount;
} VcamClassFactory;

static HRESULT STDMETHODCALLTYPE factory_query_interface(IClassFactory *This, REFIID riid, void **out)
{
	HRESULT hr = E_NOINTERFACE;
	if (!out)
		return E_POINTER;
	*out = NULL;
	if (IsEqualIID(riid, &IID_IUnknown) || IsEqualIID(riid, &IID_IClassFactory)) {
		*out = This;
		InterlockedIncrement(&((VcamClassFactory *)This)->refcount);
		hr = S_OK;
	}
	vcam_log_iid("factory QueryInterface", riid, hr);
	return hr;
}

static ULONG STDMETHODCALLTYPE factory_add_ref(IClassFactory *This)
{
	return (ULONG)InterlockedIncrement(&((VcamClassFactory *)This)->refcount);
}

static ULONG STDMETHODCALLTYPE factory_release(IClassFactory *This)
{
	LONG remaining = InterlockedDecrement(&((VcamClassFactory *)This)->refcount);
	if (remaining == 0)
		free(This);
	return (ULONG)remaining;
}

static HRESULT STDMETHODCALLTYPE factory_create_instance(IClassFactory *This, IUnknown *outer,
                                                         REFIID riid, void **out)
{
	(void)This;
	/* The CLSID provides the activator, not the media source: that is what
	 * Media Foundation asks for, and ActivateObject hands out the source. */
	return vcam_activator_create(outer, riid, out);
}

static HRESULT STDMETHODCALLTYPE factory_lock_server(IClassFactory *This, BOOL lock)
{
	(void)This;
	(void)lock;
	return S_OK;
}

static const IClassFactoryVtbl vcam_factory_vtbl = {
	.QueryInterface = factory_query_interface,
	.AddRef = factory_add_ref,
	.Release = factory_release,
	.CreateInstance = factory_create_instance,
	.LockServer = factory_lock_server,
};

/* ------------------------------------------------------------------ */
/* DLL entry points                                                   */
/* ------------------------------------------------------------------ */

BOOL WINAPI DllMain(HINSTANCE instance, DWORD reason, LPVOID reserved)
{
	(void)reserved;
	if (reason == DLL_PROCESS_ATTACH) {
		g_module = instance;
		DisableThreadLibraryCalls(instance);
	}
	return TRUE;
}

__declspec(dllexport) HRESULT WINAPI DllGetClassObject(REFCLSID clsid, REFIID riid, void **out)
{
	VcamClassFactory *factory;
	HRESULT hr;
	if (!out)
		return E_POINTER;
	*out = NULL;
	if (!IsEqualCLSID(clsid, &CLSID_VcamMediaSource))
		return CLASS_E_CLASSNOTAVAILABLE;

	/* Media Foundation may not be started in the hosting process yet. */
	MFStartup(MF_VERSION, MFSTARTUP_LITE);

	vcam_log_iid("DllGetClassObject", riid, S_OK);

	factory = (VcamClassFactory *)calloc(1, sizeof(VcamClassFactory));
	if (!factory)
		return E_OUTOFMEMORY;
	factory->lpVtbl = &vcam_factory_vtbl;
	factory->refcount = 1;
	hr = factory_query_interface((IClassFactory *)factory, riid, out);
	factory_release((IClassFactory *)factory);
	return hr;
}

__declspec(dllexport) HRESULT WINAPI DllCanUnloadNow(void)
{
	return g_object_count == 0 ? S_OK : S_FALSE;
}
