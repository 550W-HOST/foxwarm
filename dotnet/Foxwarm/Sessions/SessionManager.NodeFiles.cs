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

    // The Agent-folder file tools of a Session: master's file tools confined to its Agent's
    // folder, or the Agent store's files of its Agent.
    // The file owner of Agent folders: the store, or the folders under the store's rules
    // (no links, no special names), so the endpoint is confined alike in both modes.
    // Tests may wrap it.
    private IAgentFileStore? folderFiles;

    internal IAgentFileStore FolderFiles
    {
        get => folderFiles ??= (IAgentFileStore?)AgentStore ?? PhysicalFolderFiles;
        set => folderFiles = value;
    }

    private FileAgentFiles? physicalFolderFiles;

    private FileAgentFiles PhysicalFolderFiles => physicalFolderFiles ??= new FileAgentFiles(agents);

    internal WorkspaceTools AgentFolderWorkspace(SessionOwner owner)
    {
        return new(new AgentStoreFileOperations(FolderFiles, owner.Agent), pendingWrites, owner.Id, owner.Agent, owner)
        {
            AgentFolder = new(owner.Agent, agents.PhysicalFolders ? agents.AgentDirectory(owner.Agent) : null),
        };
    }

    // The read that admits a systemPromptFiles reference of a new Session of an Agent: a master
    // file, or a file of that Agent's folder in the store.
    internal (ResolvedTool Read, WorkspaceTools Files) PromptFileRead(string callerAgent, string targetAgent, string reference)
    {
        if (agents.PhysicalFolders)
            return (
                new("read", "node", "read", new JsonObject { ["filePath"] = memory.ResolveSelectedPath(targetAgent, reference) }),
                AgentWorkspace(callerAgent)
            );
        var path = AgentMemory.SelectedStorePath(reference);
        return (
            new(
                "read",
                "node",
                "read",
                new JsonObject { ["filePath"] = AgentFolderPaths.Variable + "/" + path },
                ExecutionNode: AgentStorePaths.Endpoint
            )
            {
                AgentFolder = true,
            },
            new(new AgentStoreFileOperations(AgentStore!, targetAgent), pendingWrites, "standalone", targetAgent, null)
            {
                AgentFolder = new(targetAgent, null),
            }
        );
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
            if (node == AgentStorePaths.Endpoint)
            {
                var scope = AgentFolderScope(owner);
                paths.Add(scope.Fact(endpoint + "Path", raw, scope.Resolve(raw)));
                continue;
            }
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

    // A file tool call on this Agent's folder (`node:@agent/<operation>`), as a call would be.
    internal Task AuthorizeAgentFolderFileAsync(SessionOwner owner, string raw, string operation, CancellationToken token) =>
        AuthorizeToolAsync(
            owner,
            new(operation, "node", operation, new JsonObject { ["filePath"] = raw }, ExecutionNode: AgentStorePaths.Endpoint)
            {
                AgentFolder = true,
            },
            AgentFolderWorkspace(owner),
            token
        );

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
        var path = MasterFilePath(files, raw);
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
        return await WriteMasterStreamAsync(owner, () => MasterFilePath(files, raw), raw, input, length, overwrite, token, progress);
    }

    // A stream written to a master file, the path resolved again before the rename.
    private async Task<(string Path, string Sha256)> WriteMasterStreamAsync(
        SessionOwner owner,
        Func<string> Resolve,
        string raw,
        Stream input,
        long length,
        bool overwrite,
        CancellationToken token,
        Action<long>? progress
    )
    {
        var path = Resolve();
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
                () => _ = Resolve(),
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

    private string MasterFilePath(WorkspaceTools files, string raw)
    {
        RequireMasterNode();
        return files.Paths.FilePath(raw);
    }

    private AgentFolderScope AgentFolderScope(SessionOwner owner) =>
        new(owner.Agent, agents.PhysicalFolders ? agents.AgentDirectory(owner.Agent) : null);

    // A copy into the Agent store: the whole file, within the file limit, created or replaced
    // as `overwrite` says.
    // Copy endpoints: `@agent` is this Agent's folder, confined by its file owner (the store,
    // or the folder under the store's rules); any other endpoint is an ordinary Node file.
    internal async Task<TransferSource> OpenCopySourceAsync(
        SessionOwner owner,
        string node,
        string raw,
        WorkspaceTools files,
        CancellationToken token,
        string? sessionCwd = null
    )
    {
        if (node != AgentStorePaths.Endpoint)
            return await OpenNodeReadAsync(owner, node, raw, files, token, sessionCwd);
        var storePath = AgentFolderPaths.StorePath(raw);
        if (AgentStore is { } store)
        {
            if (store.Stat(owner.Agent, storePath) is not { IsDirectory: false })
                throw new InvalidDataException("Not a regular file: " + raw);
            var bytes = (await store.ReadAsync(owner.Agent, storePath, token)).Bytes;
            return new(new MemoryStream(bytes, writable: false), bytes.Length, raw, Path.GetFileName(storePath));
        }
        var path = PhysicalFolderFiles.ConfinedPath(owner.Agent, storePath);
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

    internal async Task<(string Path, string Sha256)> WriteCopyTargetAsync(
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
        if (node != AgentStorePaths.Endpoint)
            return await WriteNodeStreamAsync(owner, node, raw, input, length, overwrite, files, token, progress, sessionCwd);
        var storePath = AgentFolderPaths.StorePath(raw);
        if (AgentStore is { } store)
            return await WriteAgentStoreStreamAsync(owner, store, raw, input, length, overwrite, token, progress);
        var folder = PhysicalFolderFiles;
        return await WriteMasterStreamAsync(owner, () => folder.ConfinedPath(owner.Agent, storePath), raw, input, length, overwrite, token, progress);
    }

    private static async Task<(string Path, string Sha256)> WriteAgentStoreStreamAsync(
        SessionOwner owner,
        IAgentStore store,
        string raw,
        Stream input,
        long length,
        bool overwrite,
        CancellationToken token,
        Action<long>? progress
    )
    {
        var storePath = AgentFolderPaths.StorePath(raw);
        if (length > store.Limits.FileBytes)
            throw AgentFileErrors.FileTooLarge(storePath, store.Limits);
        var existing = store.Stat(owner.Agent, storePath);
        if (existing is { IsDirectory: true } || !overwrite && existing is not null)
            throw new IOException("File already exists: " + raw + ". Use overwrite=true to overwrite.");
        using var buffer = new MemoryStream((int)length);
        var sha = await TransferStream.CopyAsync(input, buffer, length, token, progress);
        owner.Entry.RequireIdentityAuthority();
        try
        {
            await store.WriteAsync(owner.Agent, storePath, buffer.ToArray(), overwrite ? null : 0, token);
        }
        catch (AgentFileConflictException)
        {
            throw new IOException("File already exists: " + raw + ". Use overwrite=true to overwrite.");
        }
        return (AgentFolderPaths.Variable + (storePath.Length == 0 ? "" : "/" + storePath), sha);
    }
}
