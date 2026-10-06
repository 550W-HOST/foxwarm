using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Channels.WebUi;

internal sealed partial class WebUIChannel
{
    private void RegisterSetupRoutes(WebApplication app)
    {
        var configuration = sessions.Models.ConfigurationOwner;
        if (configuration is null)
            return;
        app.MapGet(
            "/api/setup/status",
            () =>
            {
                try
                {
                    var models = configuration.Diagnostics();
                    return Results.Ok(
                        new JsonObject
                        {
                            ["oobe"] = models["oobe"]!.DeepClone(),
                            ["models"] = models,
                            ["config"] = configuration.ConfigDiagnostics(),
                        }
                    );
                }
                catch (Exception error)
                {
                    return Results.Json(
                        new { error = configuration.SafeError(error) },
                        statusCode: 500
                    );
                }
            }
        );
        app.MapPost(
            "/api/setup/models",
            async (HttpRequest request) =>
            {
                JsonObject? input = null;
                try
                {
                    input =
                        await JsonNode.ParseAsync(request.Body) as JsonObject
                        ?? throw new InvalidDataException("Models setup input must be an object.");
                    await configuration.SaveAsync(input);
                    return Results.Ok(
                        new JsonObject
                        {
                            ["success"] = true,
                            ["models"] = configuration.Diagnostics(),
                            ["payload"] = WebUiContract.Models(sessions.Models),
                        }
                    );
                }
                catch (Exception error)
                    when (error
                            is JsonException
                                or InvalidDataException
                                or InvalidOperationException
                                or IOException
                    )
                {
                    return Results.BadRequest(
                        new { error = configuration.SafeError(error, input) }
                    );
                }
            }
        );
        app.MapPost(
            "/api/setup/models/list",
            async (HttpRequest request, CancellationToken cancellationToken) =>
            {
                JsonObject? input = null;
                try
                {
                    input =
                        await JsonNode.ParseAsync(request.Body) as JsonObject
                        ?? throw new InvalidDataException("Provider connection must be an object.");
                    var models = await sessions.ListSetupProviderModelsAsync(
                        input,
                        cancellationToken
                    );
                    return Results.Ok(
                        new JsonObject
                        {
                            ["models"] = new JsonArray(
                                models.Select(value => (JsonNode?)JsonValue.Create(value)).ToArray()
                            ),
                        }
                    );
                }
                catch (SetupProviderRequestException error)
                {
                    return Results.Json(
                        new { error = error.Message },
                        statusCode: error.StatusCode
                    );
                }
                catch (JsonException error)
                {
                    return Results.BadRequest(new { error = error.Message });
                }
                catch (InvalidDataException error)
                {
                    return Results.BadRequest(new { error = error.Message });
                }
            }
        );
        app.MapPost(
            "/api/setup/models/test",
            async (HttpRequest request, CancellationToken cancellationToken) =>
            {
                JsonObject? input = null;
                try
                {
                    input =
                        await JsonNode.ParseAsync(request.Body) as JsonObject
                        ?? throw new InvalidDataException(
                            "Setup model test input must be an object."
                        );
                    var result = await sessions.TestSetupProviderAsync(input, cancellationToken);
                    return Results.Ok(
                        new JsonObject
                        {
                            ["success"] = true,
                            ["text"] = result.AssistantMessage?["parts"] is JsonArray parts
                                ? string.Join(
                                    "",
                                    parts
                                        .OfType<JsonObject>()
                                        .Select(part =>
                                            Sessions.SessionWait.Text(part["text"]) ?? ""
                                        )
                                )
                                : "",
                            ["usage"] =
                                result.Usage?.DeepClone()
                                ?? (
                                    (result.AssistantMessage?["__meta"] as JsonObject)?[
                                        "usage"
                                    ]?.DeepClone()
                                ),
                        }
                    );
                }
                catch (SetupProviderRequestException error)
                {
                    return Results.BadRequest(
                        new { success = false, error = SetupProviderRequests.SafeError(error) }
                    );
                }
                catch (Exception error)
                {
                    return Results.BadRequest(
                        new { success = false, error = SetupProviderRequests.SafeError(error) }
                    );
                }
            }
        );
    }
}
