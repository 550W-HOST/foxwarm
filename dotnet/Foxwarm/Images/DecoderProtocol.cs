using System.Buffers.Binary;

namespace Foxwarm.Images;

// Private protocol between executables from the same build. Both headers are fixed-size and
// contain only little-endian integers. No file names, exception text or raw pixels on this wire.
internal enum DecodeOperation
{
    Probe,
    Optimize,
    ValidateHeif,
    RequireHeif,
    Crop,
    Identify,
}

internal static class DecoderProtocol
{
    internal const int MaxBytes = 64 * 1024 * 1024;
    internal const int RequestSize = 8 * sizeof(int);
    internal const int ReplySize = 6 * sizeof(int);
    internal const int Ok = 0,
        Bounds = 1,
        Refused = 2;
    internal const string Failed = "This image couldn't be processed.";
    internal const string Busy = "Image processing is busy. Try again in a moment.";

    internal static readonly string[] Mimes =
    [
        "",
        "image/png",
        "image/jpeg",
        "image/gif",
        "image/webp",
        "image/heic",
        "image/heif",
    ];

    // Keep existing local errors (including the ingress InvalidRaster classification). Never
    // interpolate a worker-supplied string into an exception, log, path, tool or model result.
    internal static readonly string[] Errors =
    [
        "Image raster is invalid.",
        "Image bytes do not match the declared MIME type.",
        "Image has invalid dimensions.",
        "Image exceeds the 64-megapixel limit or has invalid dimensions.",
        "Invalid provider image output format.",
        "Image pixel allocation failed.",
        "Image pixel decoding failed.",
        "Provider image encoding failed.",
        "HEIC input requires the documented Linux x64 native decoder prerequisite.",
        "HEIC input requires libheif 1.23.5 with libde265 1.1.3.",
        "The HEIC native prerequisite has no HEVC decoder.",
        "HEIC input requires compatible libheif 1.23.5 and libde265 1.1.3 native libraries.",
        "HEIC decoder could not allocate its context.",
        "HEIC native security-limit ABI is incompatible.",
        "HEIC container is invalid or exceeds native safety limits.",
        "HEIC input has no valid primary image.",
        "HEIC native decoding-options ABI is incompatible.",
        "HEIC pixels are invalid or exceed native safety limits.",
        "HEIC decoder returned incompatible transformed plane dimensions.",
        "HEIC decoder returned an invalid pixel plane.",
        "Image crop failed.",
        "Image crop encoding failed.",
        "HEIF pixel allocation failed.",
        "image_crop supports PNG, JPEG, WebP, and HEIF images on this host.",
    ];
    internal const int FirstError = 3;

    internal static int Read(byte[] header, int index) =>
        BinaryPrimitives.ReadInt32LittleEndian(header.AsSpan(index * 4));

    internal static byte[] Header(params ReadOnlySpan<int> fields)
    {
        var bytes = new byte[fields.Length * 4];
        for (var i = 0; i < fields.Length; i++)
            BinaryPrimitives.WriteInt32LittleEndian(bytes.AsSpan(i * 4), fields[i]);
        return bytes;
    }
}
