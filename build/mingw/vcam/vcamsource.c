/*
 * OpenCVisionStudio virtual camera media source.
 *
 * This is the COM object the Windows frame server activates, by CLSID, when an
 * application opens our virtual camera. It is what turns "we hold an
 * IMFVirtualCamera" into "applications can see a webcam": with nothing
 * registered under the CLSID passed as sourceId, IMFVirtualCamera::Start fails
 * with REGDB_E_CLASSNOTREG, which is how this requirement was established.
 *
 * Frames are generated synthetically here on purpose. It keeps the whole path
 * provable in CI with no hardware and no GUI - publish, enumerate, read a frame
 * - and it puts a clean seam where the Aravis frame bus plugs in: that replaces
 * `fill_pattern` with a shared-memory read and nothing else changes.
 *
 * Written in C against MinGW's MF headers, with CINTERFACE + COBJMACROS so the
 * interface vtables and their exact member names come from the system headers
 * rather than from hand-written offsets.
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

/* {8F2B1E4C-3D6A-4A21-9C7E-5B0D8A3F6C11} */
static const CLSID CLSID_VcamMediaSource = {
	0x8F2B1E4C, 0x3D6A, 0x4A21, { 0x9C, 0x7E, 0x5B, 0x0D, 0x8A, 0x3F, 0x6C, 0x11 }
};

static HMODULE g_module = NULL;
static LONG g_object_count = 0;

typedef struct VcamSource VcamSource;
typedef struct VcamStream VcamStream;

/* ------------------------------------------------------------------ */
/* Synthetic frame generator                                          */
/* ------------------------------------------------------------------ */

/* RGB32 in Media Foundation is BGRA byte order. The pattern changes with each
 * frame so a reader can tell frames apart and prove that frames advance. */
static void fill_pattern(BYTE *pixels, UINT64 frame_index)
{
	const UINT32 bar_width = 40;
	const UINT32 bar_x = (UINT32)((frame_index * 7) % (VCAM_FRAME_WIDTH + bar_width)) - bar_width;

	for (UINT32 y = 0; y < VCAM_FRAME_HEIGHT; y++) {
		BYTE *row = pixels + (size_t)y * VCAM_FRAME_WIDTH * 4;
		for (UINT32 x = 0; x < VCAM_FRAME_WIDTH; x++) {
			BYTE *pixel = row + (size_t)x * 4;
			const int in_bar = (x >= bar_x && x < bar_x + bar_width);
			pixel[0] = in_bar ? 0xE0 : (BYTE)(x & 0xFF);          /* blue */
			pixel[1] = in_bar ? 0xE0 : (BYTE)(y & 0xFF);          /* green */
			pixel[2] = in_bar ? 0xE0 : (BYTE)((frame_index * 3) & 0xFF); /* red */
			pixel[3] = 0xFF;                                      /* alpha */
		}
	}
}

/* ------------------------------------------------------------------ */
/* Event generator plumbing, shared by source and stream               */
/* ------------------------------------------------------------------ */

