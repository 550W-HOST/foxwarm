using System.Text.Json.Nodes;
using Foxwarm.Code;

namespace Foxwarm.CliNode;

// Fixed authenticated Code services do not have a model-tool or external owner.
internal static class NodeCodeServices
{
    internal static async Task<JsonObject> Execute(
        string service,
        string operation,
        JsonObject? args
    )
    {
        args ??= new();
        if (service == "vscode-fs")
        {
            var path = AbsolutePath(args["path"], "path");
            try
            {
                switch (operation)
                {
                    case "stat":
                        return CodeFileOperations.StatFile(path);
                    case "read-directory":
                        return CodeFileOperations.ReadDirectory(path);
                    case "read-file":
                        return Content(
                            await CodeFileOperations.ReadFileAsync(path, CancellationToken.None)
                        );
                    case "write-file":
                        var bytes = NodeFileTransfer.DecodeBase64(
                            Text(args, "contentBase64") ?? ""
                        );
                        if (bytes.LongLength > CodeFileOperations.MaxFileBytes)
                            throw new CodeServiceException(
                                "PayloadTooLarge",
                                "Write exceeds "
                                    + CodeFileOperations.MaxFileBytes
                                    + " bytes: "
                                    + path
                            );
                        using (var input = new MemoryStream(bytes, writable: false))
                            return await CodeFileOperations.WriteFileAsync(
                                path,
                                input,
                                Bool(args["create"]),
                                Bool(args["overwrite"]),
                                CancellationToken.None
                            );
                    case "create-directory":
                        return CodeFileOperations.CreateDirectory(path);
                    case "delete":
                        return CodeFileOperations.Delete(path, Bool(args["recursive"]));
                    case "rename":
                        return CodeFileOperations.Rename(
                            path,
                            AbsolutePath(args["newPath"], "newPath"),
                            Bool(args["overwrite"])
                        );
                    default:
                        throw new CodeServiceException(
                            "UnsupportedOperation",
                            "Unsupported vscode-fs operation: " + operation
                        );
                }
            }
            catch (Exception error)
            {
                throw CodeFileOperations.FileError(error, path);
            }
        }
        if (service == "vscode-git")
        {
            var workspace = AbsolutePath(args["workspace"], "workspace");
            try
            {
                switch (operation)
                {
                    case "status":
                        return await CodeGitOperations.StatusAsync(
                            workspace,
                            CancellationToken.None
                        );
                    case "commit":
                        return await CodeGitOperations.CommitAsync(
                            workspace,
                            Text(args, "id"),
                            CancellationToken.None
                        );
                    case "content":
                        return Content(
                            await CodeGitOperations.ContentAsync(
                                workspace,
                                Text(args, "path"),
                                Text(args, "side"),
                                args["ref"],
                                CancellationToken.None
                            )
                        );
                    default:
                        throw new CodeServiceException(
                            "UnsupportedOperation",
                            "Unsupported vscode-git operation: " + operation
                        );
                }
            }
            catch (CodeServiceException error) when (error.Code == "Unavailable")
            {
                // Main keeps its unavailable HTTP response. Source CLI Git content treats a failed
                // git show as empty; other operations return the actual executable failure.
                if (operation == "content" && Text(args, "side") == "base")
                    return Content([]);
                throw new CodeServiceException("GitError", error.Message, 422, error);
            }
        }
        throw new CodeServiceException(
            "Unknown",
            service == "vscode-pty"
                ? "vscode-pty service is unavailable on this node."
                : "Unsupported node service: " + service
        );
    }

    private static JsonObject Content(byte[] bytes) =>
        new() { ["contentBase64"] = Convert.ToBase64String(bytes) };

    private static string? Text(JsonObject args, string key) => NodeFileTools.Text(args[key]);

    internal static bool Bool(JsonNode? value) =>
        value is JsonValue json
        && (
            json.TryGetValue<bool>(out var flag) && flag
            || json.TryGetValue<double>(out var number) && number == 1
            || json.TryGetValue<string>(out var text) && text is "1" or "true"
        );

    internal static string AbsolutePath(JsonNode? value, string name)
    {
        var text = NodeFileTools.Text(value);
        if (string.IsNullOrWhiteSpace(text))
            throw new CodeServiceException("InvalidPath", name + " is required.");
        if (text.Contains('\0'))
            throw new CodeServiceException("InvalidPath", name + " must not contain NUL bytes.");
        if (!Path.IsPathFullyQualified(text))
            throw new CodeServiceException("InvalidPath", name + " must be an absolute path.");
        return Path.TrimEndingDirectorySeparator(Path.GetFullPath(text));
    }

    internal static JsonObject Error(Exception error) =>
        new()
        {
            ["code"] = error is CodeServiceException service ? service.Code : "Unknown",
            ["message"] = error.Message,
            ["statusCode"] = error is CodeServiceException status ? status.Status : 500,
        };
}
