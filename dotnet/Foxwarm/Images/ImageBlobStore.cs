using System.Security.Cryptography;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Images;

internal sealed partial class ImageBlobStore(string dataRoot)
{
    internal string DataRoot { get; } = Path.GetFullPath(dataRoot);
    internal string BlobRoot => Path.Combine(DataRoot, "state", "image-blobs");
    private static readonly Regex Id = new(
        "^([a-f0-9]{64})\\.(png|jpg|gif|webp|svg|bin)$",
        RegexOptions.CultureInvariant
    );

    internal static string Mime(JsonObject value) =>
        (
            SessionWait.Text(value["mimeType"])
            ?? SessionWait.Text(value["mime_type"])
            ?? "application/octet-stream"
        )
            .Trim()
            .ToLowerInvariant();

    internal static string Extension(string mime) =>
        mime switch
        {
            "image/png" => "png",
            "image/jpeg" => "jpg",
            "image/gif" => "gif",
            "image/webp" => "webp",
            "image/svg+xml" => "svg",
            _ => "bin",
        };

    internal static string? SafeMime(string id) =>
        Id.Match(id).Groups[2].Value switch
        {
            "png" => "image/png",
            "jpg" => "image/jpeg",
            "gif" => "image/gif",
            "webp" => "image/webp",
            _ => null,
        };

    internal string ResolveBlob(string id)
    {
        if (!Id.IsMatch(id))
            throw new ImageInputException("Invalid image blob identifier.");
        var filename = Path.Combine(BlobRoot, id[..2], id);
        var actual = AuthorizationPaths.CanonicalPotential(filename);
        var root = AuthorizationPaths.CanonicalPotential(BlobRoot);
        if (!actual.StartsWith(root + Path.DirectorySeparatorChar, StringComparison.Ordinal))
            throw new ImageInputException("Image blob resolves outside its store.");
        return filename;
    }

    internal static byte[] InlineBytes(JsonObject inline)
    {
        var text = Regex.Replace(SessionWait.Text(inline["data"]) ?? "", "\\s", "");
        if (
            text.Length == 0
            || !Regex.IsMatch(text, "^[A-Za-z0-9+/]*={0,2}$")
            || text.Length % 4 == 1
        )
            throw new ImageInputException("Invalid inline image base64 payload.");
        try
        {
            var bytes = Convert.FromBase64String(
                text.TrimEnd('=') + new string('=', (4 - text.TrimEnd('=').Length % 4) % 4)
            );
            if (Convert.ToBase64String(bytes).TrimEnd('=') != text.TrimEnd('='))
                throw new FormatException();
            return bytes;
        }
        catch (FormatException)
        {
            throw new ImageInputException("Invalid inline image base64 payload.");
        }
    }

    internal async Task<JsonObject> PutAsync(
        byte[] bytes,
        string mime,
        string imageId,
        CancellationToken token = default
    )
    {
        mime = mime.Trim().ToLowerInvariant();
        RasterCodec.Probe? probe = RasterCodec.IsSafeRaster(mime)
            ? RasterCodec.Inspect(bytes, mime)
            : null;
        var sha = Convert.ToHexStringLower(SHA256.HashData(bytes));
        var extension = Extension(mime);
        var blobId = sha + "." + extension;
        var filename = ResolveBlob(blobId);
        Directory.CreateDirectory(Path.GetDirectoryName(filename)!);
        if (File.Exists(filename))
        {
            await VerifyAsync(filename, bytes.Length, sha, token);
            LinuxAtomicJsonFile.LinuxDirectorySync.Sync(Path.GetDirectoryName(filename)!);
            LinuxAtomicJsonFile.LinuxDirectorySync.Sync(BlobRoot);
            LinuxAtomicJsonFile.LinuxDirectorySync.Sync(Path.Combine(DataRoot, "state"));
        }
        else
        {
            var temp = filename + "." + Guid.NewGuid().ToString("N") + ".tmp";
            try
            {
                await using (
                    var file = new FileStream(
                        temp,
                        FileMode.CreateNew,
                        FileAccess.Write,
                        FileShare.None,
                        65536,
                        FileOptions.Asynchronous
                    )
                )
                {
                    await file.WriteAsync(bytes, token);
                    await file.FlushAsync(token);
                    file.Flush(true);
                }
                try
                {
                    File.Move(temp, filename);
                }
                catch (IOException) when (File.Exists(filename))
                {
                    await VerifyAsync(filename, bytes.Length, sha, token);
                }
                LinuxAtomicJsonFile.LinuxDirectorySync.Sync(Path.GetDirectoryName(filename)!);
                LinuxAtomicJsonFile.LinuxDirectorySync.Sync(BlobRoot);
                LinuxAtomicJsonFile.LinuxDirectorySync.Sync(Path.Combine(DataRoot, "state"));
            }
            finally
            {
                if (File.Exists(temp))
                    File.Delete(temp);
            }
        }
        return new JsonObject
        {
            ["imageId"] = imageId,
            ["blobId"] = blobId,
            ["format"] = extension,
            ["mimeType"] = mime,
            ["byteLength"] = bytes.Length,
            ["sha256"] = sha,
            ["width"] = probe?.Width,
            ["height"] = probe?.Height,
        };
    }

