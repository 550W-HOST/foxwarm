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
                            ["channels"] = configuration.ChannelDiagnostics(webUiRunning: true),
                            ["capabilities"] = new JsonObject
                            {
                                ["managedChannels"] = false,
                                ["externalChannelMessage"] =
                                    "External chat channels are unavailable on this server.",
                            },
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
            "/api/setup/config",
            async (HttpRequest request) =>
            {
                try
                {
                    var input =
                        await JsonNode.ParseAsync(request.Body) as JsonObject
                        ?? throw new InvalidDataException("Setup config input must be an object.");
                    var raw =
                        input["yaml"] is JsonValue yaml && yaml.TryGetValue<string>(out var text)
                            ? text
                            : throw new InvalidDataException("Setup config yaml must be a string.");
                    var installation = await configuration.SaveAppAsync(raw);
                    installation["success"] = true;
                    installation["configPath"] = configuration.AppPath;
                    installation["rawYaml"] = raw;
                    installation["channelCount"] = ConfigurationYaml.Parse(raw, "app config")["channels"]
                        is JsonObject channels
                        ? channels.Count
                        : 0;
                    installation["reload"] = new JsonObject
                    {
                        ["started"] = new JsonArray(),
                        ["stopped"] = new JsonArray(),
                        ["statuses"] = configuration.ChannelDiagnostics(webUiRunning: true),
                        ["available"] = false,
                        ["message"] = "External chat channels are unavailable on this server.",
                    };
                    return Results.Ok(installation);
                }
                catch (Exception error)
                    when (error
                            is JsonException
                                or InvalidDataException
                                or InvalidOperationException
                                or IOException
                    )
                {
                    return Results.BadRequest(new { error = configuration.SafeAppError(error) });
                }
            }
        );
        app.MapPost(
            "/api/setup/channels",
            async (HttpRequest request) =>
            {
                try
                {
                    var input =
                        await JsonNode.ParseAsync(request.Body) as JsonObject
                        ?? throw new InvalidDataException(
                            "Setup channels input must be an object."
                        );
                    JsonObject channels;
                    if (input["channels"] is JsonObject objectValue)
                        channels = objectValue;
                    else if (
                        input["yaml"] is JsonValue yaml
                        && yaml.TryGetValue<string>(out var raw)
                    )
                    {
                        var parsed = ConfigurationYaml.Parse(raw, "channels config");
                        channels = parsed["channels"] as JsonObject ?? parsed;
                    }
                    else
                        throw new InvalidDataException(
                            "Setup channels must contain a channels object or YAML."
                        );
                    var installation = await configuration.SaveChannelsAsync(channels);
                    installation["success"] = true;
                    installation["configPath"] = configuration.AppPath;
                    installation["channelsYaml"] = ModelConfiguration.ChannelsYamlForObject(channels);
                    installation["channelCount"] = channels.Count;
                    installation["reload"] = new JsonObject
                    {
                        ["started"] = new JsonArray(),
                        ["stopped"] = new JsonArray(),
                        ["statuses"] = configuration.ChannelDiagnostics(webUiRunning: true),
                        ["available"] = false,
                        ["message"] = "External chat channels are unavailable on this server.",
                    };
                    return Results.Ok(installation);
                }
                catch (Exception error)
                    when (error
                            is JsonException
                                or InvalidDataException
                                or InvalidOperationException
                                or IOException
                    )
                {
                    return Results.BadRequest(new { error = configuration.SafeAppError(error) });
                }
            }
        );
        app.MapPost(
            "/api/setup/weixin/login/start",
            () =>
                Results.Json(
                    new { error = "Weixin login is unavailable on this server." },
                    statusCode: StatusCodes.Status501NotImplemented
                )
        );
        app.MapPost(
            "/api/setup/weixin/login/wait",
            () =>
                Results.Json(
                    new { error = "Weixin login is unavailable on this server." },
                    statusCode: StatusCodes.Status501NotImplemented
                )
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
                    var installation = await configuration.SaveAsync(input);
                    installation["success"] = true;
                    installation["models"] = configuration.Diagnostics();
                    installation["payload"] = WebUiContract.Models(sessions.Models);
                    return Results.Ok(installation);
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
                    return Results.BadRequest(new { success = false, error = error.Message });
                }
                catch (JsonException error)
                {
                    return Results.BadRequest(new { success = false, error = error.Message });
                }
                catch (InvalidDataException error)
                {
                    return Results.BadRequest(new { success = false, error = error.Message });
                }
                catch (Exception)
                {
                    return Results.BadRequest(
                        new { success = false, error = "Configured model request failed." }
                    );
                }
            }
        );
    }
}
