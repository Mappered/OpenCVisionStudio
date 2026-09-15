/*
 * Round-trip test for the frame bus, runnable in CI with no camera and no frame
 * server: publish three distinguishable frames, attach as a consumer, and check
 * that what comes back is the newest one, with the geometry intact.
 *
 * This is the part of the virtual camera pipeline that CI *can* prove, which is
 * where the effort belongs while the frame server on a Server SKU refuses to
 * bring a software camera up.
 */

#include "framebus.h"

#include <stdio.h>
#include <string.h>

#define TEST_WIDTH 640u
#define TEST_HEIGHT 480u
#define TEST_BYTES ((size_t)TEST_WIDTH * TEST_HEIGHT * 4u)

int main(void)
{
	VcamFrameBus publisher;
	VcamFrameBus consumer;
	unsigned char frame[TEST_BYTES];
	unsigned char received[TEST_BYTES];
	VcamFrameBusHeader info;
	int ok = 1;

	setvbuf(stdout, NULL, _IONBF, 0);

	if (!framebus_create(&publisher, TEST_WIDTH, TEST_HEIGHT)) {
		printf("framebus_create failed (error %lu)\n", (unsigned long)GetLastError());
		printf("FRAMEBUS created=0 published=0 acquired=0 match=0\n");
		return 1;
	}

	/* Three frames, each identifiable by its first pixel and its frame index. */
	for (unsigned long long index = 0; index < 3; index++) {
		memset(frame, (int)(0x10 + index), sizeof(frame));
		frame[0] = (unsigned char)index;
		frame[1] = 0xAA;
		frame[2] = 0xBB;
		frame[3] = 0xFF;
		if (!framebus_publish(&publisher, frame, index)) {
			printf("framebus_publish failed at index %llu\n", (unsigned long long)index);
			ok = 0;
			break;
		}
	}

	if (ok && !framebus_open(&consumer)) {
		printf("framebus_open failed (error %lu)\n", (unsigned long)GetLastError());
		ok = 0;
	}

	memset(&info, 0, sizeof(info));
	memset(received, 0, sizeof(received));
	if (ok) {
		const int acquired = framebus_acquire(&consumer, received, sizeof(received), &info, 1000);
		printf("acquire: %d\n", acquired);
		if (!acquired) {
			ok = 0;
		} else {
			printf("geometry: %lux%lu stride=%lu pixel_format=%lu\n",
			       (unsigned long)info.width, (unsigned long)info.height,
			       (unsigned long)info.stride, (unsigned long)info.pixel_format);
			printf("frame_index=%llu published=%llu\n",
			       (unsigned long long)info.frame_index, (unsigned long long)info.published);
			/* The newest frame is index 2. */
			const int match = received[0] == 2 && received[1] == 0xAA &&
			                  received[2] == 0xBB && received[3] == 0xFF &&
			                  info.width == TEST_WIDTH && info.height == TEST_HEIGHT &&
			                  info.stride == TEST_WIDTH * 4 &&
			                  info.pixel_format == VCAM_FRAMEBUS_PIXEL_RGB32 &&
			                  info.frame_index == 2;
			printf("match: %d\n", match);
			if (!match)
				ok = 0;
		}
	}

	if (consumer.header)
		framebus_close(&consumer);
	framebus_close(&publisher);

	printf("FRAMEBUS created=1 published=3 acquired=%d match=%d\n",
	       ok ? 1 : 0, ok ? 1 : 0);
	return ok ? 0 : 1;
}
