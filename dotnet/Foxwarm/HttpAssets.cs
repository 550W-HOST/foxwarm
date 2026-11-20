using System.Buffers.Binary;
using System.IO.Compression;
using System.Text.Json;
using Microsoft.AspNetCore.StaticFiles;
using Microsoft.Net.Http.Headers;

namespace Foxwarm;

// One resource namespace for packed releases and loose development/older installs.
// Only HTTP resource callers use this store; executable/compiler inputs stay on disk.
internal sealed class HttpAssets(string root, string packName = "foxwarm.assets", string? additionalPack = null)
{
    private static readonly FileExtensionContentTypeProvider Mime = new();
    private readonly string root = Path.GetFullPath(root);
    private readonly string[] packNames = additionalPack is null ? [packName] : [packName, additionalPack];
    private readonly object gate = new();
    private readonly Dictionary<string, PackIndex> indexes = new(StringComparer.Ordinal);

    internal const string CodePrefix = "packages/vscode-web/assets";
    internal const string CodePack = CodePrefix + "/foxwarm.assets";

    internal static bool ValidPath(string? path) =>
        !string.IsNullOrEmpty(path)
        && !path.Any(c => c < 32 || c is '\\' or ':')
        && path.Split('/').All(part => part.Length > 0 && part is not "." and not "..");

    internal bool Exists(string path)
    {
        using var asset = Open(path);
        return asset is not null;
    }

    internal static string? WebUiDirectory(HostPaths paths, bool validate = false)
    {
        var packaged = Path.Combine(paths.ResourceRoot, "webui-dist");
        if (File.Exists(Path.Combine(paths.ResourceRoot, "foxwarm.assets"))
            && new HttpAssets(paths.ResourceRoot).Exists("webui-dist/index.html"))
            return packaged;
        var installed = Path.Combine(paths.ApplicationRoot, "packages", "webui", "dist");
        var directory = Directory.Exists(packaged) ? packaged : Directory.Exists(installed) ? installed : null;
        if (validate && directory is not null
            && (!File.Exists(Path.Combine(directory, "index.html")) || !Directory.Exists(Path.Combine(directory, "assets"))))
            throw new InvalidOperationException("Configured WebUI dist needs index.html and assets/.");
        return directory;
    }

    internal HttpAsset? Open(string? path, HttpRequest? request = null)
    {
        if (!ValidPath(path))
            return null;
        FileStream? file = null;
        try
        {
            foreach (var name in packNames)
            {
                file = OpenFile(Path.Combine(root, name));
                if (file is not null)
                {
                    var stamp = File.GetLastWriteTimeUtc(file.SafeFileHandle);
                    PackIndex index;
                    lock (gate)
                    {
                        if (!indexes.TryGetValue(name, out index!) || index.Length != file.Length || index.Modified != stamp)
                            indexes[name] = index = ReadIndex(file, stamp);
                    }
                    if (index.Entries.TryGetValue(path!, out var entry))
                    {
                        var encoded = entry.Brotli && AcceptsBrotli(request);
                        Stream stream = new AssetStream(file, index.DataStart + entry.Offset, entry.Length);
                        if (entry.Brotli && !encoded)
                            stream = new BrotliStream(stream, CompressionMode.Decompress);
                        var asset = new HttpAsset(
                            stream,
                            entry.ContentType,
                            // One original-byte validator for both representations. Weak tags
                            // avoid claiming byte-for-byte equivalence across encodings.
                            new EntityTagHeaderValue('"' + entry.Sha256 + '"', isWeak: entry.Brotli),
                            stamp,
                            encoded ? "br" : null,
                            entry.Brotli,
                            encoded ? entry.Length : entry.OriginalLength,
                            !entry.Brotli,
                            true
                        );
                        file = null; // Ownership passes to the response stream.
                        return asset;
                    }
                    file.Dispose();
                    file = null;
                }
            }
            // A mounted/extracted optional Code tree can coexist with a packed Core.
            var loosePath = Path.Combine(root, path!);
            if (Directory.Exists(loosePath))
                return null;
            file = OpenFile(loosePath);
            if (file is null)
                return null;
            var modified = File.GetLastWriteTimeUtc(file.SafeFileHandle);
            var length = file.Length;
            var result = new HttpAsset(
                new AssetStream(file, 0, length),
                Mime.TryGetContentType(path!, out var type) ? type : "application/octet-stream",
                new EntityTagHeaderValue($"\"{modified.ToFileTimeUtc() ^ length:x}\""),
                modified,
                null,
                false,
                length,
                true,
                false
            );
            file = null;
            return result;
        }
        finally
        {
            file?.Dispose();
        }
    }

