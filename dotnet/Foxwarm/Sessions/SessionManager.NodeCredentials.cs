using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal async Task<JsonObject> CreateNodeAuthTokenAsync(
        SessionOwner owner,
        JsonObject args,
        CancellationToken token
    )
    {
        ToolRegistry.Keys(args, ["nodeId", "filePath", "parentNode"]);
        var id = (ToolRegistry.Text(args, "nodeId") ?? "").Trim();
        if (id.Length == 0)
            throw new InvalidDataException("node_create_auth_token nodeId is required.");
        var path = WorkspaceTools.PrivateNodeTokenPath(ToolRegistry.Text(args, "filePath") ?? "");
        var parent = ToolRegistry.Text(args, "parentNode");
        if (parent is not null && (parent.Length == 0 || parent != parent.Trim()))
            throw new InvalidDataException("parentNode must be an exact Node ID.");
        using var mutation = await Nodes.Registry.BeginMutationAsync(token);
        RequireNodeCreationParent(owner, parent);
        await AuthorizeToolAsync(
            owner,
            new("node_create_auth_token", "builtin", "node_create_auth_token", args),
            new WorkspaceTools(AgentDirectory(owner.Agent)),
            token
        );
        Nodes.Registry.RequireNewNode(
            Foxwarm.Nodes.ApprovedNodeRegistry.ValidateId(id, true),
            parent,
            mutation
        );
        token.ThrowIfCancellationRequested();
        var options = new FileStreamOptions
        {
            Mode = FileMode.CreateNew,
            Access = FileAccess.Write,
            Share = FileShare.None,
            Options = FileOptions.Asynchronous,
        };
        if (!OperatingSystem.IsWindows())
            options.UnixCreateMode = UnixFileMode.UserRead | UnixFileMode.UserWrite;
        // Exclusivity precedes reservation, including dangling symlinks. Never create parents.
        var file = new FileStream(path, options);
        JsonObject created;
        try
        {
            created = Nodes.Registry.Create(id, parent, mutation);
        }
        catch (Exception error)
        {
            await CloseTokenFileAsync(file);
            if (!CleanTokenFile(path))
                throw new IOException(
                    $"Node `{id}` registry reservation failed, and its newly created credential file may remain at {path}. Inspect both before retrying."
                );
            if (error is AuthorityCommittedException)
                throw new IOException(
                    $"Node `{id}` credential creation failed after a committed registry update. Its reservation is unconfirmed, and its credential file was cleaned. Inspect the registry before retrying.",
                    error
                );
            throw new IOException(
                $"Node `{id}` registry reservation failed after its newly created credential file was cleaned: {error.Message}",
                error
            );
        }
        try
        {
            var bytes = Encoding.UTF8.GetBytes(created["authToken"]!.GetValue<string>() + "\n");
            await file.WriteAsync(bytes, token);
            await file.DisposeAsync();
            return new() { ["nodeId"] = created["nodeId"]!.DeepClone(), ["filePath"] = path };
        }
        catch (Exception error)
        {
            await CloseTokenFileAsync(file);
            if (!CleanTokenFile(path))
                throw new IOException(
                    $"Node `{id}` remains reserved, and its credential file may remain at {path} after the write failed. Inspect the registry and file before retrying."
                );
            throw new IOException(
                $"Node `{id}` remains reserved, but its credential file could not be written and was cleaned: {error.Message}",
                error
            );
        }
    }

    private static async Task CloseTokenFileAsync(FileStream file)
    {
        try
        {
            await file.DisposeAsync();
        }
        catch (IOException) { }
    }

    private static bool CleanTokenFile(string path)
    {
        try
        {
            File.Delete(path);
            return true;
        }
        catch (IOException)
        {
            return false;
        }
        catch (UnauthorizedAccessException)
        {
            return false;
        }
    }
}
