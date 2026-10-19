namespace Foxwarm.Images;

// Signature recognition only; decoding and image metadata retain their existing owners.
internal static class RasterImageMime
{
    internal const int HeaderBytes = 12;

    internal static string? Detect(ReadOnlySpan<byte> bytes) =>
        bytes.Length >= 8
        && bytes[..8].SequenceEqual(new byte[] { 0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a })
            ? "image/png"
        : bytes.Length >= 3 && bytes[0] == 0xff && bytes[1] == 0xd8 && bytes[2] == 0xff
            ? "image/jpeg"
        : bytes.Length >= 12
        && bytes[..4].SequenceEqual("RIFF"u8)
        && bytes.Slice(8, 4).SequenceEqual("WEBP"u8)
            ? "image/webp"
        : bytes.Length >= 6 && bytes[..4].SequenceEqual("GIF8"u8) ? "image/gif"
        : bytes.Length >= 2 && bytes[..2].SequenceEqual("BM"u8) ? "image/bmp"
        : null;
}
