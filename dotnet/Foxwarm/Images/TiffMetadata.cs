using System.Buffers.Binary;

namespace Foxwarm.Images;

// First-directory dimensions for upload preflight only. This does not decode TIFF pixels,
// follow image chains, or expand the provider's supported conversion formats.
internal static class TiffMetadata
{
    internal static (int Width, int Height) Inspect(byte[] bytes)
    {
        if (bytes.Length < 8 || !(bytes[0] == bytes[1] && bytes[0] is (byte)'I' or (byte)'M'))
            throw Invalid();
        var little = bytes[0] == 'I';
        ulong Read(ulong offset, int size)
        {
            if (offset > (ulong)bytes.Length || (ulong)size > (ulong)bytes.Length - offset)
                throw Invalid();
            var value = bytes.AsSpan((int)offset, size);
            return size switch
            {
                2 => little ? BinaryPrimitives.ReadUInt16LittleEndian(value) : BinaryPrimitives.ReadUInt16BigEndian(value),
                4 => little ? BinaryPrimitives.ReadUInt32LittleEndian(value) : BinaryPrimitives.ReadUInt32BigEndian(value),
                _ => little ? BinaryPrimitives.ReadUInt64LittleEndian(value) : BinaryPrimitives.ReadUInt64BigEndian(value),
            };
        }
        var magic = Read(2, 2);
        var big = magic == 43;
        if (magic != 42 && !big || big && (Read(4, 2) != 8 || Read(6, 2) != 0))
            throw Invalid();
        var directory = Read(big ? 8UL : 4UL, big ? 8 : 4);
        var count = Read(directory, big ? 8 : 2);
        var start = directory + (big ? 8UL : 2UL);
        var entrySize = big ? 20UL : 12UL;
        if (start > (ulong)bytes.Length || count > ((ulong)bytes.Length - start) / entrySize)
            throw Invalid();
        ulong width = 0, height = 0;
        var offsets = false;
        var lengths = false;
        for (ulong index = 0; index < count; index++)
        {
            var entry = start + index * entrySize;
            var tag = Read(entry, 2);
            if (tag is not (256 or 257 or 273 or 279 or 324 or 325))
                continue;
            var type = Read(entry + 2, 2);
            var size = type switch { 3 => 2, 4 => 4, 16 when big => 8, _ => 0 };
            var values = Read(entry + 4, big ? 8 : 4);
            if (size == 0 || values == 0)
                throw Invalid();
            var valueOffset = entry + (big ? 12UL : 8UL);
            if (values > (big ? 8UL : 4UL) / (ulong)size)
                valueOffset = Read(valueOffset, big ? 8 : 4);
            if (valueOffset > (ulong)bytes.Length || values > ((ulong)bytes.Length - valueOffset) / (ulong)size)
                throw Invalid();
            if (tag is 256 or 257)
            {
                if (values != 1)
                    throw Invalid();
                var dimension = Read(valueOffset, size);
                if (dimension == 0 || dimension > int.MaxValue)
                    throw Invalid();
                if (tag == 256) width = dimension; else height = dimension;
            }
            else if (tag is 273 or 324)
                offsets = true;
            else
                lengths = true;
        }
        if (width == 0 || height == 0 || !offsets || !lengths)
            throw Invalid();
        return ((int)width, (int)height);
    }

    private static ImageInputException Invalid() => new("TIFF metadata is invalid or unsupported.");
}
