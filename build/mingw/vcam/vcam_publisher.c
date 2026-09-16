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

/* MinGW targets an older Windows than this tool runs on by default, and
 * GetTickCount64 - used to time a live session - needs the Vista-and-later
 * surface to be declared. */
#ifndef _WIN32_WINNT
#define _WIN32_WINNT 0x0601
#endif

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

/* Continuous mode is stopped with Ctrl+C. A console handler may only do things
 * that cannot deadlock, so it does nothing but raise a flag. */
static volatile LONG g_stop = 0;

static BOOL WINAPI on_console(DWORD type)
{
	(void)type;
	InterlockedExchange(&g_stop, 1);
	return TRUE;
}

/* One place that answers "is this run finished?", so the synthetic and the
 * Aravis paths cannot drift apart. frames == 0 and deadline == 0 both mean
 * "no limit"; a run then ends on Ctrl+C. */
static int should_stop(unsigned frames, unsigned published, ULONGLONG deadline)
{
	if (g_stop)
		return 1;
	if (frames && published >= frames)
		return 1;
	if (deadline && GetTickCount64() >= deadline)
		return 1;
	return 0;
}

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

static int publish_synthetic(unsigned frames, unsigned delay_ms, unsigned hold_ms,
                             unsigned seconds)
{
	VcamFrameBus bus;
	unsigned char *frame;
	unsigned i;
	ULONGLONG deadline = 0;

	if (!framebus_create(&bus, VCAM_FRAME_WIDTH, VCAM_FRAME_HEIGHT)) {
		printf("publisher: create failed (%lu)\n", (unsigned long)GetLastError());
		return 1;
	}
	frame = (unsigned char *)malloc(VCAM_FRAME_BYTES);
	if (!frame) {
		framebus_close(&bus);
		return 1;
	}

	SetConsoleCtrlHandler(on_console, TRUE);
	if (seconds)
		deadline = GetTickCount64() + (ULONGLONG)seconds * 1000u;
	/* A live synthetic feed has to be paced, or it would spin the core for no
	 * gain: the media source samples the bus at its own frame rate. */
	if (!frames && !delay_ms)
		delay_ms = 1000u / VCAM_FRAME_FPS;

	for (i = 0; !should_stop(frames, i, deadline); i++) {
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

	printf("publisher: published %u synthetic frames\n", i);
	printf("PUBLISHER source=synthetic frames=%u\n", i);
	free(frame);
	framebus_close(&bus);
	return 0;
}

/* Consumer side of the cross-process check. Two things are worth proving and
 * they are not the same thing: that a frame arrives at all, and that it carries
 * the geometry the media source expects - the second is what a mismatched
 * sensor resolution would break. */
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

	ok = info.width == VCAM_FRAME_WIDTH && info.height == VCAM_FRAME_HEIGHT &&
	     info.stride == VCAM_FRAME_WIDTH * 4u &&
	     info.pixel_format == VCAM_FRAMEBUS_PIXEL_RGB32 && info.published > 0;
	/* The tag only appears in generated frames, so it also says which half of
	 * the pipeline produced what the reader just got. A camera frame is left
	 * with whatever the sensor saw. */
	printf("verify: geometry=%lux%lu stride=%lu index=%llu published=%llu "
	       "tag=0x%02x corner=%02x%02x%02x\n",
	       (unsigned long)info.width, (unsigned long)info.height,
	       (unsigned long)info.stride,
	       (unsigned long long)info.frame_index, (unsigned long long)info.published,
	       frame[1], frame[0], frame[1], frame[2]);
	framebus_close(&bus);
	printf("PUBLISHER_VERIFY ok=%d\n", ok);
	return ok ? 0 : 1;
}

#if defined(VCAM_WITH_ARAVIS)

/* How a source buffer's pixels are laid out, reduced to the three layouts the
 * bus needs. Anything else is reported rather than guessed at: a wrong guess
 * shows up as a garbage webcam image, which is worse than a clear message. */
typedef enum {
	SRC_GRAY8,
	SRC_GRAY16,
	SRC_RGB8,
	SRC_BGR8
} SrcLayout;

typedef struct {
	const unsigned char *data;
	size_t stride;                 /* bytes per row, padding included */
	SrcLayout layout;
} SrcImage;

