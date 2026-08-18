# Image test fixtures

`synthetic-3x2.heic` and `synthetic-alpha-3x2.heic` are deterministic 3 by 2
images generated from synthetic pixels with Pillow and pillow-heif. The first
is opaque red; the second is blue with one transparent pixel. They contain no
external or user-provided image content and are used only to exercise
HEVC-backed HEIF decoding at the provider hydration boundary.

The committed bytes were generated with Pillow 12.3.0, pillow-heif 1.5.0, and
libheif 1.23.1.