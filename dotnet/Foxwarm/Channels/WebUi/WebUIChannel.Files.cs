using System.Text.Json.Nodes;
using Foxwarm.Tools;
using Microsoft.Net.Http.Headers;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private void RegisterFileRoutes(WebApplication app)
    {
        app.Lifetime.ApplicationStarted.Register(() =>
            sessions.RegisterWebUiFileDelivery(FileReady)
        );
        app.Lifetime.ApplicationStopping.Register(() => sessions.RegisterWebUiFileDelivery(null));
        app.MapPost("/api/download/sign", async (HttpRequest request) =>
        {
            var input = await request.ReadFromJsonAsync<JsonObject>() ?? new JsonObject();
            var path = WebUiDownloadSignatures.Text(input, "path");
            if (string.IsNullOrEmpty(path) || !Path.IsPathFullyQualified(path))
                return Results.BadRequest(new { error = "An absolute file path is required." });
            if (!WorkspaceTools.RegularFile(path))
                return Results.NotFound(new { error = "File not found." });
            var grant = downloads.Issue("path", path, input);
            request.HttpContext.Response.Headers.CacheControl = "no-store";
            return Results.Ok(new { url = "download" + grant.Query, expiresAt = grant.ExpiresAt });
        });
        app.MapMethods(
            "/download", ["GET", "HEAD"],
            async (HttpContext context) =>
            {
                var path = WebUiDownloadSignatures.Text(context.Request.Query, "path");
                if (string.IsNullOrEmpty(path) || !Path.IsPathFullyQualified(path))
                    return Results.BadRequest(new { error = "An absolute file path is required." });
                try
                {
                    if (!File.Exists(path))
                        return Results.NotFound(new { error = "File not found." });
                    if (!WorkspaceTools.RegularFile(path))
                        return Results.BadRequest(new { error = "Path is not a regular file." });
                    var stream = new FileStream(
                        path,
                        FileMode.Open,
                        FileAccess.Read,
                        FileShare.ReadWrite | FileShare.Delete,
                        65536,
                        FileOptions.Asynchronous | FileOptions.SequentialScan
                    );
                    if (!WorkspaceTools.RegularFileHandle(stream, path))
                    {
                        await stream.DisposeAsync();
                        return Results.BadRequest(new { error = "Path is not a regular file." });
                    }
                    var filename = WebUiDownloadSignatures.FileName(
                        WebUiDownloadSignatures.Text(context.Request.Query, "filename"), Path.GetFileName(path));
                    var mime = WebUiDownloadSignatures.Text(context.Request.Query, "preview") == "1"
                        ? WebUiDownloadSignatures.RasterMime(path) : null;
                    DownloadDisposition(context.Response, filename, mime is not null);
                    context.Response.Headers.XContentTypeOptions = "nosniff";
                    context.Response.Headers.CacheControl = "private, no-cache";
                    return Results.File(stream, mime ?? "application/octet-stream");
                }
                catch (Exception error)
                    when (error is FileNotFoundException or DirectoryNotFoundException)
                {
                    return Results.NotFound(new { error = "File not found." });
                }
                catch (Exception error)
                    when (error is IOException or UnauthorizedAccessException or ArgumentException)
                {
                    return Results.Problem("File download failed.", statusCode: 500);
                }
            }
        ).WithMetadata(new WebUiDownloadResource("path"));
    }

    private static void DownloadDisposition(HttpResponse response, string filename, bool inline)
    {
        var disposition = new ContentDispositionHeaderValue(inline ? "inline" : "attachment");
        disposition.SetHttpFileName(filename);
        response.Headers.ContentDisposition = disposition.ToString();
    }

    // Successful WebUI delivery means that the caller's paired result can link this host file.
    // There is no target-chat event, queue input or channel-side binary transfer.
    private void FileReady(string conversation, string path, string? caption) { }
}
