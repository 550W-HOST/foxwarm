using System.Text.Json.Nodes;
using Foxwarm.Models;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm.Images;

internal static class ImageTokenEstimate
{
    internal static (JsonNode? Value, int Images) Sanitize(JsonNode? node)
    {
        if (node is JsonArray array)
        {
            var result = new JsonArray();
            var count = 0;
            foreach (var child in array)
            {
                var item = Sanitize(child);
                result.Add(item.Value);
                count += item.Images;
            }
            return (result, count);
        }
        if (node is not JsonObject obj)
            return (node?.DeepClone(), 0);
        if (MimeImage(obj) && SessionWait.Text(obj["data"]) is not null)
            return (
                new JsonObject
                {
                    ["mimeType"] = ImageBlobStore.Mime(obj),
                    ["data"] = "[image omitted]",
                },
                1
            );
        var copy = new JsonObject();
        var images = 0;
        foreach (var (key, value) in obj)
        {
            var item = Sanitize(value);
            copy[key] = item.Value;
            images += item.Images;
        }
        return (copy, images);
    }

    private static bool MimeImage(JsonObject obj) =>
        ImageBlobStore.Mime(obj).StartsWith("image/", StringComparison.Ordinal);

    internal static (int Tokens, int Images) Part(JsonObject part)
    {
        var tokens = 0;
        var images = 0;
        foreach (var key in new[] { "text", "system", "thinking" })
            tokens += CompactCandidateBuilder.Tokens(SessionWait.Text(part[key]) ?? "");
        if (part["functionCall"] is JsonObject call)
            tokens +=
                CompactCandidateBuilder.Tokens(SessionWait.Text(call["name"]) ?? "")
                + CompactCandidateBuilder.Tokens(
                    FunctionCallArguments.Stringify(
                        call["args"] as JsonObject,
                        SessionWait.Text(call["rawArgsText"]),
                        SessionWait.Text(call["argsParseError"])
                    )
                );
        if (part["functionResponse"] is JsonObject response)
        {
            var value = Sanitize(response["response"] ?? new JsonObject());
            images += value.Images;
            tokens +=
                CompactCandidateBuilder.Tokens(SessionWait.Text(response["name"]) ?? "")
                + CompactCandidateBuilder.Tokens(EcmaJson.Stringify(value.Value!));
        }
        if (part["inlineDataRef"] is JsonObject reference && MimeImage(reference))
            images++;
        else if (part["inlineData"] is JsonObject inline)
        {
            if (MimeImage(inline) && SessionWait.Text(inline["data"]) is not null)
                images++;
            else
            {
                var value = Sanitize(inline);
                images += value.Images;
                tokens += CompactCandidateBuilder.Tokens(EcmaJson.Stringify(value.Value!));
            }
        }
        return (tokens, images);
    }

    internal static (int Tokens, int Images) Message(JsonObject message)
    {
        var tokens = 0;
        var images = 0;
        foreach (var part in (message["parts"] as JsonArray ?? []).OfType<JsonObject>())
        {
            var value = Part(part);
            tokens += value.Tokens;
            images += value.Images;
        }
        return (tokens, images);
    }
}
