using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal static class ConfiguredModelRequests
{
    internal static ResponsesClientOptions Plan(
        ConcreteHostModel model,
        ResponsesClientOptions defaults,
        string effort,
        string instructions,
        string cacheKey,
        string turnId,
        string purpose = "normal-turn"
    )
    {
        if (model.IsVirtual)
            throw new InvalidDataException(
                "Selected model executor is not implemented: " + model.ProviderType + "."
            );
        if (!SetupProviderRequests.IsSupportedProviderType(model.ProviderType))
            throw new InvalidDataException("Unsupported providerType: " + model.ProviderType + ".");
        var responses = model.ProviderType is "openai" or "openai-responses" or "openai-ws";
        var imageEnabled =
            model.Configuration["imageGeneration"]?["enabled"] is JsonValue image
            && image.TryGetValue<bool>(out var generate)
            && generate;
        if (imageEnabled && !responses)
            throw new InvalidDataException(
                "Image generation requires the OpenAI Responses protocol."
            );
        var featurePurpose = purpose is "compact-plan" or "background" or "setup-test";
        var imageDeclared = imageEnabled && !featurePurpose;
        if (responses)
        {
            if (
                model.Configuration["keepReasoningOnError"] is JsonValue keep
                && keep.TryGetValue<bool>(out var recovery)
                && recovery
            )
                throw new InvalidDataException(
                    "Responses keepReasoningOnError recovery is not implemented."
                );
            var extra = model.Configuration["extraFields"] as JsonObject;
            if (imageDeclared && extra?["tools"] is JsonArray)
                throw new InvalidDataException(
                    "imageGeneration cannot replace extraFields.tools; configure hosted tools with imageGeneration."
                );
            if (
                extra?["tools"] is JsonArray tools
                && tools
                    .OfType<JsonObject>()
                    .Any(tool => SessionWait.Text(tool["type"]) == "image_generation")
            )
                throw new InvalidDataException(
                    "extraFields.tools must not declare image_generation; use the imageGeneration config field."
                );
            if (
                extra?["tool_choice"] is JsonObject choice
                && !imageDeclared
                && SessionWait.Text(choice["type"]) == "image_generation"
            )
                throw new InvalidDataException(
                    "extraFields.tool_choice requires an enabled imageGeneration tool."
                );
        }
        var compression = SessionWait.Text(model.Configuration["requestCompression"]);
        if (compression is not null && compression is not ("gzip" or "br"))
            throw new InvalidDataException("Unsupported provider requestCompression.");
        JsonNode? Expand(JsonNode? node)
        {
            if (node is JsonValue value && value.TryGetValue<string>(out var text))
                return JsonValue.Create(
                    text.Replace("${SESSION_CACHE_KEY}", cacheKey, StringComparison.Ordinal)
                        .Replace("${TURN_ID}", turnId, StringComparison.Ordinal)
                );
            if (node is JsonArray array)
                return new JsonArray(array.Select(Expand).ToArray());
            if (node is JsonObject obj)
            {
                var result = new JsonObject();
                foreach (var (key, child) in obj)
                    result[key] = Expand(child);
                return result;
            }
            return node?.DeepClone();
        }
        return defaults with
        {
            BaseUri = model.BaseUri,
            RequestModel = model.ModelId,
            MaxOutputTokens = model.MaxOutput,
            ConcreteModelId = model.Key,
            Token = model.Token,
            Effort = effort,
            Instructions = instructions,
            ProviderPromptCacheKey = model.ProviderType == "openai-ws" ? cacheKey : null,
            ExtraHeaders = Expand(model.Configuration["extraHeaders"]) as JsonObject,
            ExtraFields = Expand(model.Configuration["extraFields"]) as JsonObject,
            RequestCompression = compression,
            StreamInactivityTimeoutMs = HostModels.Positive(
                model.Configuration["streamContentInactivityTimeoutMs"],
                60000,
                "streamContentInactivityTimeoutMs"
            ),
            DisallowEmptyResponse =
                model.Configuration["disallowEmptyResponse"] is JsonValue flag
                && flag.TryGetValue<bool>(out var forbid)
                && forbid,
            WebSearch = featurePurpose ? null : model.Configuration["webSearch"] as JsonObject,
            ImageGeneration = featurePurpose
                ? null
                : model.Configuration["imageGeneration"] as JsonObject,
        };
    }

    internal static IChatService CreateService(
        HttpClient http,
        ConcreteHostModel model,
        ResponsesClientOptions options,
        string cacheKey,
        Action<string, ResponsesStreamProgress>? progress = null
    )
    {
        return new ConcreteRequestHistory.ChatService(
            CreatePreparedService(http, model, options, cacheKey, progress),
            model.Key
        );
    }

    internal static IChatService CreatePreparedService(
        HttpClient http,
        ConcreteHostModel model,
        ResponsesClientOptions options,
        string cacheKey,
        Action<string, ResponsesStreamProgress>? progress = null,
        ResponsesWsTransport? websockets = null,
        ModelRequestScope scope = ModelRequestScope.LowLevel
    )
    {
        IChatService service =
            model.ProviderType == "openai-ws"
                ? new ResponsesWsChatService(
                    options,
                    websockets ?? new ResponsesWsTransport(),
                    scope,
                    websockets is null,
                    cacheKey,
                    progress
                )
            : model.ProviderType == "openai-completions"
                ? new CompletionsChatService(
                    http,
                    options,
                    SessionWait.Text(model.Configuration["historyReasoningField"])
                        ?? "reasoning_content",
                    cacheKey,
                    progress
                )
            : model.ProviderType is "openai" or "openai-responses"
                ? new ResponsesChatService(http, options, progress)
            : model.ProviderType == "anthropic" ? new AnthropicMessagesService(http, options)
            : throw new InvalidDataException(
                "Unsupported providerType: " + model.ProviderType + "."
            );
        return service;
    }

    internal static string SafeError(Exception error, ConcreteHostModel model)
    {
        var message = error
            is InvalidDataException
                or UnsupportedResponsesFeatureException
                or ModelPreparationException
                or ModelRequestException
            ? error.Message
            : "Configured model request failed.";
        return SafeReason(message, model);
    }

    internal static string SafeReason(string message, ConcreteHostModel model)
    {
        var secrets = new[] { model.Token }.Concat(
            (model.Configuration["extraHeaders"] as JsonObject ?? new JsonObject()).Select(pair =>
                SessionWait.Text(pair.Value) ?? ""
            )
        );
        return secrets.Any(secret =>
            secret.Length > 0 && message.Contains(secret, StringComparison.Ordinal)
        )
            ? "Configured model request failed."
            : message;
    }
}
