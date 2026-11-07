using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private void RegisterQuestionRoutes(WebApplication app)
    {
        // Session-owned question state (open plus a short resolved tail) for the answer dock and cards.
        app.MapGet(
            "/api/sessions/{id}/questions",
            async (string id, HttpRequest request) =>
            {
                var hosted = await FindRouteAsync(request, id);
                if (hosted is null)
                    return Results.NotFound(new JsonObject { ["error"] = "Session not found" });
                var view = sessions.QuestionsView(hosted);
                view["sessionId"] = hosted.Id;
                return Results.Ok(JsonData.WebNode(view));
            }
        );
        app.MapPost(
            "/api/sessions/{id}/questions/{questionId}/answer",
            async (string id, string questionId, HttpRequest request) =>
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
                        ?? throw new InvalidDataException("Answer must be an object.");
                }
                catch (JsonException)
                {
                    return Results.BadRequest(new JsonObject { ["error"] = "Invalid JSON" });
                }
                catch (InvalidDataException error)
                {
                    return Results.BadRequest(new JsonObject { ["error"] = error.Message });
                }
                try
                {
                    await sessions.AnswerQuestionAsync(hosted, questionId, body);
                }
                catch (KeyNotFoundException error)
                {
                    return Results.NotFound(new JsonObject { ["error"] = error.Message });
                }
                catch (QuestionNotOpenException error)
                {
                    return Results.Json(
                        new JsonObject
                        {
                            ["error"] = error.Message,
                            ["code"] = "QUESTION_NOT_OPEN",
                        },
                        statusCode: 409
                    );
                }
                catch (InvalidDataException error)
                {
                    return Results.BadRequest(new JsonObject { ["error"] = error.Message });
                }
                return Results.Accepted(
                    value: new JsonObject { ["accepted"] = true, ["questionId"] = questionId }
                );
            }
        );
    }
}
