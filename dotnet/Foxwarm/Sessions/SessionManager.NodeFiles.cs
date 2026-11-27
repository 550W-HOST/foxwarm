using System.Text.Json.Nodes;
using Foxwarm.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal WorkspaceTools AgentFileWorkspace(SessionOwner owner) => AgentWorkspace(owner.Agent);

    // The Main-local file tools of an Agent: over its folder, or over an Agent store, which
    // has no folder, a target that refuses every effect as a call to the missing master does.
    // Without a master Node those calls are refused before they reach it.
    internal WorkspaceTools AgentWorkspace(
        string agent,
        PendingWriteRefs? pending = null,
        string? sessionId = null,
        object? lifetime = null,
        string? cwd = null
    )
    {
        if (agents.PhysicalFolders)
            return pending is null
                ? new(agents.AgentDirectory(agent))
                : new(agents.AgentDirectory(agent), pending, sessionId!, agent, lifetime, cwd);
        if (!agents.Exists(agent))
            throw new InvalidDataException($"Agent '{agent}' does not exist.");
        return new(NoAgentFolderOperations.Instance, pending ?? new(), sessionId ?? "standalone", agent, lifetime);
    }

    // Every Main-local file and process effect checks this before it starts; without a master
    // Node it fails as a call to any unavailable Node does. `current`: master is only the
    // Session's current Node, which without a master Node means it has none.
    internal void RequireMasterNode(bool current = false)
    {
        if (!Capabilities.MasterNode)
            throw current ? RuntimeCapabilities.NoCurrentNode() : RuntimeCapabilities.MasterUnavailable();
    }

    // Master endpoints resolve like the invocation's own file tools: the Session working directory
    // when master is the current Node, otherwise the Agent directory.
    private IReadOnlyList<AuthorizationPath> CopyAuthorizationPaths(
        SessionOwner owner,
        JsonObject args,
        WorkspaceTools? invocationFiles
    )
    {
        var files = invocationFiles ?? AgentFileWorkspace(owner);
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

    internal async Task<TransferSource> OpenNodeReadAsync(
        SessionOwner owner,
        string node,
        string raw,
        WorkspaceTools files,
        CancellationToken token,
        string? sessionCwd = null
    )
    {
        if (node != "master")
            return await NodeProviders.OpenReadAsync(node, raw, owner, false, token, sessionCwd);
        RequireMasterNode();
        var path = files.Paths.FilePath(raw);
        if (!WorkspaceTools.RegularFile(path))
            throw new InvalidDataException("Not a regular file: " + raw);
        var stream = new FileStream(
            path,
            FileMode.Open,
            FileAccess.Read,
            FileShare.ReadWrite | FileShare.Delete,
            65536,
            FileOptions.Asynchronous | FileOptions.SequentialScan
        );
        if (!WorkspaceTools.RegularFileHandle(stream, path))
        {
            await stream.DisposeAsync();
            throw new InvalidDataException("Not a regular file: " + raw);
        }
        return new(stream, stream.Length, path, Path.GetFileName(path));
    }

    internal async Task<(string Path, string Sha256)> WriteNodeStreamAsync(
        SessionOwner owner,
        string node,
        string raw,
        Stream input,
        long length,
        bool overwrite,
        WorkspaceTools files,
        CancellationToken token,
        Action<long>? progress = null,
        string? sessionCwd = null
    )
    {
        if (node != "master")
            return await NodeProviders.WriteStreamAsync(
                node,
                raw,
                input,
                length,
                overwrite,
                owner,
                false,
                token,
                progress,
                sessionCwd
            );
        RequireMasterNode();
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
        string? sha = null;
        if (
            !await FileToolWrite.WriteStreamAtomic(
                path,
                overwrite,
                () => _ = files.Paths.FilePath(raw),
                async output =>
                    sha = await TransferStream.CopyAsync(input, output, length, token, progress),
                token
            )
        )
            throw new IOException(
                "File already exists: " + raw + ". Use overwrite=true to overwrite."
            );
        return (path, sha!);
    }

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
            return await NodeProviders.ReadFileAsync(
                node,
                raw,
                owner,
                false,
                token,
                beforeMaterialize
            );
        RequireMasterNode();
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
        beforeMaterialize?.Invoke(stream.Length);
        using var buffer = new MemoryStream();
        var chunk = new byte[65536];
        int read;
        while ((read = await stream.ReadAsync(chunk, token)) > 0)
        {
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
        CancellationToken token,
        string? sessionCwd = null
    )
    {
        if (node != "master")
        {
            var result = await NodeProviders.WriteFileAsync(
                node,
                raw,
                bytes,
                overwrite,
                owner,
                false,
                token,
                sessionCwd
            );
            return SessionWait.Text(result["absolutePath"])
                ?? SessionWait.Text(result["filePath"])
                ?? raw;
        }
        RequireMasterNode();
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
            !await FileToolWrite.WriteBytesAtomic(
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
}