typedef struct EventPlumbing {
	IMFMediaEventQueue *queue;
	DWORD *state;              /* 1 stopped, 2 started, 3 paused, 4 shutdown */
	LONG *refcount;
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

static HRESULT plumbing_queue_event(EventPlumbing *p, MediaEventType type, REFGUID extended_type,
                                    HRESULT status, IMFMediaEvent *event)
{
	if (*p->state == 4)
		return MF_E_SHUTDOWN;
	return IMFMediaEventQueue_QueueEvent(p->queue, type, extended_type, status, event);
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
	const IMFMediaStreamVtbl *lpVtbl;
	LONG refcount;
	DWORD state;
	IMFMediaEventQueue *queue;
	VcamSource *source;
	IMFStreamDescriptor *descriptor;
	UINT64 frame_index;
	HANDLE frame_event;    /* set by the frame producer, waited by RequestSample */
};

static const IMFMediaStreamVtbl vcam_stream_vtbl;

static HRESULT stream_query_interface(IMFMediaStream *iface, REFIID riid, void **out)
{
	VcamStream *self = (VcamStream *)iface;
	if (!out)
		return E_POINTER;
	*out = NULL;
	if (IsEqualIID(riid, &IID_IUnknown) || IsEqualIID(riid, &IID_IMFMediaEventGenerator) ||
	    IsEqualIID(riid, &IID_IMFMediaStream)) {
		*out = self;
		InterlockedIncrement(&self->refcount);
		return S_OK;
	}
	return E_NOINTERFACE;
}

static ULONG stream_add_ref(IMFMediaStream *iface)
{
	return (ULONG)InterlockedIncrement(&((VcamStream *)iface)->refcount);
}

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

static ULONG stream_release(IMFMediaStream *iface)
{
	VcamStream *self = (VcamStream *)iface;
	LONG remaining = InterlockedDecrement(&self->refcount);
	if (remaining == 0) {
		stream_destroy(self);
		InterlockedDecrement(&g_object_count);
	}
	return (ULONG)remaining;
}

static HRESULT stream_get_event(IMFMediaStream *iface, DWORD flags, IMFMediaEvent **event)
{
	VcamStream *self = (VcamStream *)iface;
	EventPlumbing p = { self->queue, &self->state, &self->refcount };
	return plumbing_get_event(&p, flags, event);
}

static HRESULT stream_begin_get_event(IMFMediaStream *iface, IMFAsyncCallback *callback, IUnknown *state)
{
	VcamStream *self = (VcamStream *)iface;
	EventPlumbing p = { self->queue, &self->state, &self->refcount };
	return plumbing_begin_get_event(&p, callback, state);
}

static HRESULT stream_end_get_event(IMFMediaStream *iface, IMFAsyncResult *result, IMFMediaEvent **event)
{
	VcamStream *self = (VcamStream *)iface;
	EventPlumbing p = { self->queue, &self->state, &self->refcount };
	return plumbing_end_get_event(&p, result, event);
}

static HRESULT stream_queue_event(IMFMediaStream *iface, MediaEventType type, REFGUID extended_type,
                                  HRESULT status, IMFMediaEvent *event)
{
	VcamStream *self = (VcamStream *)iface;
	EventPlumbing p = { self->queue, &self->state, &self->refcount };
	return plumbing_queue_event(&p, type, extended_type, status, event);
}

static HRESULT stream_queue_param_var(IMFMediaStream *iface, MediaEventType type, REFGUID extended_type,
                                      HRESULT status, const PROPVARIANT *value)
{
	VcamStream *self = (VcamStream *)iface;
	EventPlumbing p = { self->queue, &self->state, &self->refcount };
	return plumbing_queue_param_var(&p, type, extended_type, status, value);
}

static HRESULT stream_queue_param_unk(IMFMediaStream *iface, MediaEventType type, REFGUID extended_type,
                                      HRESULT status, IUnknown *value)
{
	VcamStream *self = (VcamStream *)iface;
	EventPlumbing p = { self->queue, &self->state, &self->refcount };
	return plumbing_queue_param_unk(&p, type, extended_type, status, value);
}

static HRESULT stream_get_media_source(IMFMediaStream *iface, IMFMediaSource **source)
{
	VcamStream *self = (VcamStream *)iface;
	if (!source)
		return E_POINTER;
	*source = (IMFMediaSource *)self->source;
	IMFMediaSource_AddRef(*source);
	return S_OK;
}

static HRESULT stream_get_stream_descriptor(IMFMediaStream *iface, IMFStreamDescriptor **descriptor)
{
	VcamStream *self = (VcamStream *)iface;
	if (!descriptor)
		return E_POINTER;
	*descriptor = self->descriptor;
	IMFStreamDescriptor_AddRef(*descriptor);
	return S_OK;
}

/* One frame per request, which is what a live source does. */
static HRESULT stream_request_sample(IMFMediaStream *iface, IUnknown *token)
{
	VcamStream *self = (VcamStream *)iface;
	IMFMediaBuffer *buffer = NULL;
	IMFSample *sample = NULL;
	BYTE *pixels = NULL;
	HRESULT hr;

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
		EventPlumbing p = { self->queue, &self->state, &self->refcount };
		hr = plumbing_queue_param_unk(&p, MEMediaSample, GUID_NULL, S_OK, (IUnknown *)sample);
	}

	if (sample)
		IMFSample_Release(sample);
	IMFMediaBuffer_Release(buffer);
	return hr;
}