/* Writes BGR, which is the byte order of MFVideoFormat_RGB32 in memory. */
static void read_source_pixel(const SrcImage *src, int sx, int sy, unsigned char *bgr)
{
	const unsigned char *row = src->data + (size_t)sy * src->stride;

	switch (src->layout) {
	case SRC_GRAY16:
		/* 16-bit greyscale, little endian: the top byte is the 8-bit value. */
		bgr[0] = bgr[1] = bgr[2] = row[(size_t)sx * 2u + 1u];
		break;
	case SRC_RGB8:
		bgr[0] = row[(size_t)sx * 3u + 2u];
		bgr[1] = row[(size_t)sx * 3u + 1u];
		bgr[2] = row[(size_t)sx * 3u + 0u];
		break;
	case SRC_BGR8:
		bgr[0] = row[(size_t)sx * 3u + 0u];
		bgr[1] = row[(size_t)sx * 3u + 1u];
		bgr[2] = row[(size_t)sx * 3u + 2u];
		break;
	case SRC_GRAY8:
	default:
		bgr[0] = bgr[1] = bgr[2] = row[sx];
		break;
	}
}

/* Maps a camera frame onto the fixed geometry the media source advertises.
 *
 * The virtual camera is 640x480 RGB32 whatever the sensor's resolution is, so
 * this cannot be a straight copy: a 512x512 or 1920x1080 sensor would come out
 * sheared. Nearest-neighbour keeps it allocation-free and fast enough for a
 * preview, and the aspect ratio is preserved with black bars so the image is
 * not distorted - for a measuring tool that matters more than filling every
 * pixel. */