    private static async Task VerifyAsync(
        string filename,
        long? length,
        string? sha,
        CancellationToken token
    )
    {
        await using var file = new FileStream(
            filename,
            FileMode.Open,
            FileAccess.Read,
            FileShare.Read,
            65536,
            FileOptions.Asynchronous
        );
        if (length is not null && file.Length != length)
            throw new ImageInputException("Image blob failed byte-length validation.");
        if (
            sha is not null
            && Convert.ToHexStringLower(await SHA256.HashDataAsync(file, token)) != sha
        )
            throw new ImageInputException("Image blob failed SHA-256 validation.");
    }

    internal async Task<byte[]> ReadAsync(JsonObject reference, CancellationToken token = default)
    {
        var id = SessionWait.Text(reference["blobId"]);
        var legacy = SessionWait.Text(reference["path"]);
        string filename;
        try
        {
            filename =
                id is not null ? ResolveBlob(id)
                : legacy is not null ? ResolveLegacy(legacy)
                : throw new ImageInputException("Image reference has no blob location.");
        }
        catch (ArgumentException)
        {
            throw new ImageInputException("Image reference has an invalid location.");
        }
        try
        {
            var bytes = await File.ReadAllBytesAsync(filename, token);
            if (
                SessionWait.Number(reference["byteLength"]) is double length
                && length >= 0
                && length != bytes.Length
            )
                throw new ImageInputException("Image blob failed byte-length validation.");
            var hash = SessionWait.Text(reference["sha256"]) ?? (id is not null ? id[..64] : null);
            if (
                hash is not null
                && (
                    Convert.ToHexStringLower(SHA256.HashData(bytes)) != hash
                    || id is not null && hash != id[..64]
                )
            )
                throw new ImageInputException("Image blob failed SHA-256 validation.");
            return bytes;
        }
        catch (Exception error) when (error is IOException or UnauthorizedAccessException)
        {
            throw new ImageInputException(
                error is ImageInputException ? error.Message : "Original image blob is unavailable."
            );
        }
    }

    private string ResolveLegacy(string path)
    {
        var state = AuthorizationPaths.CanonicalPotential(Path.Combine(DataRoot, "state"));
        var candidates = Path.IsPathRooted(path)
            ? [path]
            : new[]
            {
                Path.Combine(DataRoot, path),
                Path.Combine(DataRoot, "src", path),
                Path.Combine(Path.GetDirectoryName(DataRoot)!, "src", path),
            };
        var allowed = candidates
            .Select(Path.GetFullPath)
            .Distinct()
            .Where(value =>
                AuthorizationPaths
                    .CanonicalPotential(value)
                    .StartsWith(state + Path.DirectorySeparatorChar, StringComparison.Ordinal)
            )
            .ToArray();
        if (allowed.Length != 1)
            throw new ImageInputException(
                "Legacy image reference is outside the configured state directory or is ambiguous."
            );
        return allowed[0];
    }

    internal async Task ExternalizeTreeAsync(
        JsonNode? node,
        bool strict = false,
        CancellationToken token = default
    )
    {
        if (node is JsonObject obj)
        {
            var message = SessionWait.Text(obj["role"]) is "user" or "model" or "tool";
            var queued =
                SessionWait.Text(obj["type"])
                is "user"
                    or "intersession"
                    or "background"
                    or "onboot";
            if (obj["parts"] is JsonArray && (message || queued))
            {
                await ExternalizeMessageAsync(obj, strict, token);
                return;
            }
            foreach (
                var child in obj.Where(pair => pair.Key != "parts")
                    .Select(pair => pair.Value)
                    .ToArray()
            )
                await ExternalizeTreeAsync(child, strict, token);
        }
        else if (node is JsonArray array)
            foreach (var child in array.ToArray())
                await ExternalizeTreeAsync(child, strict, token);
    }

