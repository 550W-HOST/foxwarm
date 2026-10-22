using System.Globalization;
using System.Text.Json;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private static long ArtifactRouteRevision(string value)
    {
        if (
            !double.TryParse(
                value,
                NumberStyles.Float,
                CultureInfo.InvariantCulture,
                out var revision
            )
            || revision < 1
            || revision > 9007199254740991
            || Math.Truncate(revision) != revision
        )
            throw new InvalidDataException("Invalid artifact reference");
        return (long)revision;
    }

    private void RegisterArtifactRoutes(WebApplication app)
    {
        app.MapGet(
            "/api/sessions/{id}/artifacts/{artifactId}/{revision}",
            async (string id, string artifactId, string revision, HttpRequest request) =>
            {
                if (
                    await FindRouteAsync(request, id) is null
                    || RouteIdentity(request) is not string exact
                )
                    return Results.NotFound(new { error = "Session not found" });
                try
                {
                    var record = await sessions.Artifacts.ReadAsync(
                        artifactId,
                        ArtifactRouteRevision(revision),
                        exact,
                        request.HttpContext.RequestAborted
                    );
                    WebUiAccess.Request(request)?.Require(exact);
                    request.HttpContext.Response.Headers.CacheControl = "private, no-store";
                    request.HttpContext.Response.Headers.XContentTypeOptions = "nosniff";
                    // Artifact documents are authored JSON, not Message transport envelopes.
                    return Results.Text(record.ToJsonString(), "application/json");
                }
                catch (Exception error)
                    when (error
                            is IOException
                                or InvalidDataException
                                or JsonException
                                or InvalidOperationException
                                or ArgumentException
                                or OverflowException
                        && error is not WebUiAccessException
                    )
                {
                    return Results.NotFound(new { error = "Artifact unavailable" });
                }
            }
        );
        app.MapGet(
            "/api/sessions/{id}/artifacts/{artifactId}/{revision}/resources/{resource}",
            async (
                string id,
                string artifactId,
                string revision,
                string resource,
                HttpRequest request
            ) =>
            {
                if (
                    await FindRouteAsync(request, id) is null
                    || RouteIdentity(request) is not string exact
                )
                    return Results.NotFound(new { error = "Session not found" });
                try
                {
                    var result = await sessions.Artifacts.ResourceAsync(
                        artifactId,
                        ArtifactRouteRevision(revision),
                        exact,
                        resource,
                        request.HttpContext.RequestAborted
                    );
                    if (!Foxwarm.Images.RasterCodec.IsSafeRaster(result.MimeType))
                        throw new InvalidDataException("Unsupported resource");
                    WebUiAccess.Request(request)?.Require(exact);
                    request.HttpContext.Response.Headers.CacheControl = "private, no-store";
                    request.HttpContext.Response.Headers.XContentTypeOptions = "nosniff";
                    request.HttpContext.Response.Headers.ContentSecurityPolicy =
                        "default-src 'none'; sandbox";
                    return Results.Bytes(result.Bytes, result.MimeType);
                }
                catch (Exception error)
                    when (error
                            is IOException
                                or InvalidDataException
                                or JsonException
                                or InvalidOperationException
                                or ArgumentException
                                or OverflowException
                        && error is not WebUiAccessException
                    )
                {
                    return Results.NotFound(new { error = "Resource unavailable" });
                }
            }
        );
    }
}