static const IMFMediaStreamVtbl vcam_stream_vtbl = {
	.QueryInterface = stream_query_interface,
	.AddRef = stream_add_ref,
	.Release = stream_release,
	.GetEvent = stream_get_event,
	.BeginGetEvent = stream_begin_get_event,
	.EndGetEvent = stream_end_get_event,
	.QueueEvent = stream_queue_event,
	.QueueEventParamVar = stream_queue_param_var,
	.QueueEventParamUnk = stream_queue_param_unk,
	.GetMediaSource = stream_get_media_source,
	.GetStreamDescriptor = stream_get_stream_descriptor,
	.RequestSample = stream_request_sample,
};

/* ------------------------------------------------------------------ */
/* Source                                                             */
/* ------------------------------------------------------------------ */

struct VcamSource {
	const IMFMediaSourceVtbl *lpVtbl;
	LONG refcount;
	DWORD state;
	IMFMediaEventQueue *queue;
	IMFPresentationDescriptor *descriptor;
	IMFStreamDescriptor *stream_descriptor;
	VcamStream *stream;
};

static HRESULT source_create_stream(VcamSource *self);

static HRESULT source_query_interface(IMFMediaSource *iface, REFIID riid, void **out)
{
	VcamSource *self = (VcamSource *)iface;
	if (!out)
		return E_POINTER;
	*out = NULL;
	if (IsEqualIID(riid, &IID_IUnknown) || IsEqualIID(riid, &IID_IMFMediaEventGenerator) ||
	    IsEqualIID(riid, &IID_IMFMediaSource)) {
		*out = self;
		InterlockedIncrement(&self->refcount);
		return S_OK;
	}
	return E_NOINTERFACE;
}

static ULONG source_add_ref(IMFMediaSource *iface)
{
	return (ULONG)InterlockedIncrement(&((VcamSource *)iface)->refcount);
}

