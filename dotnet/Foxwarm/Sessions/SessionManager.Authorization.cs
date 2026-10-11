using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private readonly ToolAuthorizationAuthority authorization;
    private readonly string toolWorkspace;
    internal ToolAuthorizationAuthority Authorization => authorization;

    internal AgentIsolation Isolation(string agent) =>
        IsolatedToolCompatibility.Metadata(agents.MetadataSnapshot()[agent]);

    internal string? RecordedIsolationNode(string agent) => Isolation(agent).RecordedNode;

    internal bool AgentIsolated(string agent) => Isolation(agent).Isolated;

    private string? AuthorizationParent(JsonObject? row)
    {
        var raw = SessionCatalog.Text(row?["parentSessionId"]);
        if (raw is null)
            return null;
        return SessionCatalog.Text(Catalog.Resolve(raw)["sessionId"]) ?? raw;
    }

    internal AuthorizationTarget? AuthorizationTarget(string requested)
    {
        var id = SessionCatalog.Text(Catalog.Resolve(requested)["sessionId"]);
        var row = id is null ? null : Catalog.Get(id);
        return
            row is null
            || SessionCatalog.Text(row["agent"]) is not string agent
            || agent.Length == 0
            ? null
            : new(id!, agent, AuthorizationParent(row));
    }

    private ToolAuthorizationRequest AuthorizationRequest(
        SessionOwner owner,
        string source,
        string name,
        string? server,
        JsonObject args,
        IReadOnlyList<AuthorizationPath> paths,
        string node = "master"
    ) =>
        new(
            source,
            name,
            server,
            args,
            paths,
            owner.Agent,
            owner.Id,
            node,
            toolWorkspace,
            agents.AgentDirectory(owner.Agent),
            agents.MemoryDirectory(owner.Agent)
        );

    private ToolAuthorizationRequest PopulateAuthorizationTargets(
        ToolAuthorizationRequest request,
        SessionOwner owner
    )
    {
        var parent = AuthorizationParent(Catalog.Get(owner.Id));
        string? requested = SessionWait.Text(request.Args["sessionId"]);
        requested = requested is null ? null : SessionGoal.Trim(requested);
        if (requested is "")
            requested = null;
        if (
            request.Source != "builtin"
            || !ToolAuthorizationPolicy.TargetFamilies.TryGetValue(request.Name, out var family)
        )
            return request with { SourceParent = parent };
        if (family == "send")
        {
            if (requested is null)
                return request with { SourceParent = parent };
            try
            {
                requested = ResolveSessionReference(owner, requested);
            }
            catch (InvalidDataException)
            {
                return request with { SourceParent = parent };
            }
        }
        else if (family == "file")
        {
            if (
                SessionWait.Text(request.Args["channelTargetId"]) is string channel
                && SessionGoal.Trim(channel).Length > 0
            )
                return request with { SourceParent = parent };
            requested ??= owner.Id;
        }
        else if (family == "required")
        {
            if (requested is null)
                return request with { SourceParent = parent };
        }
        else if (family == "recall")
        {
            if (
                requested is null
                && SessionWait.Text(request.Args["vector_query"]) is string vector
                && SessionGoal.Trim(vector).Length > 0
                && SessionWait.Text(request.Args["scope"]) != "current-session"
            )
                return request with { SourceParent = parent };
            requested ??= owner.Id;
        }
        else
            requested ??= owner.Id;
        return request with
        {
            SourceParent = parent,
            SessionTarget = AuthorizationTarget(requested),
        };
    }

    internal async Task AuthorizeToolAsync(
        SessionOwner owner,
        ResolvedTool resolved,
        WorkspaceTools? files,
        CancellationToken token,
        SessionOwner? concreteTarget = null
    )
    {
        owner.Entry.RequireIdentityAuthority();
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException(
                "Tool source is no longer the current Session owner."
            );
        if (
            resolved.Source == "node"
            || resolved.Source == "builtin"
                && resolved.Name is "run_script" or "start_toolscript_run"
        )
            RequireNodeBoundary(owner, resolved.ExecutionNode);
        if (resolved.Source == "builtin" && resolved.Name is "send_file" or "image_write_to_file")
            RequireFileNodeBoundary(owner, resolved.ExecutionNode);
        if (resolved.Source == "builtin" && resolved.Name == "copy_between_nodes")
            foreach (var key in new[] { "sourceNode", "targetNode" })
                RequireFileNodeBoundary(owner, SessionWait.Text(resolved.Args[key])?.Trim() ?? "");
        var remote =
            resolved.ExecutionNode != "master"
            && (
                resolved.Source == "node"
                || resolved.Source == "builtin"
                    && resolved.Name
                        is "send_file"
                            or "image_write_to_file"
                            or "run_script"
                            or "start_toolscript_run"
            );
        var paths =
            resolved.Source == "builtin" && resolved.Name == "copy_between_nodes"
                ? CopyAuthorizationPaths(owner, resolved.Args)
            : remote ? RemoteAuthorizationPaths(resolved)
            : resolved.Source == "node"
                && resolved.Name is "read" or "write" or "edit" or "apply_patch" or "exec"
            || resolved.Source == "builtin"
                && resolved.Name
                    is "set_config"
                        or "send_file"
                        or "image_write_to_file"
                        or "run_script"
                        or "start_toolscript_run"
                ? (
                    files
                    ?? throw new NotSupportedException(
                        "This executor has no physical path resolver."
                    )
                ).AuthorizationFacts(resolved.Name, resolved.Args)
            : resolved.Source == "builtin"
            && resolved.Name
                is "read_memory"
                    or "write_memory"
                    or "edit_memory"
                    or "delete_memory"
                    or "apply_patch_memory"
                ? MemoryTools.AuthorizationFacts(this, owner, resolved.Name, resolved.Args)
            : [];
        var request = AuthorizationRequest(
            owner,
            resolved.Source,
            resolved.Name,
            resolved.Server,
            resolved.Args,
            paths,
            resolved.Name == "node"
            && SessionWait.Text(resolved.Args["nodeId"]) is string targetNode
                ? targetNode.Trim()
                : resolved.ExecutionNode
        );
        var policy = await authorization.LoadAsync(token);
        if (concreteTarget is not null)
        {
            if (!IsCurrentOwner(concreteTarget))
                throw new InvalidOperationException(
                    "Tool target is no longer the current Session owner."
                );
            request = request with
            {
                SourceParent = AuthorizationParent(Catalog.Get(owner.Id)),
                SessionTarget = new(
                    concreteTarget.Id,
                    concreteTarget.Agent,
                    AuthorizationParent(Catalog.Get(concreteTarget.Id))
                ),
            };
        }
        else if (ToolAuthorizationEvaluation.NeedsTarget(policy, request))
            request = PopulateAuthorizationTargets(request, owner);
        var decision = ToolAuthorizationEvaluation.Evaluate(policy, request);
        if (!decision.Allowed)
            throw new ToolAuthorizationDeniedException(
                SessionWait.Text(decision.Rule?["reason"])
                    ?? $"Tool authorization rule denies {resolved.Source} capability `{resolved.Name}`."
            );
        IsolatedToolCompatibility.Check(Isolation(owner.Agent), request, AuthorizationTarget);
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException(
                "Tool source is no longer the current Session owner."
            );
    }

    internal bool ToolVisible(
        SessionOwner owner,
        string source,
        string name,
        string? server = null,
        bool unknownNode = false,
        string? node = null
    )
    {
        if (name == "call_tool" && source == "builtin")
            return true;
        var targetNode =
            node
            ?? (
                source == "node"
                || source == "builtin" && name is "send_file" or "image_write_to_file"
                    ? CurrentNode(owner)
                    : "master"
            );
        if (
            source == "node"
            && AgentIsolated(owner.Agent)
            && targetNode != (RecordedIsolationNode(owner.Agent) ?? "master")
        )
            return false;
        var request = AuthorizationRequest(owner, source, name, server, new(), [], targetNode);
        return ToolAuthorizationEvaluation.Visible(authorization.Load(), request, unknownNode)
            && IsolatedToolCompatibility.Visible(
                Isolation(owner.Agent),
                source,
                name,
                server,
                unknownNode,
                targetNode
            );
    }

    internal JsonArray ModelDefinitions(SessionOwner owner, JsonArray? explicitOverride = null)
    {
        if (explicitOverride is not null)
            return (JsonArray)explicitOverride.DeepClone();
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException(
                "Model request source is no longer the current Session owner."
            );
        var node = CurrentNode(owner);
        var definitions = tools
            .Entries.Where(entry =>
                entry.DefaultInject
                && entry.Source != "node"
                && ToolVisible(owner, entry.Source, SessionWait.Text(entry.Definition["name"])!)
            )
            .Select(entry => (JsonNode?)ToolCallControls.ForModel(entry.Definition))
            .ToList();
        foreach (
            var definition in (
                node == "master" ? tools.NodeDefinitions(node) : Nodes.DiscoveredDefinitions(node)
            ).OfType<JsonObject>()
        )
        {
            var name = SessionWait.Text(definition["name"])!;
            if (
                node != "master"
                && tools.Entries.Any(entry =>
                    entry.Source == "builtin" && SessionWait.Text(entry.Definition["name"]) == name
                )
            )
                continue;
            if (ToolVisible(owner, "node", name, node: node))
                definitions.Add(ToolCallControls.ForModel(definition));
        }
        return new JsonArray(definitions.ToArray());
    }

    private static IReadOnlyList<AuthorizationPath> RemoteAuthorizationPaths(ResolvedTool resolved)
    {
        var paths = new List<AuthorizationPath>();
        if (
            resolved.Name is "run_script" or "start_toolscript_run"
            && SessionWait.Text(resolved.Args["code"]) is { } code
            && !string.IsNullOrWhiteSpace(code)
        )
            return paths;
        foreach (var key in new[] { "filePath", "cwd" })
            if (SessionWait.Text(resolved.Args[key]) is string raw)
                paths.Add(new(key, raw, null, resolved.ExecutionNode));
        if (
            resolved.Name == "apply_patch"
            && SessionWait.Text(resolved.Args["input"]) is string patch
        )
            foreach (
                System.Text.RegularExpressions.Match match in System.Text.RegularExpressions.Regex.Matches(
                    patch,
                    @"^\*\*\* (?:Add|Update|Delete) File: (.+)$",
                    System.Text.RegularExpressions.RegexOptions.Multiline
                )
            )
                paths.Add(
                    new("input", match.Groups[1].Value.TrimEnd('\r'), null, resolved.ExecutionNode)
                );
        return paths;
    }

    internal async Task<JsonObject> InstallConfigAsync(
        SessionOwner owner,
        WorkspaceTools files,
        JsonObject args,
        CancellationToken token
    )
    {
        ToolRegistry.Keys(args, ["target", "filePath"]);
        var path = ToolRegistry.Text(args, "filePath");
        var target = ToolRegistry.Text(args, "target");
        if (
            target is not ("config" or "models" or "tool-rules")
            || string.IsNullOrWhiteSpace(path)
            || Encoding.UTF8.GetByteCount(path) > 4096
        )
            throw new InvalidDataException(
                "set_config requires target (config, models, or tool-rules) and one nonempty filePath within 4096 UTF-8 bytes."
            );
        async Task Authorize(CancellationToken current)
        {
            await AuthorizeToolAsync(
                owner,
                new("set_config", "builtin", "set_config", args),
                files,
                current
            );
            await AuthorizeToolAsync(
                owner,
                new("set_config", "node", "read", new JsonObject { ["filePath"] = path }),
                files,
                current
            );
        }
        await Authorize(token);
        var bytes = await files.CaptureConfigCandidateAsync(path, target == "tool-rules", token);
        JsonObject installed;
        try
        {
            if (models.ConfigurationOwner is { } configuration)
                installed = await configuration.InstallAsync(
                    target,
                    _ => Task.FromResult(bytes),
                    authorization,
                    Authorize,
                    token
                );
            else if (target == "tool-rules")
            {
                // Constant-model hosts have no Setup/configuration owner, but retain policy installation.
                await Authorize(token);
                await authorization.InstallAsync(bytes, token);
                installed = Foxwarm.Models.ModelConfiguration.Installed(
                    target,
                    ["tool-rules"],
                    [],
                    []
                );
            }
            else
                throw new NotSupportedException(
                    "Configuration installation is unavailable on this host."
                );
        }
        catch (Exception error) when (error is InvalidDataException or DecoderFallbackException)
        {
            throw new InvalidDataException(
                $"Invalid {target} YAML candidate. The active file was not changed."
            );
        }
        return new JsonObject { ["output"] = installed.ToJsonString() };
    }
}
