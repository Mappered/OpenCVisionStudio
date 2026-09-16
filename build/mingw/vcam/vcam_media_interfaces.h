/*
 * Our own declarations of the interfaces the media source exposes.
 *
 * Why not use MinGW's? Because its declarations turned out to be unusable for
 * an object we hand to the Windows frame server:
 *
 *   - MinGW's IMFMediaEventQueue::QueueEvent takes only the event, not the
 *     (type, guid, status, event) tuple; the queue and the generator are
 *     different interfaces with different signatures.
 *
 * The frame server will call these objects through the real layouts, so the
 * layouts here must be exactly right: IUnknown, then IMFMediaEventGenerator's
 * six methods, then the interface's own. Nesting the generator struct as the
 * first member produces that layout, and the method order is taken from
 * Microsoft's documentation.
 *
 * A first version of this file also put QueueEventParamVar and
 * QueueEventParamUnk in the generator. They are not part of
 * IMFMediaEventGenerator - they belong to IMFMediaEventQueue - and carrying
 * them here shifted every method after them by two slots. The frame server then
 * called GetSourceAttributes (slot 10) into Pause, which is why Start returned
 * whatever Pause returned, and why answering S_OK from Pause without filling
 * the caller's out-parameter faulted inside FrameServerMonitorClient. MinGW's
 * own headers, which declare four generator methods, were right.
 */

#ifndef VCAM_MEDIA_INTERFACES_H
#define VCAM_MEDIA_INTERFACES_H

#include <windows.h>
#include <objbase.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfobjects.h>

typedef struct VcamMediaEventGeneratorVtbl {
	/* IUnknown */
	HRESULT (STDMETHODCALLTYPE *QueryInterface)(void *This, REFIID riid, void **out);
	ULONG   (STDMETHODCALLTYPE *AddRef)(void *This);
	ULONG   (STDMETHODCALLTYPE *Release)(void *This);
	/* IMFMediaEventGenerator */
	HRESULT (STDMETHODCALLTYPE *GetEvent)(void *This, DWORD flags, IMFMediaEvent **event);
	HRESULT (STDMETHODCALLTYPE *BeginGetEvent)(void *This, IMFAsyncCallback *callback, IUnknown *state);
	HRESULT (STDMETHODCALLTYPE *EndGetEvent)(void *This, IMFAsyncResult *result, IMFMediaEvent **event);
	HRESULT (STDMETHODCALLTYPE *QueueEvent)(void *This, MediaEventType type, REFGUID extended_type,
	                                        HRESULT status, IMFMediaEvent *event);
} VcamMediaEventGeneratorVtbl;

typedef struct VcamMediaSourceVtbl {
	VcamMediaEventGeneratorVtbl generator;   /* inherited, laid out first */
	HRESULT (STDMETHODCALLTYPE *GetCharacteristics)(void *This, DWORD *characteristics);
	HRESULT (STDMETHODCALLTYPE *CreatePresentationDescriptor)(void *This, IMFPresentationDescriptor **descriptor);
	HRESULT (STDMETHODCALLTYPE *Start)(void *This, IMFPresentationDescriptor *descriptor,
	                                   const GUID *time_format, const PROPVARIANT *start_position);
	HRESULT (STDMETHODCALLTYPE *Stop)(void *This);
	HRESULT (STDMETHODCALLTYPE *Pause)(void *This);
	HRESULT (STDMETHODCALLTYPE *Shutdown)(void *This);
	/* IMFMediaSourceEx, which the frame server asks for by name:
	 * {3C9B2EB9-86D5-4514-A394-F56664F9F0D8}. ActivateObject on the activator
	 * receives IID_IMFMediaSourceEx, not IID_IMFMediaSource, and answering
	 * E_NOINTERFACE is what stalls IMFVirtualCamera::Start. */
	HRESULT (STDMETHODCALLTYPE *GetSourceAttributes)(void *This, IMFAttributes **attributes);
	HRESULT (STDMETHODCALLTYPE *GetStreamAttributes)(void *This, DWORD stream_identifier, IMFAttributes **attributes);
	HRESULT (STDMETHODCALLTYPE *SetD3DManager)(void *This, IUnknown *manager);
} VcamMediaSourceVtbl;

typedef struct VcamMediaStreamVtbl {
	VcamMediaEventGeneratorVtbl generator;
	HRESULT (STDMETHODCALLTYPE *GetMediaSource)(void *This, IMFMediaSource **source);
	HRESULT (STDMETHODCALLTYPE *GetStreamDescriptor)(void *This, IMFStreamDescriptor **descriptor);
	HRESULT (STDMETHODCALLTYPE *RequestSample)(void *This, IUnknown *token);
} VcamMediaStreamVtbl;

/* Two more interfaces the frame server asks a capture source for by name, and
 * which MinGW's headers do not declare at all. Neither is optional in the
 * "answer or not" sense: the working reference implementation answers both, and
 * a source that returns E_NOINTERFACE is a different object to a pipeline than
 * one that returns "that service is unsupported". Each is a COM sub-object -
 * a vtable pointer first, then the source it forwards refcounting to - because
 * one C struct cannot carry two vtable pointers at offset zero. */
typedef struct VcamGetServiceVtbl {
	HRESULT (STDMETHODCALLTYPE *QueryInterface)(void *This, REFIID riid, void **out);
	ULONG   (STDMETHODCALLTYPE *AddRef)(void *This);
	ULONG   (STDMETHODCALLTYPE *Release)(void *This);
	HRESULT (STDMETHODCALLTYPE *GetService)(void *This, REFGUID service, REFIID riid, void **out);
} VcamGetServiceVtbl;

/* IKsControl {28F54685-06FD-11D2-B27A-00A0C9223196}. The parameters are the
 * KS structures this build has no headers for; they are never dereferenced,
 * only answered, so their types do not matter beyond the ABI. */
typedef struct VcamKsControlVtbl {
	HRESULT (STDMETHODCALLTYPE *QueryInterface)(void *This, REFIID riid, void **out);
	ULONG   (STDMETHODCALLTYPE *AddRef)(void *This);
	ULONG   (STDMETHODCALLTYPE *Release)(void *This);
	HRESULT (STDMETHODCALLTYPE *KsProperty)(void *This, void *property, ULONG property_length,
	                                        void *data, ULONG data_length, ULONG *bytes_returned);
	HRESULT (STDMETHODCALLTYPE *KsMethod)(void *This, void *method, ULONG method_length,
	                                      void *data, ULONG data_length, ULONG *bytes_returned);
	HRESULT (STDMETHODCALLTYPE *KsEvent)(void *This, void *event, ULONG event_length,
	                                     void *data, ULONG data_length, ULONG *bytes_returned);
} VcamKsControlVtbl;

/* The object the CLSID must provide is an activator: an IMFAttributes whose
 * ActivateObject produces the media source. The frame server asks for
 * IID_IMFActivate directly, which the trace of its QueryInterface calls showed.
 * MinGW does declare IMFAttributesVtbl, so the inherited part is reused. */
typedef struct VcamActivatorVtbl {
	IMFAttributesVtbl attributes;
	HRESULT (STDMETHODCALLTYPE *ActivateObject)(void *This, REFIID riid, void **ppv);
	HRESULT (STDMETHODCALLTYPE *ShutdownObject)(void *This);
	HRESULT (STDMETHODCALLTYPE *DetachObject)(void *This);
} VcamActivatorVtbl;

#endif /* VCAM_MEDIA_INTERFACES_H */
