/*
 * Frame bus: the shared-memory path from whatever owns the camera to the media
 * source that the frame server activates.
 *
 * The two halves run in different processes - the publishing application (which
 * will own the Aravis camera) and the media source, which Media Foundation
 * loads inside the frame server. Shared memory plus a named event is the
 * cheapest way to carry frames across that boundary: one copy in, one copy out,
 * no serialisation, and no dependency on the publisher being alive at
 * activation time (the consumer falls back to generating frames if it is not).
 *
 * Two buffers, double-buffered by `active`: the publisher writes the idle one
 * and then flips, so a reader can copy the frame it was told about without ever
 * seeing a half-written buffer. `sequence` is incremented with release
 * semantics after the pixels are written.
 */

#ifndef VCAM_FRAMEBUS_H
#define VCAM_FRAMEBUS_H

#include <windows.h>

#define VCAM_FRAMEBUS_MAGIC 0x5643414Du      /* 'V''C''A''M' */
#define VCAM_FRAMEBUS_VERSION 1u
#define VCAM_FRAMEBUS_PIXEL_RGB32 1u
#define VCAM_FRAMEBUS_BUFFERS 2u

typedef struct VcamFrameBusHeader {
	unsigned long magic;
	unsigned long version;
	unsigned long width;
	unsigned long height;
	unsigned long stride;
	unsigned long pixel_format;
	unsigned long buffers;
	volatile long active;              /* index of the buffer holding the newest frame */
	volatile long long sequence;       /* bumped after each complete write */
	unsigned long long frame_index;
	unsigned long long timestamp_100ns;
	unsigned long long published;      /* total frames published by the writer */
} VcamFrameBusHeader;

typedef struct VcamFrameBus {
	HANDLE mapping;
	HANDLE frame_ready;                /* auto-reset: signalled per published frame */
	VcamFrameBusHeader *header;
	unsigned char *buffers;
	size_t buffer_bytes;
	long long last_sequence;
} VcamFrameBus;

/* Publisher side: creates the mapping (or attaches to a live one). */
int framebus_create(VcamFrameBus *bus, unsigned long width, unsigned long height);

/* Consumer side: attaches to an existing mapping; fails if no publisher exists. */
int framebus_open(VcamFrameBus *bus);

void framebus_close(VcamFrameBus *bus);

/* Copies one frame in and flips the active buffer. */
int framebus_publish(VcamFrameBus *bus, const unsigned char *pixels, unsigned long long frame_index);

/* Waits briefly for a new frame; returns 1 if `dst` was filled. */
int framebus_acquire(VcamFrameBus *bus, unsigned char *dst, size_t dst_bytes,
                     VcamFrameBusHeader *info, unsigned long timeout_ms);

#endif /* VCAM_FRAMEBUS_H */