static void source_destroy(VcamSource *self)
{
	if (self->stream) {
		IMFMediaStream_Release((IMFMediaStream *)self->stream);
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

static ULONG source_release(IMFMediaSource *iface)
{
	VcamSource *self = (VcamSource *)iface;
	LONG remaining = InterlockedDecrement(&self->refcount);
	if (remaining == 0) {
		source_destroy(self);
		InterlockedDecrement(&g_object_count);
	}
	return (ULONG)remaining;
}

static HRESULT source_get_event(IMFMediaSource *iface, DWORD flags, IMFMediaEvent **event)
{
	VcamSource *self = (VcamSource *)iface;
	EventPlumbing p = { self->queue, &self->state, &self->refcount };
	return plumbing_get_event(&p, flags, event);
}

static HRESULT source_begin_get_event(IMFMediaSource *iface, IMFAsyncCallback *callback, IUnknown *state)
{
	VcamSource *self = (VcamSource *)iface;
	EventPlumbing p = { self->queue, &self->state, &self->refcount };
	return plumbing_begin_get_event(&p, callback, state);
}

static HRESULT source_end_get_event(IMFMediaSource *iface, IMFAsyncResult *result, IMFMediaEvent **event)
{
	VcamSource *self = (VcamSource *)iface;
	EventPlumbing p = { self->queue, &self->state, &self->refcount };
	return plumbing_end_get_event(&p, result, event);
}

static HRESULT source_queue_event(IMFMediaSource *iface, MediaEventType type, REFGUID extended_type,
                                  HRESULT status, IMFMediaEvent *event)
{
	VcamSource *self = (VcamSource *)iface;
	EventPlumbing p = { self->queue, &self->state, &self->refcount };
	return plumbing_queue_event(&p, type, extended_type, status, event);
}

static HRESULT source_queue_param_var(IMFMediaSource *iface, MediaEventType type, REFGUID extended_type,
                                      HRESULT status, const PROPVARIANT *value)
{
	VcamSource *self = (VcamSource *)iface;
	EventPlumbing p = { self->queue, &self->state, &self->refcount };
	return plumbing_queue_param_var(&p, type, extended_type, status, value);
}

static HRESULT source_queue_param_unk(IMFMediaSource *iface, MediaEventType type, REFGUID extended_type,
                                      HRESULT status, IUnknown *value)
{
	VcamSource *self = (VcamSource *)iface;
	EventPlumbing p = { self->queue, &self->state, &self->refcount };
	return plumbing_queue_param_unk(&p, type, extended_type, status, value);
}

static HRESULT source_get_characteristics(IMFMediaSource *iface, DWORD *characteristics)
{
	if (!characteristics)
		return E_POINTER;
	*characteristics = MFMEDIASOURCE_IS_LIVE;
	return S_OK;
}

/* Builds the single video stream descriptor: RGB32, 640x480, 30 fps. */
static HRESULT source_build_presentation(IMFMediaSource *iface)
{
	VcamSource *self = (VcamSource *)iface;
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
		hr = MFSetAttributeSize(media_type, &MF_MT_FRAME_SIZE, VCAM_FRAME_WIDTH, VCAM_FRAME_HEIGHT);
	if (SUCCEEDED(hr))
		hr = MFSetAttributeRatio(media_type, &MF_MT_FRAME_RATE, VCAM_FRAME_FPS, 1);
	if (SUCCEEDED(hr))
		hr = MFSetAttributeRatio(media_type, &MF_MT_PIXEL_ASPECT_RATIO, 1, 1);
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

static HRESULT source_create_presentation_descriptor(IMFMediaSource *iface, IMFPresentationDescriptor **descriptor)
{
	VcamSource *self = (VcamSource *)iface;
	HRESULT hr;
	if (!descriptor)
		return E_POINTER;
	if (self->state == 4)
		return MF_E_SHUTDOWN;
	hr = source_build_presentation(iface);
	if (FAILED(hr))
		return hr;
	*descriptor = self->descriptor;
	IMFPresentationDescriptor_AddRef(*descriptor);
	return S_OK;
}

static HRESULT source_create_stream(VcamSource *self)
{
	HRESULT hr;
	if (self->stream)
		return S_OK;
	hr = source_build_presentation((IMFMediaSource *)self);
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

static HRESULT source_start(IMFMediaSource *iface, IMFPresentationDescriptor *descriptor,
                            const GUID *time_format, const PROPVARIANT *start_position)
{
	VcamSource *self = (VcamSource *)iface;
	HRESULT hr;
	EventPlumbing p;

	if (self->state == 4)
		return MF_E_SHUTDOWN;

	hr = source_create_stream(self);
	if (FAILED(hr))
		return hr;

	p.queue = self->queue;
	p.state = &self->state;
	p.refcount = &self->refcount;

	hr = plumbing_queue_param_unk(&p, MENewStream, GUID_NULL, S_OK, (IUnknown *)self->stream);
	if (SUCCEEDED(hr))
		hr = plumbing_queue_param_unk(&p, MEUpdatedStream, GUID_NULL, S_OK, (IUnknown *)self->stream);
	if (SUCCEEDED(hr))
		hr = plumbing_queue_param_var(&p, MESourceStarted, GUID_NULL, S_OK, start_position);

	if (SUCCEEDED(hr)) {
		self->state = 2;
		self->stream->state = 2;
		hr = plumbing_queue_param_var(&p, MEStreamStarted, GUID_NULL, S_OK, start_position);
	}
	return hr;
}

static HRESULT source_stop(IMFMediaSource *iface)
{
	VcamSource *self = (VcamSource *)iface;
	EventPlumbing p;
	if (self->state == 4)
		return MF_E_SHUTDOWN;
	if (self->state == 1)
		return MF_E_INVALIDREQUEST;
	self->state = 1;
	p.queue = self->queue;
	p.state = &self->state;
	p.refcount = &self->refcount;
	if (self->stream) {
		self->stream->state = 1;
		plumbing_queue_param_var(&p, MEStreamStopped, GUID_NULL, S_OK, NULL);
	}
	return plumbing_queue_param_var(&p, MESourceStopped, GUID_NULL, S_OK, NULL);
}

static HRESULT source_pause(IMFMediaSource *iface)
{
	VcamSource *self = (VcamSource *)iface;
	EventPlumbing p;
	if (self->state == 4)
		return MF_E_SHUTDOWN;
	if (self->state != 2)
		return MF_E_INVALIDREQUEST;
	self->state = 3;
	p.queue = self->queue;
	p.state = &self->state;
	p.refcount = &self->refcount;
	if (self->stream) {
		self->stream->state = 3;
		plumbing_queue_param_var(&p, MEStreamPaused, GUID_NULL, S_OK, NULL);
	}
	return plumbing_queue_param_var(&p, MESourcePaused, GUID_NULL, S_OK, NULL);
}

static HRESULT source_shutdown(IMFMediaSource *iface)
{
	VcamSource *self = (VcamSource *)iface;
	self->state = 4;
	if (self->stream)
		self->stream->state = 4;
	if (self->queue)
		IMFMediaEventQueue_Shutdown(self->queue);
	if (self->stream && self->stream->queue)
		IMFMediaEventQueue_Shutdown(self->stream->queue);
	return S_OK;
}

static const IMFMediaSourceVtbl vcam_source_vtbl = {
	.QueryInterface = source_query_interface,
	.AddRef = source_add_ref,
	.Release = source_release,
	.GetEvent = source_get_event,
	.BeginGetEvent = source_begin_get_event,
	.EndGetEvent = source_end_get_event,
	.QueueEvent = source_queue_event,
	.QueueEventParamVar = source_queue_param_var,
	.QueueEventParamUnk = source_queue_param_unk,
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
	hr = source_query_interface((IMFMediaSource *)self, riid, out);
	source_release((IMFMediaSource *)self);
	return hr;
}

/* ------------------------------------------------------------------ */
/* Class factory                                                      */
/* ------------------------------------------------------------------ */

typedef struct VcamClassFactory {
	const IClassFactoryVtbl *lpVtbl;
	LONG refcount;
} VcamClassFactory;

static HRESULT factory_query_interface(IClassFactory *iface, REFIID riid, void **out)
{
	VcamClassFactory *self = (VcamClassFactory *)iface;
	if (!out)
		return E_POINTER;
	*out = NULL;
	if (IsEqualIID(riid, &IID_IUnknown) || IsEqualIID(riid, &IID_IClassFactory)) {
		*out = self;
		InterlockedIncrement(&self->refcount);
		return S_OK;
	}
	return E_NOINTERFACE;
}

static ULONG factory_add_ref(IClassFactory *iface)
{
	return (ULONG)InterlockedIncrement(&((VcamClassFactory *)iface)->refcount);
}

static ULONG factory_release(IClassFactory *iface)
{
	VcamClassFactory *self = (VcamClassFactory *)iface;
	LONG remaining = InterlockedDecrement(&self->refcount);
	if (remaining == 0)
		free(self);
	return (ULONG)remaining;
}

static HRESULT factory_create_instance(IClassFactory *iface, IUnknown *outer, REFIID riid, void **out)
{
	(void)iface;
	return vcam_source_create(outer, riid, out);
}

static HRESULT factory_lock_server(IClassFactory *iface, BOOL lock)
{
	(void)iface;
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

