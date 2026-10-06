using Foxwarm.Tools;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private void RegisterFileRoutes(WebApplication app)
    {
        app.Lifetime.ApplicationStarted.Register(() =>
            sessions.RegisterWebUiFileDelivery(FileReady)
        );
        app.Lifetime.ApplicationStopping.Register(() => sessions.RegisterWebUiFileDelivery(null));
        app.MapGet(
            "/download",
            async (HttpContext context) =>
            {
                var query = context.Request.Query["path"];
                if (
                    query.Count != 1
                    || string.IsNullOrEmpty(query[0])
                    || !Path.IsPathFullyQualified(query[0]!)
                )
                    return Results.BadRequest(new { error = "An absolute file path is required." });
                var path = query[0]!;
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
                    context.Response.Headers.XContentTypeOptions = "nosniff";
                    context.Response.Headers.CacheControl = "private, no-store";
                    return Results.File(
                        stream,
                        "application/octet-stream",
                        fileDownloadName: Path.GetFileName(path)
                    );
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
        );
    }

    // Successful WebUI delivery means that the caller's paired result can link this host file.
    // There is no target-chat event, queue input or channel-side binary transfer.
    private void FileReady(string conversation, string path, string? caption) { }
}