static int buffer_to_rgb32(ArvBuffer *buffer, unsigned char *dst, size_t dst_bytes,
                           unsigned long *width_out, unsigned long *height_out,
                           const char **format_name)
{
	const void *data = NULL;
	size_t size = 0;
	int width = arv_buffer_get_image_width(buffer);
	int height = arv_buffer_get_image_height(buffer);
	ArvPixelFormat format = arv_buffer_get_image_pixel_format(buffer);
	SrcImage src;
	int out_w, out_h, x_off, y_off, y;
	size_t dst_pixels = (size_t)VCAM_FRAME_WIDTH * VCAM_FRAME_HEIGHT;

	*width_out = (unsigned long)(width > 0 ? width : 0);
	*height_out = (unsigned long)(height > 0 ? height : 0);
	*format_name = "unsupported";

	if (width <= 0 || height <= 0 || dst_pixels * 4u > dst_bytes)
		return 0;

	data = arv_buffer_get_image_data(buffer, &size);
	if (!data)
		return 0;

	switch (format) {
	case ARV_PIXEL_FORMAT_MONO_8:
		src.layout = SRC_GRAY8;
		*format_name = "Mono8";
		break;
	case ARV_PIXEL_FORMAT_MONO_16:
		src.layout = SRC_GRAY16;
		*format_name = "Mono16";
		break;
	case ARV_PIXEL_FORMAT_RGB_8_PACKED:
		src.layout = SRC_RGB8;
		*format_name = "RGB8";
		break;
	case ARV_PIXEL_FORMAT_BGR_8_PACKED:
		src.layout = SRC_BGR8;
		*format_name = "BGR8";
		break;
	default:
		printf("aravis: pixel format 0x%08lx is not carried by the frame bus "
		       "(Mono8, Mono16, RGB8 and BGR8 are)\n",
		       (unsigned long)format);
		return 0;
	}
	src.data = (const unsigned char *)data;
	/* Payload padding is real on GigE Vision; deriving the row pitch from the
	 * payload keeps padded buffers readable instead of diagonal. */
	src.stride = (size_t)size / (size_t)height;
	if (src.stride < (size_t)width * (src.layout == SRC_GRAY8 ? 1u :
	                                  src.layout == SRC_GRAY16 ? 2u : 3u))
		src.stride = (size_t)width * (src.layout == SRC_GRAY8 ? 1u :
		                              src.layout == SRC_GRAY16 ? 2u : 3u);

	out_w = VCAM_FRAME_WIDTH;
	out_h = (int)((long long)height * VCAM_FRAME_WIDTH / width);
	if (out_h > (int)VCAM_FRAME_HEIGHT) {
		out_h = VCAM_FRAME_HEIGHT;
		out_w = (int)((long long)width * VCAM_FRAME_HEIGHT / height);
	}
	if (out_w < 1)
		out_w = 1;
	if (out_h < 1)
		out_h = 1;
	x_off = ((int)VCAM_FRAME_WIDTH - out_w) / 2;
	y_off = ((int)VCAM_FRAME_HEIGHT - out_h) / 2;

	/* Bars first: the scaled image covers only part of the frame. */
	memset(dst, 0, dst_pixels * 4u);
	for (y = 0; y < out_h; y++) {
		unsigned char *dst_row = dst + (size_t)(y + y_off) * VCAM_FRAME_WIDTH * 4u;
		int sy = (int)((long long)y * height / out_h);
		int x;
		if (sy >= height)
			sy = height - 1;
		for (x = 0; x < out_w; x++) {
			unsigned char *pixel = dst_row + (size_t)(x + x_off) * 4u;
			int sx = (int)((long long)x * width / out_w);
			if (sx >= width)
				sx = width - 1;
			read_source_pixel(&src, sx, sy, pixel);
			pixel[3] = 0xFF;
		}
	}
	return 1;
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

/* The formats the frame bus carries, best first. Aravis converts from the
 * sensor's native format when it has to, so asking for RGB8 works on a
 * Bayer-only camera as well - it only fails when no conversion exists. */
static const struct {
	ArvPixelFormat format;
	const char *name;
} kPreferredFormats[] = {
	{ ARV_PIXEL_FORMAT_RGB_8_PACKED, "RGB8" },
	{ ARV_PIXEL_FORMAT_MONO_8, "Mono8" },
	{ ARV_PIXEL_FORMAT_MONO_16, "Mono16" },
};

static int publish_aravis(const char *device_id, unsigned frames, unsigned seconds)
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
	ULONGLONG deadline = 0;
	ULONGLONG started;

	SetConsoleCtrlHandler(on_console, TRUE);

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
	for (i = 0; i < sizeof(kPreferredFormats) / sizeof(kPreferredFormats[0]); i++) {
		GError *format_error = NULL;
		if (arv_camera_set_pixel_format(camera, kPreferredFormats[i].format, &format_error)) {
			printf("aravis: pixel format %s\n", kPreferredFormats[i].name);
			break;
		}
		g_clear_error(&format_error);
	}
	if (i == sizeof(kPreferredFormats) / sizeof(kPreferredFormats[0]))
		printf("aravis: warning: neither RGB8 nor Mono8/Mono16 was accepted; "
		       "using whatever the camera reports\n");
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

	started = GetTickCount64();
	if (seconds)
		deadline = started + (ULONGLONG)seconds * 1000u;

	while (frame && !should_stop(frames, published, deadline)) {
		ArvBuffer *buffer = arv_stream_timeout_pop_buffer(stream, 2000000);
		unsigned long width = 0, height = 0;
		const char *format_name = NULL;

		if (!buffer) {
			printf("aravis: no buffer within the timeout\n");
			/* A live feed keeps waiting - a camera that stalls for two
			 * seconds has not ended the session. A frame-limited run breaks,
			 * because then the caller is waiting for us to finish. */
			if (frames)
				break;
			continue;
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
			/* A live session needs to show it is alive, and how fast. */
			if (published % 30u == 0u) {
				const ULONGLONG elapsed = GetTickCount64() - started;
				printf("aravis: %u frames in %llu ms (%.1f fps)\n", published,
				       elapsed, elapsed ? (double)published * 1000.0 / (double)elapsed : 0.0);
			}
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
	unsigned seconds = 0;
	int run_forever = 0;
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
		if (strcmp(argv[i], "--seconds") == 0 && i + 1 < argc)
			seconds = (unsigned)atoi(argv[i + 1]);
		if (strcmp(argv[i], "--run") == 0)
			run_forever = 1;
	}
	/* --run and --seconds both mean "no frame limit": one stops on Ctrl+C, the
	 * other after a wall-clock time. Either is live mode. */
	if (run_forever || seconds)
		frames = 0;

	for (i = 1; i < argc; i++) {
		if (strcmp(argv[i], "--synthetic") == 0)
			return publish_synthetic(frames, 0, hold_ms, seconds);
#if defined(VCAM_WITH_ARAVIS)
		if (strcmp(argv[i], "--list") == 0)
			return list_aravis_devices();
		if (strcmp(argv[i], "--aravis") == 0) {
			const char *device = (i + 1 < argc && argv[i + 1][0] != '-') ? argv[i + 1] : NULL;
			/* The client script passes an empty argument when no camera is
			 * named; that means "first camera", not "a camera called ''". */
			if (device && !*device)
				device = NULL;
			return publish_aravis(device, frames, seconds);
		}
#endif
	}

	printf("usage: vcam-publisher.exe --synthetic [--frames N] [--run] [--seconds N] [--hold ms]\n");
#if defined(VCAM_WITH_ARAVIS)
	printf("       vcam-publisher.exe --list\n");
	printf("       vcam-publisher.exe --aravis [device-id] [--frames N] [--run] [--seconds N]\n");
#endif
	printf("\n");
	printf("  --frames N   stop after N frames (default 5)\n");
	printf("  --run        keep publishing until Ctrl+C - this is the live webcam mode\n");
	printf("  --seconds N  keep publishing for N seconds (what CI uses)\n");
	printf("       vcam-publisher.exe --verify\n");
	return 2;
}
