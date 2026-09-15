/*
 * Minimal declarations for the Windows 11 virtual camera API.
 *
 * MinGW-w64's shipped headers stop short of this API (mfvirtualcamera.h is not
 * present in MSYS2's 14.0.0 headers), so the declarations live here and the
 * entry point is resolved with GetProcAddress instead of a link-time import.
 * Every fact below was verified against Microsoft's IDL and docs rather than
 * recalled:
 *
 *   - MFCreateVirtualCamera is exported by mfsensorgroup.dll, NOT mfplat.dll.
 *     mfplat, mfcore, mf, mfreadwrite, mfmediaengine and windows.media all
 *     report no such export; this was measured on Windows build 26100.
 *   - Prototype, from Microsoft's IDL: eight parameters, the sixth and seventh
 *     being a device-interface category list and its count. A seven-parameter
 *     guess with an attributes object faulted, which is how this was found.
 *   - IMFVirtualCamera derives from IMFAttributes, so the inherited vtable is
 *     spelled by embedding IMFAttributesVtbl (which MinGW does declare).
 *   - IIDs: IMFVirtualCamera {1C08A864-EF6C-4C75-AF59-5F2D68DA9563},
 *     IMFCameraSyncObject {6338B23A-3042-49D2-A3EA-EC0FED815407}.
 *   - sourceId is a CLSID string: it names the media source COM server that the
 *     frame server activates to pull frames from the publishing application.
 */

#ifndef VCAM_MFVCAM_H
#define VCAM_MFVCAM_H

#define CINTERFACE
#define COBJMACROS
#include <windows.h>
#include <objbase.h>
#include <mfapi.h>
#include <mfidl.h>
#include <mfobjects.h>

typedef enum MFVirtualCameraType {
	MFVirtualCameraType_SoftwareCameraSource = 0
} MFVirtualCameraType;

typedef enum MFVirtualCameraLifetime {
	MFVirtualCameraLifetime_Session = 0,
	MFVirtualCameraLifetime_System = 1
} MFVirtualCameraLifetime;

typedef enum MFVirtualCameraAccess {
	MFVirtualCameraAccess_CurrentUser = 0,
	MFVirtualCameraAccess_AllUsers = 1
} MFVirtualCameraAccess;

struct _DEVPROPKEY;

typedef struct IMFCameraSyncObject IMFCameraSyncObject;
typedef struct IMFVirtualCamera IMFVirtualCamera;

typedef struct IMFCameraSyncObjectVtbl {
	HRESULT (STDMETHODCALLTYPE *QueryInterface)(IMFCameraSyncObject *This, REFIID riid, void **ppv);
	ULONG   (STDMETHODCALLTYPE *AddRef)(IMFCameraSyncObject *This);
	ULONG   (STDMETHODCALLTYPE *Release)(IMFCameraSyncObject *This);
	HRESULT (STDMETHODCALLTYPE *WaitOnSignal)(IMFCameraSyncObject *This, DWORD timeout_ms);
	void    (STDMETHODCALLTYPE *Shutdown)(IMFCameraSyncObject *This);
} IMFCameraSyncObjectVtbl;

struct IMFCameraSyncObject {
	IMFCameraSyncObjectVtbl *lpVtbl;
};

