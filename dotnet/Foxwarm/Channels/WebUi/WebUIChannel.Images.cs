using System.Security.Cryptography;
using System.Text.Json.Nodes;
using Foxwarm.Images;
using Foxwarm.Sessions;
using Foxwarm.Tools;
using Microsoft.AspNetCore.Http.Features;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private const long UploadLimit = 50L * 1024 * 1024;
    private string UploadRoot => Path.Combine(sessions.DataRoot, "state", "webui-uploads");
    private static string AttachmentMime(string? declared, string filename)
    {
        var mime = (declared ?? "").Trim().ToLowerInvariant();
        if (mime.StartsWith("image/", StringComparison.Ordinal)) return mime;
        if (mime is not ("" or "application/octet-stream")) return mime;
        return Path.GetExtension(filename).ToLowerInvariant() switch
        { ".png" => "image/png", ".jpg" or ".jpeg" => "image/jpeg", ".gif" => "image/gif", ".webp" => "image/webp", ".heic" => "image/heic", ".heif" => "image/heif", ".bmp" => "image/bmp", ".svg" => "image/svg+xml", _ => "application/octet-stream" };
    }
    private void RegisterImageRoutes(WebApplication app)
    {
        app.MapPost("/api/upload", async (HttpContext context) =>
        {
            if (context.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit) limit.MaxRequestBodySize = UploadLimit + 1024 * 1024;
            if (!context.Request.HasFormContentType) return Results.BadRequest(new { error = "A multipart image file is required." });
            try
            {
                var form = await context.Request.ReadFormAsync(context.RequestAborted);
                if (form.Files.Count != 1 || form.Files[0].Name != "file") return Results.BadRequest(new { error = "One image file is required." });
                var file = form.Files[0];
                var mimeType = AttachmentMime(file.ContentType, file.FileName);
                if (!mimeType.StartsWith("image/", StringComparison.Ordinal)) return Results.BadRequest(new { error = "Only image attachments are supported." });
                if (file.Length > UploadLimit) return Results.BadRequest(new { error = "Image exceeds the 50 MiB upload limit." });
                Directory.CreateDirectory(UploadRoot);
                var original = Path.GetFileName(file.FileName.Replace('\\', '/')); var extension = Path.GetExtension(original);
                var path = Path.Combine(UploadRoot, Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16)) + (extension.Length <= 16 ? extension : ""));
                try
                {
                    await using (var output = new FileStream(path, FileMode.CreateNew, FileAccess.Write, FileShare.None, 65536, FileOptions.Asynchronous))
                    { await file.CopyToAsync(output, context.RequestAborted); await output.FlushAsync(context.RequestAborted); output.Flush(true); }
                    LinuxAtomicJsonFile.LinuxDirectorySync.Sync(UploadRoot);
                }
                catch { File.Delete(path); throw; }
                return Results.Ok(new { path, filename = original, mimeType, size = file.Length });
            }
            catch (Exception error) when (error is InvalidDataException or IOException or BadHttpRequestException)
            { return Results.BadRequest(new { error = "Image upload failed: " + ImageTransport.SafeText(error.Message) }); }
        });
        app.MapGet("/api/blobs/{blobId}", async (string blobId, HttpContext context) =>
        {
            try
            {
                var path = sessions.Images.ResolveBlob(blobId);
                if (!File.Exists(path)) return Results.NotFound(new { error = "Image is unavailable." });
                var reference = new JsonObject { ["blobId"] = blobId, ["sha256"] = blobId[..64] };
                var bytes = await sessions.Images.ReadAsync(reference, context.RequestAborted);
                var etag = '"' + blobId[..64] + '"';
                context.Response.Headers.ETag = etag; context.Response.Headers.CacheControl = "private, max-age=31536000, immutable";
                context.Response.Headers.XContentTypeOptions = "nosniff";
                if (context.Request.Headers.IfNoneMatch.ToString() == etag) return Results.StatusCode(304);
                var mime = ImageBlobStore.SafeMime(blobId);
                return Results.File(bytes, mime ?? "application/octet-stream", fileDownloadName: mime is null || context.Request.Query["download"] == "1" ? blobId : null);
            }
            catch (ImageInputException) { return Results.BadRequest(new { error = "Image is unavailable or invalid." }); }
        });
    }
    private async Task<IReadOnlyList<JsonObject>> PrepareUploadedPartsAsync(JsonObject input, SessionOwner owner, CancellationToken token)
    {
        var parts = input["parts"] is JsonArray given ? given.OfType<JsonObject>().Select(part => (JsonObject)part.DeepClone()).ToList()
            : SessionWait.Text(input["text"]) is { } text ? [new JsonObject { ["text"] = text }] : [];
        if (input["parts"] is JsonArray array && (parts.Count != array.Count || parts.Any(part => part.Count != 1 || SessionWait.Text(part["text"]) is null)))
            throw new ImageInputException("Message parts must contain text; attach images through upload.");
        var entries = input["uploadedFiles"] as JsonArray ?? input["filePaths"] as JsonArray ?? [];
        foreach (var entry in entries)
        {
            var path = SessionWait.Text(entry) ?? SessionWait.Text((entry as JsonObject)?["path"]) ?? throw new ImageInputException("Uploaded image has no staging path.");
            var filename = SessionWait.Text((entry as JsonObject)?["filename"]) ?? Path.GetFileName(path);
            var mime = AttachmentMime(SessionWait.Text((entry as JsonObject)?["mimeType"]), filename);
            if (!mime.StartsWith("image/", StringComparison.Ordinal)) throw new ImageInputException("Only image attachments are supported.");
            var physicalRoot = AuthorizationPaths.CanonicalPotential(UploadRoot); var physical = AuthorizationPaths.CanonicalPotential(Path.GetFullPath(path));
            if (!physical.StartsWith(physicalRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal) || !WorkspaceTools.RegularFile(path))
                throw new ImageInputException("Uploaded image is not a regular file in server upload staging.");
            byte[] bytes;
            await using (var stream = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read, 65536, FileOptions.Asynchronous))
            {
                if (OperatingSystem.IsLinux())
                {
                    var opened = new FileInfo("/proc/self/fd/" + stream.SafeFileHandle.DangerousGetHandle().ToInt64()).ResolveLinkTarget(true)?.FullName;
                    if (opened is null || !opened.StartsWith(physicalRoot + Path.DirectorySeparatorChar, StringComparison.Ordinal))
                        throw new ImageInputException("Uploaded image is outside server upload staging.");
                }
                if (stream.Length > UploadLimit) throw new ImageInputException("Image exceeds the 50 MiB upload limit.");
                using var buffer = new MemoryStream(); await stream.CopyToAsync(buffer, token); bytes = buffer.ToArray();
            }
            var imageId = "image_" + Guid.NewGuid(); var reference = await sessions.Images.PutAsync(bytes, mime, imageId, token);
            var safeName = System.Text.RegularExpressions.Regex.Replace(Path.GetFileNameWithoutExtension(filename), "[^a-zA-Z0-9._-]+", "_").TrimStart('.');
            if (safeName.Length == 0) safeName = "upload"; if (safeName.Length > 80) safeName = safeName[..80];
            var directory = Path.Combine(sessions.AgentDirectory(owner.Agent), ".temp", "channel-files", "webui"); Directory.CreateDirectory(directory);
            var destination = Path.Combine(directory, DateTimeOffset.UtcNow.ToString("yyyy-MM-ddTHH-mm-ss-fffZ") + "-" + Guid.NewGuid().ToString("N")[..8] + "-" + safeName + Path.GetExtension(filename));
            await File.WriteAllBytesAsync(destination, bytes, token);
            static string Escape(string value) => System.Net.WebUtility.HtmlEncode(value).Replace("'", "&apos;");
            parts.Add(new JsonObject { ["text"] = $"<foxwarm-image name=\"{Escape(filename)}\" node=\"master\" path=\"{Escape(destination)}\" />" });
            parts.Add(new JsonObject { ["inlineDataRef"] = reference, ["imageMeta"] = new JsonObject { ["imageId"] = imageId, ["mimeType"] = mime, ["width"] = reference["width"]?.DeepClone(), ["height"] = reference["height"]?.DeepClone(), ["sizeBytes"] = bytes.Length, ["sha256"] = reference["sha256"]?.DeepClone() } });
            // No Session-bound upload receipt. Any authenticated message may use an existing staging file.
            File.Delete(path);
        }
        return parts;
    }
}
