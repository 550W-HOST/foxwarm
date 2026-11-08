using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    // The administrator decides every approval. A scoped identity decides only records whose
    // asking rules all name it; FindRouteAsync has already checked its Session scope.
    private static bool MayDecide(HttpRequest request, JsonObject record) =>
        WebUiAccess.Request(request) is not { } scoped
        || SessionWait.Strings(record["approvers"]).Contains(scoped.IdentityId);

    private static JsonObject Decider(HttpRequest request) =>
        WebUiAccess.Request(request) is { } scoped
            ? new JsonObject { ["kind"] = "identity", ["id"] = scoped.IdentityId }
            : new JsonObject { ["kind"] = "administrator" };

    // Adds what the requester may do to each approval record of a questions view.
    private static void MarkDecidableApprovals(HttpRequest request, JsonObject view)
    {
        foreach (var record in (view["approvals"] as JsonArray ?? []).OfType<JsonObject>())
            record["canDecide"] =
                SessionApprovals.Status(record) == "pending" && MayDecide(request, record);
    }

    private static IResult NotApprover() =>
        Results.Json(
            new JsonObject
            {
                ["error"] = "You are not an approver for this request.",
                ["code"] = "APPROVAL_NOT_ALLOWED",
            },
            statusCode: 403
        );

    private void RegisterApprovalRoutes(WebApplication app)
    {
        // Full arguments of one approval request, including any beyond the stored preview.
        app.MapGet(
            "/api/sessions/{id}/approvals/{approvalId}",
            async (string id, string approvalId, HttpRequest request) =>
            {
                var hosted = await FindRouteAsync(request, id);
                if (hosted is null)
                    return Results.NotFound(new JsonObject { ["error"] = "Session not found" });
                var record = hosted.Entry.WithState(state =>
                    SessionApprovals.Find(state.Meta, approvalId)?.DeepClone() as JsonObject
                );
                if (record is null)
                    return Results.NotFound(new JsonObject { ["error"] = "Approval not found" });
                if (!MayDecide(request, record))
                    return NotApprover();
                var args = hosted.ApprovalWaiters.Args(approvalId) ?? record["args"];
                return Results.Ok(
                    JsonData.WebNode(
                        new JsonObject
                        {
                            ["sessionId"] = hosted.Id,
                            ["approval"] = record,
                            ["args"] = args?.DeepClone(),
                        }
                    )
                );
            }
        );
        app.MapPost(
            "/api/sessions/{id}/approvals/{approvalId}",
            async (string id, string approvalId, HttpRequest request) =>
            {
                var hosted = await FindRouteAsync(request, id);
                if (hosted is null)
                    return Results.NotFound(new JsonObject { ["error"] = "Session not found" });
                if (!sessions.Accepting)
                    return Results.StatusCode(503);
                JsonObject body;
                try
                {
                    body =
                        await JsonNode.ParseAsync(request.Body) as JsonObject
                        ?? throw new InvalidDataException("Decision must be an object.");
                    if (body.Any(pair => pair.Key is not ("decision" or "note")))
                        throw new InvalidDataException("Decision accepts only decision and note.");
                    if (SessionWait.Text(body["decision"]) is not ("approve" or "reject"))
                        throw new InvalidDataException("decision must be approve or reject.");
                    if (body.ContainsKey("note") && SessionWait.Text(body["note"]) is null)
                        throw new InvalidDataException("note must be a string.");
                }
                catch (JsonException)
                {
                    return Results.BadRequest(new JsonObject { ["error"] = "Invalid JSON" });
                }
                catch (InvalidDataException error)
                {
                    return Results.BadRequest(new JsonObject { ["error"] = error.Message });
                }
                var record = hosted.Entry.WithState(state =>
                    SessionApprovals.Find(state.Meta, approvalId)?.DeepClone() as JsonObject
                );
                if (record is null)
                    return Results.NotFound(new JsonObject { ["error"] = "Approval not found" });
                if (!MayDecide(request, record))
                    return NotApprover();
                JsonObject decided;
                try
                {
                    decided = await sessions.DecideToolApprovalAsync(
                        hosted,
                        approvalId,
                        SessionWait.Text(body["decision"]) == "approve",
                        SessionWait.Text(body["note"]),
                        Decider(request)
                    );
                }
                catch (KeyNotFoundException error)
                {
                    return Results.NotFound(new JsonObject { ["error"] = error.Message });
                }
                catch (ToolApprovalNotPendingException error)
                {
                    return Results.Json(
                        new JsonObject
                        {
                            ["error"] = error.Message,
                            ["code"] = "APPROVAL_NOT_PENDING",
                        },
                        statusCode: 409
                    );
                }
                catch (InvalidDataException error)
                {
                    return Results.BadRequest(new JsonObject { ["error"] = error.Message });
                }
                return Results.Accepted(
                    value: new JsonObject
                    {
                        ["accepted"] = true,
                        ["approvalId"] = approvalId,
                        ["status"] = decided["status"]?.DeepClone(),
                    }
                );
            }
        );
    }
}
