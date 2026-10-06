using System.Text.Json;
using System.Text.Json.Nodes;

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
            () =>
                Results.Json(
                    new { error = "Provider model discovery is not implemented." },
                    statusCode: 501
                )
        );
        app.MapPost(
            "/api/setup/models/test",
            () =>
                Results.Json(
                    new { error = "Setup provider testing is not implemented." },
                    statusCode: 501
                )
        );
    }
}
