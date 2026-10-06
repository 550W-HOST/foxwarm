using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Images;

internal sealed partial class ImageBlobStore
{
    private static readonly ConcurrentDictionary<
        string,
        Lazy<Task<RasterCodec.Variant>>
    > Conversions = new();

    internal async Task<IReadOnlyList<JsonObject>> HydrateAsync(
        IReadOnlyList<JsonObject> history,
        string protocol,
        string outputFormat = "webp",
        CancellationToken token = default
    )
    {
        var result = new List<JsonObject>();
        foreach (var source in history)
        {
            var message = (JsonObject)source.DeepClone();
            foreach (var part in (message["parts"] as JsonArray ?? []).OfType<JsonObject>())
            {
                part.Remove("__providerImageIdentity");
                part.Remove("__providerImageDeduplicated");
                var reference = part["inlineDataRef"] as JsonObject;
                var inline = part["inlineData"] as JsonObject;
                if (reference is null && inline is null)
                    continue;
                var mime = Mime(reference ?? inline!);
                byte[] bytes;
                if (reference is not null)
                    bytes = await ReadAsync(reference, token);
                else
                {
                    bytes = InlineBytes(inline!);
                }
                var nonvisual =
                    SessionWait.Text(message["role"]) == "model"
                    && (
                        protocol == "responses"
                        || SessionWait.Text(part["imageMeta"]?["origin"]) == "generated"
                    );
                if (nonvisual)
                {
                    if (RasterCodec.IsHeif(mime))
                        _ = HeifDecoder.DecodeImage(bytes);
                    part["inlineData"] = new JsonObject
                    {
                        ["mimeType"] = mime,
                        ["data"] = Convert.ToBase64String(bytes),
                    };
                    continue;
                }
                var variant = await OptimizeAsync(bytes, mime, outputFormat);
                token.ThrowIfCancellationRequested();
                part["inlineData"] = new JsonObject
                {
                    ["mimeType"] = variant.MimeType,
                    ["data"] = Convert.ToBase64String(variant.Bytes),
                };
            }
            result.Add(message);
        }
        ProviderImageDedup.Apply(result, protocol);
        return result;
    }

    private async Task<RasterCodec.Variant> OptimizeAsync(byte[] bytes, string mime, string output)
    {
        if (RasterCodec.IsHeif(mime))
            HeifDecoder.RequirePrerequisite();
        // Different native encoder policy => separate disposable cache from Source variants.
        var key = Convert.ToHexStringLower(
            SHA256.HashData(
                Encoding.UTF8.GetBytes(
                    Convert.ToHexStringLower(SHA256.HashData(bytes))
                        + "\0"
                        + mime
                        + "\0"
                        + output
                        + "\0skia4.153.1-heif1.23.5-v1"
                )
            )
        );
        var root = Path.Combine(DataRoot, "state", "provider-image-cache", "dotnet-v1");
        var path = Path.Combine(root, key[..2], key + ".cache");
        var operation = Conversions.GetOrAdd(
            path,
            _ => new Lazy<Task<RasterCodec.Variant>>(ConvertAsync)
        );
        try
        {
            return await operation.Value;
        }
        finally
        {
            Conversions.TryRemove(
                new KeyValuePair<string, Lazy<Task<RasterCodec.Variant>>>(path, operation)
            );
        }
        async Task<RasterCodec.Variant> ConvertAsync()
        {
            try
            {
                if (new FileInfo(path).Length > 32L * 1024 * 1024 + 4096)
                    throw new IOException("Derived image cache entry is oversized.");
                var saved = await File.ReadAllBytesAsync(path);
                var newline = Array.IndexOf(saved, (byte)'\n');
                if (
                    newline > 0
                    && newline < 4096
                    && JsonNode.Parse(saved.AsSpan(0, newline)) is JsonObject header
                )
                {
                    var payload = saved[(newline + 1)..];
                    var passthrough = header["passThrough"]?.GetValue<bool>() == true;
                    if (
                        SessionWait.Text(header["key"]) == key
                        && SessionWait.Text(header["inputMime"]) == mime
                        && SessionWait.Number(header["inputLength"]) == bytes.Length
                        && SessionWait.Text(header["resultMime"]) is { } resultMime
                        && (
                            passthrough && resultMime == mime
                            || !passthrough
                                && RasterCodec.IsSafeRaster(resultMime)
                                && SessionWait.Text(header["resultSha256"])
                                    == Convert.ToHexStringLower(SHA256.HashData(payload))
                        )
                    )
                    {
                        if (!passthrough)
                            _ = RasterCodec.Inspect(payload, resultMime);
                        return new(passthrough ? bytes : payload, resultMime);
                    }
                }
            }
            catch (Exception error)
                when (error
                        is IOException
                            or System.Text.Json.JsonException
                            or InvalidOperationException
                            or UnauthorizedAccessException
                ) { }
            var converted = RasterCodec.Optimize(bytes, mime, output);
            if (converted.Bytes.Length > 32 * 1024 * 1024)
                return converted;
            var temp = path + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                Directory.CreateDirectory(Path.GetDirectoryName(path)!);
                var passthrough = ReferenceEquals(converted.Bytes, bytes);
                var header = new JsonObject
                {
                    ["key"] = key,
                    ["inputMime"] = mime,
                    ["inputLength"] = bytes.Length,
                    ["resultMime"] = converted.MimeType,
                    ["passThrough"] = passthrough,
                    ["resultSha256"] = Convert.ToHexStringLower(SHA256.HashData(converted.Bytes)),
                };
                await using (var file = new FileStream(temp, FileMode.CreateNew, FileAccess.Write))
                {
                    await file.WriteAsync(Encoding.UTF8.GetBytes(header.ToJsonString() + "\n"));
                    if (!passthrough)
                        await file.WriteAsync(converted.Bytes);
                }
                File.Move(temp, path, true);
                TrimDerivedCache(root);
            }
            catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
            finally
            {
                try
                {
                    File.Delete(temp);
                }
                catch (IOException) { }
            }
            return converted;
        }
    }

    private static void TrimDerivedCache(string root)
    {
        // A best-effort, process-exit-safe lease applies only to disposable variants.
        try
        {
            using var lease = new FileStream(
                Path.Combine(root, "cleanup.lock"),
                FileMode.OpenOrCreate,
                FileAccess.ReadWrite,
                FileShare.None
            );
            var now = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            var previous = new byte[8];
            if (
                lease.Read(previous) == previous.Length
                && now - BitConverter.ToInt64(previous) < TimeSpan.FromMinutes(10).TotalMilliseconds
            )
                return;
            lease.Position = 0;
            lease.Write(BitConverter.GetBytes(now));
            lease.SetLength(8);
            lease.Flush();
            var entries = new DirectoryInfo(root)
                .EnumerateFiles("*.cache", SearchOption.AllDirectories)
                .OrderBy(file => file.LastWriteTimeUtc)
                .ToArray();
            var total = entries.Sum(file => file.Length);
            if (total > 512L * 1024 * 1024)
                foreach (var entry in entries)
                {
                    total -= entry.Length;
                    entry.Delete();
                    if (total <= 384L * 1024 * 1024)
                        break;
                }
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException) { }
    }
}
