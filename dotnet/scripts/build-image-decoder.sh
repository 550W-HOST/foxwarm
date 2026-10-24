#!/usr/bin/env bash
# Build only the declared Linux HEIC input prerequisite in a caller-owned prefix.
set -euo pipefail
if [[ $# != 1 ]]; then echo "Usage: $0 <owned-build-directory>" >&2; exit 2; fi
for command in cmake curl sha256sum tar; do command -v "$command" >/dev/null; done
mkdir -p "$1"
root=$(cd "$1" && pwd -P)
mkdir -p "$root/sources" "$root/prefix"
fetch() {
  local name=$1 url=$2 digest=$3
  if [[ ! -f "$root/sources/$name.tar.gz" ]]; then curl --fail --location "$url" --output "$root/sources/$name.tar.gz"; fi
  printf '%s  %s\n' "$digest" "$root/sources/$name.tar.gz" | sha256sum --check
  if [[ ! -d "$root/sources/$name" ]]; then
    mkdir "$root/sources/$name"
    tar -xzf "$root/sources/$name.tar.gz" --strip-components=1 -C "$root/sources/$name"
  fi
}
fetch libde265 https://codeload.github.com/strukturag/libde265/tar.gz/refs/tags/v1.1.3 189baa08fd6d2dd34db099de411bd6b2e6bd5eb88e81236a3d0fa3826b9715c4
fetch libheif https://codeload.github.com/strukturag/libheif/tar.gz/refs/tags/v1.23.5 3be49950c75d3fd9318ba775e8253248dd9e08c61ea955fca81b6b89c02d6b2b
cmake -S "$root/sources/libde265" -B "$root/libde265-build" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_INSTALL_PREFIX="$root/prefix" \
  -DENABLE_DECODER=OFF -DENABLE_ENCODER=OFF -DENABLE_SHERLOCK265=OFF -DENABLE_INTERNAL_DEVELOPMENT_TOOLS=OFF
cmake --build "$root/libde265-build" --parallel 2
cmake --install "$root/libde265-build"
PKG_CONFIG_PATH="$root/prefix/lib/pkgconfig${PKG_CONFIG_PATH:+:$PKG_CONFIG_PATH}" \
cmake -S "$root/sources/libheif" -B "$root/libheif-build" \
  -DCMAKE_BUILD_TYPE=Release -DCMAKE_INSTALL_LIBDIR=lib -DCMAKE_INSTALL_PREFIX="$root/prefix" -DCMAKE_PREFIX_PATH="$root/prefix" \
  -DCMAKE_INSTALL_RPATH="$root/prefix/lib" -DENABLE_PLUGIN_LOADING=OFF \
  -DWITH_LIBDE265=ON -DWITH_LIBDE265_PLUGIN=OFF -DWITH_EXAMPLES=OFF -DBUILD_TESTING=OFF \
  -DWITH_X265=OFF -DWITH_X264=OFF -DWITH_KVAZAAR=OFF -DWITH_AOM_ENCODER=OFF -DWITH_AOM_DECODER=OFF \
  -DWITH_DAV1D=OFF -DWITH_RAV1E=OFF -DWITH_SvtEnc=OFF -DWITH_FFMPEG_DECODER=OFF \
  -DWITH_JPEG_ENCODER=OFF -DWITH_JPEG_DECODER=OFF -DWITH_OpenJPEG_ENCODER=OFF -DWITH_OpenJPEG_DECODER=OFF \
  -DWITH_OpenH264_DECODER=OFF -DWITH_OPENJPH_ENCODER=OFF -DWITH_UVG266=OFF -DWITH_VVDEC=OFF -DWITH_VVENC=OFF \
  -DWITH_UNCOMPRESSED_CODEC=OFF -DWITH_WEBCODECS=OFF -DWITH_HEADER_COMPRESSION=OFF -DWITH_GDK_PIXBUF=OFF
cmake --build "$root/libheif-build" --parallel 2
cmake --install "$root/libheif-build"
printf 'Native input prerequisite: %s/prefix/lib\n' "$root"
