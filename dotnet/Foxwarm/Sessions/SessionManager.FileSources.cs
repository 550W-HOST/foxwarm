using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private static string RemoteSourcePath(string file, string? cwd)
    {
        // Only join strings here: the Node owns normalization, home/tokens and OS path rules.
        if (
            string.IsNullOrWhiteSpace(cwd)
            || file.StartsWith('/')
            || file.StartsWith('\\')
            || file.StartsWith('~')
            || file.StartsWith('$')
            || file.Length > 1 && file[1] == ':'
        )
            return file;
        var separator = cwd.Contains('\\') ? "\\" : "/";
        return cwd.TrimEnd('/', '\\') + separator + file;
    }

    // Use explicitly complete programmatic content; previews still need correlated byte transfer.
    internal async Task<Foxwarm.Nodes.NodeConnectionHub.TransferFile> ReadResidentSourceAsync(
        SessionOwner hosted,
        string node,
        string file,
        string? cwd,
        WorkspaceTools files,
        CancellationToken token,
        Action<long>? beforeMaterialize = null
    )
    {
        string? resolvedPath = null;
        var result = await Nodes.ExecuteAsync(
            node,
            "read",
            new JsonObject { ["filePath"] = file },
            hosted.Id,
            hosted.Agent,
            node,
            cwd,
            true,
            token,
            hosted,
            value =>
            {
                if (value is not JsonObject)
                    return;
                resolvedPath = SessionWait.Text(value?["filePath"]);
                if (
                    resolvedPath is null
                    && value?["__foxwarmResolvedToolPaths"] is JsonArray paths
                    && paths.Count == 1
                    && SessionWait.Text(paths[0]?["raw"]) == file
                )
                    resolvedPath = SessionWait.Text(paths[0]?["resolved"]);
            }
        );
        if (
            result is JsonObject value
            && SessionWait.Text(value["content"]) is string content
            && value["truncated"] is JsonValue truncated
            && truncated.TryGetValue<bool>(out var isTruncated)
            && !isTruncated
            && SessionWait.Number(value["sizeBytes"]) is double size
            && size >= 0
            && size <= 9007199254740991
            && Math.Truncate(size) == size
            && SessionWait.Number(value["selectedBytes"]) == size
        )
        {
            // Charge actual UTF-8 bytes before allocation, not the peer's size metadata.
            beforeMaterialize?.Invoke(System.Text.Encoding.UTF8.GetByteCount(content));
            var path = resolvedPath ?? RemoteSourcePath(file, cwd);
            return new(
                System.Text.Encoding.UTF8.GetBytes(content),
                path,
                Foxwarm.Nodes.NodeConnectionHub.RemoteFileName(path)
            );
        }
        return await ReadNodeFileAsync(
            hosted,
            node,
            resolvedPath ?? RemoteSourcePath(file, cwd),
            files,
            token,
            beforeMaterialize
        );
    }
}
