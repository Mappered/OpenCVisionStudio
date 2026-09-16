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
#include "framebus.h"
#include "vcam_yuv.h"

/* {8F2B1E4C-3D6A-4A21-9C7E-5B0D8A3F6C11} */
static const CLSID CLSID_VcamMediaSource = {
	0x8F2B1E4C, 0x3D6A, 0x4A21, { 0x9C, 0x7E, 0x5B, 0x0D, 0x8A, 0x3F, 0x6C, 0x11 }
};

/* The event queues want a "no extended type" GUID. GUID_NULL is not visible in
 * this toolchain's headers, and an all-zero GUID is what it means. Exposed as a
 * pointer because every use site passes it as REFGUID. */
static const GUID kNullGuidValue = { 0, 0, 0, { 0, 0, 0, 0, 0, 0, 0, 0 } };
#define kNullGuid (&kNullGuidValue)

/* {3C9B2EB9-86D5-4514-A394-F56664F9F0D8} - not declared in this toolchain's
 * headers, taken from Microsoft's mfidl.h. The frame server asks for this IID
 * by name, so the source must answer it. */
static const GUID kIID_IMFMediaSourceEx = {
	0x3C9B2EB9, 0x86D5, 0x4514, { 0xA3, 0x94, 0xF5, 0x66, 0x64, 0xF9, 0xF0, 0xD8 }
};

/* Attribute keys this toolchain does not declare, with values taken from
 * Microsoft's mfidl.h and mfapi.h. The frame server classifies a stream by
 * MF_DEVICESTREAM_STREAM_CATEGORY, and it refuses a source whose stream carries
 * no capture pin category - before it ever calls Start on it. */
static const GUID kMFDevicestreamStreamCategory = {
	0x2939E7B8, 0xA62E, 0x4579, { 0xB6, 0x74, 0xD4, 0x07, 0x3D, 0xFA, 0xBB, 0xBA }
};
static const GUID kMFDevicestreamStreamId = {
	0x11BD5120, 0xD124, 0x446B, { 0x88, 0xE6, 0x17, 0x06, 0x02, 0x57, 0xFF, 0xF9 }
};
static const GUID kMFDevicestreamFrameserverShared = {
	0x1CB378E9, 0xB279, 0x41D4, { 0xAF, 0x97, 0x34, 0xA2, 0x43, 0xE6, 0x83, 0x20 }
};
static const GUID kMFDevicestreamFrameSourceTypes = {
	0x17145FD1, 0x1B2B, 0x423C, { 0x80, 0x01, 0x2B, 0x68, 0x33, 0xED, 0x35, 0x88 }
};

/* {65E8773D-8F56-11D0-A3B9-00A0C9223196} - PINNAME_VIDEO_CAPTURE, the KS pin
 * category that identifies a video capture stream. Declared by ksmedia.h, but
 * its definition lives in a GUID library this build does not link, so the value
 * is spelled out. */
static const GUID kPinCategoryCapture = {
	0x65E8773D, 0x8F56, 0x11D0, { 0xA3, 0xB9, 0x00, 0xA0, 0xC9, 0x22, 0x31, 0x96 }
};

/* The two interfaces a capture source is asked for by name, and which this
 * toolchain's headers do not declare: {FA993888-4383-415A-A930-DD472A8CF6F7}
 * IMFGetService (Microsoft's mfidl.h) and
 * {28F54685-06FD-11D2-B27A-00A0C9223196} IKsControl (ksuuids.h). */
static const GUID kIID_IMFGetService = {
	0xFA993888, 0x4383, 0x415A, { 0xA9, 0x30, 0xDD, 0x47, 0x2A, 0x8C, 0xF6, 0xF7 }
};
static const GUID kIID_IKsControl = {
	0x28F54685, 0x06FD, 0x11D2, { 0xB2, 0x7A, 0x00, 0xA0, 0xC9, 0x22, 0x31, 0x96 }
};

/* MF_E_UNSUPPORTED_SERVICE, from Microsoft's mferror.h. The macro may not exist
 * in this toolchain, so the value is spelled out either way and the two agree. */
static const HRESULT kMFUnsupportedService = (HRESULT)0xC00D36BAL;

