using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal async Task<string[]> ListSetupProviderModelsAsync(
        JsonObject input,
        CancellationToken cancellationToken
    )
    {
        var connection = SetupProviderRequests.ParseListRequest(input);
        var providerType = HostModels.Text(connection, "providerType")!;
        if (!SetupProviderRequests.IsSupportedProviderType(providerType))
            throw new SetupProviderRequestException(
                "unsupported-provider",
                "Model listing is not supported for this provider type.",
                400
            );
        var provider = (JsonObject)connection.DeepClone();
        provider["models"] = new JsonArray("__provider_model_list__");
        var model = SetupProviderRequests.ResolveTransientModel(
            provider,
            models.ConfigurationOwner?.AppConfiguration ?? new JsonObject(),
            "provider-model-list",
            "__provider_model_list__"
        );
        return await SetupProviderRequests.ListAsync(http, model, cancellationToken);
    }

    internal async Task<ChatResult> TestSetupProviderAsync(
        JsonObject input,
        CancellationToken cancellationToken
    )
    {
        var providerKey = TextOrDefault(input["providerKey"] ?? input["provider"], "openai");
        var providerType = TextOrDefault(input["providerType"], "openai-completions");
        var baseUrl = TextOrDefault(input["baseUrl"], "");
        var apiKey = TextOrDefault(input["apiKey"], "");
        var rawModels = TextOrDefault(input["models"] ?? input["model"], "");
        var modelIds = rawModels
            .Split(
                [',', '\n'],
                StringSplitOptions.RemoveEmptyEntries | StringSplitOptions.TrimEntries
            )
            .Where(value => value.Length > 0)
            .ToArray();
        if (modelIds.Length == 0)
            throw new InvalidDataException("At least one model id is required.");
        var testModel = TextOrDefault(input["testModel"], modelIds[0]);
        var provider = new JsonObject
        {
            ["providerType"] = providerType,
            ["baseUrl"] = baseUrl,
            ["apiKey"] = apiKey,
            ["models"] = new JsonArray((JsonNode?)JsonValue.Create(testModel)),
        };
        if (input["extraHeaders"] is not null)
            provider["extraHeaders"] = input["extraHeaders"]!.DeepClone();
        var model = SetupProviderRequests.ResolveTransientModel(
            provider,
            models.ConfigurationOwner?.AppConfiguration ?? new JsonObject(),
            providerKey,
            testModel
        );
        var options = ConfiguredModelRequests.Plan(
            model,
            clientOptions,
            model.DefaultEffort ?? "high",
            "",
            "setup-model-test",
            "setup-model-test"
        );
        using var timeout = CancellationTokenSource.CreateLinkedTokenSource(cancellationToken);
        timeout.CancelAfter(TimeSpan.FromSeconds(30));
        var service = ConfiguredModelRequests.CreatePreparedService(
            http,
            model,
            options,
            "setup-model-test",
            scope: ModelRequestScope.LowLevel
        );
        try
        {
            return await service.ChatAsync(
                "setup-model-test",
                [
                    new JsonObject
                    {
                        ["role"] = "user",
                        ["parts"] = new JsonArray(new JsonObject { ["text"] = "Please reply ok" }),
                    },
                ],
                timeout.Token
            );
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            throw new SetupProviderRequestException(
                "timeout",
                "Configured model request timed out.",
                400
            );
        }
        catch (Exception error)
        {
            throw new SetupProviderRequestException(
                "request",
                ConfiguredModelRequests.SafeError(error, model),
                400
            );
        }

        static string TextOrDefault(JsonNode? node, string fallback)
        {
            if (node is not JsonValue value || !value.TryGetValue<string>(out var text))
                return fallback;
            var trimmed = text.Trim();
            return trimmed.Length == 0 ? fallback : trimmed;
        }
    }
}
