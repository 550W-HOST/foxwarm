using System.Runtime.InteropServices;
using SkiaSharp;

namespace Foxwarm.Images;

internal static class RasterCrop
{
    internal sealed class Outside(int sourceWidth, int sourceHeight) : Exception
    {
        internal int Width => sourceWidth;
        internal int Height => sourceHeight;

        internal InvalidDataException ForRectangle(int x, int y, int width, int height) =>
            new(
                $"Crop rectangle ({x}, {y}, {width}, {height}) exceeds source image bounds {Width}x{Height}."
            );
    }

    internal static RasterCodec.Variant Crop(
        byte[] bytes,
        string mime,
        int x,
        int y,
        int width,
        int height
    )
    {
        int sourceWidth;
        int sourceHeight;
        using var source = mime is "image/heic" or "image/heif"
            ? DecodeHeifSource(bytes, out sourceWidth, out sourceHeight)
            : DecodeRasterSource(bytes, mime, out sourceWidth, out sourceHeight);
        if ((long)x + width > sourceWidth || (long)y + height > sourceHeight)
            throw new Outside(sourceWidth, sourceHeight);
        using var cropped = new SKBitmap(
            new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Premul)
        );
        if (!source.ExtractSubset(cropped, new SKRectI(x, y, x + width, y + height)))
            throw new InvalidDataException("Image crop failed.");
        var format = mime switch
        {
            "image/jpeg" => SKEncodedImageFormat.Jpeg,
            "image/webp" => SKEncodedImageFormat.Webp,
            _ => SKEncodedImageFormat.Png,
        };
        using var image = SKImage.FromBitmap(cropped);
        using var encoded =
            image.Encode(format, 90)
            ?? throw new InvalidDataException("Image crop encoding failed.");
        var outputBytes = encoded.ToArray();
        var outputMime =
            format == SKEncodedImageFormat.Jpeg ? "image/jpeg"
            : format == SKEncodedImageFormat.Webp ? "image/webp"
            : "image/png";
        return new(outputBytes, outputMime, width, height);
    }

    private static SKBitmap DecodeHeifSource(byte[] bytes, out int width, out int height)
    {
        var decoded = HeifDecoder.DecodeImage(bytes);
        width = decoded.Width;
        height = decoded.Height;
        var source = new SKBitmap(
            new SKImageInfo(width, height, SKColorType.Rgba8888, SKAlphaType.Unpremul)
        );
        try
        {
            if (source.GetPixels() == IntPtr.Zero)
                throw new InvalidDataException("HEIF pixel allocation failed.");
            Marshal.Copy(decoded.Rgba, 0, source.GetPixels(), decoded.Rgba.Length);
            return source;
        }
        catch
        {
            source.Dispose();
            throw;
        }
    }

    private static SKBitmap DecodeRasterSource(
        byte[] bytes,
        string mime,
        out int width,
        out int height
    )
    {
        if (!RasterCodec.IsSafeRaster(mime))
            throw new InvalidDataException(
                "image_crop supports PNG, JPEG, WebP, and HEIF images on this host."
            );
        var probe = RasterCodec.Inspect(bytes, mime);
        width = probe.Width;
        height = probe.Height;
        using var data = SKData.CreateCopy(bytes);
        using var codec =
            SKCodec.Create(data) ?? throw new InvalidDataException("Image raster is invalid.");
        var source = new SKBitmap(
            new SKImageInfo(
                codec.Info.Width,
                codec.Info.Height,
                SKColorType.Rgba8888,
                SKAlphaType.Unpremul
            )
        );
        try
        {
            if (codec.GetPixels(source.Info, source.GetPixels()) != SKCodecResult.Success)
                throw new InvalidDataException("Image pixel decoding failed.");
            return source;
        }
        catch
        {
            source.Dispose();
            throw;
        }
    }
}
