using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Images;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private void RegisterSessionImageRoutes(WebApplication app)
    {
        app.MapMethods("/api/sessions/{id}/blobs/{blobId}", ["GET", "HEAD"], async (string id, string blobId, HttpContext context) =>
        {
            if (!downloads.Authorizes(context)) await RequireImageReferenceAsync(context.Request, id, blobId, null);
            return await BlobResultAsync(blobId, context);
        }).WithMetadata(new WebUiDownloadResource("session-blob"));
        app.MapPost("/api/sessions/{id}/blobs/{blobId}/download", async (string id, string blobId, HttpRequest request) =>
        {
            var input = await request.ReadFromJsonAsync<JsonObject>() ?? new JsonObject();
            await RequireImageReferenceAsync(request, id, blobId, input);
            try
            {
                if (!File.Exists(sessions.Images.ResolveBlob(blobId))) return Results.NotFound(new { error = "Image is unavailable." });
                WebUiAccess.Request(request)?.Require();
                var grant = downloads.Issue("blob", blobId, input, RouteIdentity(request));
                request.HttpContext.Response.Headers.CacheControl = "no-store";
                return Results.Ok(new { url = Uri.EscapeDataString(blobId) + grant.Query, expiresAt = grant.ExpiresAt });
            }
            catch (ImageInputException) { return Results.BadRequest(new { error = "Image is unavailable or invalid." }); }
        });
    }

    private async Task RequireImageReferenceAsync(HttpRequest request, string id, string blobId, JsonObject? body)
    {
        var scoped = WebUiAccess.Request(request);
        if (scoped is null) return; // Ordinary administrator authority, not a resource signature.
        var owner = await FindRouteAsync(request, id) ?? throw new WebUiAccessException();
        var snapshot = owner.Entry.Snapshot();
        var referenced = snapshot.History.Any(message => WebUiSessionImages.References(message.ToJson(), blobId));
        var rawSeq = WebUiDownloadSignatures.Text(request.Query, "archiveSeq") ?? (body is null ? null : WebUiDownloadSignatures.Text(body, "archiveSeq"));
        if (!referenced && rawSeq is not null && Regex.IsMatch(rawSeq, "^[1-9][0-9]*$") && long.TryParse(rawSeq, out var seq) && seq <= 9007199254740991L && seq <= snapshot.NextMessageSeq - 1)
        {
            var record = owner.Archive.ReadEffectiveMessagesRange(seq, seq).FirstOrDefault();
            if (record is not null)
            {
                await sessions.Images.ExternalizeMessageAsync(record.Message, strict: false, request.HttpContext.RequestAborted);
                referenced = WebUiSessionImages.References(record.Message, blobId);
            }
        }
        scoped.Require(owner.Id);
        if (!referenced) throw new WebUiAccessException();
    }
}

internal static class WebUiSessionImages
{
    internal static bool References(JsonObject message, string blobId) => message["parts"] is JsonArray parts && parts.OfType<JsonObject>().Any(part => SessionWait.Text(part["inlineDataRef"]?["blobId"]) == blobId);

    // Continuous pages carry committed message sequences. The browser must retain the sequence
    // when a compacted message is no longer present in active history.
    internal static void Project(JsonObject page, string sessionId, bool archive)
    {
        if (page["messages"] is not JsonArray messages) return;
        foreach (var message in messages.OfType<JsonObject>())
        {
            if (message["parts"] is not JsonArray parts) continue;
            foreach (var part in parts.OfType<JsonObject>())
                if (part["inlineDataRef"] is JsonObject reference && SessionWait.Text(reference["blobId"]) is { } blobId)
                    reference["apiPath"] = "/sessions/" + Uri.EscapeDataString(sessionId) + "/blobs/" + Uri.EscapeDataString(blobId)
                        + (archive && SessionWait.Number(message["__meta"]?["seq"]) is { } seq ? "?archiveSeq=" + seq.ToString(System.Globalization.CultureInfo.InvariantCulture) : "");
        }
    }
}
