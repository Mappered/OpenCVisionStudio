/*
 * Our own declarations of the interfaces the media source exposes.
 *
 * Why not use MinGW's? Because its declarations turned out to be unusable for
 * an object we hand to the Windows frame server:
 *
 *   - MinGW's IMFMediaStreamVtbl has no QueueEventParamVar / QueueEventParamUnk
 *     members at all (the compiler rejects the initialisers).
 *   - MinGW's IMFMediaEventQueue::QueueEvent takes only the event, not the
 *     (type, guid, status, event) tuple; the queue and the generator are
 *     different interfaces with different signatures.
 *
 * The frame server will call these objects through the real layouts, so the
 * layouts here must be exactly right: IUnknown, then IMFMediaEventGenerator's
 * six methods, then the interface's own. Nesting the generator struct as the
 * first member produces that layout, and the method order is taken from
 * Microsoft's documentation.
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
	HRESULT (STDMETHODCALLTYPE *QueueEventParamVar)(void *This, MediaEventType type, REFGUID extended_type,
	                                                HRESULT status, const PROPVARIANT *value);
	HRESULT (STDMETHODCALLTYPE *QueueEventParamUnk)(void *This, MediaEventType type, REFGUID extended_type,
	                                                HRESULT status, IUnknown *value);
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
} VcamMediaSourceVtbl;

typedef struct VcamMediaStreamVtbl {
	VcamMediaEventGeneratorVtbl generator;
	HRESULT (STDMETHODCALLTYPE *GetMediaSource)(void *This, IMFMediaSource **source);
	HRESULT (STDMETHODCALLTYPE *GetStreamDescriptor)(void *This, IMFStreamDescriptor **descriptor);
	HRESULT (STDMETHODCALLTYPE *RequestSample)(void *This, IUnknown *token);
} VcamMediaStreamVtbl;

#endif /* VCAM_MEDIA_INTERFACES_H */
