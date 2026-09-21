/*
 * Identity shared by every piece of the virtual camera: the COM class of the
 * media source, the source id handed to MFCreateVirtualCamera, and the friendly
 * name applications will see.
 *
 * The source id passed to MFCreateVirtualCamera is this CLSID as a string. That
 * was established by measurement: with nothing registered under it, Start()
 * returns REGDB_E_CLASSNOTREG, which means the frame server instantiates a COM
 * object by that CLSID to pull frames.
 */

#ifndef VCAM_CLSID_H
#define VCAM_CLSID_H

/* {8F2B1E4C-3D6A-4A21-9C7E-5B0D8A3F6C11} */
#define VCAM_SOURCE_CLSID_STRING L"{8F2B1E4C-3D6A-4A21-9C7E-5B0D8A3F6C11}"

#define VCAM_FRIENDLY_NAME L"OpenCVisionStudio Virtual Camera"

/* Frame geometry produced by the media source. Kept in one place because the
 * media type, the buffer sizes and the pattern generator must agree. */
#define VCAM_FRAME_WIDTH 640
#define VCAM_FRAME_HEIGHT 480
#define VCAM_FRAME_FPS 30
#define VCAM_FRAME_BYTES ((VCAM_FRAME_WIDTH) * (VCAM_FRAME_HEIGHT) * 4)

#endif /* VCAM_CLSID_H */
