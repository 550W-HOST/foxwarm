using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private readonly ToolAuthorizationAuthority authorization;
    private readonly string toolWorkspace;
    internal ToolAuthorizationAuthority Authorization => authorization;
    internal string ToolWorkspace => toolWorkspace;

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
        string node = "master",
        string? effectNode = null
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
            agents.MemoryDirectory(owner.Agent),
            NodeTargets: ToolAuthorizationNodeEffects.Resolve(
                source,
                name,
                effectNode ?? node,
                args
            ),
            CurrentNode: CurrentNode(owner)
        );

    private ToolAuthorizationRequest PopulateAuthorizationTargets(
        ToolAuthorizationRequest request,
        SessionOwner owner
    )
    {
        var parent = AuthorizationParent(Catalog.Get(owner.Id));
        if (
            request.Source != "builtin"
            || !ToolAuthorizationPolicy.TargetResolvers.TryGetValue(request.Name, out var resolver)
        )
            return request with { SourceParent = parent };
        var family = resolver.Family;
        string? requested = SessionWait.Text(request.Args[resolver.Argument]);
        requested = requested is null ? null : SessionGoal.Trim(requested);
        if (requested is "")
            requested = null;
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
        SessionOwner? concreteTarget = null,
        bool toolScriptSourceRead = false
    )
    {
        owner.Entry.RequireIdentityAuthority();
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException(
                "Tool source is no longer the current Session owner."
            );
        if (resolved.Source == "node")
        {
            if (toolScriptSourceRead && resolved.ExecutionNode == "master")
                RequireFileNodeBoundary(owner, resolved.ExecutionNode);
            else if (!IsMasterBrowser(resolved.Source, resolved.Name, resolved.ExecutionNode))
                RequireNodeBoundary(owner, resolved.ExecutionNode);
        }
        if (
            resolved.Source == "builtin"
            && resolved.Name == "artifact"
            && ToolRegistry.ArtifactFileSource(resolved.Args)
        )
            RequireFileNodeBoundary(owner, resolved.ExecutionNode);
        if (resolved.Source == "builtin" && resolved.Name is "run_script" or "start_toolscript_run")
            RequireFileNodeBoundary(owner, resolved.ExecutionNode);
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
                    && resolved.Name == "artifact"
                    && ToolRegistry.ArtifactFileSource(resolved.Args)
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
            : resolved.Source == "builtin"
            && resolved.Name == "artifact"
            && ToolRegistry.ArtifactFileSource(resolved.Args)
                ? (
                    files
                    ?? throw new NotSupportedException(
                        "This executor has no physical path resolver."
                    )
                ).AuthorizationFacts("read", resolved.Args)
            : resolved.Source == "node"
                && resolved.Name is "read" or "write" or "edit" or "apply_patch" or "exec"
            || resolved.Source == "builtin"
                && resolved.Name
                    is "node_create_auth_token"
                        or "set_config"
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
                : resolved.ExecutionNode,
            effectNode: resolved.ExecutionNode
        );
        var policies = EffectivePolicies(owner.Agent, await authorization.LoadAsync(token));
        request = PopulateEffectiveTargets(request, owner, policies, concreteTarget);
        var decision = EffectiveDecision(policies, request);
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

    private ToolAuthorizationPolicy[] EffectivePolicies(string agent, ToolAuthorizationPolicy global) =>
        new[] { global }.Concat(agents.RuleLayers(agent)).ToArray();

    private static AuthorizationDecision EffectiveDecision(
        IReadOnlyList<ToolAuthorizationPolicy> policies,
        ToolAuthorizationRequest request
    )
    {
        foreach (var policy in policies)
        {
            var decision = ToolAuthorizationEvaluation.Evaluate(policy, request);
            if (!decision.Allowed)
                return decision;
        }
        return new(true, null);
    }

    private ToolAuthorizationRequest PopulateEffectiveTargets(
        ToolAuthorizationRequest request,
        SessionOwner owner,
        IReadOnlyList<ToolAuthorizationPolicy> policies,
        SessionOwner? concreteTarget = null
    )
    {
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
        else if (policies.Any(policy => ToolAuthorizationEvaluation.NeedsTarget(policy, request)))
            request = PopulateAuthorizationTargets(request, owner);
        if (
            policies.Any(policy => ToolAuthorizationEvaluation.NeedsTaskTarget(policy, request))
            && SessionWait.Text(request.Args["taskId"]) is string taskId
        )
        {
            if (taskId.Length > 128 || string.IsNullOrWhiteSpace(taskId))
                throw new InvalidDataException("Task authorization requires a bounded taskId.");
            var taskOwner = Tasks.OwnerSessionId(taskId.Trim());
            request = request with
            {
                TaskOwnerSession = taskOwner is null
                    ? null
                    : SessionWait.Text(Catalog.Resolve(taskOwner)["sessionId"]),
            };
        }
        return request;
    }

    private void RequireCreationParent(string callerAgent, string? parent)
    {
        if (parent is null || agents.CreatedBy(callerAgent) is null)
            return;
        var target = AuthorizationTarget(parent)
            ?? throw new InvalidDataException("Parent Session does not exist.");
        agents.RequireSessionTarget(callerAgent, target.Agent);
    }

    internal Task SetAgentRulesAsync(string agent, JsonArray rules, SessionOwner? caller = null) =>
        agents.SetRulesAsync(agent, rules, caller?.Agent, caller is null ? null : () =>
            AuthorizeToolAsync(caller, new("set_agent_rules", "builtin", "set_agent_rules",
                new JsonObject { ["agentName"] = agent, ["rules"] = rules.DeepClone() }),
                null, semanticCaller.Value ?? CancellationToken.None));

    internal Task SetAgentDefaultNodeAsync(string agent, string? node) =>
        agents.SetDefaultNodeAsync(agent, node);

    private async Task AuthorizePromptFilesAsync(
        SessionOwner source,
        string targetAgent,
        IReadOnlyList<string> selection,
        CancellationToken token
    )
    {
        // Prompt sources live on Main regardless of the new Session's execution Node.
        // Authorize the selecting caller once; lifecycle rebuilds reuse the admitted selection.
        var files = new WorkspaceTools(AgentDirectory(source.Agent));
        foreach (var reference in selection)
            await AuthorizeToolAsync(
                source,
                new(
                    "read",
                    "node",
                    "read",
                    new JsonObject
                    {
                        ["filePath"] = memory.ResolveSelectedPath(targetAgent, reference),
                    }
                ),
                files,
                token
            );
    }

    // This exception reaches generic policy and the existing exact isolated capability check.
    // It does not grant selection, exec, file export or any other off-bound-Node authority.
    private static bool IsMasterBrowser(string source, string name, string node) =>
        source == "node" && node == "master" && MainBrowserDefinitions.Contains(name);

    internal bool ToolVisible(
        SessionOwner owner,
        string source,
        string name,
        string? server = null,
        bool unknownNode = false,
        string? node = null,
        string? selectedNode = null
    )
    {
        ToolAuthorizationPolicy[] layers;
        try
        {
            layers = agents.RuleLayers(owner.Agent);
        }
        catch (InvalidDataException)
        {
            return false;
        }
        if (name == "call_tool" && source == "builtin")
            return true;
        if (
            source == "builtin"
            && name
                is "artifact"
                    or "run_script"
                    or "start_toolscript_run"
                    or "send_file"
                    or "image_write_to_file"
        )
            unknownNode = true;
        var targetNode =
            node
            ?? (
                source == "node"
                || source == "builtin" && name is "send_file" or "image_write_to_file"
                    ? selectedNode ?? CurrentNode(owner)
                    : "master"
            );
        if (
            source == "node"
            && AgentIsolated(owner.Agent)
            && targetNode != (RecordedIsolationNode(owner.Agent) ?? "master")
            && !IsMasterBrowser(source, name, targetNode)
        )
            return false;
        var request = AuthorizationRequest(owner, source, name, server, new(), [], targetNode);
        var unknownNodeTargets =
            source == "builtin"
            && name is "send_file" or "image_write_to_file" or "copy_between_nodes" or "node";
        return new[] { authorization.Load() }.Concat(layers).All(policy =>
                ToolAuthorizationEvaluation.Visible(policy, request, unknownNode, unknownNodeTargets))
            && IsolatedToolCompatibility.Visible(
                Isolation(owner.Agent),
                source,
                name,
                server,
                unknownNode,
                targetNode
            );
    }

    internal JsonArray ModelDefinitions(
        SessionOwner owner,
        JsonArray? explicitOverride = null,
        string? selectedNode = null
    )
    {
        if (explicitOverride is not null)
            return (JsonArray)explicitOverride.DeepClone();
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException(
                "Model request source is no longer the current Session owner."
            );
        var node = selectedNode ?? CurrentNode(owner);
        var definitions = tools
            .Entries.Where(entry =>
                entry.DefaultInject
                && entry.Source != "node"
                && ToolVisible(
                    owner,
                    entry.Source,
                    SessionWait.Text(entry.Definition["name"])!,
                    selectedNode: node
                )
            )
            .Select(entry => (JsonNode?)ToolCallControls.ForModel(entry.Definition))
            .ToList();
        foreach (
            var definition in (
                node == "master" ? tools.NodeDefinitions(node) : NodeProviders.Definitions(node)
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
            if (
                !tools.Entries.Any(entry =>
                    entry.Source == "node"
                    && !entry.DefaultInject
                    && SessionWait.Text(entry.Definition["name"]) == name
                ) && ToolVisible(owner, "node", name, node: node)
            )
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
                paths.Add(
                    new(
                        key,
                        resolved.Name is "run_script" or "start_toolscript_run"
                            ? SessionGoal.Trim(raw)
                            : raw,
                        null,
                        resolved.ExecutionNode
                    )
                );
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