    private static FileStream? OpenFile(string path)
    {
        try
        {
            return new FileStream(path, FileMode.Open, FileAccess.Read,
                FileShare.Read | FileShare.Delete, 4096, FileOptions.Asynchronous | FileOptions.RandomAccess);
        }
        catch (FileNotFoundException) { return null; }
        catch (DirectoryNotFoundException) { return null; }
    }

    internal async Task<string> ReadTextAsync(string path, CancellationToken token)
    {
        using var asset = Open(path) ?? throw new FileNotFoundException("HTTP asset is missing.", path);
        using var reader = new StreamReader(asset.Stream);
        return await reader.ReadToEndAsync(token);
    }

    internal async Task ServeAsync(HttpContext context, string? path)
    {
        using var asset = Open(path, context.Request);
        if (asset is null)
        {
            context.Response.StatusCode = StatusCodes.Status404NotFound;
            return;
        }
        if (asset.Packed)
            context.Features.Set(asset);
        if (asset.Brotli)
            context.Response.Headers.Append(HeaderNames.Vary, "Accept-Encoding");
        if (asset.Encoding is not null)
            context.Response.Headers.ContentEncoding = asset.Encoding;
        context.Response.ContentLength = asset.Length;
        // ASP.NET owns conditionals, single ranges, 416 and HEAD; the bounded stream
        // exposes only this representation. Content-Encoding bypasses runtime compression.
        await Results.Stream(asset.Stream, asset.ContentType, lastModified: asset.Modified,
            entityTag: asset.ETag, enableRangeProcessing: asset.Ranges).ExecuteAsync(context);
    }

    private static bool AcceptsBrotli(HttpRequest? request)
    {
        var accepted = request?.GetTypedHeaders().AcceptEncoding;
        if (accepted is null || accepted.Count == 0)
            return false;
        var br = accepted.FirstOrDefault(value => value.Value.Equals("br", StringComparison.OrdinalIgnoreCase))
            ?? accepted.FirstOrDefault(value => value.Value == "*");
        var identity = accepted.FirstOrDefault(value => value.Value.Equals("identity", StringComparison.OrdinalIgnoreCase));
        return br is not null && (br.Quality ?? 1) > 0
            && (br.Quality ?? 1) >= (identity?.Quality ?? 0);
    }

    private sealed record Entry(long Offset, long Length, long OriginalLength, string Sha256, string ContentType, bool Brotli);
    private sealed record PackIndex(long Length, DateTime Modified, long DataStart, Dictionary<string, Entry> Entries);

