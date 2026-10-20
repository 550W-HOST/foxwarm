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
    private static string UploadRoot => WebUiUploadedFiles.StagingRoot;

    private static string AttachmentMime(string? declared, string filename) =>
        WebUiUploadedFiles.Mime(declared, filename);

    private void RegisterUploadAndImageRoutes(WebApplication app)
    {
        RegisterSessionImageRoutes(app);
        app.MapPost(
            "/api/upload",
            async (HttpContext context) =>
            {
                if (
                    context.Features.Get<IHttpMaxRequestBodySizeFeature>() is
                    { IsReadOnly: false } limit
                )
                    // Source limits each file, not the complete multipart body.
                    limit.MaxRequestBodySize = null;
                if (!context.Request.HasFormContentType)
                    return Results.BadRequest(new { error = "A multipart file is required." });
                try
                {
                    var scoped = WebUiAccess.Request(context);
                    var form = await context.Request.ReadFormAsync(
                        new FormOptions
                        {
                            MultipartBodyLengthLimit = UploadLimit,
                            ValueLengthLimit = 1024 * 1024,
                        },
                        context.RequestAborted
                    );
                    var uploadSession =
                        form["sessionId"].Count == 1 ? form["sessionId"].ToString().Trim() : "";
                    if (scoped is not null)
                    {
                        if (uploadSession.Length == 0)
                            return Results.BadRequest(
                                new { error = "WebUI identity upload requires a bound sessionId." }
                            );
                        scoped.Bind(uploadSession);
                    }
                    if (form.Files.Count != 1 || form.Files[0].Name != "file")
                        return Results.BadRequest(new { error = "One file is required." });
                    var file = form.Files[0];
                    var mimeType = AttachmentMime(file.ContentType, file.FileName);
                    if (file.Length > UploadLimit)
                        return Results.BadRequest(
                            new { error = "File exceeds the 50 MiB upload limit." }
                        );
                    Directory.CreateDirectory(UploadRoot);
                    var original = Path.GetFileName(file.FileName.Replace('\\', '/'));
                    var extension = Path.GetExtension(original);
                    var path = Path.Combine(
                        UploadRoot,
                        Convert.ToHexStringLower(RandomNumberGenerator.GetBytes(16))
                            + extension
                    );
                    try
                    {
                        await using (
                            var output = new FileStream(
                                path,
                                FileMode.CreateNew,
                                FileAccess.Write,
                                FileShare.None,
                                65536,
                                FileOptions.Asynchronous
                            )
                        )
                        {
                            await file.CopyToAsync(output, context.RequestAborted);
                            await output.FlushAsync(context.RequestAborted);
                        }
                        scoped?.Require(uploadSession);
                        scoped?.RegisterUpload(uploadSession, path);
                    }
                    catch
                    {
                        File.Delete(path);
                        throw;
                    }
                    return Results.Ok(
                        new
                        {
                            path,
                            filename = original,
                            mimeType,
                            size = file.Length,
                        }
                    );
                }
                catch (Exception error)
                    when (error is InvalidDataException or IOException or BadHttpRequestException)
                {
                    return Results.BadRequest(
                        new
                        {
                            error = "File upload failed: " + ImageTransport.SafeText(error.Message),
                        }
                    );
                }
            }
        );
        app.MapPost(
            "/api/blobs/{blobId}/download",
            async (string blobId, HttpRequest request) =>
            {
                try
                {
                    var path = sessions.Images.ResolveBlob(blobId);
                    if (!File.Exists(path))
                        return Results.NotFound(new { error = "Image is unavailable." });
                    var input = await request.ReadFromJsonAsync<JsonObject>() ?? new JsonObject();
                    var grant = downloads.Issue("blob", blobId, input);
                    request.HttpContext.Response.Headers.CacheControl = "no-store";
                    return Results.Ok(
                        new
                        {
                            url = Uri.EscapeDataString(blobId) + grant.Query,
                            expiresAt = grant.ExpiresAt,
                        }
                    );
                }
                catch (ImageInputException)
                {
                    return Results.BadRequest(new { error = "Image is unavailable or invalid." });
                }
            }
        );
        app.MapMethods(
                "/api/blobs/{blobId}",
                ["GET", "HEAD"],
                async (string blobId, HttpContext context) =>
                {
                    return await BlobResultAsync(blobId, context);
                }
            )
            .WithMetadata(new WebUiDownloadResource("blob"));
    }

    private async Task<IResult> BlobResultAsync(string blobId, HttpContext context)
    {
        try
        {
            var path = sessions.Images.ResolveBlob(blobId);
            if (!File.Exists(path))
                return Results.NotFound(new { error = "Image is unavailable." });
            var reference = new JsonObject { ["blobId"] = blobId, ["sha256"] = blobId[..64] };
            var bytes = await sessions.Images.ReadAsync(reference, context.RequestAborted);
            if (!downloads.Authorizes(context))
                WebUiAccess.Request(context)?.Require();
            var etag = '"' + blobId[..64] + '"';
            context.Response.Headers.ETag = etag;
            context.Response.Headers.CacheControl = "private, max-age=31536000, immutable";
            context.Response.Headers.XContentTypeOptions = "nosniff";
            if (context.Request.Headers.IfNoneMatch.ToString() == etag)
                return Results.StatusCode(304);
            var mime = ImageBlobStore.SafeMime(blobId);
            if (
                mime is null
                || context.Request.Query["preview"] == "0"
                || context.Request.Query["download"] == "1"
            )
                DownloadDisposition(
                    context.Response,
                    WebUiDownloadSignatures.FileName(
                        WebUiDownloadSignatures.Text(context.Request.Query, "filename"),
                        blobId
                    ),
                    inline: false
                );
            return Results.File(bytes, mime ?? "application/octet-stream");
        }
        catch (ImageInputException)
        {
            return Results.BadRequest(new { error = "Image is unavailable or invalid." });
        }
    }
}
