using System.Text.Json.Nodes;

namespace Foxwarm.Code;

internal static class CodeFileService
{
    internal const long MaxFileBytes = CodeFileOperations.MaxFileBytes;

    internal static string Node(string? value)
    {
        var id = string.IsNullOrWhiteSpace(value) ? "master" : value.Trim();
        if (!System.Text.RegularExpressions.Regex.IsMatch(id, "^[A-Za-z0-9._-]+$"))
            throw new CodeServiceException("InvalidNode", "Invalid node id.");
        return id;
    }

    internal static string PathValue(string? value)
    {
        if (
            string.IsNullOrWhiteSpace(value)
            || !value.Trim().StartsWith('/')
            || value.Contains('\0')
        )
            throw new CodeServiceException(
                "InvalidPath",
                "An absolute filesystem path is required."
            );
        var parts = new List<string>();
        foreach (var part in value.Trim().Split('/'))
        {
            if (part is "" or ".")
                continue;
            if (part == "..")
            {
                if (parts.Count > 0)
                    parts.RemoveAt(parts.Count - 1);
            }
            else
                parts.Add(part);
        }
        return "/" + string.Join('/', parts);
    }

    internal static bool Bool(JsonNode? value) =>
        value switch
        {
            JsonValue node when node.TryGetValue<bool>(out var flag) => flag,
            JsonValue node when node.TryGetValue<double>(out var number) => number != 0,
            JsonValue node when node.TryGetValue<string>(out var text) => text.Trim()
                .ToLowerInvariant()
                is "1"
                    or "true"
                    or "yes",
            _ => false,
        };

    internal static JsonObject StatFile(string path) => CodeFileOperations.StatFile(CodeNativePaths.Native(path));
    internal static JsonObject ReadDirectory(string path) => CodeFileOperations.ReadDirectory(CodeNativePaths.Native(path));
    internal static Task<byte[]> ReadFileAsync(string path, CancellationToken token) => CodeFileOperations.ReadFileAsync(CodeNativePaths.Native(path), token);
    internal static Task<byte[]> ReadBoundedAsync(Stream input, long limit, CancellationToken token) => CodeFileOperations.ReadBoundedAsync(input, limit, token);
    internal static Task<JsonObject> WriteFileAsync(string path, Stream input, bool create, bool overwrite, CancellationToken token) => CodeFileOperations.WriteFileAsync(CodeNativePaths.Native(path), input, create, overwrite, token);
    internal static JsonObject CreateDirectory(string path) => CodeFileOperations.CreateDirectory(CodeNativePaths.Native(path));
    internal static JsonObject Delete(string path, bool recursive) => CodeFileOperations.Delete(CodeNativePaths.Native(path), recursive);
    internal static JsonObject Rename(string oldPath, string newPath, bool overwrite) => CodeFileOperations.Rename(CodeNativePaths.Native(oldPath), CodeNativePaths.Native(newPath), overwrite);
}
