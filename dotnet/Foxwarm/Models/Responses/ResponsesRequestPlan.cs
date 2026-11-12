using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Models;

internal static class ResponsesRequestPlan
{
    internal static JsonObject Build(
        IReadOnlyList<JsonObject> history,
        ResponsesClientOptions options
    )
    {
        if (options.ImageGenerationOnly)
            return ImageGenerationRequests.Build(history, options);
        var body = ResponsesRequestSerializer.BuildRequestWithImages(
            history,
            options.RequestModel,
            options.ConcreteModelId,
            options.Instructions,
            options.MaxOutputTokens,
            options.Tools,
            options.Effort,
            options.Images,
            options.HistoryCompatibility
        );
        var hostedTools = body["tools"] as JsonArray ?? new JsonArray();
        if (HostedResponsesTools.BuildWebSearchTool(options.WebSearch) is JsonObject search)
        {
            hostedTools.Add(search);
            body["tool_choice"] = SessionWait.Text(options.WebSearch?["toolChoice"]) ?? "auto";
        }
        if (ImageTool(options.ImageGeneration) is { } image)
            hostedTools.Add(image);
        body["tools"] = hostedTools;
        if (options.ProviderPromptCacheKey is not null)
            body["prompt_cache_key"] = options.ProviderPromptCacheKey;
        if (options.ExtraFields is not null)
            foreach (var (key, value) in options.ExtraFields)
                body[key] = value?.DeepClone();
        if (options.Effort is string effort)
        {
            var reasoning = body["reasoning"] as JsonObject ?? new JsonObject();
            reasoning["effort"] = effort;
            var include = body["include"] as JsonArray ?? new JsonArray();
            if (effort == "none")
            {
                reasoning.Remove("summary");
                var filtered = new JsonArray(
                    include
                        .Where(value => SessionWait.Text(value) != "reasoning.encrypted_content")
                        .Select(value => value?.DeepClone())
                        .ToArray()
                );
                if (filtered.Count > 0)
                    body["include"] = filtered;
                else
                    body.Remove("include");
            }
            else
            {
                if (!reasoning.ContainsKey("summary"))
                    reasoning["summary"] = "auto";
                if (!include.Any(value => SessionWait.Text(value) == "reasoning.encrypted_content"))
                    include.Add((System.Text.Json.Nodes.JsonNode?)("reasoning.encrypted_content"));
                body["include"] = include.DeepClone();
            }
            body["reasoning"] = reasoning.DeepClone();
        }
        // Inspect the final declarations, after extraFields and effort precedence.
        if (
            (body["tools"] as JsonArray ?? [])
                .OfType<JsonObject>()
                .Any(tool => SessionWait.Text(tool["type"]) is "web_search" or "web_search_preview")
        )
        {
            var include = body["include"] as JsonArray ?? new JsonArray();
            if (!include.Any(value => SessionWait.Text(value) == HostedSearchSources.Include))
                include.Add((System.Text.Json.Nodes.JsonNode?)(HostedSearchSources.Include));
            body["include"] = include.DeepClone();
        }
        return body;
    }

    internal static JsonObject? ImageTool(JsonObject? configuration)
    {
        if (configuration?["enabled"]?.GetValue<bool>() != true)
            return null;
        var image = new JsonObject { ["type"] = "image_generation", ["partial_images"] = 0 };
        foreach (
            var key in new[]
            {
                "model",
                "action",
                "size",
                "quality",
                "background",
                "outputFormat",
                "outputCompression",
            }
        )
            if (configuration[key] is JsonNode value)
                image[
                    key switch
                    {
                        "outputFormat" => "output_format",
                        "outputCompression" => "output_compression",
                        _ => key,
                    }
                ] = value.DeepClone();
        return image;
    }
}
