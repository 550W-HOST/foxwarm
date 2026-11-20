using System.Globalization;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

/// <summary>
/// The version of one active-history message that was sent to the model: which ranges text
/// redaction replaced, read from memory only. Scoped browser identities reach it for their own
/// Sessions through the normal Session route binding.
/// </summary>
internal sealed partial class WebUIChannel
{
    private void RegisterRedactionRoutes(WebApplication app)
    {
        app.MapGet(
            "/api/sessions/{id}/messages/{seq}/redaction",
            async (string id, string seq, HttpRequest request) =>
            {
                var hosted = await FindRouteAsync(request, id);
                if (hosted is null)
                    return Results.NotFound(new JsonObject { ["error"] = "Session not found" });
                if (request.Query.Count > 0)
                    return Results.BadRequest(new JsonObject { ["error"] = "Unexpected query." });
                if (
                    !long.TryParse(
                        seq,
                        NumberStyles.None,
                        CultureInfo.InvariantCulture,
                        out var target
                    ) || target is <= 0 or > 9007199254740991L
                )
                    return Results.BadRequest(
                        new JsonObject { ["error"] = "seq must be a positive safe integer." }
                    );
                var message = hosted
                    .Entry.Snapshot()
                    .History.FirstOrDefault(item => item.Sequence == target);
                if (message is null)
                    return Results.NotFound(new JsonObject { ["error"] = "Message not found" });
                var session = hosted.BuildDto();
                var candidates =
                    session["textRedaction"]?.GetValue<bool>() == true
                        ? TextRedactionView.Candidates(
                            sessions.Models.Capture(),
                            SessionWait.Text(session["modelKey"])
                        )
                        : [];
                var result = TextRedactionView.Describe(
                    (JsonObject)JsonNode.Parse(message.ToJsonString())!,
                    candidates,
                    sessions.Secrets
                );
                result["seq"] = target;
                WebUiAccess.Request(request)?.Require(hosted.Id);
                return Results.Ok(result);
            }
        );
    }
}