    private static PackIndex ReadIndex(FileStream file, DateTime modified)
    {
        Span<byte> header = stackalloc byte[16];
        file.ReadExactly(header);
        if (!header[..8].SequenceEqual("FWASSET1"u8))
            throw new InvalidDataException("Unsupported HTTP asset pack.");
        var length = BinaryPrimitives.ReadUInt64LittleEndian(header[8..]);
        if (length is 0 or > 64 * 1024 * 1024 || length > (ulong)Math.Max(0, file.Length - 16))
            throw new InvalidDataException("Invalid HTTP asset index length.");
        var bytes = new byte[(int)length];
        file.ReadExactly(bytes);
        using var document = JsonDocument.Parse(bytes);
        var start = 16 + (long)length;
        var available = file.Length - start;
        var entries = new Dictionary<string, Entry>(StringComparer.Ordinal);
        foreach (var property in document.RootElement.GetProperty("entries").EnumerateObject())
        {
            if (!ValidPath(property.Name))
                throw new InvalidDataException("Invalid HTTP asset path.");
            var element = property.Value;
            var type = element.GetProperty("contentType").GetString();
            if (!MediaTypeHeaderValue.TryParse(type, out _))
                throw new InvalidDataException("Invalid HTTP asset content type.");
            var offset = element.GetProperty("offset").GetInt64();
            var count = element.GetProperty("length").GetInt64();
            var original = element.GetProperty("originalLength").GetInt64();
            var hash = element.GetProperty("sha256").GetString();
            var brotli = element.TryGetProperty("encoding", out var encoding);
            if (brotli && encoding.GetString() != "br")
                throw new InvalidDataException("Invalid HTTP asset encoding.");
            if (offset < 0 || count < 0 || original < 0 || count > available || offset > available - count
                || (!brotli && count != original)
                || hash is not { Length: 64 } || hash.Any(c => !char.IsAsciiHexDigitLower(c)))
                throw new InvalidDataException("Invalid HTTP asset extent.");
            if (!entries.TryAdd(property.Name, new(offset, count, original, hash, type!, brotli)))
                throw new InvalidDataException("Duplicate HTTP asset path.");
        }
        return new(file.Length, modified, start, entries);
    }
}

internal sealed record HttpAsset(
    Stream Stream,
    string ContentType,
    EntityTagHeaderValue ETag,
    DateTimeOffset Modified,
    string? Encoding,
    bool Brotli,
    long Length,
    bool Ranges,
    bool Packed
) : IDisposable
{
    public void Dispose() => Stream.Dispose();
}

// Each request owns its file handle. Positional reads have no shared seek cursor,
// and replacing the pack cannot change the file behind an in-flight response.
internal sealed class AssetStream(FileStream file, long offset, long length) : Stream
{
    private long position;
    public override bool CanRead => true;
    public override bool CanSeek => true;
    public override bool CanWrite => false;
    public override long Length => length;
    public override long Position
    {
        get => position;
        set
        {
            if (value < 0 || value > length)
                throw new ArgumentOutOfRangeException(nameof(value));
            position = value;
        }
    }
    public override int Read(byte[] buffer, int start, int count) => Read(buffer.AsSpan(start, count));
    public override int Read(Span<byte> buffer)
    {
        var count = (int)Math.Min(buffer.Length, length - position);
        var read = RandomAccess.Read(file.SafeFileHandle, buffer[..count], offset + position);
        position += read;
        return read;
    }
    public override async ValueTask<int> ReadAsync(Memory<byte> buffer, CancellationToken token = default)
    {
        var count = (int)Math.Min(buffer.Length, length - position);
        var read = await RandomAccess.ReadAsync(file.SafeFileHandle, buffer[..count], offset + position, token);
        position += read;
        return read;
    }
    public override Task<int> ReadAsync(byte[] buffer, int start, int count, CancellationToken token) =>
        ReadAsync(buffer.AsMemory(start, count), token).AsTask();
    public override long Seek(long value, SeekOrigin origin)
    {
        Position = origin switch
        {
            SeekOrigin.Begin => value,
            SeekOrigin.Current => checked(position + value),
            SeekOrigin.End => checked(length + value),
            _ => throw new ArgumentOutOfRangeException(nameof(origin)),
        };
        return position;
    }
    public override void Flush() { }
    public override void SetLength(long value) => throw new NotSupportedException();
    public override void Write(byte[] buffer, int offset, int count) => throw new NotSupportedException();
    protected override void Dispose(bool disposing)
    {
        if (disposing)
            file.Dispose();
        base.Dispose(disposing);
    }
}
