using System.Text;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal sealed partial class SessionToolExecutor
{
    internal async Task<ToolOutputGuard.SavedOutput> SaveToolOutputAsync(
        string text,
        string node,
        string workspace,
        CancellationToken token
    )
    {
        try
        {
            var name = "result-" + Guid.NewGuid().ToString("N") + ".txt";
            var path = ".temp/tool-output/" + name;
            var files = new WorkspaceTools(workspace);
            var mainResult = node == "master";
            if (node != "master" && sessions.NodeProviders.Online(node))
            {
                var capabilities = sessions.NodeProviders.Definitions(node);
                if (
                    !new[] { "read", "write" }.All(name =>
                        capabilities.Any(tool => SessionWait.Text(tool?["name"]) == name)
                    )
                )
                    // Capability limits do not remove an otherwise authorized Main spool.
                    node = "master";
            }
            if (node == "master")
            {
                try
                {
                    await sessions.AuthorizeNodeFileAsync(
                        hosted,
                        node,
                        Path.Combine(workspace, ".temp", "tool-output", name),
                        "read",
                        files,
                        token
                    );
                }
                catch (ToolAuthorizationDeniedException) when (mainResult)
                {
                    // Main-produced results must remain retrievable by a Node-bound caller.
                    // Unavailable policy is not a deny and must never select a different destination.
                    node = sessions.CurrentNode(hosted);
                    if (node == "master")
                        throw;
                }
                if (node == "master")
                    return await ToolOutputGuard.SaveLocalAsync(text, workspace, name);
            }
            await sessions.AuthorizeNodeFileAsync(hosted, node, path, "read", files, token);
            await sessions.AuthorizeNodeFileAsync(hosted, node, path, "write", files, token);
            if (sessions.NodeProviders.IsProviderNode(node))
            {
                // Match ordinary provider file tools: paths remain target-owned and use the captured cwd.
                var placement = sessions.ExecutionPlacement(hosted);
                var cwd = placement.Node == node ? placement.Cwd : null;
                var operations = await sessions.NodeProviders.FileOperationsAsync(
                    node,
                    true,
                    cwd,
                    token
                );
                hosted.Entry.RequireIdentityAuthority();
                await TargetFileContent.WriteAsync(
                    operations,
                    path,
                    Encoding.UTF8.GetBytes(text),
                    false,
                    token
                );
                return new(path, node, true, cwd);
            }
            var saved = await sessions.WriteNodeFileAsync(
                hosted,
                node,
                path,
                Encoding.UTF8.GetBytes(text),
                false,
                files,
                token
            );
            return new(saved, node);
        }
        catch (ToolAuthorizationUnavailableException)
        {
            Interlocked.Exchange(ref policyUnavailable, 1);
            throw;
        }
    }
}