/* {F0273718-4A4D-4AC5-A15D-305EB5E90667} - MF_VIRTUALCAMERA_PROVIDE_ASSOCIATED_CAMERA_SOURCES,
 * a UINT32 the frame server reads while bringing a virtual camera up. Also not
 * declared in this toolchain's headers. */
static const GUID kMFVirtualcameraProvideAssociatedCameraSources = {
	0xF0273718, 0x4A4D, 0x4AC5, { 0xA1, 0x5D, 0x30, 0x5E, 0xB5, 0xE9, 0x06, 0x67 }
};

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

/* Which process hosts the media source is not a detail: the frame server can
 * load it in its own service process or have it activated inside the caller,
 * and that decides whether our environment, our view of the shared frame bus
 * and our trace are the ones in play. Every trace starts by saying. */
static const char *host_process_name(void)
{
	static char name[MAX_PATH] = "";
	wchar_t wide[MAX_PATH];
	DWORD length;

	if (name[0])
		return name;
	length = GetModuleFileNameW(NULL, wide, MAX_PATH);
	if (length == 0 || length >= MAX_PATH ||
	    !WideCharToMultiByte(CP_ACP, 0, wide, -1, name, MAX_PATH, NULL, NULL))
		strcpy(name, "(unknown)");
	return name;
}

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
	if (g_log) {
		fprintf(g_log, "--- media source loaded in pid %lu (%s), thread %lu ---",
		        (unsigned long)GetCurrentProcessId(), host_process_name(),
		        (unsigned long)GetCurrentThreadId());
		fputc('\n', g_log);
		fflush(g_log);
	}
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
	if (IsEqualIID(riid, &kIID_IMFMediaSourceEx)) return "IMFMediaSourceEx";
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
	/* The whole GUID, not just the first three fields: an interface the
	 * pipeline asks for by name is identified by its tail as much as by its
	 * head, and a truncated one reads as all zeros when it is not. */
	const unsigned char *tail = riid->Data4;
	vcam_log("%s %s {%08lx-%04x-%04x-%02x%02x-%02x%02x%02x%02x%02x%02x} -> 0x%08lx",
	         what, iid_name(riid),
	         (unsigned long)riid->Data1, (unsigned)riid->Data2, (unsigned)riid->Data3,
	         (unsigned)tail[0], (unsigned)tail[1], (unsigned)tail[2], (unsigned)tail[3],
	         (unsigned)tail[4], (unsigned)tail[5], (unsigned)tail[6], (unsigned)tail[7],
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
	if (!p->queue)
		return E_UNEXPECTED;
	return IMFMediaEventQueue_GetEvent(p->queue, flags, event);
}

static HRESULT plumbing_begin_get_event(EventPlumbing *p, IMFAsyncCallback *callback, IUnknown *state)
{
	if (*p->state == 4)
		return MF_E_SHUTDOWN;
	if (!p->queue)
		return E_UNEXPECTED;
	return IMFMediaEventQueue_BeginGetEvent(p->queue, callback, state);
}

static HRESULT plumbing_end_get_event(EventPlumbing *p, IMFAsyncResult *result, IMFMediaEvent **event)
{
	if (*p->state == 4)
		return MF_E_SHUTDOWN;
	if (!p->queue)
		return E_UNEXPECTED;
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
	if (!p->queue)
		return E_UNEXPECTED;
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
	if (!p->queue)
		return E_UNEXPECTED;
	return IMFMediaEventQueue_QueueEventParamVar(p->queue, type, extended_type, status, value);
}

static HRESULT plumbing_queue_param_unk(EventPlumbing *p, MediaEventType type, REFGUID extended_type,
                                        HRESULT status, IUnknown *value)
{
	if (*p->state == 4)
		return MF_E_SHUTDOWN;
	if (!p->queue)
		return E_UNEXPECTED;
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
	/* The frame bus is per stream: it carries the pixels this stream delivers. */
	VcamFrameBus bus;
	int bus_ready;
	int bus_checked;
	/* The bus carries RGB32; the sample may have to be YUY2. Staging is heap
	 * because two 1.2 MB buffers on the stack is what once overflowed it. */
	BYTE *rgb32_frame;
};

