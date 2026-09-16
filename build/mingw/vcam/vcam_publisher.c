/*
 * Virtual camera publisher.
 *
 * The other half of the frame path: a process that owns a camera and writes its
 * frames into the shared-memory bus, which the media source (already built)
 * reads from inside the frame server.
 *
 * Two sources:
 *   --synthetic          generated frames, for machines with no camera
 *   --aravis [device-id] frames from Aravis, i.e. a real GigE Vision or USB3
 *                        Vision camera, or Aravis' own fake GV camera in CI
 *
 * Plus a consumer mode, so CI can prove cross-process delivery: one invocation
 * publishes, another attaches to the same bus and checks what it reads.
 */

#define WIN32_LEAN_AND_MEAN
#include <windows.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "framebus.h"
#include "vcam_clsid.h"

#if defined(VCAM_WITH_ARAVIS)
#include <arv.h>
#endif

/* Marks a frame as produced by this publisher, so a consumer can tell a real
 * published frame from an untouched buffer. */
#define VCAM_FRAME_TAG 0x5Au

static void fill_synthetic(unsigned char *pixels, unsigned long long index)
{
	unsigned y;
	for (y = 0; y < VCAM_FRAME_HEIGHT; y++) {
		unsigned char *row = pixels + (size_t)y * VCAM_FRAME_WIDTH * 4u;
		unsigned x;
		for (x = 0; x < VCAM_FRAME_WIDTH; x++) {
			unsigned char *pixel = row + (size_t)x * 4u;
			pixel[0] = (unsigned char)(index * 3u);
			pixel[1] = VCAM_FRAME_TAG;
			pixel[2] = (unsigned char)(x & 0xFF);
			pixel[3] = 0xFF;
		}
	}
}

static int publish_synthetic(unsigned frames, unsigned delay_ms, unsigned hold_ms)
{
	VcamFrameBus bus;
	unsigned char *frame;
	unsigned i;

	if (!framebus_create(&bus, VCAM_FRAME_WIDTH, VCAM_FRAME_HEIGHT)) {
		printf("publisher: create failed (%lu)\n", (unsigned long)GetLastError());
		return 1;
	}
	frame = (unsigned char *)malloc(VCAM_FRAME_BYTES);
	if (!frame) {
		framebus_close(&bus);
		return 1;
	}

	for (i = 0; i < frames; i++) {
		fill_synthetic(frame, i);
		if (!framebus_publish(&bus, frame, i)) {
			printf("publisher: publish failed at %u\n", i);
			free(frame);
			framebus_close(&bus);
			return 1;
		}
		if (delay_ms)
			Sleep(delay_ms);
	}

	/* Keep the mapping alive so another process can attach and verify it. */
	if (hold_ms)
		Sleep(hold_ms);

	printf("publisher: published %u synthetic frames\n", frames);
	printf("PUBLISHER source=synthetic frames=%u\n", frames);
	free(frame);
	framebus_close(&bus);
	return 0;
}

/* Consumer side of the cross-process check. */
static int verify(void)
{
	VcamFrameBus bus;
	static unsigned char frame[VCAM_FRAME_BYTES];
	VcamFrameBusHeader info;
	int ok;

	if (!framebus_open(&bus)) {
		printf("verify: no publisher on the bus (%lu)\n", (unsigned long)GetLastError());
		printf("PUBLISHER_VERIFY ok=0\n");
		return 1;
	}
	memset(&info, 0, sizeof(info));
	if (!framebus_acquire(&bus, frame, sizeof(frame), &info, 2000)) {
		printf("verify: no frame available\n");
		framebus_close(&bus);
		printf("PUBLISHER_VERIFY ok=0\n");
		return 1;
	}

	/* A real published frame carries the tag; untouched memory would not. */
	ok = frame[1] == VCAM_FRAME_TAG &&
	     info.width == VCAM_FRAME_WIDTH && info.height == VCAM_FRAME_HEIGHT &&
	     info.stride == VCAM_FRAME_WIDTH * 4u &&
	     info.pixel_format == VCAM_FRAMEBUS_PIXEL_RGB32;
	printf("verify: tag=0x%02x geometry=%lux%lu index=%llu published=%llu\n",
	       frame[1], (unsigned long)info.width, (unsigned long)info.height,
	       (unsigned long long)info.frame_index, (unsigned long long)info.published);
	framebus_close(&bus);
	printf("PUBLISHER_VERIFY ok=%d\n", ok);
	return ok ? 0 : 1;
}

