using Foxwarm.Images;
using SkiaSharp;

namespace Foxwarm.Tests;

public sealed class ImageCodecTests
{
    internal static byte[] Raster(SKEncodedImageFormat format, int width = 3, int height = 2, byte alpha = 255)
    {
        using var bitmap = new SKBitmap(width, height, SKColorType.Rgba8888, SKAlphaType.Premul);
        bitmap.Erase(new SKColor(91, 91, 91, alpha));
        using var image = SKImage.FromBitmap(bitmap); using var encoded = image.Encode(format, 90)!;
        return encoded.ToArray();
    }
    [Fact]
    public void Real_EXIF_rotation_survives_forced_pixel_conversion()
    {
        var jpeg = Raster(SKEncodedImageFormat.Jpeg);
        byte[] exif = [0xff, 0xe1, 0, 34, 69, 120, 105, 102, 0, 0, 73, 73, 42, 0, 8, 0, 0, 0, 1, 0, 18, 1, 3, 0, 1, 0, 0, 0, 6, 0, 0, 0, 0, 0, 0, 0];
        using var source = new MemoryStream(); source.Write(jpeg.AsSpan(0, 2)); source.Write(exif);
        for (var i = 0; i < 3; i++) { source.Write([0xff, 0xfe, 0xc3, 0x52]); source.Write(new byte[50000]); }
        source.Write(jpeg.AsSpan(2)); var bytes = source.ToArray(); Assert.Equal(SKEncodedOrigin.RightTop, RasterCodec.Inspect(bytes, "image/jpeg").Origin);
        var converted = RasterCodec.Optimize(bytes, "image/jpeg", "webp"); var result = RasterCodec.Inspect(converted.Bytes, converted.MimeType); Assert.Equal(2, result.Width); Assert.Equal(3, result.Height); Assert.Equal(SKEncodedOrigin.TopLeft, result.Origin);
    }
    [Theory]
    [InlineData(SKEncodedImageFormat.Png, "image/png")]
    [InlineData(SKEncodedImageFormat.Jpeg, "image/jpeg")]
    [InlineData(SKEncodedImageFormat.Webp, "image/webp")]
    public void Actual_native_raster_header_and_small_passthrough_are_valid(SKEncodedImageFormat format, string mime)
    {
        var bytes = Raster(format); var probe = RasterCodec.Inspect(bytes, mime);
        Assert.Equal(3, probe.Width); Assert.Equal(2, probe.Height);
        Assert.Same(bytes, RasterCodec.Optimize(bytes, mime, "webp").Bytes);
        Assert.Throws<ImageInputException>(() => RasterCodec.Inspect(bytes, mime == "image/png" ? "image/jpeg" : "image/png"));
    }
    [Fact]
    public void Actual_pixels_alpha_compatibility_resize_and_gif_first_frame()
    {
        var webp = Raster(SKEncodedImageFormat.Webp, alpha: 125);
        var variant = RasterCodec.Optimize(webp, "image/webp", "jpeg");
        Assert.Equal("image/png", variant.MimeType); Assert.Equal(3, RasterCodec.Inspect(variant.Bytes, variant.MimeType).Width);
        var opaque = RasterCodec.Optimize(Raster(SKEncodedImageFormat.Webp), "image/webp", "jpeg"); Assert.Equal("image/jpeg", opaque.MimeType);
        var large = Raster(SKEncodedImageFormat.Png, 4097, 2); var resized = RasterCodec.Optimize(large, "image/png", "webp"); Assert.Equal(4096, RasterCodec.Inspect(resized.Bytes, resized.MimeType).Width);
        var gif = Convert.FromBase64String("R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7");
        var normalized = RasterCodec.Optimize(gif, "image/gif", "webp"); Assert.Equal("image/webp", normalized.MimeType); Assert.Equal(1, RasterCodec.Inspect(normalized.Bytes, normalized.MimeType).Width);
        Assert.Throws<ImageInputException>(() => RasterCodec.ValidatePixels(8193, 8192));
    }
    private static byte[] Heif(string name)
    {
        var root = Environment.GetEnvironmentVariable("FOXWARM_TS_ROOT") ?? throw new InvalidOperationException("Image tests require the assigned Source root.");
        return File.ReadAllBytes(Path.Combine(root, "src", "testFixtures", name));
    }
    [Theory]
    [InlineData("synthetic-3x2.heic", false)]
    [InlineData("synthetic-alpha-3x2.heic", true)]
    public void Real_pinned_native_HEIC_primary_pixels_alpha_and_provider_formats(string name, bool alpha)
    {
        var bytes = Heif(name); var pixels = HeifDecoder.DecodeImage(bytes);
        Assert.Equal(3, pixels.Width); Assert.Equal(2, pixels.Height); Assert.Equal(24, pixels.Rgba.Length); Assert.Equal(alpha, pixels.HasTransparency);
        var variant = RasterCodec.Optimize(bytes, "image/heic", "jpeg"); Assert.Equal(alpha ? "image/png" : "image/jpeg", variant.MimeType); Assert.Equal(3, RasterCodec.Inspect(variant.Bytes, variant.MimeType).Width);
        Assert.Equal("image/webp", RasterCodec.Optimize(bytes, "image/heic", "webp").MimeType);
        Assert.Throws<ImageInputException>(() => HeifDecoder.DecodeImage(bytes, 4));
    }
    [Fact]
    public void Native_coded_pixel_limit_rejects_a_small_declared_size_before_large_coded_decode()
    {
        // The synthetic primary is cropped to 3x2, but its HEVC coded plane is larger.
        // A six-pixel limit passes the managed primary-size check and must still
        // reject the coded pixels in native decoding before their allocation.
        var bytes = Heif("synthetic-3x2.heic");
        var error = Assert.Throws<ImageInputException>(() => HeifDecoder.DecodeImage(bytes, 6));
        Assert.Contains("native safety limits", error.Message);
        Assert.Throws<ImageInputException>(() => HeifDecoder.DecodeImage("not an image"u8.ToArray()));
    }
}