    internal async Task ExternalizeMessageAsync(
        JsonObject message,
        bool strict = true,
        CancellationToken token = default
    )
    {
        if (message["parts"] is not JsonArray parts)
            return;
        var result = new JsonArray();
        var index = 0;
        foreach (var original in parts.OfType<JsonObject>())
        {
            var part = (JsonObject)original.DeepClone();
            part.Remove("__providerImageIdentity");
            part.Remove("__providerImageDeduplicated");
            var nested = part["functionResponse"]?["response"] as JsonObject;
            var images = new List<JsonObject>();
            if (nested?["inlineData"] is JsonObject single && Mime(single).StartsWith("image/"))
                images.Add(single);
            if (nested?["inlineDataItems"] is JsonArray items)
                images.AddRange(
                    items.OfType<JsonObject>().Where(item => Mime(item).StartsWith("image/"))
                );
            var references = (nested?["imageParts"] as JsonArray ?? [])
                .OfType<JsonObject>()
                .Select(NormalizeToolReference)
                .OfType<JsonObject>()
                .ToArray();
            try
            {
                await ExternalizePartAsync(part, message, index, token);
                if (images.Count > 0 || references.Length > 0)
                {
                    var siblingParts = new List<JsonObject>();
                    var callId =
                        SessionWait.Text(part["functionResponse"]?["tool_use_id"])
                        ?? SessionWait.Text(part["toolUseId"])
                        ?? "tool";
                    for (var i = 0; i < images.Count; i++)
                    {
                        var sibling = new JsonObject
                        {
                            ["toolUseId"] = callId,
                            ["inlineData"] = images[i].DeepClone(),
                            ["imageMeta"] = new JsonObject
                            {
                                ["imageId"] = callId.Trim() + "#" + (i + 1),
                                ["mimeType"] = Mime(images[i]),
                            },
                        };
                        await ExternalizePartAsync(sibling, message, index + i + 1, token);
                        siblingParts.Add(sibling);
                    }
                    for (var i = 0; i < references.Length; i++)
                    {
                        var reference = references[i];
                        _ = await ReadAsync(reference, token);
                        siblingParts.Add(
                            new JsonObject
                            {
                                ["toolUseId"] = callId,
                                ["inlineDataRef"] = reference.DeepClone(),
                                ["imageMeta"] = new JsonObject
                                {
                                    ["imageId"] = callId.Trim() + "#" + (images.Count + i + 1),
                                    ["mimeType"] = reference["mimeType"]?.DeepClone(),
                                    ["width"] = reference["width"]?.DeepClone(),
                                    ["height"] = reference["height"]?.DeepClone(),
                                    ["sizeBytes"] = reference["byteLength"]?.DeepClone(),
                                    ["sha256"] = reference["sha256"]?.DeepClone(),
                                },
                            }
                        );
                    }
                    nested!.Remove("inlineData");
                    nested.Remove("inlineDataItems");
                    nested.Remove("imageParts");
                    nested["output"] ??= "[Image loaded]";
                    result.Add(part);
                    foreach (var sibling in siblingParts)
                        result.Add(sibling);
                }
                else
                    result.Add(part);
            }
            catch (Exception error)
                when (!strict
                    && error is IOException or UnauthorizedAccessException or ArgumentException
                )
            {
                result.Add(original.DeepClone());
            } // Old bytes and structure remain intact on failed materialization.
            index++;
        }
        message["parts"] = result;
    }

    internal static JsonObject? NormalizeToolReference(JsonObject part)
    {
        if (
            part["inlineDataRef"] is not JsonObject value
            || SessionWait.Text(value["blobId"]) is not { } id
            || SafeMime(id) is null
            || !Mime(value).StartsWith("image/", StringComparison.Ordinal)
            || SessionWait.Number(value["byteLength"]) is not double length
            || length < 0
            || length != Math.Truncate(length)
            || SessionWait.Text(value["sha256"]) is not { } hash
            || !Regex.IsMatch(hash, "^[a-f0-9]{64}$")
        )
            return null;
        var reference = new JsonObject
        {
            ["imageId"] = SessionWait.Text(value["imageId"]) is { Length: > 0 } imageId
                ? imageId
                : id,
            ["blobId"] = id,
            ["mimeType"] = Mime(value),
            ["byteLength"] = length,
            ["sha256"] = hash,
        };
        foreach (var key in new[] { "format", "width", "height" })
            if (value[key] is not null)
                reference[key] = value[key]!.DeepClone();
        return reference;
    }

    private async Task ExternalizePartAsync(
        JsonObject part,
        JsonObject message,
        int index,
        CancellationToken token
    )
    {
        JsonObject? reference = null;
        var imageId =
            SessionWait.Text(part["imageMeta"]?["imageId"])
            ?? SessionWait.Text(part["inlineDataRef"]?["imageId"])
            ?? (
                SessionWait.Number(message["__meta"]?["seq"]) is double seq
                    ? "msg"
                        + seq.ToString(
                            "00000000",
                            System.Globalization.CultureInfo.InvariantCulture
                        )
                        + "_part"
                        + (index + 1)
                    : "image_" + Guid.NewGuid()
            );
        if (
            part["inlineData"] is JsonObject inline
            && Mime(inline).StartsWith("image/", StringComparison.Ordinal)
        )
            reference = await PutAsync(InlineBytes(inline), Mime(inline), imageId, token);
        else if (
            part["inlineDataRef"] is JsonObject legacy
            && legacy["blobId"] is null
            && legacy["path"] is not null
        )
            reference = await PutAsync(
                await ReadAsync(legacy, token),
                Mime(legacy),
                imageId,
                token
            );
        if (reference is null)
            return;
        part.Remove("inlineData");
        part["inlineDataRef"] = reference;
        part["imageMeta"] ??= new JsonObject
        {
            ["imageId"] = reference["imageId"]?.DeepClone(),
            ["mimeType"] = reference["mimeType"]?.DeepClone(),
            ["width"] = reference["width"]?.DeepClone(),
            ["height"] = reference["height"]?.DeepClone(),
            ["sizeBytes"] = reference["byteLength"]?.DeepClone(),
            ["sha256"] = reference["sha256"]?.DeepClone(),
        };
    }
}