static void stream_destroy(VcamStream *self)
{
	free(self->rgb32_frame);
	if (self->queue) {
		IMFMediaEventQueue_Shutdown(self->queue);
		IMFMediaEventQueue_Release(self->queue);
	}
	if (self->descriptor)
		IMFStreamDescriptor_Release(self->descriptor);
	if (self->bus_ready)
		framebus_close(&self->bus);
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
	HRESULT hr = plumbing_get_event(&p, flags, event);
	vcam_log("stream GetEvent -> 0x%08lx", (unsigned long)hr);
	return hr;
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

/* The subtype this stream is currently set to deliver. */
static GUID stream_current_subtype(VcamStream *self)
{
	GUID subtype = MFVideoFormat_RGB32;
	IMFMediaTypeHandler *handler = NULL;
	IMFMediaType *type = NULL;

	if (self->descriptor &&
	    SUCCEEDED(IMFStreamDescriptor_GetMediaTypeHandler(self->descriptor, &handler)) &&
	    handler &&
	    SUCCEEDED(IMFMediaTypeHandler_GetCurrentMediaType(handler, &type)) && type)
		IMFMediaType_GetGUID(type, &MF_MT_SUBTYPE, &subtype);
	if (type)
		IMFMediaType_Release(type);
	if (handler)
		IMFMediaTypeHandler_Release(handler);
	return subtype;
}

/* One frame per request, which is what a live source does. */
static HRESULT STDMETHODCALLTYPE stream_request_sample(void *This, IUnknown *token)
{
	VcamStream *self = (VcamStream *)This;
	IMFMediaBuffer *buffer = NULL;
	IMFSample *sample = NULL;
	BYTE *pixels = NULL;
	GUID subtype;
	DWORD frame_bytes;
	HRESULT hr;

	vcam_log("stream RequestSample (#%llu)", (unsigned long long)self->frame_index);

	if (self->state == 4)
		return MF_E_SHUTDOWN;
	if (self->state != 2)
		return MF_E_INVALIDREQUEST;

	/* What the consumer negotiated decides what a sample has to be: the bus is
	 * RGB32 either way. Read it per sample, so a consumer that renegotiates
	 * mid-session is answered in the format it asked for. */
	subtype = stream_current_subtype(self);
	frame_bytes = (subtype == MFVideoFormat_YUY2)
	              ? VCAM_FRAME_WIDTH * VCAM_FRAME_HEIGHT * 2u
	              : VCAM_FRAME_BYTES;

	if (!self->rgb32_frame) {
		self->rgb32_frame = (BYTE *)malloc(VCAM_FRAME_BYTES);
		if (!self->rgb32_frame)
			return E_OUTOFMEMORY;
	}

	/* Prefer real frames from the publisher's shared-memory bus; fall back to
	 * the generator when nobody is publishing, so the camera still comes up on
	 * a machine with no camera attached. */
	if (!self->bus_checked) {
		self->bus_checked = 1;
		self->bus_ready = framebus_open(&self->bus);
		vcam_log("stream: frame bus %s",
		         self->bus_ready ? "attached (real frames)" : "absent (generating frames)");
	}
	if (self->bus_ready) {
		VcamFrameBusHeader info;
		if (framebus_acquire(&self->bus, self->rgb32_frame, VCAM_FRAME_BYTES, &info, 5))
			self->frame_index = info.frame_index + 1;
		else
			fill_pattern(self->rgb32_frame, self->frame_index++);
	} else {
		fill_pattern(self->rgb32_frame, self->frame_index++);
	}

	hr = MFCreateMemoryBuffer(frame_bytes, &buffer);
	if (FAILED(hr))
		return hr;
	hr = IMFMediaBuffer_Lock(buffer, &pixels, NULL, NULL);
	if (FAILED(hr)) {
		IMFMediaBuffer_Release(buffer);
		return hr;
	}
	if (subtype == MFVideoFormat_YUY2)
		vcam_rgb32_to_yuy2(self->rgb32_frame, pixels, VCAM_FRAME_WIDTH, VCAM_FRAME_HEIGHT);
	else
		memcpy(pixels, self->rgb32_frame, frame_bytes);
	IMFMediaBuffer_Unlock(buffer);
	IMFMediaBuffer_SetCurrentLength(buffer, frame_bytes);

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
	},
	.GetMediaSource = stream_get_media_source,
	.GetStreamDescriptor = stream_get_stream_descriptor,
	.RequestSample = stream_request_sample,
};

