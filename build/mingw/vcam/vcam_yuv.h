/*
 * RGB32 to YUY2, the conversion the media source needs once it advertises the
 * media type a camera is expected to have.
 *
 * The frame bus carries RGB32 because that is what the publisher can produce
 * from any camera without a colour model argument. A camera *source*, though,
 * advertises YUY2 or NV12: the frame server synthesises the other formats from
 * whatever the source declares, and a source that declares RGB32 is declaring
 * something no capture device does.
 *
 * BT.601 studio swing, integer arithmetic. Shared with the harness that checks
 * the pixels, so the two cannot drift apart.
 */

#ifndef VCAM_YUV_H
#define VCAM_YUV_H

static inline unsigned char vcam_clamp_u8(int value)
{
	if (value < 0)
		return 0;
	if (value > 255)
		return 255;
	return (unsigned char)value;
}

static inline void vcam_rgb_to_yuv(unsigned char r, unsigned char g, unsigned char b,
                                   unsigned char *y, unsigned char *u, unsigned char *v)
{
	*y = vcam_clamp_u8(((66 * r + 129 * g + 25 * b + 128) >> 8) + 16);
	*u = vcam_clamp_u8(((-38 * r - 74 * g + 112 * b + 128) >> 8) + 128);
	*v = vcam_clamp_u8(((112 * r - 94 * g - 18 * b + 128) >> 8) + 128);
}

/* Writes width*height*2 bytes: Y0 U Y1 V per pixel pair. */
static inline void vcam_rgb32_to_yuy2(const unsigned char *rgb32, unsigned char *yuy2,
                                      unsigned long width, unsigned long height)
{
	unsigned long y;

	for (y = 0; y < height; y++) {
		const unsigned char *src = rgb32 + (size_t)y * width * 4u;
		unsigned char *dst = yuy2 + (size_t)y * width * 2u;
		unsigned long x;
		for (x = 0; x + 1 < width; x += 2) {
			const unsigned char *p0 = src + (size_t)x * 4u;
			const unsigned char *p1 = src + (size_t)(x + 1) * 4u;
			unsigned char y0, u0, v0, y1, u1, v1;
			vcam_rgb_to_yuv(p0[2], p0[1], p0[0], &y0, &u0, &v0);
			vcam_rgb_to_yuv(p1[2], p1[1], p1[0], &y1, &u1, &v1);
			dst[x * 2 + 0] = y0;
			/* Averaging the two chroma samples keeps a two-tone edge from
			 * picking one side's colour for both pixels. */
			dst[x * 2 + 1] = (unsigned char)(((unsigned)u0 + (unsigned)u1) / 2u);
			dst[x * 2 + 2] = y1;
			dst[x * 2 + 3] = (unsigned char)(((unsigned)v0 + (unsigned)v1) / 2u);
		}
		/* A YUY2 row is an even number of bytes by definition, so the caller
		 * must not ask for an odd width; every capture format in use here is
		 * even, and the media type says so. */
	}
}

#endif /* VCAM_YUV_H */