#if defined(VCAM_WITH_ARAVIS)

/* Converts the buffer Aravis hands us into the RGB32 the camera advertises. */
static int buffer_to_rgb32(ArvBuffer *buffer, unsigned char *dst, size_t dst_bytes,
                           unsigned long *width_out, unsigned long *height_out,
                           const char **format_name)
{
	const void *data = NULL;
	size_t size = 0;
	int width = arv_buffer_get_image_width(buffer);
	int height = arv_buffer_get_image_height(buffer);
	ArvPixelFormat format = arv_buffer_get_image_pixel_format(buffer);
	size_t pixels;

	*width_out = (unsigned long)width;
	*height_out = (unsigned long)height;
	*format_name = "unsupported";

	if (width <= 0 || height <= 0)
		return 0;
	pixels = (size_t)width * (size_t)height;
	if (pixels * 4u > dst_bytes)
		return 0;

	data = arv_buffer_get_image_data(buffer, &size);
	if (!data)
		return 0;

	if (format == ARV_PIXEL_FORMAT_MONO_8) {
		size_t i;
		if (size < pixels)
			return 0;
		*format_name = "Mono8";
		for (i = 0; i < pixels; i++) {
			const unsigned char value = ((const unsigned char *)data)[i];
			dst[i * 4 + 0] = value;
			dst[i * 4 + 1] = value;
			dst[i * 4 + 2] = value;
			dst[i * 4 + 3] = 0xFF;
		}
		return 1;
	}
	if (format == ARV_PIXEL_FORMAT_RGB_8_PACKED) {
		size_t i;
		if (size < pixels * 3u)
			return 0;
		*format_name = "RGB8";
		for (i = 0; i < pixels; i++) {
			dst[i * 4 + 0] = ((const unsigned char *)data)[i * 3 + 2];
			dst[i * 4 + 1] = ((const unsigned char *)data)[i * 3 + 1];
			dst[i * 4 + 2] = ((const unsigned char *)data)[i * 3 + 0];
			dst[i * 4 + 3] = 0xFF;
		}
		return 1;
	}
	return 0;
}

static int list_aravis_devices(void)
{
	unsigned count;
	unsigned i;

	arv_update_device_list();
	count = arv_get_n_devices();
	printf("aravis: %u device(s)\n", count);
	for (i = 0; i < count; i++) {
		printf("  [%u] id=%s model=%s protocol=%s\n", i,
		       arv_get_device_id(i) ? arv_get_device_id(i) : "(none)",
		       arv_get_device_model(i) ? arv_get_device_model(i) : "(none)",
		       arv_get_device_protocol(i) ? arv_get_device_protocol(i) : "(none)");
	}
	printf("PUBLISHER_ARAVIS_LIST devices=%u\n", count);
	return 0;
}

