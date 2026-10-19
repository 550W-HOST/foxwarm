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
            "setup-model-test",
            "setup-test"
        );
        var setupHistory = new[]
        {
            new JsonObject
            {
                ["role"] = "user",
                ["parts"] = new JsonArray(new JsonObject { ["text"] = "Please reply ok" }),
            },
        };
        var requestId = await Journal.BeginRequestAsync(
            null,
            "setup-test",
            0,
            "",
            new JsonArray(),
            setupHistory,
            testModel,
            "setup-model-test",
            cancellationToken
        );
        var attemptStarted = false;
        options = options with
        {
            AttemptPrepared = async payload =>
            {
                await Journal.AppendAttemptStartAsync(
                    requestId,
                    1,
                    model.Key,
                    null,
                    model.ProviderType,
                    payload,
                    "",
                    cancellationToken
                );
                attemptStarted = true;
            },
        };
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
            var result = await service.ChatAsync("setup-model-test", setupHistory, timeout.Token);
            try
            {
                await Journal.AppendChatResultAsync(requestId, 1, result, timeout.Token);
            }
            catch (Exception journalError)
            {
                System.Diagnostics.Trace.TraceWarning(
                    "LLM journal setup result persistence failed: {0}",
                    journalError.Message
                );
            }
            return result;
        }
        catch (OperationCanceledException) when (cancellationToken.IsCancellationRequested)
        {
            if (attemptStarted)
                try
                {
                    await Journal.AppendAttemptResultAsync(
                        requestId,
                        1,
                        "abort",
                        null,
                        new JsonObject { ["kind"] = "abort", ["message"] = "Request cancelled." }
                    );
                }
                catch (Exception journalError)
                {
                    System.Diagnostics.Trace.TraceWarning(
                        "LLM journal setup cancellation persistence failed: {0}",
                        journalError.Message
                    );
                }
            throw;
        }
        catch (OperationCanceledException) when (!cancellationToken.IsCancellationRequested)
        {
            if (attemptStarted)
                try
                {
                    await Journal.AppendAttemptResultAsync(
                        requestId,
                        1,
                        "abort",
                        null,
                        new JsonObject
                        {
                            ["kind"] = "timeout",
                            ["message"] = "Configured model request timed out.",
                        }
                    );
                }
                catch (Exception journalError)
                {
                    System.Diagnostics.Trace.TraceWarning(
                        "LLM journal setup timeout persistence failed: {0}",
                        journalError.Message
                    );
                }
            throw new SetupProviderRequestException(
                "timeout",
                "Configured model request timed out.",
                400
            );
        }
        catch (Exception error)
        {
            if (attemptStarted)
                try
                {
                    await Journal.AppendAttemptResultAsync(
                        requestId,
                        1,
                        "failure",
                        null,
                        new JsonObject { ["kind"] = "request-error", ["message"] = error.Message }
                    );
                }
                catch (Exception journalError)
                {
                    System.Diagnostics.Trace.TraceWarning(
                        "LLM journal setup failure persistence failed: {0}",
                        journalError.Message
                    );
                }
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
