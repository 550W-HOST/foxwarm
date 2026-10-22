using System.Collections.Concurrent;
using System.Security.Cryptography;
using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Channels;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

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
        CancellationToken token = default,
        string? concreteModelId = null
    )
    {
        var result = new List<JsonObject>();
        foreach (var source in history)
        {
            var message = (JsonObject)source.DeepClone();
            var parts = new List<JsonObject>();
            var toolFiles = new List<(JsonObject Part, string? ToolUseId)>();
            foreach (var part in (message["parts"] as JsonArray ?? []).OfType<JsonObject>())
            {
                part.Remove("__providerImageIdentity");
                part.Remove("__providerImageDeduplicated");
                var reference = part["inlineDataRef"] as JsonObject;
                var inline = part["inlineData"] as JsonObject;
                if (reference is null && inline is null)
                {
                    parts.Add(part);
                    continue;
                }
                var generatedOutput =
                    part["providerMeta"]?["openaiResponses"]?["outputItem"] as JsonObject;
                var generatedSource = SessionWait.Text(
                    part["providerMeta"]?["openaiResponses"]?["sourceModelId"]
                );
                var nativeGenerated =
                    generatedOutput is not null
                    && HostedResponsesTools.IsGeneratedImage(generatedOutput);
                var nativeReplay =
                    SessionWait.Text(message["role"]) == "model"
                    && protocol == "responses"
                    && concreteModelId is not null
                    && generatedSource == concreteModelId
                    && nativeGenerated;
                if (
                    reference is not null
                    && SessionWait.Text(message["role"]) == "model"
                    && SessionWait.Text(part["imageMeta"]?["origin"]) == "generated"
                    && nativeGenerated
                    && generatedSource is not null
                    && concreteModelId is not null
                    && !nativeReplay
                )
                {
                    // Incompatible destinations receive the existing text-only placeholder.
                    part.Remove("inlineData");
                    parts.Add(part);
                    continue;
                }
                byte[] bytes;
                if (reference is not null)
                    bytes = await ReadAsync(reference, token);
                else
                {
                    try
                    {
                        bytes = InlineBytes(inline!);
                    }
                    catch (ImageInputException)
                    {
                        parts.Add(part);
                        continue;
                    }
                }
                var mime = Mime(reference ?? inline!);
                var nonvisual =
                    SessionWait.Text(message["role"]) == "model"
                    && !nativeReplay
                    && (
                        protocol == "responses"
                        || SessionWait.Text(part["imageMeta"]?["origin"]) == "generated"
                    );
                if (nonvisual && RasterCodec.IsHeif(mime))
                    _ = HeifDecoder.DecodeImage(bytes);
                var variant = new RasterCodec.Variant(bytes, mime);
                if (!nativeReplay && !nonvisual)
                {
                    try
                    {
                        if (
                            bytes.LongLength > ImageInputPolicy.MaxBytes
                            || (RasterCodec.IsSafeRaster(mime) || RasterCodec.IsHeif(mime))
                                && ImageInputPolicy.IsOversized(bytes, mime)
                        )
                        {
                            var fallback = AppendFileFallback(parts, part, mime);
                            if (SessionWait.Text(message["role"]) == "tool")
                                toolFiles.Add((fallback, SessionWait.Text(part["toolUseId"])));
                            continue;
                        }
                        variant = await OptimizeAsync(bytes, mime, outputFormat);
                    }
                    catch (ImageInputException)
                        when (reference is null && !RasterCodec.IsHeif(mime))
                    { /* Preserve previously unvalidated legacy inline payloads. */
                    }
                }
                token.ThrowIfCancellationRequested();
                part["inlineData"] = new JsonObject
                {
                    ["mimeType"] = variant.MimeType,
                    ["data"] = Convert.ToBase64String(variant.Bytes),
                };
                parts.Add(part);
            }
            foreach (var file in toolFiles)
            {
                var fileIndex = parts.IndexOf(file.Part);
                var response = parts
                    .Select((part, index) => (Part: part, Index: index))
                    .Where(item =>
                        item.Part["functionResponse"] is JsonObject
                        && (
                            file.ToolUseId is not null
                                ? (
                                    SessionWait.Text(item.Part["functionResponse"]?["tool_use_id"])
                                    ?? SessionWait.Text(item.Part["toolUseId"])
                                ) == file.ToolUseId
                                : item.Index >= fileIndex
                        )
                    )
                    .OrderBy(item => Math.Abs(item.Index - fileIndex))
                    .FirstOrDefault();
                if (response.Part is null)
                    continue;
                var function = response.Part["functionResponse"]!.AsObject();
                function["response"] = new JsonObject
                {
                    ["output"] = string.Join(
                        "\n",
                        new[]
                        {
                            ToolResponseFormatting.Format(function["response"]),
                            SessionWait.Text(file.Part["text"]),
                        }.Where(text => !string.IsNullOrEmpty(text))
                    ),
                };
                if (response.Part != file.Part)
                    parts.Remove(file.Part);
            }
            message["parts"] = new JsonArray(
                parts.Select(part => (JsonNode)part.DeepClone()).ToArray()
            );
            result.Add(message);
        }
        ProviderImageDedup.Apply(result, protocol);
        return result;
    }

    private static string? FileDescriptor(string? text, string mime)
    {
        if (text is null)
            return null;
        var lines = text.Split('\n');
        for (var index = lines.Length - 1; index >= 0; index--)
        {
            if (
                !Regex.IsMatch(
                    lines[index],
                    "^\\s*<foxwarm-image\\b([^>]*)/?\\s*>\\s*$",
                    RegexOptions.IgnoreCase | RegexOptions.CultureInvariant
                )
            )
                continue;
            var attributes = new Dictionary<string, string>(StringComparer.Ordinal);
            foreach (
                Match attribute in Regex.Matches(
                    lines[index],
                    "([a-zA-Z_:][a-zA-Z0-9_.:-]*)\\s*=\\s*\"([^\"]*)\""
                )
            )
                attributes[attribute.Groups[1].Value] = attribute
                    .Groups[2]
                    .Value.Replace("&quot;", "\"")
                    .Replace("&apos;", "'")
                    .Replace("&lt;", "<")
                    .Replace("&gt;", ">")
                    .Replace("&amp;", "&");
            if (
                !attributes.TryGetValue("name", out var name)
                || name.Length == 0
                || !attributes.TryGetValue("node", out var node)
                || node.Length == 0
                || !attributes.TryGetValue("path", out var path)
                || path.Length == 0
            )
                continue;
            lines[index] = ChannelFileNames.Descriptor(name, path, mime, node, false);
            return string.Join('\n', lines);
        }
        return null;
    }

    private static JsonObject AppendFileFallback(
        List<JsonObject> parts,
        JsonObject part,
        string mime
    )
    {
        var own = FileDescriptor(SessionWait.Text(part["text"]), mime);
        var previous = parts.LastOrDefault();
        var preceding =
            own is null && previous?["inlineData"] is null && previous?["inlineDataRef"] is null
                ? FileDescriptor(SessionWait.Text(previous?["text"]), mime)
                : null;
        var imageId =
            SessionWait.Text(part["imageMeta"]?["imageId"])
            ?? SessionWait.Text(part["inlineDataRef"]?["imageId"]);
        part.Remove("inlineData");
        part.Remove("inlineDataRef");
        part.Remove("imageMeta");
        if (preceding is not null)
        {
            previous!["text"] = preceding;
            if (
                part["text"] is not null
                || part["functionCall"] is not null
                || part["functionResponse"] is not null
            )
                parts.Add(part);
            return previous;
        }
        part["text"] =
            own
            ?? string.Join(
                "\n",
                new[]
                {
                    SessionWait.Text(part["text"]),
                    "Image content was not sent because it exceeds the image input limit. "
                        + (
                            imageId is not null
                                ? "The original is retained as image "
                                    + JsonStringQuoting.Quote(imageId)
                                    + "; use image_write_to_file to save it as a file."
                                : "The original remains in the source message."
                        ),
                }.Where(text => !string.IsNullOrEmpty(text))
            );
        parts.Add(part);
        return part;
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
