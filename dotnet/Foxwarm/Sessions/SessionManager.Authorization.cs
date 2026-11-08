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
    )
    {
        var targets =
            source == "builtin" && name == "node"
                ? NodeProviders.AuthorizationTargets(args)
                : ToolAuthorizationNodeEffects.Resolve(source, name, effectNode ?? node, args);
        return new(
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
            NodeTargets: targets,
            CurrentNode: CurrentNode(owner),
            NodeForest: targets is { Count: > 0 } ? Nodes.Registry.Forest() : null
        );
    }

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
        bool toolScriptSourceRead = false,
        IReadOnlyList<string>? nodeEffects = null
    )
    {
        var assessment = await AssessToolAsync(
            owner,
            resolved,
            files,
            token,
            concreteTarget,
            toolScriptSourceRead,
            nodeEffects
        );
        if (assessment.Denied is { } denied)
            throw new ToolAuthorizationDeniedException(
                SessionWait.Text(denied.Decision.Rule?["reason"])
                    ?? $"Tool authorization rule denies {resolved.Source} capability `{resolved.Name}`."
            );
        IsolatedToolCompatibility.Check(
            Isolation(owner.Agent),
            assessment.Request,
            AuthorizationTarget
        );
        // Deny and isolation are final above. An ask outcome passes only within the invocation a
        // person approved, including its internal steps and effect-owner rechecks.
        if (
            assessment.Effect == ToolAuthorizationEffect.Ask
            && ToolApprovalScope.Current?.Covers(owner) != true
        )
            throw new ToolApprovalRequiredException(assessment, resolved);
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException(
                "Tool source is no longer the current Session owner."
            );
    }

    // Shared by enforcement and explanation: structural prechecks, fact construction and
    // every generic policy layer. A replacement global policy only substitutes that layer.
    internal async Task<AuthorizationAssessment> AssessToolAsync(
        SessionOwner owner,
        ResolvedTool resolved,
        WorkspaceTools? files,
        CancellationToken token,
        SessionOwner? concreteTarget = null,
        bool toolScriptSourceRead = false,
        IReadOnlyList<string>? nodeEffects = null,
        ToolAuthorizationPolicy? global = null
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
            else
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
            : resolved.Source == "node" && resolved.Name is "read" or "write" or "edit" or "exec"
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
        if (
            nodeEffects is null
            && resolved is { Source: "builtin", Name: "node" }
            && SessionWait.Text(resolved.Args["action"])?.Trim().ToLowerInvariant() == "ensure"
            && resolved.Args.ContainsKey("nodeId")
        )
            nodeEffects = await NodeProviders.EnsureAuthorizationTargetsAsync(
                RequiredNodeArgument(resolved.Args, "providerId", 64).Trim(),
                RequiredNodeArgument(resolved.Args, "nodeId", 193, exact: true),
                token
            );
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
        if (nodeEffects is not null)
            request = request with
            {
                NodeTargets = nodeEffects,
                NodeForest = nodeEffects.Count > 0 ? Nodes.Registry.Forest() : null,
            };
        // Compound consumers and their source reads must decide policy with the same admitted
        // endpoint facts as ordinary Node capabilities, before any file materialization or effect.
        // Read-only Node inspection keeps its independent, nonblocking metadata path.
        if (
            request.NodeTargets is { Count: > 0 } endpoints
            && endpoints.Any(NodeProviders.IsProviderNode)
            && !(
                resolved is { Source: "builtin", Name: "node" }
                && SessionWait.Text(resolved.Args["action"])?.Trim().ToLowerInvariant() == "inspect"
            )
        )
            request = request with
            {
                NodeForest = await NodeProviders.PrepareAuthorizationForestAsync(endpoints, token),
            };
        var layers = EffectiveLayers(owner.Agent, global ?? await authorization.LoadAsync(token));
        request = PopulateEffectiveTargets(
            request,
            owner,
            layers.Select(layer => layer.Policy).ToArray(),
            concreteTarget
        );
        return new(
            request,
            layers
                .Select(layer => new AuthorizationLayerDecision(
                    layer.Name,
                    layer.Policy,
                    ToolAuthorizationEvaluation.Evaluate(layer.Policy, request)
                ))
                .ToArray()
        );
    }

    private (string? Name, ToolAuthorizationPolicy Policy)[] EffectiveLayers(
        string agent,
        ToolAuthorizationPolicy global
    ) =>
        new (string?, ToolAuthorizationPolicy)[] { (null, global) }
            .Concat(
                agents.NamedRuleLayers(agent).Select(layer => ((string?)layer.Agent, layer.Policy))
            )
            .ToArray();

    private ToolAuthorizationPolicy[] EffectivePolicies(
        string agent,
        ToolAuthorizationPolicy global
    ) => EffectiveLayers(agent, global).Select(layer => layer.Policy).ToArray();

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
        return new(ToolAuthorizationEffect.Allow, null);
    }

    private async Task AuthorizeCreateSessionTargetAsync(
        SessionOwner source,
        string agent,
        CancellationToken token
    )
    {
        source.Entry.RequireIdentityAuthority();
        if (!IsCurrentOwner(source))
            throw new InvalidOperationException(
                "Creation source is no longer the current Session owner."
            );
        var request = AuthorizationRequest(
            source,
            "builtin",
            "create_session",
            null,
            new JsonObject { ["agentName"] = agent },
            []
        );
        var policies = EffectivePolicies(source.Agent, await authorization.LoadAsync(token));
        var indeterminate = false;
        var ask = false;
        foreach (var policy in policies)
        {
            var decision = ToolAuthorizationEvaluation.EvaluateCreationTarget(policy, request);
            if (decision == CreationTargetDecision.Deny)
                throw new ToolAuthorizationDeniedException(
                    $"Tool authorization rules deny creating a Session in Agent '{agent}'."
                );
            indeterminate |= decision == CreationTargetDecision.Indeterminate;
            ask |= decision == CreationTargetDecision.Ask;
        }
        if (indeterminate)
            throw new ToolAuthorizationDeniedException(
                "Future Session parameters make create_session target authorization indeterminate at timer registration. "
                    + "Place a decisive creation-target rule before rules depending on future names or settings."
            );
        // A future unattended creation has no invocation a person could approve.
        if (ask)
            throw new ToolAuthorizationDeniedException(
                $"Tool authorization rules require approval to create Sessions in Agent '{agent}'. A scheduled creation can't be approved in advance, so this timer was not registered."
            );
        // Only generic policy is shared. Legacy structural create_session denial must not
        // replace the timer's independent isolation and creator-target checks.
        source.Entry.RequireIdentityAuthority();
        if (!IsCurrentOwner(source))
            throw new InvalidOperationException(
                "Creation source is no longer the current Session owner."
            );
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
        var target =
            AuthorizationTarget(parent)
            ?? throw new InvalidDataException("Parent Session does not exist.");
        agents.RequireSessionTarget(callerAgent, target.Agent);
    }

    private void RequireParentChange(string callerAgent, string target, string? parent)
    {
        if (agents.CreatedBy(callerAgent) is null)
            return;
        var existing =
            AuthorizationTarget(target)
            ?? throw new InvalidDataException("Session does not exist.");
        agents.RequireSessionTarget(callerAgent, existing.Agent);
        RequireCreationParent(callerAgent, parent);
    }

    internal Task SetAgentRulesAsync(string agent, JsonArray rules, SessionOwner? caller = null) =>
        agents.SetRulesAsync(
            agent,
            rules,
            caller is null ? null : () => caller.Agent,
            caller is null
                ? null
                : () =>
                    AuthorizeToolAsync(
                        caller,
                        new(
                            "set_agent_rules",
                            "builtin",
                            "set_agent_rules",
                            new JsonObject { ["agentName"] = agent, ["rules"] = rules.DeepClone() }
                        ),
                        null,
                        semanticCaller.Value ?? CancellationToken.None
                    )
        );

    internal string? AgentDefaultNode(string agent) => agents.EffectiveDefaultNode(agent);

    internal string? AgentDefaultCwd(string agent) => agents.DefaultCwd(agent);

    internal Task SetAgentDefaultPlacementAsync(
        string agent,
        bool setNode,
        string? node,
        bool setCwd,
        string? cwd
    ) => agents.SetDefaultPlacementAsync(agent, setNode, node, setCwd, cwd);

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

    internal bool ToolVisible(
        SessionOwner owner,
        string source,
        string name,
        string? server = null,
        bool unknownNode = false,
        string? node = null
    )
    {
        if (
            owner.Entry.WithState(state => ClaudeRuntimeState.IsExternal(state.AuthorityEnvelope))
            && !ClaudeRuntimeToolSupport.Visible(source, name)
        )
            return false;
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
                    ? CurrentNode(owner)
                    : "master"
            );
        if (
            source == "node"
            && AgentIsolated(owner.Agent)
            && targetNode != (RecordedIsolationNode(owner.Agent) ?? "master")
        )
            return false;
        var unknownNodeTargets =
            source == "builtin"
            && name
                is "send_file"
                    or "image_write_to_file"
                    or "copy_between_nodes"
                    or "node"
                    or "node_create_auth_token"
                    or "node_remove";
        try
        {
            var request = AuthorizationRequest(owner, source, name, server, new(), [], targetNode);
            return new[] { authorization.Load() }
                    .Concat(layers)
                    .All(policy =>
                        ToolAuthorizationEvaluation.Visible(
                            policy,
                            request,
                            unknownNode,
                            unknownNodeTargets
                        )
                    )
                && IsolatedToolCompatibility.Visible(
                    Isolation(owner.Agent),
                    source,
                    name,
                    server,
                    unknownNode,
                    targetNode
                );
        }
        catch (InvalidDataException)
        {
            return false;
        }
    }

    internal JsonArray ModelDefinitions(
        SessionOwner owner,
        JsonArray? explicitOverride = null,
        bool batchControls = true
    )
    {
        if (explicitOverride is not null)
            return (JsonArray)explicitOverride.DeepClone();
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException(
                "Model request source is no longer the current Session owner."
            );
        // Default Node declarations describe the framework interface, not the selected
        // environment's capabilities or permission grant. Concrete dispatch checks both.
        return new JsonArray(
            tools
                .Entries.Where(entry =>
                    entry.DefaultInject
                    && (
                        entry.Source == "node"
                        || ToolVisible(
                            owner,
                            entry.Source,
                            SessionWait.Text(entry.Definition["name"])!
                        )
                    )
                )
                .OrderBy(entry => entry.Source == "node")
                .Select(entry =>
                    (JsonNode?)ToolCallControls.ForModel(entry.Definition, batchControls)
                )
                .ToArray()
        );
    }

    // The external runtime receives the same visible model tool set as an internal Session.
    // Each MCP request is one call, so response-wide batch controls are omitted.
    internal JsonArray RuntimeModelDefinitions(SessionOwner owner) =>
        new(
            ModelDefinitions(owner, batchControls: false)
                .OfType<JsonObject>()
                .Select(definition => (JsonNode)ClaudeRuntimeToolSupport.Project(definition))
                .ToArray()
        );

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
            resolved.Name == "edit"
            && SessionWait.Text(resolved.Args["apply_patch"]) is string patch
        )
            foreach (var operation in WorkspacePatch.Parse(patch))
                paths.Add(new("apply_patch", operation.Path, null, resolved.ExecutionNode));

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
                    token,
                    webhooksLocked: true
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
