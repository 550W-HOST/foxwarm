using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.ToolScript;

namespace Foxwarm.Tools;

internal sealed partial class SessionToolExecutor
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

    private sealed record ScriptScope(string LiteralOwner, ToolScriptDataBudget Budget);

    private readonly AsyncLocal<ScriptScope?> scriptScope = new();
    internal bool Programmatic => scriptScope.Value is not null;
    internal ToolScriptDataBudget? ScriptBudget => scriptScope.Value?.Budget;

    private async Task<JsonObject> ExecuteToolScriptAsync(
        string name,
        JsonObject args,
        CancellationToken token
    )
    {
        var rootCall = invocation.Value;
        var nested = Programmatic;
        var literal = scriptScope.Value?.LiteralOwner ?? hosted.Id;
        ToolScriptContext context = null!;
        context = new ToolScriptContext(
            hosted,
            literal,
            async (wrapper, budget, currentToken) =>
            {
                var previous = scriptScope.Value;
                scriptScope.Value = new(literal, budget);
                try
                {
                    var resolved = registry.Resolve(
                        "call_tool",
                        wrapper,
                        sessions.CurrentNode(hosted)
                    );
                    var concrete = new JsonObject
                    {
                        ["name"] = resolved.Name,
                        ["args"] = resolved.Args.DeepClone(),
                    };
                    var planned = ToolCallControls.Plan([concrete], HandoffConfirmationEnabled)[0];
                    if (planned.Preset is not null)
                        return planned.Preset;
                    var request = (JsonObject)wrapper.DeepClone();
                    request["args"] = planned.Call["args"]!.DeepClone();
                    var execution = await ExecuteAttributedAsync(
                        new JsonObject
                        {
                            ["id"] = rootCall?.CallId ?? "",
                            ["name"] = "call_tool",
                            ["args"] = request,
                        },
                        currentToken
                    );
                    if (execution.SessionMessages is { Count: > 0 } deliveries)
                        foreach (var delivery in deliveries.OfType<JsonObject>())
                            context.SessionMessageDelivered?.Invoke(delivery);
                    if (
                        execution.Receipt is not null
                        && resolved.Name == "task"
                        && SessionWait.Text(resolved.Args["action"]) == "complete"
                        && rootCall is not null
                    )
                        rootCall.Receipt = execution.Receipt;
                    if (PolicyUnavailable)
                        throw new ToolScriptHostFatalException(
                            new ToolAuthorizationUnavailableException()
                        );
                    hosted.Entry.RequireIdentityAuthority();
                    return await sessions.NormalizeToolScriptResultAsync(
                        execution.Response,
                        resolved.Name,
                        budget,
                        currentToken
                    );
                }
                catch (SessionIdentityUnavailableException error)
                {
                    throw new ToolScriptHostFatalException(error);
                }
                finally
                {
                    scriptScope.Value = previous;
                }
            },
            (prompt, model, budget, currentToken) =>
                sessions.RequestToolScriptModelAsync(hosted, prompt, model, budget, currentToken),
            async (file, budget, currentToken) =>
            {
                await sessions.WaitForIdentityMutationAsync(hosted.Id, currentToken);
                hosted.Entry.RequireIdentityAuthority();
                var source =
                    rootCall?.ScriptSource
                    ?? throw new InvalidOperationException(
                        "ToolScript source routing was not captured."
                    );
                var node = source.Node;
                var cwd = source.Cwd;
                var files = source.Files;
                if (node != "master")
                {
                    var raw = file;
                    await sessions.AuthorizeNodeFileAsync(
                        hosted,
                        node,
                        raw,
                        "read",
                        files,
                        currentToken
                    );
                    string? resolvedPath = null;
                    await sessions.Nodes.ExecuteAsync(
                        node,
                        "read",
                        new JsonObject { ["filePath"] = file },
                        hosted.Id,
                        hosted.Agent,
                        node,
                        cwd,
                        true,
                        currentToken,
                        hosted,
                        value =>
                        {
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
                    var transferred = await sessions.ReadNodeFileAsync(
                        hosted,
                        node,
                        resolvedPath ?? RemoteSourcePath(file, cwd),
                        files,
                        currentToken,
                        size => budget.Charge(checked(8L * size))
                    );
                    return (
                        transferred.Path,
                        new System.Text.UTF8Encoding(false, true).GetString(transferred.Bytes)
                    );
                }
                var actual = files.Paths.FilePath(file);
                await sessions.AuthorizeToolAsync(
                    hosted,
                    new ResolvedTool(
                        "read",
                        "node",
                        "read",
                        new JsonObject { ["filePath"] = file }
                    ),
                    files,
                    currentToken,
                    toolScriptSourceRead: true
                );
                sessions.RequireToolScriptPath(hosted, actual);
                if (!WorkspaceTools.RegularFile(actual))
                    throw new FileNotFoundException(
                        "ToolScript source must be a regular file.",
                        actual
                    );
                await using var stream = new FileStream(
                    actual,
                    FileMode.Open,
                    FileAccess.Read,
                    FileShare.ReadWrite,
                    65536,
                    FileOptions.Asynchronous
                );
                var length = stream.Length;
                budget.Charge(checked(8 * length));
                if (length > int.MaxValue)
                    throw new ToolScriptDataLimitException(
                        "ToolScript source exceeds its materialization budget."
                    );
                var bytes = new byte[(int)length];
                await stream.ReadExactlyAsync(bytes, currentToken);
                return (actual, new System.Text.UTF8Encoding(false, true).GetString(bytes));
            },
            nested
                ? null
                : calls =>
                {
                    if (rootCall is not null)
                        rootCall.ToolScriptSubCalls = (JsonArray)calls.DeepClone();
                    hosted.Emit(
                        SessionEventKind.ModelStream,
                        new JsonObject
                        {
                            ["type"] = "toolscript-progress",
                            ["toolUseId"] = rootCall?.CallId,
                            ["subCalls"] = calls.DeepClone(),
                        }
                    );
                },
            rootCall?.ScriptSource?.Node
        );
        return await sessions.ToolScript.ExecuteAsync(name, args, context, token);
    }
}
