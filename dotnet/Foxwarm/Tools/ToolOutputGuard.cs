using System.Text;
using System.Text.Json.Nodes;

namespace Foxwarm.Tools;

internal static class ToolOutputGuard
{
    internal static async Task<JsonObject> GuardAsync(JsonObject response, string workspace, string callId)
    {
        var text = ToolResponseFormatting.Format(response);
        if (text.Length <= 40_000) return response;
        var directory = Path.Combine(workspace, ".temp", "tool-output");
        var parent = Path.GetDirectoryName(directory)!;
        if (Directory.Exists(parent) && (File.GetAttributes(parent) & FileAttributes.ReparsePoint) != 0) throw new IOException("Tool output parent cannot be a symbolic link.");
        Directory.CreateDirectory(directory);
        if ((File.GetAttributes(directory) & FileAttributes.ReparsePoint) != 0) throw new IOException("Tool output directory cannot be a symbolic link.");
        var file = Path.Combine(directory, "result-" + Guid.NewGuid().ToString("N") + ".txt");
        await File.WriteAllTextAsync(file, text, new UTF8Encoding(false));
        var headEnd = Boundary(text, Math.Min(15_000, text.Length)); var tailStart = Boundary(text, Math.Max(headEnd, text.Length - 15_000));
        var head = text[..headEnd]; var line = head.LastIndexOf('\n'); if (line > head.Length / 2) head = head[..(line + 1)];
        var tail = text[tailStart..]; line = tail.IndexOf('\n'); if (line >= 0 && line < tail.Length / 2) tail = tail[(line + 1)..];
        var result = new JsonObject();
        foreach (var key in new[] { "error", "status", "runId", "cancelled", "fullPath", "filePath", "node", "nodeId", "offset", "nextOffset", "totalBytes", "exitCode" })
            if (response[key] is JsonNode value && value.ToJsonString().Length <= 2000) result[key] = value.DeepClone();
        var excerpt = head + $"\n[Tool output truncated; complete output: {file}]\n" + tail;
        if (response.ContainsKey("error")) result["error"] = "TOOL ERROR OUTPUT TOO LONG\n" + excerpt;
        else result["output"] = excerpt;
        result["outputFullPath"] = file; result["outputFullNode"] = "master";
        result["outputOriginalLengthChars"] = text.Length; result["outputTruncated"] = true;
        return result;
    }
    private static int Boundary(string text, int index) => index > 0 && index < text.Length && char.IsLowSurrogate(text[index]) && char.IsHighSurrogate(text[index - 1]) ? index - 1 : index;
}
