using System.Text.Json.Nodes;
using Foxwarm.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private WorkspaceTools AgentFileWorkspace(SessionOwner owner) =>
        new(AgentDirectory(owner.Agent));

    private IReadOnlyList<AuthorizationPath> CopyAuthorizationPaths(
        SessionOwner owner,
        JsonObject args
    )
    {
        var files = AgentFileWorkspace(owner);
        var paths = new List<AuthorizationPath>();
        foreach (var endpoint in new[] { "source", "target" })
        {
            var node = SessionWait.Text(args[endpoint + "Node"])?.Trim() ?? "";
            if (SessionWait.Text(args[endpoint + "Path"]) is not string raw)
                continue;
            paths.Add(
                new(
                    endpoint + "Path",
                    raw,
                    node == "master"
                        ? AuthorizationPaths.CanonicalPotential(files.Paths.FilePath(raw))
                        : null,
                    node
                )
            );
        }
        return paths;
    }

    private void RequireFileNodeBoundary(SessionOwner owner, string node)
    {
        if (
            AgentIsolated(owner.Agent)
            && node != "master"
            && node != CurrentNode(owner)
            && node != BoundNode(owner.Agent)
        )
            throw new ToolAuthorizationDeniedException(
                "Isolated Agent can only transfer files between Main and its bound/current Node."
            );
    }

    internal Task AuthorizeNodeFileAsync(
        SessionOwner owner,
        string node,
        string raw,
        string operation,
        WorkspaceTools files,
        CancellationToken token
    ) =>
        AuthorizeToolAsync(
            owner,
            new(
                operation,
                "node",
                operation,
                new JsonObject { ["filePath"] = raw },
                ExecutionNode: node
            ),
            files,
            token
        );

    internal async Task<NodeConnectionHub.TransferFile> ReadNodeFileAsync(
        SessionOwner owner,
        string node,
        string raw,
        WorkspaceTools files,
        CancellationToken token,
        Action<long>? beforeMaterialize = null
    )
    {
        if (node != "master")
            return await Nodes.ReadFileAsync(node, raw, owner, false, token, beforeMaterialize);
        var path = files.Paths.FilePath(raw);
        if (!WorkspaceTools.RegularFile(path))
            throw new InvalidDataException("Not a regular file: " + raw);
        await using var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete,
            65536,
            FileOptions.Asynchronous
        );
        if (!WorkspaceTools.RegularFileHandle(stream, path))
            throw new InvalidDataException("Not a regular file: " + raw);
        if (stream.Length > NodeConnectionHub.FileLimit)
            throw new InvalidDataException("File exceeds the 50 MiB transfer limit.");
        beforeMaterialize?.Invoke(stream.Length);
        using var buffer = new MemoryStream();
        var chunk = new byte[65536];
        int read;
        while ((read = await stream.ReadAsync(chunk, token)) > 0)
        {
            if (buffer.Length + read > NodeConnectionHub.FileLimit)
                throw new InvalidDataException("File exceeds the 50 MiB transfer limit.");
            buffer.Write(chunk, 0, read);
        }
        return new(buffer.ToArray(), path, Path.GetFileName(path));
    }

    internal async Task<string> WriteNodeFileAsync(
        SessionOwner owner,
        string node,
        string raw,
        byte[] bytes,
        bool overwrite,
        WorkspaceTools files,
        CancellationToken token
    )
    {
        if (bytes.Length > NodeConnectionHub.FileLimit)
            throw new InvalidDataException("File exceeds the 50 MiB transfer limit.");
        if (node != "master")
        {
            var result = await Nodes.WriteFileAsync(
                node,
                raw,
                bytes,
                overwrite,
                owner,
                false,
                token
            );
            return SessionWait.Text(result["absolutePath"])
                ?? SessionWait.Text(result["filePath"])
                ?? raw;
        }
        var path = files.Paths.FilePath(raw);
        if (
            Directory.Exists(path)
            || !overwrite && (File.Exists(path) || new FileInfo(path).LinkTarget is not null)
        )
            throw new IOException(
                "File already exists: " + raw + ". Use overwrite=true to overwrite."
            );
        if (File.Exists(path) && !WorkspaceTools.RegularFile(path))
            throw new IOException("File target must be a regular file.");
        token.ThrowIfCancellationRequested();
        owner.Entry.RequireIdentityAuthority();
        Directory.CreateDirectory(Path.GetDirectoryName(path)!);
        if (
            !await FileToolCore.WriteBytesAtomic(
                path,
                bytes,
                overwrite,
                () => _ = files.Paths.FilePath(raw),
                token
            )
        )
            throw new IOException(
                "File already exists: " + raw + ". Use overwrite=true to overwrite."
            );
        return path;
    }

    internal async Task<JsonObject> CopyBetweenNodesAsync(
        SessionOwner owner,
        JsonObject args,
        CancellationToken token
    )
    {
        ToolRegistry.Keys(
            args,
            ["sourceNode", "sourcePath", "targetNode", "targetPath", "overwrite"]
        );
        string Required(string key) =>
            ToolRegistry.Text(args, key) is { } value && !string.IsNullOrWhiteSpace(value)
                ? value
                : throw new InvalidDataException("copy_between_nodes requires " + key + ".");
        var source = Required("sourceNode").Trim();
        var target = Required("targetNode").Trim();
        var sourcePath = Required("sourcePath");
        var targetPath = Required("targetPath");
        var overwrite = OptionalBool(args, "overwrite") ?? false;
        using var admission = BeginOwnerMutation(owner);
        var files = AgentFileWorkspace(owner);
        // The compound builtin owns both endpoint facts; ordinary Node tool grants are not transfer grants.
        await AuthorizeToolAsync(
            owner,
            new("copy_between_nodes", "builtin", "copy_between_nodes", args),
            files,
            token
        );
        var file = await ReadNodeFileAsync(owner, source, sourcePath, files, token);
        await WaitForIdentityMutationAsync(owner.Id, token);
        files = AgentFileWorkspace(owner);
        await AuthorizeToolAsync(
            owner,
            new("copy_between_nodes", "builtin", "copy_between_nodes", args),
            files,
            token
        );
        var path = await WriteNodeFileAsync(
            owner,
            target,
            targetPath,
            file.Bytes,
            overwrite,
            files,
            token
        );
        return new JsonObject
        {
            ["output"] =
                $"Copied `{sourcePath}` on `{source}` to `{targetPath}` on `{target}` ({file.Bytes.Length} bytes).",
            ["targetNode"] = target,
            ["fullPath"] = path,
            ["sizeBytes"] = file.Bytes.Length,
        };
    }
}