/* The inherited IMFAttributes vtable comes first, method for method. */
typedef struct IMFVirtualCameraVtbl {
	IMFAttributesVtbl attributes;
	HRESULT (STDMETHODCALLTYPE *AddDeviceSourceInfo)(IMFVirtualCamera *This, LPCWSTR device_source_info);
	HRESULT (STDMETHODCALLTYPE *AddProperty)(IMFVirtualCamera *This, const struct _DEVPROPKEY *key,
	                                        ULONG type, const BYTE *data, ULONG size);
	HRESULT (STDMETHODCALLTYPE *AddRegistryEntry)(IMFVirtualCamera *This, LPCWSTR entry_name,
	                                              LPCWSTR subkey_path, DWORD reg_type,
	                                              const BYTE *data, ULONG size);
	HRESULT (STDMETHODCALLTYPE *Start)(IMFVirtualCamera *This, IMFAsyncCallback *callback);
	HRESULT (STDMETHODCALLTYPE *Stop)(IMFVirtualCamera *This);
	HRESULT (STDMETHODCALLTYPE *Remove)(IMFVirtualCamera *This);
	HRESULT (STDMETHODCALLTYPE *GetMediaSource)(IMFVirtualCamera *This, IMFMediaSource **source);
	HRESULT (STDMETHODCALLTYPE *SendCameraProperty)(IMFVirtualCamera *This, REFGUID property_set,
	                                                ULONG property_id, ULONG property_flags,
	                                                void *property_payload, ULONG property_payload_length,
	                                                void *data, ULONG data_length, ULONG *data_written);
	HRESULT (STDMETHODCALLTYPE *CreateSyncEvent)(IMFVirtualCamera *This, REFGUID event_set,
	                                             ULONG event_id, ULONG event_flags, HANDLE event_handle,
	                                             IMFCameraSyncObject **sync_object);
	HRESULT (STDMETHODCALLTYPE *CreateSyncSemaphore)(IMFVirtualCamera *This, REFGUID event_set,
	                                                 ULONG event_id, ULONG event_flags,
	                                                 HANDLE semaphore_handle, LONG adjustment,
	                                                 IMFCameraSyncObject **sync_object);
	HRESULT (STDMETHODCALLTYPE *Shutdown)(IMFVirtualCamera *This);
} IMFVirtualCameraVtbl;

struct IMFVirtualCamera {
	IMFVirtualCameraVtbl *lpVtbl;
};

/* Released through the inherited IUnknown, which sits at the head of the
 * IMFAttributes part of the vtable. */
static __inline void IMFVirtualCamera_Release(IMFVirtualCamera *camera)
{
	camera->lpVtbl->attributes.Release((IMFAttributes *)camera);
}

static __inline HRESULT IMFVirtualCamera_Start(IMFVirtualCamera *camera, IMFAsyncCallback *callback)
{
	return camera->lpVtbl->Start(camera, callback);
}

static __inline HRESULT IMFVirtualCamera_Stop(IMFVirtualCamera *camera)
{
	return camera->lpVtbl->Stop(camera);
}

static __inline HRESULT IMFVirtualCamera_Remove(IMFVirtualCamera *camera)
{
	return camera->lpVtbl->Remove(camera);
}

static __inline HRESULT IMFVirtualCamera_Shutdown(IMFVirtualCamera *camera)
{
	return camera->lpVtbl->Shutdown(camera);
}

typedef HRESULT (STDAPICALLTYPE *PFN_MFCreateVirtualCamera)(
	MFVirtualCameraType type,
	MFVirtualCameraLifetime lifetime,
	MFVirtualCameraAccess access,
	LPCWSTR friendly_name,
	LPCWSTR source_id,
	const GUID *categories,
	ULONG category_count,
	IMFVirtualCamera **virtual_camera);

typedef HRESULT (STDAPICALLTYPE *PFN_MFIsVirtualCameraTypeSupported)(
	MFVirtualCameraType type,
	BOOL *supported);

/* mfsensorgroup.dll is where these live; the module is intentionally never
 * freed, since its lifetime is the process's. */
static __inline PFN_MFCreateVirtualCamera vcam_resolve_create(void)
{
	HMODULE module = LoadLibraryW(L"mfsensorgroup.dll");
	if (!module)
		return NULL;
	return (PFN_MFCreateVirtualCamera)(void *)GetProcAddress(module, "MFCreateVirtualCamera");
}

static __inline PFN_MFIsVirtualCameraTypeSupported vcam_resolve_supported(void)
{
	HMODULE module = LoadLibraryW(L"mfsensorgroup.dll");
	if (!module)
		return NULL;
	return (PFN_MFIsVirtualCameraTypeSupported)(void *)GetProcAddress(module, "MFIsVirtualCameraTypeSupported");
}

#endif /* VCAM_MFVCAM_H */
