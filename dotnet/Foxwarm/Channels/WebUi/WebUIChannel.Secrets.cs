using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Secrets;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Channels.WebUi;

// Setup > Secrets. Values are write-only: no response contains a stored value.
internal sealed partial class WebUIChannel
{
    private void RegisterSecretRoutes(WebApplication app, ModelConfiguration configuration)
    {
        var secrets = configuration.Secrets;
        app.MapGet("/api/setup/secrets", () => SecretRoute(() => SecretStatus(configuration)));
        app.MapPut(
            "/api/setup/secrets/{name}",
            async (string name, HttpRequest request) =>
            {
                JsonObject input;
                try
                {
                    input =
                        await JsonNode.ParseAsync(request.Body) as JsonObject
                        ?? throw new InvalidDataException("Secret input must be an object.");
                }
                catch (JsonException)
                {
                    return Results.BadRequest(
                        new JsonObject { ["error"] = "Secret input must be JSON." }
                    );
                }
                return await SecretRouteAsync(async () =>
                {
                    ToolRegistry.Keys(input, ["value", "description"]);
                    var value = input["value"] is null ? null : TextField(input, "value");
                    var description = input["description"] is null
                        ? null
                        : TextField(input, "description");
                    SecretMetadata metadata;
                    if (value is not null)
                        metadata = secrets.Store.Set(name, value, description);
                    else if (description is not null)
                        metadata = secrets.Store.Describe(name, description);
                    else
                        throw new InvalidDataException("Enter a value or a description.");
                    var result = new JsonObject { ["secret"] = Metadata(metadata, []) };
                    if (value is not null)
                    {
                        if (!metadata.Redactable)
                            result["warning"] =
                                $"Values shorter than {SecretStore.MinimumRedactableLength} characters cannot be hidden from tool output and model requests.";
                        result["restartedChannels"] = await RestartChannelsAsync(
                            configuration,
                            name
                        );
                    }
                    return result;
                });
            }
        );
        app.MapDelete(
            "/api/setup/secrets/{name}",
            (string name) =>
                SecretRouteAsync(async () =>
                {
                    secrets.Store.Delete(name);
                    return new JsonObject
                    {
                        ["deleted"] = name,
                        ["restartedChannels"] = await RestartChannelsAsync(configuration, name),
                    };
                })
        );
        app.MapPost(
            "/api/setup/secrets/{name}/forget-retired",
            (string name) =>
                SecretRoute(() =>
                {
                    secrets.Store.ForgetRetired(name);
                    return new JsonObject { ["forgotten"] = name };
                })
        );
        app.MapPost(
            "/api/setup/secrets/exposures/clear",
            async (HttpRequest request) =>
            {
                JsonObject input;
                try
                {
                    input =
                        await JsonNode.ParseAsync(request.Body) as JsonObject
                        ?? throw new InvalidDataException("Input must be an object.");
                }
                catch (JsonException)
                {
                    return Results.BadRequest(new JsonObject { ["error"] = "Input must be JSON." });
                }
                return SecretRoute(() =>
                {
                    ToolRegistry.Keys(input, ["label"]);
                    secrets.Exposures.Clear(TextField(input, "label"));
                    return new JsonObject { ["cleared"] = true };
                });
            }
        );
    }

