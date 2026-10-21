namespace Foxwarm.Images;

// Source admission is byte-first, then metadata-only; pixel conversion is a later operation.
internal static class ImageInputPolicy
{
    internal const long MaxBytes = 32L * 1024 * 1024;

    internal static bool IsOversized(byte[] bytes, string mime)
    {
        if (bytes.LongLength > MaxBytes)
            return true;
        if (RasterCodec.IsHeif(mime))
        {
            var dimensions = HeifDecoder.Inspect(bytes);
            return (long)dimensions.Width * dimensions.Height > HeifDecoder.MaxPixels;
        }
        var probe = RasterCodec.Inspect(bytes, mime, enforcePixelLimit: false);
        return (long)probe.Width * probe.Height > HeifDecoder.MaxPixels;
    }
}
