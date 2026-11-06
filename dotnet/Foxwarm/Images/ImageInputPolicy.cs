namespace Foxwarm.Images;

// Source admission is byte-first, then metadata-only; pixel conversion is a later operation.
internal static class ImageInputPolicy
{
    internal const long MaxBytes = 32L * 1024 * 1024;

    // Image formats admitted as model image input; others (e.g. SVG) remain ordinary files.
    internal static bool IsImageInput(string mime) =>
        RasterCodec.IsSafeRaster(mime) || RasterCodec.IsHeif(mime) || mime == "image/tiff";

    // Formats the provider preparation can send as pixels (HEIF is converted first).
    internal static bool IsProviderImage(string mime) =>
        RasterCodec.IsSafeRaster(mime) || RasterCodec.IsHeif(mime);

    internal static bool IsOversized(byte[] bytes, string mime)
    {
        if (bytes.LongLength > MaxBytes)
            return true;
        if (RasterCodec.IsHeif(mime))
        {
            var dimensions = HeifDecoder.Inspect(bytes);
            return (long)dimensions.Width * dimensions.Height > HeifDecoder.MaxPixels;
        }
        if (mime == "image/tiff")
        {
            var dimensions = TiffMetadata.Inspect(bytes);
            return (long)dimensions.Width * dimensions.Height > HeifDecoder.MaxPixels;
        }
        var probe = RasterCodec.Inspect(bytes, mime, enforcePixelLimit: false);
        return (long)probe.Width * probe.Height > HeifDecoder.MaxPixels;
    }
}
