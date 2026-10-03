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
    private static string AttachmentMime(string? declared, string filename) => WebUiUploadedFiles.Mime(declared, filename);
    private void RegisterUploadAndImageRoutes(WebApplication app)
    {
        app.MapPost("/api/upload", async (HttpContext context) =>
        {
            if (context.Features.Get<IHttpMaxRequestBodySizeFeature>() is { IsReadOnly: false } limit) limit.MaxRequestBodySize = UploadLimit + 1024 * 1024;
            if (!context.Request.HasFormContentType) return Results.BadRequest(new { error = "A multipart file is required." });
            try
            {
                var form = await context.Request.ReadFormAsync(context.RequestAborted);
                if (form.Files.Count != 1 || form.Files[0].Name != "file") return Results.BadRequest(new { error = "One file is required." });
                var file = form.Files[0];
                var mimeType = AttachmentMime(file.ContentType, file.FileName);
                if (file.Length > UploadLimit) return Results.BadRequest(new { error = "File exceeds the 50 MiB upload limit." });
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
            { return Results.BadRequest(new { error = "File upload failed: " + ImageTransport.SafeText(error.Message) }); }
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
}
