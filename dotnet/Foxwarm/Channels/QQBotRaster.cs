using System.Buffers.Binary;
using Foxwarm.Images;
using SkiaSharp;

namespace Foxwarm.Channels;

internal static class QQBotRaster
{
    internal static string? Probe(string path)
    {
        try
        {
            using var input = new SKFileStream(path);
            using var codec = SKCodec.Create(input);
            if (codec is null)
                return null;
            RasterCodec.ValidatePixels(codec.Info.Width, codec.Info.Height);
            return codec.EncodedFormat switch
            {
                SKEncodedImageFormat.Png => "image/png",
                SKEncodedImageFormat.Jpeg => "image/jpeg",
                SKEncodedImageFormat.Gif => "image/gif",
                SKEncodedImageFormat.Webp => "image/webp",
                _ => null,
            };
        }
        catch
        {
            return null;
        }
    }

    internal static bool OfficialImage(string path) => Probe(path) is not null || ValidBmp(path);

    private static bool ValidBmp(string path)
    {
        try
        {
            using var file = File.OpenRead(path);
            if (file.Length < 26)
                return false;
            var header = new byte[Math.Min(file.Length, 138)];
            file.ReadExactly(header);
            uint U32(int at) => BinaryPrimitives.ReadUInt32LittleEndian(header.AsSpan(at, 4));
            int I32(int at) => BinaryPrimitives.ReadInt32LittleEndian(header.AsSpan(at, 4));
            int U16(int at) => BinaryPrimitives.ReadUInt16LittleEndian(header.AsSpan(at, 2));
            if (header[0] != 'B' || header[1] != 'M')
                return false;
            var declared = U32(2);
            var offset = U32(10);
            var dib = U32(14);
            if (declared < 26 || declared > file.Length || offset >= declared)
                return false;
            long width,
                height;
            int bpp;
            if (dib == 12)
            {
                if (offset < 26 || U16(22) != 1)
                    return false;
                width = U16(18);
                height = U16(20);
                bpp = U16(24);
                if (width <= 0 || height <= 0 || bpp != 24)
                    return false;
            }
            else
            {
                if (dib < 40 || dib > 124 || header.Length < 54 || offset < 14 + dib)
                    return false;
                width = I32(18);
                height = I32(22);
                bpp = U16(28);
                if (
                    width <= 0
                    || height == 0
                    || U16(26) != 1
                    || bpp is not (24 or 32)
                    || U32(30) != 0
                )
                    return false;
            }
            var span = ((width * bpp + 31) / 32) * 4 * Math.Abs(height);
            return span > 0 && offset + span <= declared && offset + span <= file.Length;
        }
        catch
        {
            return false;
        }
    }
}
