using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class ToolOutputGuard
{
    internal static async Task<JsonNode?> GuardAsync(
        JsonNode? response,
        string workspace,
        string callId,
        bool toolScriptExecution = false
    )
    {
        if (response is not JsonObject)
            return await GuardTextAsync(response, workspace, toolScriptExecution);
        // Keep recognized image carriers outside the text guard, as Source extraction does.
        var plain = (JsonObject)response.DeepClone();
        var carriers = new JsonObject();
        if (
            plain["inlineData"] is JsonObject single
            && Foxwarm
                .Images.ImageBlobStore.Mime(single)
                .StartsWith("image/", StringComparison.Ordinal)
        )
        {
            carriers["inlineData"] = single.DeepClone();
            plain.Remove("inlineData");
        }
        if (plain["inlineDataItems"] is JsonArray items)
        {
            var images = items
                .OfType<JsonObject>()
                .Where(item =>
                    Foxwarm
                        .Images.ImageBlobStore.Mime(item)
                        .StartsWith("image/", StringComparison.Ordinal)
                )
                .ToArray();
            if (images.Length > 0)
            {
                carriers["inlineDataItems"] = new JsonArray(
                    images.Select(item => item.DeepClone()).ToArray()
                );
                var other = new JsonArray(
                    items
                        .Where(item => !images.Contains(item))
                        .Select(item => item?.DeepClone())
                        .ToArray()
                );
                if (other.Count > 0)
                    plain["inlineDataItems"] = other;
                else
                    plain.Remove("inlineDataItems");
            }
        }
        if (plain["imageParts"] is JsonArray references)
        {
            var images = references
                .OfType<JsonObject>()
                .Where(item =>
                    Foxwarm.Images.ImageBlobStore.NormalizeToolReference(item) is not null
                )
                .ToArray();
            if (images.Length > 0)
            {
                carriers["imageParts"] = new JsonArray(
                    images.Select(item => item.DeepClone()).ToArray()
                );
                var other = new JsonArray(
                    references
                        .Where(item => !images.Contains(item))
                        .Select(item => item?.DeepClone())
                        .ToArray()
                );
                if (other.Count > 0)
                    plain["imageParts"] = other;
                else
                    plain.Remove("imageParts");
            }
        }
        if (carriers.Count == 0)
            return await GuardTextAsync(response, workspace, toolScriptExecution);
        var guarded = await GuardTextAsync(plain, workspace, toolScriptExecution);
        foreach (var (key, value) in carriers)
            if (guarded![key] is JsonArray existing && value is JsonArray extracted)
                foreach (var item in extracted)
                    existing.Add(item?.DeepClone());
            else
                guarded![key] = value?.DeepClone();
        return guarded;
    }

    private static async Task<JsonNode?> GuardTextAsync(JsonNode? response, string workspace, bool toolScriptExecution)
    {
        var text = toolScriptExecution
            ? ToolResponseFormatting.FormatToolScriptExecution(response)
            : ToolResponseFormatting.Format(response);
        if (text.Length <= 40_000)
            return response;
        var directory = Path.Combine(workspace, ".temp", "tool-output");
        var parent = Path.GetDirectoryName(directory)!;
        if (
            Directory.Exists(parent)
            && (File.GetAttributes(parent) & FileAttributes.ReparsePoint) != 0
        )
            throw new IOException("Tool output parent cannot be a symbolic link.");
        Directory.CreateDirectory(directory);
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0)
            throw new IOException("Tool output directory cannot be a symbolic link.");
        var file = Path.Combine(directory, "result-" + Guid.NewGuid().ToString("N") + ".txt");
        await File.WriteAllTextAsync(file, text, new UTF8Encoding(false));
        var headEnd = Boundary(text, Math.Min(15_000, text.Length));
        var tailStart = Boundary(text, Math.Max(headEnd, text.Length - 15_000));
        var head = text[..headEnd];
        var line = head.LastIndexOf('\n');
        if (line > head.Length / 2)
            head = head[..(line + 1)];
        var tail = text[tailStart..];
        line = tail.IndexOf('\n');
        if (line >= 0 && line < tail.Length / 2)
            tail = tail[(line + 1)..];
        var result = new JsonObject();
        foreach (
            var key in new[]
            {
                "error",
                "status",
                "runId",
                "continuationId",
                "waitingReason",
                "question",
                "cancelled",
                "fullPath",
                "filePath",
                "node",
                "nodeId",
                "offset",
                "nextOffset",
                "totalBytes",
                "exitCode",
            }
        )
            if (
                response is JsonObject obj
                && obj[key] is JsonNode value
                && value.ToJsonString().Length <= 2000
            )
                result[key] = value.DeepClone();
        var excerpt = head + $"\n[Tool output truncated; complete output: {file}]\n" + tail;
        if (response is JsonObject error && error.ContainsKey("error"))
            result["error"] = "TOOL ERROR OUTPUT TOO LONG\n" + excerpt;
        else
            result["output"] = excerpt;
        result["outputFullPath"] = file;
        result["outputFullNode"] = "master";
        result["outputOriginalLengthChars"] = text.Length;
        result["outputTruncated"] = true;
        return result;
    }

    private static int Boundary(string text, int index) =>
        index > 0
        && index < text.Length
        && char.IsLowSurrogate(text[index])
        && char.IsHighSurrogate(text[index - 1])
            ? index - 1
            : index;
}
