/*
 * Registers (or removes) the virtual camera media source as a COM in-proc
 * server.
 *
 * Both registry roots are attempted and reported separately, because which one
 * the frame server actually reads is an open question: the frame server may run
 * in the user's session (HKCU is enough) or as a service (HKLM is required).
 * The probe output settles it.
 *
 * Usage:
 *   vcam_register register <path-to-vcamsource.dll>
 *   vcam_register unregister
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>

#include "vcam_clsid.h"

static const wchar_t *kClsidKey = L"Software\\Classes\\CLSID\\" VCAM_SOURCE_CLSID_STRING;
static const wchar_t *kDescription = L"OpenCVisionStudio Virtual Camera Media Source";

static HRESULT set_string(HKEY root, const wchar_t *subkey, const wchar_t *name, const wchar_t *value)
{
	HKEY key = NULL;
	LONG status = RegCreateKeyExW(root, subkey, 0, NULL, REG_OPTION_NON_VOLATILE,
	                              KEY_WRITE, NULL, &key, NULL);
	if (status != ERROR_SUCCESS)
		return HRESULT_FROM_WIN32(status);
	status = RegSetValueExW(key, name, 0, REG_SZ, (const BYTE *)value,
	                        (DWORD)((wcslen(value) + 1) * sizeof(wchar_t)));
	RegCloseKey(key);
	return HRESULT_FROM_WIN32(status);
}

static void register_root(HKEY root, const wchar_t *label, const wchar_t *dll_path)
{
	wchar_t inproc[512];
	HRESULT hr;

	swprintf(inproc, 512, L"%ls\\InprocServer32", kClsidKey);

	hr = set_string(root, kClsidKey, NULL, kDescription);
	printf("  %ls: class key   0x%08lx\n", label, (unsigned long)hr);
	if (FAILED(hr))
		return;

	hr = set_string(root, inproc, NULL, dll_path);
	printf("  %ls: server path 0x%08lx\n", label, (unsigned long)hr);
	if (FAILED(hr))
		return;

	hr = set_string(root, inproc, L"ThreadingModel", L"Both");
	printf("  %ls: threading   0x%08lx\n", label, (unsigned long)hr);
}

static void unregister_root(HKEY root, const wchar_t *label)
{
	LONG status = RegDeleteTreeW(root, kClsidKey);
	printf("  %ls: delete 0x%08lx\n", label, (unsigned long)HRESULT_FROM_WIN32(status));
}

int main(int argc, char **argv)
{
	if (argc < 2) {
		printf("usage: vcam_register register <dll> | unregister\n");
		return 2;
	}

	if (_stricmp(argv[1], "register") == 0) {
		wchar_t dll_path[MAX_PATH];
		DWORD length;
		if (argc < 3) {
			printf("error: register needs the DLL path\n");
			return 2;
		}
		length = GetFullPathNameA(argv[2], MAX_PATH, dll_path, NULL);
		if (length == 0 || length >= MAX_PATH) {
			printf("error: cannot resolve %s\n", argv[2]);
			return 1;
		}
		if (GetFileAttributesW(dll_path) == INVALID_FILE_ATTRIBUTES) {
			printf("error: %ls does not exist\n", dll_path);
			return 1;
		}
		printf("registering %ls\n", dll_path);
		printf("CLSID %ls\n", VCAM_SOURCE_CLSID_STRING);
		register_root(HKEY_CURRENT_USER, L"HKCU", dll_path);
		register_root(HKEY_LOCAL_MACHINE, L"HKLM", dll_path);
		printf("VCAM_REGISTER action=register clsid=%ls\n", VCAM_SOURCE_CLSID_STRING);
		return 0;
	}

	if (_stricmp(argv[1], "unregister") == 0) {
		unregister_root(HKEY_CURRENT_USER, L"HKCU");
		unregister_root(HKEY_LOCAL_MACHINE, L"HKLM");
		printf("VCAM_REGISTER action=unregister clsid=%ls\n", VCAM_SOURCE_CLSID_STRING);
		return 0;
	}

	printf("unknown action %s\n", argv[1]);
	return 2;
}
