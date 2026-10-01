using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal static class ConfiguredOpenAI
{
    internal static ResponsesClientOptions Plan(ConcreteHostModel model, ResponsesClientOptions defaults,
        string effort, string instructions, string cacheKey, string turnId)
    {
        if (model.ProviderType is not ("openai" or "openai-responses" or "openai-completions")) throw new InvalidDataException("Selected model executor is not implemented: " + model.ProviderType + ".");
        var completions = model.ProviderType == "openai-completions";
        if (model.Configuration["imageGeneration"]?["enabled"] is JsonValue image && image.TryGetValue<bool>(out var generate) && generate)
            throw new InvalidDataException("Selected model enables unimplemented image generation.");
        if (!completions)
        {
            if (model.Configuration["webSearch"]?["enabled"] is JsonValue web && web.TryGetValue<bool>(out var search) && search) throw new InvalidDataException("Selected model enables unimplemented Responses web search.");
            if (model.Configuration["keepReasoningOnError"] is JsonValue keep && keep.TryGetValue<bool>(out var recovery) && recovery) throw new InvalidDataException("Responses keepReasoningOnError recovery is not implemented.");
            var extra = model.Configuration["extraFields"] as JsonObject;
            if (extra?["tools"] is JsonArray tools && tools.OfType<JsonObject>().Any(tool => SessionWait.Text(tool["type"]) == "image_generation")) throw new InvalidDataException("extraFields.tools must not declare image_generation; use the imageGeneration config field.");
            if (extra?["tool_choice"] is JsonObject choice && SessionWait.Text(choice["type"]) == "image_generation") throw new InvalidDataException("extraFields.tool_choice requires an enabled imageGeneration tool.");
        }
        var compression = SessionWait.Text(model.Configuration["requestCompression"]);
        if (compression is not null && compression is not ("gzip" or "br")) throw new InvalidDataException("Unsupported OpenAI requestCompression.");
        JsonNode? Expand(JsonNode? node)
        {
            if (node is JsonValue value && value.TryGetValue<string>(out var text)) return JsonValue.Create(text.Replace("${SESSION_CACHE_KEY}", cacheKey, StringComparison.Ordinal).Replace("${TURN_ID}", turnId, StringComparison.Ordinal));
            if (node is JsonArray array) return new JsonArray(array.Select(Expand).ToArray());
            if (node is JsonObject obj) { var result = new JsonObject(); foreach (var (key, child) in obj) result[key] = Expand(child); return result; }
            return node?.DeepClone();
        }
        return defaults with
        {
            BaseUri = model.BaseUri, RequestModel = model.ModelId, ConcreteModelId = model.Key, Token = model.Token,
            Effort = effort, Instructions = instructions,
            ExtraHeaders = Expand(model.Configuration["extraHeaders"]) as JsonObject,
            ExtraFields = Expand(model.Configuration["extraFields"]) as JsonObject,
            RequestCompression = compression,
            StreamInactivityTimeoutMs = HostModels.Positive(model.Configuration["streamContentInactivityTimeoutMs"], 60000, "streamContentInactivityTimeoutMs"),
            DisallowEmptyResponse = model.Configuration["disallowEmptyResponse"] is JsonValue flag && flag.TryGetValue<bool>(out var forbid) && forbid
        };
    }
    internal static IChatService CreateService(HttpClient http, ConcreteHostModel model, ResponsesClientOptions options,
        string cacheKey, Action<string, ResponsesStreamProgress>? progress = null)
    {
        IChatService service = model.ProviderType == "openai-completions"
            ? new CompletionsChatService(http, options, SessionWait.Text(model.Configuration["historyReasoningField"]) ?? "reasoning_content", cacheKey, progress)
            : new ResponsesChatService(http, options, progress);
        return new ConcreteRequestHistory.ChatService(service, model.Key);
    }

    internal static string SafeError(Exception error, ConcreteHostModel model)
    {
        var message = error is InvalidDataException or UnsupportedResponsesFeatureException ? error.Message : "Configured model request failed.";
        var secrets = new[] { model.Token }.Concat((model.Configuration["extraHeaders"] as JsonObject ?? new JsonObject()).Select(pair => SessionWait.Text(pair.Value) ?? ""));
        return secrets.Any(secret => secret.Length > 0 && message.Contains(secret, StringComparison.Ordinal)) ? "Configured model request failed." : message;
    }
}
