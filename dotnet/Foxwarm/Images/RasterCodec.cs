using System.Runtime.InteropServices;
using SkiaSharp;

namespace Foxwarm.Images;

internal static class RasterCodec
{
    internal sealed record Probe(int Width, int Height, string MimeType, SKEncodedOrigin Origin);
    internal sealed record Variant(byte[] Bytes, string MimeType);
    internal static bool IsSafeRaster(string mime) => mime is "image/png" or "image/jpeg" or "image/webp" or "image/gif";
    internal static bool IsHeif(string mime) => mime is "image/heic" or "image/heif";
    internal static Probe Inspect(byte[] bytes, string declaredMime)
    {
        using var data = SKData.CreateCopy(bytes);
        using var codec = SKCodec.Create(data) ?? throw new ImageInputException("Image raster is invalid.");
        var mime = codec.EncodedFormat switch { SKEncodedImageFormat.Png => "image/png", SKEncodedImageFormat.Jpeg => "image/jpeg", SKEncodedImageFormat.Webp => "image/webp", SKEncodedImageFormat.Gif => "image/gif", _ => "application/octet-stream" };
        if (mime != declaredMime) throw new ImageInputException("Image bytes do not match the declared MIME type.");
        ValidatePixels(codec.Info.Width, codec.Info.Height);
        return new(codec.Info.Width, codec.Info.Height, mime, codec.EncodedOrigin);
    }
    internal static void ValidatePixels(int width, int height)
    {
        if (width <= 0 || height <= 0 || (long)width * height > HeifDecoder.MaxPixels)
            throw new ImageInputException("Image exceeds the 64-megapixel limit or has invalid dimensions.");
    }
    internal static Variant Optimize(byte[] bytes, string mime, string outputFormat)
    {
        if (outputFormat is not ("webp" or "jpeg")) throw new ImageInputException("Invalid provider image output format.");
        if (!IsSafeRaster(mime) && !IsHeif(mime)) return new(bytes, mime);
        var heif = IsHeif(mime); var gif = mime == "image/gif"; var compatibility = outputFormat == "jpeg" && mime == "image/webp";
        SKBitmap bitmap;
        if (heif)
        {
            var decoded = HeifDecoder.DecodeImage(bytes);
            bitmap = new SKBitmap(new SKImageInfo(decoded.Width, decoded.Height, SKColorType.Rgba8888, SKAlphaType.Unpremul));
            if (bitmap.GetPixels() == IntPtr.Zero) { bitmap.Dispose(); throw new ImageInputException("Image pixel allocation failed."); }
            Marshal.Copy(decoded.Rgba, 0, bitmap.GetPixels(), decoded.Rgba.Length);
        }
        else
        {
            var probe = Inspect(bytes, mime);
            var swapped = probe.Origin is SKEncodedOrigin.LeftTop or SKEncodedOrigin.RightTop or SKEncodedOrigin.RightBottom or SKEncodedOrigin.LeftBottom;
            var width = swapped ? probe.Height : probe.Width; var height = swapped ? probe.Width : probe.Height;
            var pixels = (long)width * height;
            var scale = Math.Min(1, Math.Min(4096d / Math.Max(width, height), Math.Sqrt(4d * 1024 * 1024 / pixels)));
            var threshold = Math.Min(1_000_000d, 96 * 1024 + 0.5 * pixels);
            if (!gif && scale >= 1 && !compatibility && bytes.Length <= threshold) return new(bytes, mime);
            using var data = SKData.CreateCopy(bytes); using var codec = SKCodec.Create(data)!;
            using var raw = new SKBitmap(new SKImageInfo(probe.Width, probe.Height, SKColorType.Rgba8888, SKAlphaType.Premul));
            if (raw.GetPixels() == IntPtr.Zero || codec.GetPixels(raw.Info, raw.GetPixels(), new SKCodecOptions(0)) != SKCodecResult.Success)
                throw new ImageInputException("Image pixel decoding failed.");
            bitmap = Orient(raw, probe.Origin);
        }
        using (bitmap)
        {
            var pixels = (long)bitmap.Width * bitmap.Height;
            var scale = Math.Min(1, Math.Min(4096d / Math.Max(bitmap.Width, bitmap.Height), Math.Sqrt(4d * 1024 * 1024 / pixels)));
            using var resized = scale < 1 ? bitmap.Resize(new SKImageInfo(Math.Max(1, (int)Math.Floor(bitmap.Width * scale)), Math.Max(1, (int)Math.Floor(bitmap.Height * scale)), SKColorType.Rgba8888, SKAlphaType.Premul), new SKSamplingOptions(SKFilterMode.Linear)) : null;
            var target = resized ?? bitmap;
            var transparent = false;
            if (outputFormat == "jpeg")
                for (var y = 0; y < target.Height && !transparent; y++)
                    for (var x = 0; x < target.Width; x++) if (target.GetPixel(x, y).Alpha != 255) { transparent = true; break; }
            var resultMime = outputFormat == "webp" ? "image/webp" : transparent ? "image/png" : "image/jpeg";
            var format = resultMime == "image/webp" ? SKEncodedImageFormat.Webp : resultMime == "image/png" ? SKEncodedImageFormat.Png : SKEncodedImageFormat.Jpeg;
            using var image = SKImage.FromBitmap(target); using var encoded = image.Encode(format, 80) ?? throw new ImageInputException("Provider image encoding failed.");
            var result = encoded.ToArray();
            if (!heif && !gif && scale >= 1 && !compatibility && result.Length >= bytes.Length) return new(bytes, mime);
            return new(result, resultMime);
        }
    }
    private static SKBitmap Orient(SKBitmap raw, SKEncodedOrigin origin)
    {
        var swap = origin is SKEncodedOrigin.LeftTop or SKEncodedOrigin.RightTop or SKEncodedOrigin.RightBottom or SKEncodedOrigin.LeftBottom;
        var result = new SKBitmap(swap ? raw.Height : raw.Width, swap ? raw.Width : raw.Height, SKColorType.Rgba8888, SKAlphaType.Premul);
        using var canvas = new SKCanvas(result);
        var w = raw.Width; var h = raw.Height;
        var matrix = origin switch
        {
            SKEncodedOrigin.TopRight => new SKMatrix(-1, 0, w, 0, 1, 0, 0, 0, 1),
            SKEncodedOrigin.BottomRight => new SKMatrix(-1, 0, w, 0, -1, h, 0, 0, 1),
            SKEncodedOrigin.BottomLeft => new SKMatrix(1, 0, 0, 0, -1, h, 0, 0, 1),
            SKEncodedOrigin.LeftTop => new SKMatrix(0, 1, 0, 1, 0, 0, 0, 0, 1),
            SKEncodedOrigin.RightTop => new SKMatrix(0, -1, h, 1, 0, 0, 0, 0, 1),
            SKEncodedOrigin.RightBottom => new SKMatrix(0, -1, h, -1, 0, w, 0, 0, 1),
            SKEncodedOrigin.LeftBottom => new SKMatrix(0, 1, 0, -1, 0, w, 0, 0, 1),
            _ => SKMatrix.Identity
        };
        canvas.SetMatrix(matrix); canvas.DrawBitmap(raw, 0, 0, new SKSamplingOptions(SKFilterMode.Nearest)); canvas.Flush(); return result;
    }
}