/* ------------------------------------------------------------------ */
/* Source                                                             */
/* ------------------------------------------------------------------ */

struct VcamSource;

/* Shared layout of a sub-object interface: the vtable pointer has to be first,
 * because that pointer *is* the interface the caller receives. */
typedef struct VcamSubobject {
	const void *lpVtbl;
	struct VcamSource *owner;
} VcamSubobject;

struct VcamSource {
	const VcamMediaSourceVtbl *lpVtbl;
	LONG refcount;
	DWORD state;
	IMFMediaEventQueue *queue;
	IMFPresentationDescriptor *descriptor;
	IMFStreamDescriptor *stream_descriptor;
	VcamStream *stream;
	IMFAttributes *source_attributes;
	/* The two extra interfaces, as COM sub-objects: the frame server asks for
	 * them on the source, and one struct cannot have two vtables at offset 0. */
	VcamSubobject get_service;
	VcamSubobject ks_control;
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
	if (self->source_attributes)
		IMFAttributes_Release(self->source_attributes);
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
	    IsEqualIID(riid, &IID_IMFMediaSource) || IsEqualIID(riid, &kIID_IMFMediaSourceEx)) {
		*out = self;
		InterlockedIncrement(&self->refcount);
		hr = S_OK;
	} else if (IsEqualIID(riid, &kIID_IMFGetService)) {
		*out = &self->get_service;
		InterlockedIncrement(&self->refcount);
		hr = S_OK;
	} else if (IsEqualIID(riid, &kIID_IKsControl)) {
		*out = &self->ks_control;
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

/* --- the two extra interfaces ---------------------------------------------
 * Read and written by nobody, answered by both. GetService is the source
 * saying "no such service", not "no such interface": the difference is how a
 * pipeline distinguishes an object that knows the protocol from one that has
 * never heard of it. */
static HRESULT STDMETHODCALLTYPE subobject_query_interface(void *This, REFIID riid, void **out)
{
	return source_query_interface(((VcamSubobject *)This)->owner, riid, out);
}

static ULONG STDMETHODCALLTYPE subobject_add_ref(void *This)
{
	return source_add_ref(((VcamSubobject *)This)->owner);
}

static ULONG STDMETHODCALLTYPE subobject_release(void *This)
{
	return source_release(((VcamSubobject *)This)->owner);
}

static HRESULT STDMETHODCALLTYPE source_get_service(void *This, REFGUID service, REFIID riid, void **out)
{
	(void)This;
	(void)riid;
	if (out)
		*out = NULL;
	vcam_log_iid("source GetService(service)", service, kMFUnsupportedService);
	vcam_log("source GetService -> MF_E_UNSUPPORTED_SERVICE");
	return kMFUnsupportedService;
}

static HRESULT STDMETHODCALLTYPE source_ks_property(void *This, void *property, ULONG property_length,
                                                    void *data, ULONG data_length, ULONG *bytes_returned)
{
	(void)This; (void)property; (void)property_length; (void)data; (void)data_length;
	if (bytes_returned)
		*bytes_returned = 0;
	vcam_log("source KsProperty -> ERROR_SET_NOT_FOUND");
	return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
}

static HRESULT STDMETHODCALLTYPE source_ks_method(void *This, void *method, ULONG method_length,
                                                  void *data, ULONG data_length, ULONG *bytes_returned)
{
	(void)This; (void)method; (void)method_length; (void)data; (void)data_length;
	if (bytes_returned)
		*bytes_returned = 0;
	return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
}

static HRESULT STDMETHODCALLTYPE source_ks_event(void *This, void *event, ULONG event_length,
                                                 void *data, ULONG data_length, ULONG *bytes_returned)
{
	(void)This; (void)event; (void)event_length; (void)data; (void)data_length;
	if (bytes_returned)
		*bytes_returned = 0;
	return HRESULT_FROM_WIN32(ERROR_SET_NOT_FOUND);
}

static const VcamGetServiceVtbl vcam_get_service_vtbl = {
	.QueryInterface = subobject_query_interface,
	.AddRef = subobject_add_ref,
	.Release = subobject_release,
	.GetService = source_get_service,
};

static const VcamKsControlVtbl vcam_ks_control_vtbl = {
	.QueryInterface = subobject_query_interface,
	.AddRef = subobject_add_ref,
	.Release = subobject_release,
	.KsProperty = source_ks_property,
	.KsMethod = source_ks_method,
	.KsEvent = source_ks_event,
};

static HRESULT STDMETHODCALLTYPE source_get_event(void *This, DWORD flags, IMFMediaEvent **event)
{
	VcamSource *self = (VcamSource *)This;
	EventPlumbing p = { self->queue, &self->state };
	HRESULT hr = plumbing_get_event(&p, flags, event);
	vcam_log("source GetEvent -> 0x%08lx", (unsigned long)hr);
	return hr;
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
/* One video media type at the geometry the frame bus carries. */
static HRESULT make_video_type(REFGUID subtype, DWORD stride, DWORD sample_size,
                               IMFMediaType **out)
{
	IMFMediaType *media_type = NULL;
	HRESULT hr;

	*out = NULL;
	hr = MFCreateMediaType(&media_type);
	if (SUCCEEDED(hr))
		hr = IMFMediaType_SetGUID(media_type, &MF_MT_MAJOR_TYPE, &MFMediaType_Video);
	if (SUCCEEDED(hr))
		hr = IMFMediaType_SetGUID(media_type, &MF_MT_SUBTYPE, subtype);
	if (SUCCEEDED(hr))
		hr = set_attribute_size(media_type, &MF_MT_FRAME_SIZE, VCAM_FRAME_WIDTH, VCAM_FRAME_HEIGHT);
	if (SUCCEEDED(hr))
		hr = set_attribute_ratio(media_type, &MF_MT_FRAME_RATE, VCAM_FRAME_FPS, 1);
	if (SUCCEEDED(hr))
		hr = set_attribute_ratio(media_type, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
	if (SUCCEEDED(hr))
		hr = IMFMediaType_SetUINT32(media_type, &MF_MT_INTERLACE_MODE, MFVideoInterlace_Progressive);
	if (SUCCEEDED(hr))
		hr = IMFMediaType_SetUINT32(media_type, &MF_MT_ALL_SAMPLES_INDEPENDENT, TRUE);
	if (SUCCEEDED(hr))
		hr = IMFMediaType_SetUINT32(media_type, &MF_MT_FIXED_SIZE_SAMPLES, TRUE);
	if (SUCCEEDED(hr))
		hr = IMFMediaType_SetUINT32(media_type, &MF_MT_DEFAULT_STRIDE, stride);
	if (SUCCEEDED(hr))
		hr = IMFMediaType_SetUINT32(media_type, &MF_MT_SAMPLE_SIZE, sample_size);
	if (SUCCEEDED(hr)) {
		*out = media_type;
		return S_OK;
	}
	if (media_type)
		IMFMediaType_Release(media_type);
	return hr;
}

static HRESULT source_build_presentation(VcamSource *self)
{
	/* YUY2 first, and the current type: it is what a capture source is
	 * expected to carry, and the frame server synthesises every other format
	 * from it. RGB32 stays advertised - it is the bus's own format and the
	 * harness reads it - but it is not what a camera declares. */
	IMFMediaType *types[2] = { NULL, NULL };
	IMFMediaTypeHandler *handler = NULL;
	HRESULT hr;

	if (self->descriptor)
		return S_OK;

	hr = make_video_type(&MFVideoFormat_YUY2, VCAM_FRAME_WIDTH * 2u,
	                     VCAM_FRAME_WIDTH * VCAM_FRAME_HEIGHT * 2u, &types[0]);
	if (SUCCEEDED(hr))
		hr = make_video_type(&MFVideoFormat_RGB32, VCAM_FRAME_WIDTH * 4u,
		                     VCAM_FRAME_BYTES, &types[1]);
	if (SUCCEEDED(hr))
		hr = MFCreateStreamDescriptor(0, 2, types, &self->stream_descriptor);
	if (SUCCEEDED(hr)) {
		/* The frame server classifies a stream by these. Without the capture
		 * pin category it does not treat the source as a camera at all, which
		 * is why it refused the source before ever calling Start on it. */
		IMFAttributes *stream_attributes = (IMFAttributes *)self->stream_descriptor;
		IMFAttributes_SetGUID(stream_attributes, &kMFDevicestreamStreamCategory, &kPinCategoryCapture);
		IMFAttributes_SetUINT32(stream_attributes, &kMFDevicestreamStreamId, 0);
		IMFAttributes_SetUINT32(stream_attributes, &kMFDevicestreamFrameserverShared, 1);
		IMFAttributes_SetUINT32(stream_attributes, &kMFDevicestreamFrameSourceTypes, 1);
	}
	if (SUCCEEDED(hr))
		hr = IMFStreamDescriptor_GetMediaTypeHandler(self->stream_descriptor, &handler);
	if (SUCCEEDED(hr))
		hr = IMFMediaTypeHandler_SetCurrentMediaType(handler, types[0]);
	if (SUCCEEDED(hr))
		hr = MFCreatePresentationDescriptor(1, &self->stream_descriptor, &self->descriptor);
	if (SUCCEEDED(hr))
		hr = IMFPresentationDescriptor_SelectStream(self->descriptor, 0);

	if (handler)
		IMFMediaTypeHandler_Release(handler);
	if (types[1])
		IMFMediaType_Release(types[1]);
	if (types[0])
		IMFMediaType_Release(types[0]);
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
	/* Hand out a copy: callers are allowed to modify the descriptor they get. */
	hr = IMFPresentationDescriptor_Clone(self->descriptor, descriptor);
	vcam_log("source CreatePresentationDescriptor -> 0x%08lx (%dx%d YUY2 + RGB32)",
	         (unsigned long)hr, VCAM_FRAME_WIDTH, VCAM_FRAME_HEIGHT);
	return hr;
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
		/* Already stopped, and Stop is idempotent in Media Foundation: there is
		 * no transition to make and no second MESourceStopped to raise. */
		return S_OK;
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

	/* Measured on a Windows 11 client: the frame server calls Pause on the
	 * source while bringing the camera up, on a source that has never been
	 * started, and IMFVirtualCamera::Start returns whatever this returns - the
	 * earlier run failed with Start = MF_E_INVALID_STATE_TRANSITION, which is
	 * exactly what this function used to answer. A capture source is live and
	 * has nothing to halt, so the transition is accepted and recorded. */
	p.queue = self->queue;
	p.state = &self->state;
	if (self->stream) {
		self->stream->state = 3;
		plumbing_queue_event(&p, MEStreamPaused, kNullGuid, S_OK, NULL);
	}
	self->state = 3;
	vcam_log("source Pause -> S_OK (paused)");
	return plumbing_queue_event(&p, MESourcePaused, kNullGuid, S_OK, NULL);
}

static HRESULT STDMETHODCALLTYPE source_shutdown(void *This)
{
	VcamSource *self = (VcamSource *)This;
	vcam_log("source Shutdown");
	if (self->state == 4) {
		/* Media Foundation's convention, and what the reference implementation
		 * does: the second Shutdown is an error, not a no-op. Returning S_OK
		 * here hides how many times the pipeline really shut the object down. */
		vcam_log("source Shutdown -> MF_E_SHUTDOWN (was already shut down)");
		return MF_E_SHUTDOWN;
	}
	self->state = 4;
	if (self->stream) {
		self->stream->state = 4;
		if (self->stream->queue)
			IMFMediaEventQueue_Shutdown(self->stream->queue);
	}
	if (self->queue)
		IMFMediaEventQueue_Shutdown(self->queue);
	vcam_log("source Shutdown -> S_OK");
	return S_OK;
}

/* IMFMediaSourceEx. The frame server asks for these three; answering
 * E_NOINTERFACE to the interface itself is what stalled Start. Source and stream
 * attributes are a plain store, and D3D callbacks are accepted but unused:
 * returning E_NOTIMPL for SetD3DManager would make the server abandon the
 * source rather than fall back to system memory. */
static HRESULT STDMETHODCALLTYPE source_get_source_attributes(void *This, IMFAttributes **attributes)
{
	VcamSource *self = (VcamSource *)This;
	HRESULT hr = S_OK;
	if (!attributes)
		return E_POINTER;
	*attributes = NULL;
	if (!self->source_attributes)
		hr = MFCreateAttributes(&self->source_attributes, 1);
	if (SUCCEEDED(hr)) {
		IMFAttributes_SetString(self->source_attributes, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, VCAM_FRIENDLY_NAME);
		*attributes = self->source_attributes;
		IMFAttributes_AddRef(*attributes);
	}
	vcam_log("source GetSourceAttributes -> 0x%08lx", (unsigned long)hr);
	return hr;
}

static HRESULT STDMETHODCALLTYPE source_get_stream_attributes(void *This, DWORD stream_identifier,
                                                              IMFAttributes **attributes)
{
	VcamSource *self = (VcamSource *)This;
	HRESULT hr = S_OK;
	if (!attributes)
		return E_POINTER;
	*attributes = NULL;
	if (self->state == 4)
		return MF_E_SHUTDOWN;
	hr = source_build_presentation(self);
	if (FAILED(hr))
		return hr;
	if (stream_identifier != 0) {
		vcam_log("source GetStreamAttributes(%lu): unknown stream", (unsigned long)stream_identifier);
		return MF_E_INVALIDSTREAMNUMBER;
	}
	/* The stream descriptor is itself an IMFAttributes and carries the capture
	 * pin category and frame-source type the frame server looks for. */
	*attributes = (IMFAttributes *)self->stream_descriptor;
	IMFAttributes_AddRef(*attributes);
	vcam_log("source GetStreamAttributes(stream=0) -> 0x%08lx", (unsigned long)hr);
	return hr;
}

static HRESULT STDMETHODCALLTYPE source_set_d3d_manager(void *This, IUnknown *manager)
{
	(void)This;
	vcam_log("source SetD3DManager(%p): accepted, system memory is used", (void *)manager);
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
	},
	.GetCharacteristics = source_get_characteristics,
	.CreatePresentationDescriptor = source_create_presentation_descriptor,
	.Start = source_start,
	.Stop = source_stop,
	.Pause = source_pause,
	.Shutdown = source_shutdown,
	.GetSourceAttributes = source_get_source_attributes,
	.GetStreamAttributes = source_get_stream_attributes,
	.SetD3DManager = source_set_d3d_manager,
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
	self->get_service.lpVtbl = &vcam_get_service_vtbl;
	self->get_service.owner = self;
	self->ks_control.lpVtbl = &vcam_ks_control_vtbl;
	self->ks_control.owner = self;
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

/* The frame server may set attributes on the activator before calling
 * ActivateObject, and expects the source to expose them again through
 * GetSourceAttributes. Copying them across is what makes the two objects agree
 * about the device. */
static void source_copy_activation_attributes(VcamSource *self, IMFAttributes *activation)
{
	if (!self->source_attributes) {
		if (FAILED(MFCreateAttributes(&self->source_attributes, 4)))
			return;
	}
	if (activation)
		IMFAttributes_CopyAllItems(activation, self->source_attributes);
	IMFAttributes_SetString(self->source_attributes, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, VCAM_FRIENDLY_NAME);
	vcam_log("source activation attributes copied");
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
	int trace_attributes;   /* attribute reads are chatty; only trace on demand */
} VcamActivator;

/* The attribute methods are forwarded to a real IMFAttributes rather than
 * reimplemented: the storage rules are not our business, only the identity. */
#define ACTIVATOR_ATTR_FORWARD(name, decl, call) \
	static HRESULT STDMETHODCALLTYPE activator_##name decl \
	{ \
		VcamActivator *self = (VcamActivator *)This; \
		if (self->trace_attributes) \
			vcam_log("activator attribute " #name); \
		return IMFAttributes_##name call; \
	}

ACTIVATOR_ATTR_FORWARD(GetItem, (IMFAttributes *This, REFGUID key, PROPVARIANT *value), (self->attributes, key, value))
ACTIVATOR_ATTR_FORWARD(CompareItem, (IMFAttributes *This, REFGUID key, REFPROPVARIANT value, BOOL *result), (self->attributes, key, value, result))
ACTIVATOR_ATTR_FORWARD(Compare, (IMFAttributes *This, IMFAttributes *theirs, MF_ATTRIBUTES_MATCH_TYPE match, BOOL *result), (self->attributes, theirs, match, result))
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

/* These two are logged with the key, because which attribute the frame server
 * asks for is the whole question when it finds one missing. */
static HRESULT STDMETHODCALLTYPE activator_GetItemType(IMFAttributes *This, REFGUID key,
                                                      MF_ATTRIBUTE_TYPE *type)
{
	VcamActivator *self = (VcamActivator *)This;
	HRESULT hr = IMFAttributes_GetItemType(self->attributes, key, type);
	vcam_log("activator GetItemType key={%08lx-%04x-%04x} -> 0x%08lx",
	         (unsigned long)key->Data1, (unsigned)key->Data2, (unsigned)key->Data3, (unsigned long)hr);
	return hr;
}

static HRESULT STDMETHODCALLTYPE activator_GetUINT32(IMFAttributes *This, REFGUID key, UINT32 *value)
{
	VcamActivator *self = (VcamActivator *)This;
	HRESULT hr = IMFAttributes_GetUINT32(self->attributes, key, value);
	vcam_log("activator GetUINT32 key={%08lx-%04x-%04x} -> 0x%08lx",
	         (unsigned long)key->Data1, (unsigned)key->Data2, (unsigned)key->Data3, (unsigned long)hr);
	return hr;
}

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
		source_copy_activation_attributes(self->source, self->attributes);
		/* Build the stream (and with it the presentation descriptor and media
		 * types) now rather than lazily on Start. The working reference
		 * implementation publishes its capability block to the media source
		 * before the camera is created for exactly this reason: whichever part
		 * of the pipeline activates the source can then find it complete. */
		vcam_log("activator ActivateObject: building the stream -> 0x%08lx",
		         (unsigned long)source_create_stream(self->source));
	}

	hr = source_query_interface(self->source, riid, ppv);
	vcam_log("activator ActivateObject -> 0x%08lx", (unsigned long)hr);
	return hr;
}

static HRESULT STDMETHODCALLTYPE activator_shutdown_object(void *This)
{
	VcamActivator *self = (VcamActivator *)This;
	vcam_log("activator ShutdownObject");
	/* Shut the source down *and forget it*. Measured: the pipeline activates a
	 * source, probes it, shuts it down, and then needs one again - and an
	 * activator that hands back the object it just shut down makes the next
	 * Start return MF_E_SHUTDOWN, which is what the trace showed. */
	if (self->source) {
		source_shutdown((void *)self->source);
		source_release((void *)self->source);
		self->source = NULL;
	}
	return S_OK;
}

static HRESULT STDMETHODCALLTYPE activator_detach_object(void *This)
{
	VcamActivator *self = (VcamActivator *)This;
	vcam_log("activator DetachObject");
	/* Detach, unlike ShutdownObject, means "let go without shutting down": the
	 * next ActivateObject is expected to build a fresh source. */
	if (self->source) {
		source_release((void *)self->source);
		self->source = NULL;
	}
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
	self->trace_attributes = 1;
	hr = MFCreateAttributes(&self->attributes, 2);
	if (FAILED(hr)) {
		free(self);
		return hr;
	}
	/* A friendly name is cheap and makes the object identifiable while
	 * debugging; the real identity is the CLSID. */
	IMFAttributes_SetString(self->attributes, &MF_DEVSOURCE_ATTRIBUTE_FRIENDLY_NAME, VCAM_FRIENDLY_NAME);
	/* A capture source announces its type, and says whether it provides
	 * associated camera sources. The frame server reads the latter as a UINT32
	 * and crashing on a null in FrameServerMonitorClient when it is absent is
	 * what put us on to it. */
	IMFAttributes_SetGUID(self->attributes, &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE,
	                      &MF_DEVSOURCE_ATTRIBUTE_SOURCE_TYPE_VIDCAP_GUID);
	IMFAttributes_SetUINT32(self->attributes, &kMFVirtualcameraProvideAssociatedCameraSources, 0);
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

	/* Media Foundation may not be started in the hosting process yet. Full
	 * startup, like the reference implementation: the frame server clients are
	 * part of the platform a lite startup does not bring up. */
	MFStartup(MF_VERSION, MFSTARTUP_FULL);

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