static int publish_aravis(const char *device_id, unsigned frames)
{
	GError *error = NULL;
	ArvCamera *camera = NULL;
	ArvStream *stream = NULL;
	VcamFrameBus bus;
	unsigned char *frame;
	size_t payload;
	unsigned published = 0;
	unsigned i;
	const char *model;
	const char *protocol;

	camera = arv_camera_new(device_id, &error);
	if (!camera) {
		printf("aravis: cannot open camera '%s': %s\n", device_id ? device_id : "(first)",
		       error ? error->message : "unknown error");
		if (error)
			g_error_free(error);
		printf("PUBLISHER source=aravis published=0\n");
		return 1;
	}

	model = arv_camera_get_model_name(camera, NULL);
	protocol = arv_camera_get_device_id(camera, NULL) ? "device" : "device";
	printf("aravis: opened %s\n", model ? model : "(unknown model)");
	(void)protocol;

	arv_camera_set_acquisition_mode(camera, ARV_ACQUISITION_MODE_CONTINUOUS, &error);
	arv_camera_set_pixel_format(camera, ARV_PIXEL_FORMAT_MONO_8, &error);
	/* Five parameters: callback, user data, destroy notify, then GError. */
	stream = arv_camera_create_stream(camera, NULL, NULL, NULL, &error);
	if (!stream) {
		printf("aravis: cannot create stream: %s\n", error ? error->message : "unknown error");
		if (error)
			g_error_free(error);
		g_object_unref(camera);
		printf("PUBLISHER source=aravis published=0\n");
		return 1;
	}

	payload = arv_camera_get_payload(camera, &error);
	for (i = 0; i < 8; i++)
		arv_stream_push_buffer(stream, arv_buffer_new(payload, NULL));

	arv_camera_start_acquisition(camera, &error);

	if (!framebus_create(&bus, VCAM_FRAME_WIDTH, VCAM_FRAME_HEIGHT)) {
		printf("publisher: bus create failed (%lu)\n", (unsigned long)GetLastError());
		arv_camera_stop_acquisition(camera, NULL);
		g_object_unref(stream);
		g_object_unref(camera);
		printf("PUBLISHER source=aravis published=0\n");
		return 1;
	}
	frame = (unsigned char *)malloc(VCAM_FRAME_BYTES);

	while (frame && published < frames) {
		ArvBuffer *buffer = arv_stream_timeout_pop_buffer(stream, 2000000);
		unsigned long width = 0, height = 0;
		const char *format_name = NULL;

		if (!buffer) {
			printf("aravis: no buffer within the timeout\n");
			break;
		}
		if (arv_buffer_get_status(buffer) == ARV_BUFFER_STATUS_SUCCESS &&
		    buffer_to_rgb32(buffer, frame, VCAM_FRAME_BYTES, &width, &height, &format_name) &&
		    !framebus_publish(&bus, frame, published)) {
			printf("aravis: publish failed\n");
			arv_stream_push_buffer(stream, buffer);
			break;
		}
		if (arv_buffer_get_status(buffer) == ARV_BUFFER_STATUS_SUCCESS) {
			if (published == 0)
				printf("aravis: first frame %lux%lu %s\n", width, height,
				       format_name ? format_name : "?");
			published++;
		}
		arv_stream_push_buffer(stream, buffer);
	}

	if (frame)
		free(frame);
	framebus_close(&bus);
	arv_camera_stop_acquisition(camera, NULL);
	g_object_unref(stream);
	g_object_unref(camera);

	printf("aravis: published %u frames\n", published);
	printf("PUBLISHER source=aravis published=%u\n", published);
	return published ? 0 : 1;
}
#endif /* VCAM_WITH_ARAVIS */

int main(int argc, char **argv)
{
	unsigned frames = 5;
	unsigned hold_ms = 0;
	int i;

	setvbuf(stdout, NULL, _IONBF, 0);

	/* Optional: vcam-publisher.exe --verify */
	for (i = 1; i < argc; i++) {
		if (strcmp(argv[i], "--verify") == 0)
			return verify();
	}

	for (i = 1; i < argc; i++) {
		if (strcmp(argv[i], "--frames") == 0 && i + 1 < argc)
			frames = (unsigned)atoi(argv[i + 1]);
		if (strcmp(argv[i], "--hold") == 0 && i + 1 < argc)
			hold_ms = (unsigned)atoi(argv[i + 1]);
	}

	for (i = 1; i < argc; i++) {
		if (strcmp(argv[i], "--synthetic") == 0)
			return publish_synthetic(frames, 0, hold_ms);
#if defined(VCAM_WITH_ARAVIS)
		if (strcmp(argv[i], "--list") == 0)
			return list_aravis_devices();
		if (strcmp(argv[i], "--aravis") == 0) {
			const char *device = (i + 1 < argc && argv[i + 1][0] != '-') ? argv[i + 1] : NULL;
			return publish_aravis(device, frames);
		}
#endif
	}

	printf("usage: vcam-publisher.exe --synthetic [--frames N] [--hold ms]\n");
#if defined(VCAM_WITH_ARAVIS)
	printf("       vcam-publisher.exe --list\n");
	printf("       vcam-publisher.exe --aravis [device-id] [--frames N]\n");
#endif
	printf("       vcam-publisher.exe --verify\n");
	return 2;
}
