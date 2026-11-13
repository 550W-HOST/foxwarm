using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

// One policy for the separately owned image request, including its final wire shape.
internal static class ImageGenerationRequests
{
    internal const string Purpose = "image-generation";

    internal static bool UsesSeparateRequest(ConcreteHostModel model) =>
        !model.IsVirtual
        && model.ProviderType is "openai" or "openai-responses" or "openai-ws"
        && model.Configuration["imageGeneration"]?["enabled"]?.GetValue<bool>() == true
        && SessionWait.Text(model.Configuration["imageGeneration"]?["mode"])
            is "separate"
                or "isolated";

    internal static ResponsesClientOptions Prepare(ResponsesClientOptions options) =>
        options with
        {
            ImageGenerationOnly = true,
            Effort = null,
            Tools = new JsonArray(),
            WebSearch = null,
            ProviderPromptCacheKey = null,
        };

    internal static JsonObject Build(
        IReadOnlyList<JsonObject> history,
        ResponsesClientOptions options
    )
    {
        var image =
            ResponsesRequestPlan.ImageTool(options.ImageGeneration)
            ?? throw new InvalidDataException(
                "A separate image request requires image generation."
            );
        var body = ResponsesRequestSerializer.BuildRequestWithImages(
            history,
            options.RequestModel,
            options.ConcreteModelId,
            options.Instructions,
            options.MaxOutputTokens,
            new JsonArray(image),
            null,
            options.Images,
            options.HistoryCompatibility
        );
        // Provider extensions may tune transport/output options, not replace this request's
        // bounded input, image-only tools, or reasoning-free ownership contract.
        if (options.ExtraFields is not null)
            foreach (var (key, value) in options.ExtraFields)
                if (
                    key
                    is not (
                        "reasoning"
                        or "include"
                        or "previous_response_id"
                        or "prompt_cache_key"
                        or "tools"
                        or "tool_choice"
                        or "parallel_tool_calls"
                        or "input"
                        or "instructions"
                        or "model"
                        or "conversation"
                    )
                )
                    body[key] = value?.DeepClone();
        body["tool_choice"] = new JsonObject { ["type"] = "image_generation" };
        body["parallel_tool_calls"] = false;
        return body;
    }

    internal static Task<ChatResult> RequestAsync(
        ModelRequestOwner requests,
        HostModels catalog,
        ConcreteHostModel model,
        string sessionId,
        string turnId,
        JsonArray inputParts,
        Action<Exception> warning,
        CancellationToken token
    )
    {
        if (!UsesSeparateRequest(model))
            throw new InvalidDataException(
                "Separate image generation is not enabled for the selected model."
            );
        return requests.RequestAsync(
            sessionId,
            requests.Capture(catalog, model.Key, null),
            "image-" + Guid.NewGuid().ToString("N"),
            turnId,
            [new JsonObject { ["role"] = "user", ["parts"] = inputParts }],
            (_, _) =>
                Task.FromResult(
                    "Generate or edit the requested image. Use the image generation tool and return the image. Follow the user's visual requirements."
                ),
            null,
            null,
            null,
            warning,
            token,
            ModelRequestScope.LowLevel,
            () => new JsonArray(),
            null,
            Purpose,
            0,
            maxAttempts: 1
        );
    }
}
