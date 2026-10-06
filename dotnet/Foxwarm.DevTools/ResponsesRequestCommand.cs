using System.Text.Json;
using System.Text.Json.Nodes;
using Foxwarm.Models;

namespace Foxwarm.DevTools;

internal static class ResponsesRequestCommand
{
    public static async Task RunAsync(string[] args)
    {
        var corpusPath =
            args.Length > 0 ? args[0] : throw new ArgumentException("Corpus path is required.");
        var corpus =
            JsonNode.Parse(await File.ReadAllTextAsync(corpusPath)) as JsonArray
            ?? throw new FormatException("Corpus must be an array.");
        var results = new JsonArray();
        foreach (var node in corpus)
        {
            var item =
                node as JsonObject ?? throw new FormatException("Corpus entries must be objects.");
            var messages = (
                item["messages"] as JsonArray ?? throw new FormatException("messages is required")
            )
                .Select(message =>
                    (JsonObject)(
                        message?.DeepClone() ?? throw new FormatException("message is required")
                    )
                )
                .ToArray();
            results.Add(
                new JsonObject
                {
                    ["name"] = item["name"]?.GetValue<string>(),
                    ["input"] = ResponsesRequestSerializer.ConvertHistory(
                        messages,
                        item["modelId"]?.GetValue<string>() ?? ""
                    ),
                }
            );
        }
        Console.Write(results.ToJsonString(new JsonSerializerOptions { WriteIndented = false }));
    }
}
