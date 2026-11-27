using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal sealed record ResolvedTool(
    string InvocationName,
    string Source,
    string Name,
    JsonObject Args,
    string? Server = null,
    string ExecutionNode = "master"
)
{
    // The ctl command path (`node select`, `tool call`) when the call came through ctl. Display
    // and denial attribution only; it is never an authorization fact.
    internal string? Command { get; init; }

    // A Node file tool confined to the caller's own Agent folder (`node:@agent/<tool>`, or a
    // `$fw_agentdir` path without a current Node or master). Its ExecutionNode is master over
    // Agent folders and `@agent` over an Agent store.
    internal bool AgentFolder { get; init; }
}

internal sealed record RegisteredTool(
    JsonObject Definition,
    string Source,
    bool DefaultInject,
    Func<SessionToolExecutor, JsonObject, CancellationToken, Task<JsonNode?>> Execute,
    Func<bool>? Available = null
);

internal sealed class ToolRegistry(
    Foxwarm.McpClient mcp,
    Func<SessionOwner, string> workspace,
    Foxwarm.Nodes.NodeConnectionHub? nodes = null,
    Foxwarm.Nodes.NodeProviderRegistry? providers = null
)
{
    private readonly Dictionary<string, RegisteredTool> entries = new(StringComparer.Ordinal);
    internal Foxwarm.McpClient Mcp => mcp;
    internal Foxwarm.Nodes.NodeConnectionHub? Nodes => nodes;
    internal Foxwarm.Nodes.NodeProviderRegistry? Providers => providers;
    internal IEnumerable<RegisteredTool> Entries => entries.Values;

    // RuntimeCapabilities.MasterNode: without it, a call whose effect would land on master is
    // refused at resolution, before authorization or any effect.
    internal bool MasterNode { get; init; } = true;

    // Central known-secret masking for every dispatched result (builtin, MCP, Node,
    // Provider and ToolScript-nested), before the output guard saves or returns it.
    internal Func<JsonNode?, string, JsonNode?>? Redaction { get; set; }

    // True for a marker label of a currently masked value; writers reject such markers.
    internal Func<string, bool>? KnownSecretLabel { get; set; }

    // The unknown-tool error. The 0.9.5 front ends, still present in older Session histories and
    // persisted scripts, name their ctl replacement (user decision 2026-11-16); they are not
    // aliases and run nothing.
    internal static string UnknownTool(string name) =>
        name switch
        {
            "search_tools" => "Unknown tool: search_tools. Use `ctl tool search <words>`.",
            "call_tool" => "Unknown tool: call_tool. Use `ctl tool call <tool-id>` or the tool's `ctl` command.",
            _ => "Unknown tool: " + name,
        };

    internal void Register(
        JsonObject definition,
        string source,
        bool inject,
        Func<SessionToolExecutor, JsonObject, CancellationToken, Task<JsonObject>> handler
    )
    {
        var name =
            SessionWait.Text(definition["name"])
            ?? throw new InvalidDataException("Tool definition requires a name.");
        entries.Add(
            name,
            new(
                (JsonObject)definition.DeepClone(),
                source,
                inject,
                async (owner, args, token) => await handler(owner, args, token)
            )
        );
    }

    // Browser tools stay out of discovery while the machine cannot run them. A direct call still
    // reaches the host, which reports the precise reason.
    internal void RegisterBrowser(JsonObject definition, Func<bool> available)
    {
        var name = SessionWait.Text(definition["name"])!;
        entries.Add(
            name,
            new(
                (JsonObject)definition.DeepClone(),
                "node",
                false,
                (owner, args, token) => owner.Browser.Execute(name, args, token),
                available
            )
        );
    }

    internal JsonArray ModelDefinitions() =>
        new(
            entries
                .Values.Where(entry => entry.DefaultInject)
                .Select(entry => (JsonNode?)ToolCallControls.ForModel(entry.Definition))
                .ToArray()
        );

    // ctl is a front end: a command resolves to the canonical capability it names, with the
    // invocation recorded as ctl. Help, discovery and malformed commands stay with ctl itself.
    // ToolScript's call_tool("ctl", ...) host call is unwrapped the same way.
    internal static (string Invocation, JsonObject Args, bool Ctl) Unwrap(
        string invocation,
        JsonObject args
    )
    {
        var (target, targetArgs, ctl, _) = UnwrapCommand(invocation, args);
        return (target, targetArgs, ctl);
    }

    private static (string Invocation, JsonObject Args, bool Ctl, string? Command) UnwrapCommand(
        string invocation,
        JsonObject args
    )
    {
        if (invocation == "call_tool" && NamesCtl(args))
        {
            invocation = "ctl";
            args = ObjectArg(args, "args", "argsJson") ?? new JsonObject();
        }
        if (invocation != "ctl")
            return (invocation, args, false, null);
        return CtlParser.Parse(args) switch
        {
            CtlTarget target => (target.Name, target.Args, true, target.Command.Path),
            CtlCall call => ("call_tool", call.Descriptor, true, call.Command.Path),
            _ => ("ctl", args, true, null),
        };
    }

    private static bool NamesCtl(JsonObject descriptor) =>
        SessionWait.Text(descriptor["toolId"]) is { Length: > 0 } id
            ? id.Trim() == "builtin:ctl"
            : SessionWait.Text(descriptor["source"])?.Trim() == "builtin"
                && SessionWait.Text(descriptor["name"]) == "ctl";

    internal ResolvedTool Resolve(string invocation, JsonObject args, string currentNode = "master")
    {
        var (target, targetArgs, ctl, command) = UnwrapCommand(invocation, args);
        if (!ctl)
            return ResolveConcrete(invocation, args, currentNode);
        if (target == "ctl")
            return new("ctl", "builtin", "ctl", (JsonObject)targetArgs.DeepClone());
        return ResolveConcrete(target, targetArgs, currentNode) with
        {
            InvocationName = "ctl",
            Command = command,
        };
    }

    private ResolvedTool ResolveConcrete(string invocation, JsonObject args, string currentNode)
    {
        if (invocation != "call_tool")
        {
            if (!entries.TryGetValue(invocation, out var direct))
            {
                if (
                    currentNode != "master"
                    && nodes is not null
                    && Definitions(currentNode)
                        .Any(value => SessionWait.Text(value?["name"]) == invocation)
                )
                    return new(
                        invocation,
                        "node",
                        invocation,
                        (JsonObject)args.DeepClone(),
                        ExecutionNode: currentNode
                    );
                throw new InvalidDataException(UnknownTool(invocation));
            }
            return new(
                invocation,
                direct.Source,
                invocation,
                (JsonObject)args.DeepClone(),
                ExecutionNode: direct.Source == "node" ? currentNode
                    : invocation is "run_script" or "start_toolscript_run"
                        ? ToolScriptSourceNode(args, currentNode) ?? "master"
                    : invocation == "artifact" && ArtifactFileSource(args)
                        ? ArtifactSourceNode(args, currentNode)
                    : invocation is "send_file" or "image_write_to_file"
                        ? TargetNode(Text(args, "node"), currentNode)
                    : "master"
            );
        }
        Keys(args, ["toolId", "source", "name", "server", "nodeId", "args", "argsJson"]);
        var source = Text(args, "source")?.Trim();
        var name = Text(args, "name");
        var server = Text(args, "server");
        var node = Text(args, "nodeId");
        if (Text(args, "toolId") is string id && id.Length > 0)
        {
            if (id.StartsWith("builtin:", StringComparison.Ordinal))
            {
                source = "builtin";
                name = id[8..].Trim();
            }
            else if (
                id.StartsWith("node:", StringComparison.Ordinal)
                || id.StartsWith("mcp:", StringComparison.Ordinal)
            )
            {
                source = id[..id.IndexOf(':')];
                var rest = id[(source.Length + 1)..];
                var slash = source == "node" ? rest.LastIndexOf('/') : rest.IndexOf('/');
                if (slash <= 0 || slash == rest.Length - 1)
                    throw new InvalidDataException("Invalid toolId: " + id);
                name = rest[(slash + 1)..];
                if (source == "mcp")
                    server = rest[..slash];
                else
                    node = rest[..slash];
            }
            else
                throw new InvalidDataException("Unsupported toolId source: " + id);
        }
        if (source is not ("builtin" or "node" or "mcp") || string.IsNullOrEmpty(name))
            throw new InvalidDataException(
                "A tool call requires either toolId or a valid source and tool name."
            );
        var targetArgs = ObjectArg(args, "args", "argsJson", required: true)!;
        if (source == "mcp")
        {
            if (string.IsNullOrEmpty(server))
                throw new InvalidDataException("MCP calls require an explicit server.");
            return new(invocation, source, name, targetArgs, server);
        }
        if (name == "ctl" && source == "builtin")
            throw new InvalidDataException(
                "`ctl` is a command front end, not a concrete tool; run the command directly."
            );
        if (source == "node" && node?.Trim() == AgentStorePaths.Endpoint)
            return AgentFolderTool(invocation, name, targetArgs);
        var targetNode = TargetNode(node, currentNode);
        if (source == "node" && targetNode != "master")
        {
            if (
                nodes is null
                || !Definitions(targetNode).Any(value => SessionWait.Text(value?["name"]) == name)
            )
                throw new InvalidDataException("Tool is not advertised by Node: " + name);
            return new(invocation, source, name, targetArgs, ExecutionNode: targetNode);
        }
        if (!entries.TryGetValue(name, out var registration))
            throw new InvalidDataException(UnknownTool(name));
        if (registration.Source != source)
            throw new InvalidDataException(
                $"Tool `{name}` is a {registration.Source} capability, not {source}."
            );
        if (source == "node")
            LocalNode(node);
        else if (node is not null)
            throw new InvalidDataException("Builtin tools do not support Node selection.");
        return new(
            invocation,
            source,
            name,
            targetArgs,
            ExecutionNode: source == "node" ? targetNode
                : name is "run_script" or "start_toolscript_run"
                    ? ToolScriptSourceNode(targetArgs, currentNode) ?? "master"
                : name == "artifact" && ArtifactFileSource(targetArgs)
                    ? ArtifactSourceNode(targetArgs, currentNode)
                : name is "send_file" or "image_write_to_file"
                    ? TargetNode(Text(targetArgs, "node"), currentNode)
                : "master"
        );
    }

    internal async Task<JsonNode?> ExecuteAsync(
        ResolvedTool resolved,
        SessionToolExecutor owner,
        CancellationToken cancellationToken
    )
    {
        cancellationToken.ThrowIfCancellationRequested();
        var generation = owner.Hosted.McpGeneration;
        await owner.AuthorizeAsync(resolved, cancellationToken);
        cancellationToken.ThrowIfCancellationRequested();
        if (
            KnownSecretLabel is { } known
            && resolved
                is { Source: "node", Name: "write" or "edit" or "apply_patch" }
                    or {
                        Source: "builtin",
                        Name: "mcp_config"
                            or "write_memory"
                            or "edit_memory"
                            or "apply_patch_memory"
                    }
        )
            Foxwarm.Secrets.SecretMarkerGuard.Require(resolved.Args, known);
        var result =
            resolved.Source == "mcp"
                ? await mcp.CallAsync(
                    resolved.Server!,
                    resolved.Name,
                    resolved.Args,
                    cancellationToken,
                    owner.Hosted,
                    generation
                )
            : resolved is { Source: "node", Name: "exec" }
            && providers?.IsProviderNode(resolved.ExecutionNode) == true
                ? await owner.ExecuteProviderExecAsync(resolved, cancellationToken)
            : resolved is { Source: "node", AgentFolder: true }
                ? await owner.ExecuteAgentFolderAsync(resolved.Name, resolved.Args, cancellationToken)
            : resolved.Source == "node" && resolved.ExecutionNode != "master"
                ? await ExecuteNodeAsync(
                    resolved.ExecutionNode,
                    resolved.Name,
                    resolved.Args,
                    owner.Hosted.Id,
                    owner.Hosted.Agent,
                    owner.ExecutionNode,
                    owner.ExecutionCwd,
                    owner.Programmatic,
                    cancellationToken,
                    owner.Hosted,
                    owner.RemoteResultMetadata(resolved),
                    owner.ScriptBudget
                )
            : await entries[resolved.Name].Execute(owner, resolved.Args, cancellationToken);
        if (
            resolved is { Source: "node", Name: "exec" }
            && resolved.ExecutionNode != "master"
            && providers?.IsProviderNode(resolved.ExecutionNode) != true
        )
            owner.SettleRemoteExec(resolved);
        if (Redaction is { } redact)
            result = redact(result, owner.Hosted.Id);
        if (owner.Programmatic)
        {
            owner.ScriptBudget!.JsonValue(result);
            // Local files publish structured data; only directory listings have a sole output field.
            if (
                resolved is { Source: "node", ExecutionNode: "master", Name: "read" }
                && result is JsonObject { Count: 1 } localRead
                && localRead["output"] is JsonValue output
                && output.TryGetValue<string>(out var listing)
            )
                return JsonValue.Create(listing);
            return result;
        }
        return await ToolOutputGuard.GuardAsync(
            result,
            text =>
                owner.SaveToolOutputAsync(
                    text,
                    resolved.ExecutionNode,
                    workspace(owner.Hosted),
                    cancellationToken
                ),
            owner.ToolScriptExecution
        );
    }

    internal static bool ArtifactFileSource(JsonObject args) =>
        SessionWait.Text(args["action"]) is "prepare" or "publish";

    internal static string ArtifactSourceNode(JsonObject args, string currentNode)
    {
        var node = Text(args, "node") ?? currentNode;
        if (
            !System.Text.RegularExpressions.Regex.IsMatch(
                node,
                @"^(?:[A-Za-z0-9._:-]{1,128}|[A-Za-z0-9][A-Za-z0-9._:-]{0,63}/[A-Za-z0-9][A-Za-z0-9._:-]{0,127})$"
            )
        )
            throw new InvalidDataException("Invalid source Node");
        return node;
    }

    internal static string? ToolScriptSourceNode(JsonObject args, string currentNode)
    {
        if (!string.IsNullOrWhiteSpace(Text(args, "code")))
        {
            if (args.ContainsKey("node"))
                throw new InvalidDataException("node applies only to filePath, not inline code.");
            return null;
        }
        return TargetNode(Text(args, "node"), currentNode);
    }

    internal static string TargetNode(string? node, string currentNode) =>
        string.IsNullOrWhiteSpace(node)
        || node.Trim().Equals("current", StringComparison.OrdinalIgnoreCase)
            ? SessionGoal.Trim(currentNode)
            : node.Trim();

    internal JsonArray NodeDefinitions(string id) =>
        id == "master" && !MasterNode ? throw RuntimeCapabilities.MasterUnavailable()
        : id == "master"
            ? new JsonArray(
                entries
                    .Values.Where(entry => entry.Source == "node" && (entry.Available?.Invoke() ?? true))
                    .Select(entry => (JsonNode?)entry.Definition.DeepClone())
                    .ToArray()
            )
            : Definitions(id);

    private JsonArray Definitions(string id) =>
        providers?.Definitions(id)
        ?? (nodes ?? throw new InvalidDataException("Remote Nodes are unavailable.")).Definitions(
            id
        );

    internal Task RefreshNodeAsync(string id, CancellationToken token) =>
        providers?.RefreshAsync(id, token) ?? Task.CompletedTask;

    internal async Task<ResolvedTool> ResolveAsync(
        string invocation,
        JsonObject args,
        string currentNode,
        CancellationToken token
    )
    {
        var (expanded, expandedArgs, _) = Unwrap(invocation, args);
        var resolvedArgs = args;
        args = expandedArgs;
        var resolvedInvocation = invocation;
        invocation = expanded;
        var target = currentNode;
        var toolId = Text(args, "toolId");
        var nodeCapability =
            invocation == "call_tool"
                ? toolId is { Length: > 0 }
                    ? toolId.StartsWith("node:", StringComparison.Ordinal)
                    : Text(args, "source")?.Trim() == "node"
                : !entries.TryGetValue(invocation, out var direct) || direct.Source == "node";
        if (invocation == "call_tool")
        {
            target = TargetNode(Text(args, "nodeId"), currentNode);
            if (
                Text(args, "toolId") is string id
                && id.StartsWith("node:", StringComparison.Ordinal)
                && id.LastIndexOf('/') > 5
            )
                target = id[5..id.LastIndexOf('/')];
        }
        if (nodeCapability && target is not ("master" or AgentStorePaths.Endpoint) && invocation != "ctl")
            await RefreshNodeAsync(target, token);
        var resolved = Resolve(resolvedInvocation, resolvedArgs, currentNode);
        // Without master, a Session without a Node reaches its Agent folder through
        // `$fw_agentdir`, as on master.
        if (
            !MasterNode
            && currentNode == "master"
            && resolved is { Source: "node", ExecutionNode: "master", AgentFolder: false, Name: "read" or "write" or "edit" }
            && !NamesMaster(resolvedInvocation, resolvedArgs, invocation, args, resolved)
            && FolderPaths(resolved) is { Count: > 0 } paths
            && paths.All(AgentFolderPaths.NamesFolder)
        )
            resolved = resolved with { ExecutionNode = AgentStorePaths.Endpoint, AgentFolder = true };
        // Without master, a configuration candidate is a file of the Agent's folder.
        if (
            !MasterNode
            && resolved is { Source: "builtin", Name: "set_config" or "explain_tool_authorization" }
            && resolved.Args.ContainsKey(resolved.Name == "set_config" ? "filePath" : "policyFilePath")
        )
            resolved = resolved with { AgentFolder = true };
        if (!MasterNode && TargetsMaster(resolved))
            throw currentNode == "master" && !NamesMaster(resolvedInvocation, resolvedArgs, invocation, args, resolved)
                ? RuntimeCapabilities.NoCurrentNode()
                : RuntimeCapabilities.MasterUnavailable();
        // A move from configuration needs what reading the value directly would: a master read
        // of the file holding it. Without master no tool reads the tenant documents.
        if (!MasterNode && resolved is { Source: "builtin", Name: "add_secret" } && resolved.Args.ContainsKey("fromConfig"))
            throw new InvalidDataException(
                "fromConfig is not available on this server: no tool reads its configuration documents. Give the value with value or filePath."
            );
        return resolved;
    }

    // Whether a call that targets master names it, rather than reaching it through the Session's
    // current Node. A Node tool names it only as a call_tool target; for a builtin, the call is
    // resolved again with another current Node, which is pure for builtins, and still targets
    // master only when an argument names it.
    private bool NamesMaster(
        string resolvedInvocation,
        JsonObject resolvedArgs,
        string invocation,
        JsonObject args,
        ResolvedTool resolved
    )
    {
        if (resolved.Source == "node")
            return invocation == "call_tool"
                && (
                    Text(args, "toolId") is { } id && id.StartsWith("node:master/", StringComparison.Ordinal)
                    || TargetNode(Text(args, "nodeId"), "") == "master"
                );
        if (resolved.Source != "builtin")
            return true;
        try
        {
            return TargetsMaster(Resolve(resolvedInvocation, resolvedArgs, "\u0000current"));
        }
        catch (InvalidDataException)
        {
            return true;
        }
    }

    // Whether a resolved call reads, writes or runs anything on master: a Node tool there, a
    // builtin whose Node endpoints include it, a ToolScript file there, or a builtin that reads
    // or writes a Main-local file it is given.
    internal static bool TargetsMaster(ResolvedTool resolved)
    {
        if (resolved.Source == "node")
            return resolved.ExecutionNode == "master";
        if (resolved.Source != "builtin")
            return false;
        var args = resolved.Args;
        if (
            ToolAuthorizationNodeEffects.Resolve("builtin", resolved.Name, resolved.ExecutionNode, args)
            is { } endpoints
            && endpoints.Contains("master")
        )
            return true;
        return resolved.Name switch
        {
            "run_script" or "start_toolscript_run" => ToolScriptSourceNode(
                args,
                resolved.ExecutionNode
            ) == "master",
            // Main-local files: the candidate of set_config and explain, and the new owner-only
            // token files of node_bootstrap_info and node_create_auth_token.
            "set_config" => !resolved.AgentFolder && args.ContainsKey("filePath"),
            "node_bootstrap_info" or "node_create_auth_token" => args.ContainsKey("filePath"),
            "explain_tool_authorization" => !resolved.AgentFolder && args.ContainsKey("policyFilePath"),
            _ => false,
        };
    }

    private Task<JsonNode?> ExecuteNodeAsync(
        string node,
        string name,
        JsonObject args,
        string sessionId,
        string agent,
        string currentNode,
        string? cwd,
        bool programmatic,
        CancellationToken token,
        SessionOwner owner,
        Action<JsonNode?>? metadata,
        Foxwarm.ToolScript.ToolScriptDataBudget? budget
    ) =>
        providers is not null
            ? providers.ExecuteAsync(
                node,
                name,
                args,
                sessionId,
                agent,
                currentNode,
                cwd,
                programmatic,
                token,
                owner,
                metadata,
                budget
            )
            : (
                nodes ?? throw new InvalidOperationException("Remote Nodes are unavailable.")
            ).ExecuteAsync(
                node,
                name,
                args,
                sessionId,
                agent,
                currentNode,
                cwd,
                programmatic,
                token,
                owner,
                metadata
            );

    // The Agent-folder file tools: read, write and edit, on master's file tools over Agent
    // folders and on the Agent store without master.
    private ResolvedTool AgentFolderTool(string invocation, string name, JsonObject args)
    {
        if (name is not ("read" or "write" or "edit"))
            throw new InvalidDataException("Tool is not advertised by Node: " + name);
        return new(
            invocation,
            "node",
            name,
            args,
            ExecutionNode: MasterNode ? "master" : AgentStorePaths.Endpoint
        )
        {
            AgentFolder = true,
        };
    }

    // The paths a Node file call names: its filePath, or the files of its patch.
    private static IReadOnlyList<string?> FolderPaths(ResolvedTool resolved)
    {
        if (resolved.Name == "edit" && resolved.Args.ContainsKey("apply_patch"))
            try
            {
                return WorkspacePatch
                    .Parse(Text(resolved.Args, "apply_patch") ?? "")
                    .Select(operation => (string?)operation.Path)
                    .ToArray();
            }
            catch (InvalidDataException)
            {
                return [];
            }
        return [Text(resolved.Args, "filePath")];
    }

    internal static void LocalNode(string? node)
    {
        if (
            node is null
            || string.IsNullOrWhiteSpace(node)
            || node.Trim().Equals("current", StringComparison.OrdinalIgnoreCase)
            || node.Trim() == "master"
        )
            return;
        throw new InvalidDataException("Node is not available: " + node);
    }

    internal static void Keys(JsonObject args, IEnumerable<string> allowed)
    {
        if (args.Any(pair => !allowed.Contains(pair.Key, StringComparer.Ordinal)))
            throw new InvalidDataException("Unsupported tool argument.");
    }

    internal static string? Text(JsonObject args, string key) =>
        args[key] is null
            ? null
            : SessionWait.Text(args[key])
                ?? throw new InvalidDataException(key + " must be a string.");

    internal static JsonObject? ObjectArg(
        JsonObject args,
        string key,
        string fallback,
        bool required = false
    )
    {
        if (args[key] is JsonObject primary)
            return (JsonObject)primary.DeepClone();
        if (args.ContainsKey(fallback))
        {
            var value = JsonNode.Parse(
                Text(args, fallback)
                    ?? throw new InvalidDataException(fallback + " must be a JSON object string.")
            );
            return value is JsonObject obj
                ? obj
                : throw new InvalidDataException(fallback + " must parse as a JSON object.");
        }
        if (args.ContainsKey(key) || required)
            throw new InvalidDataException(
                key + " must be a JSON object, or provide " + fallback + "."
            );
        return null;
    }
}