    private JsonObject SecretStatus(ModelConfiguration configuration)
    {
        var secrets = configuration.Secrets;
        var usages = configuration.SecretUsages(sessions.OutboundMcp.Configuration.Snapshot());
        var lockError = secrets.LockError;
        IReadOnlyList<SecretMetadata> listed;
        try
        {
            listed = secrets.Store.List();
        }
        catch (SecretStoreLockedException error)
        {
            lockError ??= error;
            listed = [];
        }
        var defined = new HashSet<string>(
            listed.Where(item => item.IsSet).Select(item => item.Name)
        );
        return new JsonObject
        {
            ["locked"] = lockError is not null,
            ["lockMessage"] = lockError is null ? null : MainLog.SafeFailure(lockError),
            ["keyFile"] = secrets.KeyPath,
            ["minimumRedactableLength"] = SecretStore.MinimumRedactableLength,
            ["retiredRetentionDays"] = (int)SecretStore.RetiredRetention.TotalDays,
            ["secrets"] = new JsonArray(
                listed
                    .Select(item =>
                        (JsonNode)Metadata(
                            item,
                            usages.TryGetValue(item.Name, out var used) ? used : []
                        )
                    )
                    .ToArray()
            ),
            ["missing"] = new JsonArray(
                usages
                    .Where(pair => !defined.Contains(pair.Key))
                    .OrderBy(pair => pair.Key, StringComparer.Ordinal)
                    .Select(pair =>
                        (JsonNode)
                            new JsonObject
                            {
                                ["name"] = pair.Key,
                                ["usages"] = new JsonArray(
                                    pair.Value.Select(item => item.DeepClone()).ToArray()
                                ),
                            }
                    )
                    .ToArray()
            ),
            ["exposures"] = new JsonArray(
                secrets
                    .Exposures.List()
                    .Select(item =>
                        (JsonNode)
                            new JsonObject
                            {
                                ["label"] = item.Label,
                                ["count"] = item.Count,
                                ["firstSeenAt"] = item.FirstSeenAt,
                                ["lastSeenAt"] = item.LastSeenAt,
                                ["lastSource"] = item.LastSource,
                                ["lastSessionId"] = item.LastSessionId,
                            }
                    )
                    .ToArray()
            ),
        };
    }

    private static JsonObject Metadata(SecretMetadata item, IReadOnlyList<JsonObject> usages) =>
        new()
        {
            ["name"] = item.Name,
            ["description"] = item.Description,
            ["isSet"] = item.IsSet,
            ["redactable"] = item.Redactable,
            ["createdAt"] = item.CreatedAt,
            ["updatedAt"] = item.UpdatedAt,
            ["setAt"] = item.SetAt,
            ["retiredVersions"] = item.RetiredVersions,
            ["retainedUntil"] = item.RetainedUntil,
            ["usages"] = new JsonArray(usages.Select(usage => usage.DeepClone()).ToArray()),
        };

    private static string TextField(JsonObject input, string key) =>
        input[key] is JsonValue value && value.TryGetValue<string>(out var text)
            ? text
            : throw new InvalidDataException($"Secret {key} must be a string.");

    private static async Task<JsonArray> RestartChannelsAsync(
        ModelConfiguration configuration,
        string name
    ) =>
        configuration.ManagedChannels is { } channels
            ? new JsonArray(
                (await channels.RestartReferencingAsync(name)).Select(id => (JsonNode)id).ToArray()
            )
            : [];

    private static IResult SecretRoute(Func<JsonObject> action)
    {
        try
        {
            return Results.Ok(action());
        }
        catch (Exception error) when (SecretFailure(error) is { } failure)
        {
            return failure;
        }
    }

    private static async Task<IResult> SecretRouteAsync(Func<Task<JsonObject>> action)
    {
        try
        {
            return Results.Ok(await action());
        }
        catch (Exception error) when (SecretFailure(error) is { } failure)
        {
            return failure;
        }
    }

    // Store and validation messages name secrets but never contain values.
    private static IResult? SecretFailure(Exception error) =>
        error switch
        {
            KeyNotFoundException => Results.NotFound(new JsonObject { ["error"] = error.Message }),
            SecretStoreLockedException => Results.Json(
                new JsonObject { ["error"] = error.Message },
                statusCode: 409
            ),
            InvalidDataException or InvalidOperationException => Results.BadRequest(
                new JsonObject { ["error"] = error.Message }
            ),
            IOException => Results.Json(
                new JsonObject { ["error"] = "The secret store could not be saved." },
                statusCode: 500
            ),
            _ => null,
        };
}
