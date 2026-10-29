using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class ToolOutputGuard
{
    private const int CharLimit = 40_000;

    internal sealed record SavedOutput(
        string Path,
        string Node,
        bool Relative = false,
        string? Cwd = null
    );

    internal static async Task<JsonNode?> GuardAsync(
        JsonNode? response,
        Func<string, Task<SavedOutput>> save,
        bool toolScriptExecution = false
    )
    {
        if (response is not JsonObject)
            return await GuardTextAsync(response, save, toolScriptExecution);
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
            return await GuardTextAsync(response, save, toolScriptExecution);
        var guarded = await GuardTextAsync(plain, save, toolScriptExecution);
        foreach (var (key, value) in carriers)
            if (guarded![key] is JsonArray existing && value is JsonArray extracted)
                foreach (var item in extracted)
                    existing.Add(item?.DeepClone());
            else
                guarded![key] = value?.DeepClone();
        return guarded;
    }

    private static async Task<JsonNode?> GuardTextAsync(
        JsonNode? response,
        Func<string, Task<SavedOutput>> save,
        bool toolScriptExecution
    )
    {
        string Format(JsonNode? value) =>
            toolScriptExecution
                ? ToolResponseFormatting.FormatToolScriptExecution(value)
                : ToolResponseFormatting.Format(value);
        var originalText = Format(response);
        var result = response;
        try
        {
            if (response is JsonObject source && source.ContainsKey("output"))
            {
                var output = ToolResponseFormatting.FormatStructuredValue(source["output"]);
                if (output.Length > CharLimit)
                {
                    var saved = await save(output);
                    var shortened = (JsonObject)source.DeepClone();
                    shortened["output"] = Excerpt(output, 30_000, Location(saved));
                    AddLocation(shortened, saved, output.Length);
                    result = shortened;
                }
            }
            if (Format(result).Length <= CharLimit)
                return result;
            // Stage B saves the original response, not the already-shortened Stage A envelope.
            var complete = await save(originalText);
            return Summary(response, originalText, complete, null);
        }
        catch (Exception error)
            when (error
                    is IOException
                        or UnauthorizedAccessException
                        or InvalidOperationException
                        or NotSupportedException
                        or TimeoutException
                        or OperationCanceledException
                        or ToolAuthorizationUnavailableException
            )
        {
            // Saving a presentation artifact must not turn a successful tool effect into an error.
            return Summary(response, originalText, null, error.Message);
        }
    }

    private static JsonObject Summary(
        JsonNode? response,
        string text,
        SavedOutput? saved,
        string? saveError
    )
    {
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
                && obj.TryGetPropertyValue(key, out var value)
                && (value is null || value.ToJsonString().Length <= 2000)
            )
                result[key] = value?.DeepClone();
        var notice = saved is not null
            ? Location(saved)
            : "Saving complete tool output failed: " + ShortError(saveError!);
        var excerpt = Excerpt(text, 18_000, notice);
        if (response is JsonObject error && error["error"] is not null)
            result["error"] = "TOOL ERROR OUTPUT TOO LONG\n" + excerpt;
        else
            result["output"] = excerpt;
        if (saved is not null)
            AddLocation(result, saved, text.Length);
        else
        {
            result["outputOriginalLengthChars"] = text.Length;
            result["outputTruncated"] = true;
            result["toolOutputGuardError"] = ShortError(saveError!);
        }
        return result;
    }

    private static string ShortError(string error) =>
        error[..Boundary(error, Math.Min(1200, error.Length))];

    private static void AddLocation(JsonObject result, SavedOutput saved, int length)
    {
        result["outputFullPath"] = saved.Path;
        result["outputFullNode"] = saved.Node;
        result["outputOriginalLengthChars"] = length;
        result["outputTruncated"] = true;
    }

    private static string Location(SavedOutput saved) =>
        $"Tool output truncated; complete output on Node {saved.Node}: {saved.Path}. Use read on that Node to inspect it."
        + (
            saved.Relative
                ? saved.Cwd is null
                    ? " This path uses the Node's default directory; the Session cwd was unset when saved."
                    : $" This path is relative to Session cwd {saved.Cwd} at save time; use read with that cwd."
                : ""
        );

    private static string Excerpt(string text, int limit, string notice)
    {
        var headEnd = Boundary(text, Math.Min(limit / 2, text.Length));
        var tailStart = Boundary(text, Math.Max(headEnd, text.Length - limit / 2));
        var head = text[..headEnd];
        var line = head.LastIndexOf('\n');
        if (line > head.Length / 2)
            head = head[..(line + 1)];
        var tail = text[tailStart..];
        line = tail.IndexOf('\n');
        if (line >= 0 && line < tail.Length / 2)
            tail = tail[(line + 1)..];
        return head + $"\n[{notice}]\n" + tail;
    }

    internal static async Task<SavedOutput> SaveLocalAsync(
        string text,
        string workspace,
        string? fileName = null
    )
    {
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
        var file = Path.Combine(
            directory,
            fileName ?? ("result-" + Guid.NewGuid().ToString("N") + ".txt")
        );
        await File.WriteAllTextAsync(file, text, new UTF8Encoding(false));
        return new(file, "master");
    }

    private static int Boundary(string text, int index) =>
        index > 0
        && index < text.Length
        && char.IsLowSurrogate(text[index])
        && char.IsHighSurrogate(text[index - 1])
            ? index - 1
            : index;
}
