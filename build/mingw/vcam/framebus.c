#include "framebus.h"

#include <string.h>

static const wchar_t *kMappingName = L"Local\\OpenCVisionStudioVCamFrames";
static const wchar_t *kEventName = L"Local\\OpenCVisionStudioVCamFrameReady";

static size_t frame_bytes(const VcamFrameBusHeader *header)
{
	return (size_t)header->stride * (size_t)header->height;
}

static unsigned long long now_100ns(void)
{
	FILETIME file_time;
	GetSystemTimeAsFileTime(&file_time);
	return ((unsigned long long)file_time.dwHighDateTime << 32) | file_time.dwLowDateTime;
}

int framebus_create(VcamFrameBus *bus, unsigned long width, unsigned long height)
{
	size_t total;

	memset(bus, 0, sizeof(*bus));
	bus->buffer_bytes = (size_t)width * (size_t)height * 4u;
	total = sizeof(VcamFrameBusHeader) + bus->buffer_bytes * VCAM_FRAMEBUS_BUFFERS;

	bus->mapping = CreateFileMappingW(INVALID_HANDLE_VALUE, NULL, PAGE_READWRITE,
	                                  (DWORD)(total >> 32), (DWORD)(total & 0xFFFFFFFFu),
	                                  kMappingName);
	if (!bus->mapping)
		return 0;

	bus->header = (VcamFrameBusHeader *)MapViewOfFile(bus->mapping, FILE_MAP_ALL_ACCESS,
	                                                 0, 0, total);
	if (!bus->header) {
		CloseHandle(bus->mapping);
		bus->mapping = NULL;
		return 0;
	}
	bus->buffers = (unsigned char *)(bus->header + 1);
	bus->frame_ready = CreateEventW(NULL, FALSE, FALSE, kEventName);

	/* A fresh mapping starts zeroed; initialise the geometry every time, so a
	 * stale mapping from a crashed publisher cannot mis-describe the frames. */
	bus->header->magic = VCAM_FRAMEBUS_MAGIC;
	bus->header->version = VCAM_FRAMEBUS_VERSION;
	bus->header->width = width;
	bus->header->height = height;
	bus->header->stride = width * 4u;
	bus->header->pixel_format = VCAM_FRAMEBUS_PIXEL_RGB32;
	bus->header->buffers = VCAM_FRAMEBUS_BUFFERS;
	bus->header->active = 0;
	bus->header->sequence = 0;
	bus->header->frame_index = 0;
	bus->header->published = 0;
	return 1;
}

int framebus_open(VcamFrameBus *bus)
{
	memset(bus, 0, sizeof(*bus));
	bus->mapping = OpenFileMappingW(FILE_MAP_ALL_ACCESS, FALSE, kMappingName);
	if (!bus->mapping)
		return 0;

	bus->header = (VcamFrameBusHeader *)MapViewOfFile(bus->mapping, FILE_MAP_ALL_ACCESS, 0, 0, 0);
	if (!bus->header) {
		CloseHandle(bus->mapping);
		bus->mapping = NULL;
		return 0;
	}
	if (bus->header->magic != VCAM_FRAMEBUS_MAGIC ||
	    bus->header->version != VCAM_FRAMEBUS_VERSION ||
	    bus->header->buffers != VCAM_FRAMEBUS_BUFFERS) {
		UnmapViewOfFile(bus->header);
		CloseHandle(bus->mapping);
		memset(bus, 0, sizeof(*bus));
		return 0;
	}
	bus->buffer_bytes = frame_bytes(bus->header);
	bus->buffers = (unsigned char *)(bus->header + 1);
	bus->frame_ready = CreateEventW(NULL, FALSE, FALSE, kEventName);
	bus->last_sequence = 0;
	return 1;
}

void framebus_close(VcamFrameBus *bus)
{
	if (bus->frame_ready)
		CloseHandle(bus->frame_ready);
	if (bus->header)
		UnmapViewOfFile(bus->header);
	if (bus->mapping)
		CloseHandle(bus->mapping);
	memset(bus, 0, sizeof(*bus));
}

int framebus_publish(VcamFrameBus *bus, const unsigned char *pixels, unsigned long long frame_index)
{
	long idle;

	if (!bus->header || !pixels || !bus->buffer_bytes)
		return 0;

	idle = bus->header->active ^ 1;
	memcpy(bus->buffers + (size_t)idle * bus->buffer_bytes, pixels, bus->buffer_bytes);

	bus->header->frame_index = frame_index;
	bus->header->timestamp_100ns = now_100ns();
	bus->header->published++;
	/* Flip last, and with release semantics: a consumer that sees the new
	 * `active` is guaranteed to see the pixels behind it. */
	InterlockedExchange(&bus->header->active, idle);
	InterlockedIncrement64(&bus->header->sequence);

	if (bus->frame_ready)
		SetEvent(bus->frame_ready);
	return 1;
}

int framebus_acquire(VcamFrameBus *bus, unsigned char *dst, size_t dst_bytes,
                     VcamFrameBusHeader *info, unsigned long timeout_ms)
{
	long long sequence;
	long active;
	size_t bytes;

	if (!bus->header || !dst)
		return 0;

	if (bus->frame_ready)
		WaitForSingleObject(bus->frame_ready, timeout_ms);

	sequence = InterlockedCompareExchange64(&bus->header->sequence, 0, 0);
	if (sequence == bus->last_sequence)
		return 0;
	bus->last_sequence = sequence;

	active = bus->header->active;
	bytes = frame_bytes(bus->header);
	if (bytes > dst_bytes)
		bytes = dst_bytes;
	memcpy(dst, bus->buffers + (size_t)active * bus->buffer_bytes, bytes);

	if (info)
		*info = *bus->header;
	return 1;
}
