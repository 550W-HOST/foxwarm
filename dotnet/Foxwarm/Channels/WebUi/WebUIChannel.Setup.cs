using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;

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
                    var claudeUnavailable = Sessions
                        .ClaudeRuntimeConfiguration.Capture(configuration.AppConfiguration)
                        .UnavailableReason(sessions);
                    return Results.Ok(
                        new JsonObject
                        {
                            ["oobe"] = models["oobe"]!.DeepClone(),
                            ["models"] = models,
                            ["config"] = configuration.ConfigDiagnostics(),
                            ["channels"] = configuration.ChannelDiagnostics(webUiRunning: true),
                            ["capabilities"] = new JsonObject
                            {
                                ["historySearch"] = new JsonObject
                                {
                                    ["available"] =
                                        sessions.Vector.Configuration.Enabled
                                        && sessions.Vector.Ready,
                                    ["reason"] =
                                        !sessions.Vector.Configuration.Enabled
                                            ? "Conversation search is not enabled on this server."
                                        : !sessions.Vector.Ready
                                            ? "Conversation search is temporarily unavailable."
                                        : null,
                                },
                                ["claudeCode"] = new JsonObject
                                {
                                    ["available"] = claudeUnavailable is null,
                                    ["reason"] = claudeUnavailable,
                                },
                                ["managedChannels"] = configuration.ManagedChannels is not null,
                                ["externalChannelMessage"] =
                                    "External channels are not running in this host.",
                            },
                        }
                    );
                }
                catch (Exception error)
                {
                    return Results.Json(
                        new JsonObject { ["error"] = configuration.SafeError(error) },
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
                    installation["channelCount"] = ConfigurationYaml.Parse(raw, "app config")[
                        "channels"
                    ]
                        is JsonObject channels
                        ? channels.Count
                        : 0;
                    installation["reload"] ??= new JsonObject
                    {
                        ["started"] = new JsonArray(),
                        ["stopped"] = new JsonArray(),
                        ["statuses"] = configuration.ChannelDiagnostics(webUiRunning: true),
                        ["available"] = false,
                        ["message"] = "External chat channels are unavailable on this server.",
                    };
                    return Results.Ok(JsonData.WebNode(installation));
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
                        new JsonObject { ["error"] = configuration.SafeAppError(error) }
                    );
                }
            }
        );
        RegisterWeixinSetupRoutes(app, configuration);
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
                    // The client locale only selects the first-run welcome language.
                    var locale = input.Remove("locale", out var localeNode)
                        ? SessionWait.Text(localeNode)
                        : null;
                    var firstRun = !File.Exists(configuration.ActivePath);
                    var installation = await configuration.SaveAsync(input);
                    installation["success"] = true;
                    installation["models"] = configuration.Diagnostics();
                    installation["payload"] = WebUiContract.Models(sessions.Models);
                    if (firstRun)
                        installation["firstSessionId"] = await EnsureFirstRunSessionAsync(
                            locale,
                            request.Headers.AcceptLanguage.ToString()
                        );
                    return Results.Ok(JsonData.WebNode(installation));
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
                        new JsonObject { ["error"] = configuration.SafeError(error, input) }
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
                                models.Select(model => (JsonNode?)model.ToJson()).ToArray()
                            ),
                        }
                    );
                }
                catch (SetupProviderRequestException error)
                {
                    return Results.Json(
                        new JsonObject { ["error"] = error.Message },
                        statusCode: error.StatusCode
                    );
                }
                catch (JsonException error)
                {
                    return Results.BadRequest(new JsonObject { ["error"] = error.Message });
                }
                catch (InvalidDataException error)
                {
                    return Results.BadRequest(new JsonObject { ["error"] = error.Message });
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
                        new JsonObject { ["success"] = false, ["error"] = error.Message }
                    );
                }
                catch (JsonException error)
                {
                    return Results.BadRequest(
                        new JsonObject { ["success"] = false, ["error"] = error.Message }
                    );
                }
                catch (InvalidDataException error)
                {
                    return Results.BadRequest(
                        new JsonObject { ["success"] = false, ["error"] = error.Message }
                    );
                }
                catch (Exception)
                {
                    return Results.BadRequest(
                        new JsonObject
                        {
                            ["success"] = false,
                            ["error"] = "Configured model request failed.",
                        }
                    );
                }
            }
        );
    }

    // A model configuration is already installed; a failed welcome must not report the
    // save as failed. The installation keeps working without the default Session.
    private async Task<string?> EnsureFirstRunSessionAsync(string? locale, string? acceptLanguage)
    {
        try
        {
            return await sessions.EnsureFirstRunSessionAsync(
                FirstRunWelcome.Language(locale, acceptLanguage)
            );
        }
        catch (Exception error)
        {
            MainLog.Diagnostic(
                "First-run default Session was not created: " + MainLog.SafeFailure(error),
                failure: true
            );
            return null;
        }
    }
}
