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

    // The retained legacy isolation fields. Since R2 they are a downgrade fence and the
    // migration input only; nothing enforces them as authority.
    internal AgentIsolation Isolation(string agent) =>
        IsolatedToolCompatibility.Metadata(agents.MetadataSnapshot()[agent]);

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
        // On master, the Agent folder is a master folder, and its calls are master's.
        if (Capabilities.MasterNode && targets is not null && targets.Contains(AgentStorePaths.Endpoint))
            targets = targets.Select(target => target == AgentStorePaths.Endpoint ? "master" : target).ToArray();
        // Clearing the Node selection targets what an unset Node is: master in file mode, with
        // the Node named as a selection names it; no Node otherwise.
        string? targetNode = node;
        if (Foxwarm.Nodes.NodeProviderRegistry.ClearsSelection(source, name, args))
        {
            targets = Capabilities.MasterNode ? ["master"] : [];
            targetNode = Capabilities.MasterNode ? "master" : null;
            if (Capabilities.MasterNode)
            {
                args = (JsonObject)args.DeepClone();
                args["nodeId"] = "master";
            }
        }
        // So are a copy's endpoint arguments, as policy facts; the call keeps its own.
        if (Capabilities.MasterNode && source == "builtin" && name == "copy_between_nodes")
            foreach (var key in new[] { "sourceNode", "targetNode" })
                if (SessionWait.Text(args[key])?.Trim() == AgentStorePaths.Endpoint)
                {
                    args = (JsonObject)args.DeepClone();
                    args[key] = "master";
                }
        return new(
            source,
            name,
            server,
            args,
            paths,
            owner.Agent,
            owner.Id,
            targetNode,
            toolWorkspace,
            agents.AuthorizationAgentRoot(owner.Agent),
            agents.AuthorizationMemoryRoot(owner.Agent),
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
        var target = AuthorizationTarget(requested);
        // An Archive outlives its catalog row. Without a live row, the requested identity's
        // Agent names the owner, so same-Agent rules still cover deleted Sessions.
        if (target is null && family == "archive" && SessionIdentity.IsValid(requested))
            target = new(requested, SessionIdentity.Agent(requested), null);
        return request with { SourceParent = parent, SessionTarget = target };
    }

    internal async Task AuthorizeToolAsync(
        SessionOwner owner,
        ResolvedTool resolved,
        WorkspaceTools? files,
        CancellationToken token,
        SessionOwner? concreteTarget = null,
        IReadOnlyList<string>? nodeEffects = null,
        Action<AuthorizationAssessment>? observe = null,
        IReadOnlyList<string>? secrets = null,
        IReadOnlyList<AuthorizationOperation>? operations = null
    )
    {
        var assessment = await AssessToolAsync(
            owner,
            resolved,
            files,
            token,
            concreteTarget,
            nodeEffects,
            secrets: secrets,
            operations: operations
        );
        observe?.Invoke(assessment);
        if (assessment.Denied is not null)
            throw Denial(owner, resolved, assessment);
        // Deny is final above: the current policy is always evaluated first. An ask outcome
        // passes only when a grant of this invocation covers this exact request.
        if (assessment.Effect == ToolAuthorizationEffect.Ask)
        {
            var fingerprint = await ApprovalFingerprintAsync(owner, resolved, assessment.Request);
            if (ToolApprovalScope.Current?.Covers(owner, fingerprint) != true)
                throw new ToolApprovalRequiredException(assessment, resolved, fingerprint);
        }
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException(
                "Tool source is no longer the current Session owner."
            );
    }

    // The denial of a request: the existing message, then which rule denied which obligation of
    // which call.
    internal static ToolAuthorizationDeniedException Denial(
        SessionOwner owner,
        ResolvedTool resolved,
        AuthorizationAssessment assessment,
        string? lead = null
    )
    {
        var denied = assessment.Denied!;
        if (denied.Decision.Unresolved is { } unresolved)
            return new ToolAuthorizationUnresolvedException(
                OperationAttribution.Unresolved(
                    resolved,
                    OperationAttribution.Primary(owner),
                    denied,
                    unresolved
                )
            );
        return new ToolAuthorizationDeniedException(
            OperationAttribution.Append(
                denied.Decision
                    is {
                        Secrets.Effect: ToolAuthorizationEffect.Deny,
                        Call.Effect: not ToolAuthorizationEffect.Deny
                    }
                    ? SessionWait.Text(denied.Decision.Secrets.Rule?["reason"])
                        ?? Foxwarm.Secrets.SecretConfigurationChanges.DeniedMessage(
                            assessment.Request.Secrets!
                        )
                    : SessionWait.Text(denied.Decision.Rule?["reason"])
                        ?? lead
                        ?? $"Tool authorization rule denies {resolved.Source} capability `{resolved.Name}`.",
                OperationAttribution.Denial(
                    resolved,
                    OperationAttribution.Primary(owner),
                    denied,
                    assessment.Request.Secrets
                )
            )
        );
    }

    // The identity an approval binds and a later check must match: the request with its Session
    // target and Task owner resolved even when no rule needed them, so a check that names its
    // concrete target and one that resolves it from the arguments agree. Resolution failures
    // leave the fact absent; a check that resolves it differently is then not covered.
    internal async Task<string> ApprovalFingerprintAsync(
        SessionOwner owner,
        ResolvedTool resolved,
        ToolAuthorizationRequest request
    ) => ToolApprovalScope.Fingerprint(resolved, await ApprovalRequestAsync(owner, request));

    private ToolAuthorizationRequest ApprovalSessionTarget(SessionOwner owner, ToolAuthorizationRequest request)
    {
        if (request.SessionTarget is null)
            try
            {
                request = PopulateAuthorizationTargets(request, owner);
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                // The fact stays absent: a check that resolves it is then not covered.
            }
        return request;
    }

    // The request with the facts an approval binds, as approvers see them.
    internal async Task<ToolAuthorizationRequest> ApprovalRequestAsync(
        SessionOwner owner,
        ToolAuthorizationRequest request
    )
    {
        if (request.SessionTarget is null)
            try
            {
                request = await Catalog.QueryAsync(() => PopulateAuthorizationTargets(request, owner));
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                // A target that could not be resolved is not covered by this approval.
            }
        if (
            request.TaskOwnerSession is null
            && SessionWait.Text(request.Args["taskId"]) is { Length: > 0 and <= 128 } taskId
            && !string.IsNullOrWhiteSpace(taskId)
        )
            try
            {
                var taskOwner = (await Tasks.ReferencesAsync(taskId.Trim())).Owner;
                request = request with
                {
                    TaskOwnerSession = taskOwner is null
                        ? null
                        : await Catalog.QueryAsync(() => SessionWait.Text(Catalog.Resolve(taskOwner)["sessionId"])),
                };
            }
            catch (Exception error) when (error is not OperationCanceledException)
            {
                // The fact stays absent: a check that resolves it is then not covered.
            }
        return request;
    }

    // Shared by enforcement and explanation: structural prechecks, fact construction and
    // every generic policy layer. A replacement global policy only substitutes that layer.
    // Secret facts are computed from the current configuration unless the effect owner supplies
    // those of the exact change it installs.
    internal async Task<AuthorizationAssessment> AssessToolAsync(
        SessionOwner owner,
        ResolvedTool resolved,
        WorkspaceTools? files,
        CancellationToken token,
        SessionOwner? concreteTarget = null,
        IReadOnlyList<string>? nodeEffects = null,
        ToolAuthorizationPolicy? global = null,
        IReadOnlyList<string>? secrets = null,
        IReadOnlyList<AuthorizationPath>? paths = null,
        IReadOnlyList<AuthorizationOperation>? operations = null
    )
    {
        owner.Entry.RequireIdentityAuthority();
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException(
                "Tool source is no longer the current Session owner."
            );
        if (
            resolved.Source == "builtin"
            && resolved.Name == "generate_image"
            && !UsesSeparateImageGeneration(owner)
        )
            throw new ToolAuthorizationDeniedException(
                "Separate image generation is not enabled for the selected concrete model."
            );
        var remote =
            resolved.ExecutionNode != "master"
            && !resolved.AgentFolder
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
        // Given path facts (explain's reuse of facts a probe already established) replace the
        // computed ones.
        paths ??=
            resolved.Source == "builtin" && resolved.Name == "copy_between_nodes"
                ? CopyAuthorizationPaths(owner, resolved.Args, files)
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
                        or "node_bootstrap_info"
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
        var policy = global ?? await authorization.LoadAsync(token);
        // A Self call is not authorizable: every valid layer passes it. Structural failures (an
        // unavailable policy, an invalid creator chain, an unreadable layer) still reject it.
        // Operations a host call states (a ToolScript model request) are never Self.
        if (operations is null && OperationPlan.SelfReason(resolved) is { } self)
            return new(
                request,
                EffectiveLayers(owner.Agent, policy)
                    .Select(layer => new AuthorizationLayerDecision(
                        layer.Name,
                        layer.Policy,
                        new(ToolAuthorizationEffect.Allow, null)
                    ))
                    .ToArray()
            )
            {
                Self = self,
            };
        var secretsUnknown = false;
        if (secrets is null)
        {
            secrets = await SecretFactsAsync(owner, resolved, files, policy, token);
            secretsUnknown =
                secrets is null
                && resolved.Source == "builtin"
                && (
                    resolved.Name == "mcp_config"
                    || resolved.Name == "set_config"
                        && files is not null
                        && SessionWait.Text(resolved.Args["target"]) is "config" or "models"
                        && SessionWait.Text(resolved.Args["filePath"]) is not null
                        && models.ConfigurationOwner is not null
                );
        }
        if (secrets is { Count: > 0 })
            request = request with
            {
                Secrets = secrets,
                OwnedSecrets = OwnedSecrets(owner.Agent, secrets),
            };
        var layers = EffectiveLayers(owner.Agent, policy);
        var policies = layers.Select(layer => layer.Policy).ToArray();
        if (concreteTarget is not null || policies.Any(policy => ToolAuthorizationEvaluation.NeedsTarget(policy, request)))
            request = await Catalog.QueryAsync(() => PopulateSessionTargets(request, owner, policies, concreteTarget));
        request = await PopulateTaskTargetAsync(request, policies);
        if (operations is not null)
            request = request with { Operations = operations };
        else if (layers.Any(layer => layer.Policy.HasOperationRules))
            request = request with { Operations = await AuthorizationOperationsAsync(owner, resolved, request, files) };
        return new(
            request,
            layers
                .Select(layer => new AuthorizationLayerDecision(
                    layer.Name,
                    layer.Policy,
                    ToolAuthorizationEvaluation.Evaluate(layer.Policy, request)
                ))
                .ToArray()
        )
        {
            SecretsUnknown = secretsUnknown,
        };
    }

    // Those of the named secrets that the Agent owns. An unreadable store grants nothing.
    private IReadOnlyList<string> OwnedSecrets(string agent, IReadOnlyList<string> names)
    {
        if (secrets is not { } store)
            return [];
        try
        {
            return names.Where(name => store.Store.Owner(name) == agent).ToArray();
        }
        catch (Foxwarm.Secrets.SecretStoreLockedException)
        {
            return [];
        }
    }

    // Stored secrets a configuration call would send to a new destination, against the
    // configuration as it is now. A set_config candidate is read only when the caller may read
    // it, so a fact never reveals anything about a file the caller cannot read; the call then
    // fails on that read anyway.
    private async Task<IReadOnlyList<string>?> SecretFactsAsync(
        SessionOwner owner,
        ResolvedTool resolved,
        WorkspaceTools? files,
        ToolAuthorizationPolicy global,
        CancellationToken token
    )
    {
        if (resolved is { Source: "node", Name: "exec" })
            return ExecSecretFacts(resolved.Args);
        if (resolved.Source != "builtin")
            return null;
        if (resolved.Name == "mcp_config")
            return mcp.SecretFacts(resolved.Args);
        if (resolved.Name == "add_secret")
            return AddSecretFacts(resolved.Args);
        if (resolved.Name == "ask_user")
            return AskUserSecretFacts(resolved.Args);
        if (
            resolved.Name != "set_config"
            || files is null
            || SessionWait.Text(resolved.Args["target"]) is not ("config" or "models")
            || SessionWait.Text(resolved.Args["filePath"]) is not { } path
            || models.ConfigurationOwner is not { } configuration
        )
            return null;
        try
        {
            var readTool = CandidateRead(path, files);
            var read = await AssessToolAsync(
                owner,
                readTool,
                files,
                token,
                global: global,
                secrets: []
            );
            // An asking read counts only when an approval of this invocation covers it.
            if (
                read.Effect == ToolAuthorizationEffect.Deny
                || read.Effect == ToolAuthorizationEffect.Ask
                    && ToolApprovalScope.Current?.Covers(
                        owner,
                        await ApprovalFingerprintAsync(owner, readTool, read.Request)
                    ) != true
            )
                return null;
            // The bytes admitted before the plan, which the installation consumes.
            var bytes =
                AdmittedCandidate(owner, path)
                ?? await files.CaptureConfigCandidateAsync(path, false, token);
            return Foxwarm.Secrets.SecretConfigurationChanges.ForConfiguration(
                configuration,
                SessionWait.Text(resolved.Args["target"])!,
                new UTF8Encoding(false).GetString(bytes).TrimStart('\uFEFF')
            );
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            // The handler reads the candidate itself and reports why it cannot.
            return null;
        }
    }

    private (string? Name, ToolAuthorizationPolicy Policy)[] EffectiveLayers(
        string agent,
        ToolAuthorizationPolicy global
    ) =>
        // The operator ceiling, when one applies, comes first: it is evaluated before the
        // tenant's global policy (OperatorCeiling).
        (
            authorization.LoadCeiling() is { } ceiling
                ? new (string?, ToolAuthorizationPolicy)[] { (OperatorCeiling.Layer, ceiling), (null, global) }
                : new (string?, ToolAuthorizationPolicy)[] { (null, global) }
        )
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
        AuthorizationDecision? ask = null;
        foreach (var policy in policies)
        {
            var decision = ToolAuthorizationEvaluation.Evaluate(policy, request);
            if (decision.Effect == ToolAuthorizationEffect.Deny)
                return decision;
            if (decision.Effect == ToolAuthorizationEffect.Ask)
                ask ??= decision;
        }
        return ask ?? new(ToolAuthorizationEffect.Allow, null);
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
        var layers = EffectiveLayers(source.Agent, await authorization.LoadAsync(token));
        var primary = OperationAttribution.Primary(source);
        (string? Layer, ToolAuthorizationPolicy Policy, CreationTargetOutcome Outcome)? indeterminate = null;
        (string? Layer, ToolAuthorizationPolicy Policy, CreationTargetOutcome Outcome)? ask = null;
        foreach (var (layer, policy) in layers)
        {
            var outcome = ToolAuthorizationEvaluation.EvaluateCreationTargetOutcome(policy, request);
            var decision = outcome.Decision;
            if (decision == CreationTargetDecision.Deny)
                throw new ToolAuthorizationDeniedException(
                    OperationAttribution.Append(
                        $"Tool authorization rules deny creating a Session in Agent '{agent}'.",
                        OperationAttribution.CreationTarget(primary, layer, policy, outcome)
                    )
                );
            if (decision == CreationTargetDecision.Indeterminate)
                indeterminate ??= (layer, policy, outcome);
            if (decision == CreationTargetDecision.Ask)
                ask ??= (layer, policy, outcome);
        }
        if (indeterminate is { } unsettled)
            throw new ToolAuthorizationDeniedException(
                OperationAttribution.Append(
                    "Future Session parameters make create_session target authorization indeterminate at timer registration. "
                        + "Place a decisive creation-target rule before rules depending on future names or settings.",
                    OperationAttribution.CreationTarget(
                        primary,
                        unsettled.Layer,
                        unsettled.Policy,
                        unsettled.Outcome
                    )
                )
            );
        // A future unattended creation has no invocation a person could approve.
        if (ask is { } asking)
            throw new ToolAuthorizationDeniedException(
                OperationAttribution.Append(
                    $"Tool authorization rules require approval to create Sessions in Agent '{agent}'. A scheduled creation can't be approved in advance, so this timer was not registered.",
                    OperationAttribution.CreationTarget(
                        primary,
                        asking.Layer,
                        asking.Policy,
                        asking.Outcome
                    )
                )
            );
        source.Entry.RequireIdentityAuthority();
        if (!IsCurrentOwner(source))
            throw new InvalidOperationException(
                "Creation source is no longer the current Session owner."
            );
    }

    private ToolAuthorizationRequest PopulateSessionTargets(
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
        return request;
    }

    private async Task<ToolAuthorizationRequest> PopulateTaskTargetAsync(ToolAuthorizationRequest request, IReadOnlyList<ToolAuthorizationPolicy> policies)
    {
        if (
            policies.Any(policy => ToolAuthorizationEvaluation.NeedsTaskTarget(policy, request))
            && SessionWait.Text(request.Args["taskId"]) is string taskId
        )
        {
            if (taskId.Length > 128 || string.IsNullOrWhiteSpace(taskId))
                throw new InvalidDataException("Task authorization requires a bounded taskId.");
            var taskOwner = (await Tasks.ReferencesAsync(taskId.Trim())).Owner;
            request = request with
            {
                TaskOwnerSession = taskOwner is null
                    ? null
                    : await Catalog.QueryAsync(() => SessionWait.Text(Catalog.Resolve(taskOwner)["sessionId"])),
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

    internal Task SetAgentInheritableAsync(string agent, bool inheritable) =>
        agents.SetInheritableAsync(agent, inheritable);

    internal bool AgentInheritable(string agent) => agents.Inheritable(agent);

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
        foreach (var reference in selection)
        {
            var (read, files) = PromptFileRead(source.Agent, targetAgent, reference);
            await AuthorizeToolAsync(source, read, files, token);
        }
    }

    internal bool ToolVisible(
        SessionOwner owner,
        string source,
        string name,
        string? server = null,
        bool unknownNode = false,
        string? node = null,
        JsonObject? fixedArgs = null
    ) =>
        (source != "builtin" || name != "generate_image" || UsesSeparateImageGeneration(owner))
        && ToolVisible(VisibilityFor(owner), source, name, server, unknownNode, node, fixedArgs);

    internal JsonArray ModelDefinitions(SessionOwner owner, JsonArray? explicitOverride = null)
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
                    (
                        entry.DefaultInject
                        || SessionWait.Text(entry.Definition["name"]) == "generate_image"
                    )
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
                .Select(entry => (JsonNode?)ToolCallControls.ForModel(entry.Definition))
                .ToArray()
        );
    }

    // The external runtime receives the same visible model tool set as an internal Session.
    internal JsonArray RuntimeModelDefinitions(SessionOwner owner) =>
        new(
            ModelDefinitions(owner)
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

    // The protected input of set_config: its candidate, read as the caller on master, or in
    // the Agent store's folder where there is no master.
    internal static ResolvedTool CandidateRead(string path, WorkspaceTools? files) =>
        new(
            "set_config",
            "node",
            "read",
            new JsonObject { ["filePath"] = path },
            ExecutionNode: files?.AgentFolder is { Store: true } ? AgentStorePaths.Endpoint : "master"
        )
        {
            AgentFolder = files?.AgentFolder is not null,
        };

    internal static string CandidateInput(string path) => "set_config:" + path;

    private static byte[]? AdmittedCandidate(SessionOwner owner, string path) =>
        ToolApprovalScope.Current is { } scope
        && ReferenceEquals(scope.Owner, owner)
        && scope.Inputs.TryGetValue(CandidateInput(path), out var bytes)
            ? bytes
            : null;

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
        async Task Authorize(CancellationToken current, IReadOnlyList<string>? secrets = null)
        {
            await AuthorizeToolAsync(
                owner,
                new("set_config", "builtin", "set_config", args),
                files,
                current,
                secrets: secrets
            );
            await AuthorizeToolAsync(owner, CandidateRead(path, files), files, current);
        }
        await Authorize(token);
        // The candidate the plan was derived from, when it was admitted before planning;
        // otherwise read now.
        var bytes =
            (target is "config" or "models" ? AdmittedCandidate(owner, path) : null)
            ?? await files.CaptureConfigCandidateAsync(path, target == "tool-rules", token);
        var text = new UTF8Encoding(false).GetString(bytes).TrimStart('\uFEFF');
        if (target is "config" or "models" && models.ConfigurationOwner is { } current)
            Foxwarm.Secrets.SecretMarkerGuard.Require(text, current.Secrets.Redactor.HasLabel);
        JsonObject installed;
        try
        {
            if (models.ConfigurationOwner is { } configuration)
                installed = await configuration.InstallAsync(
                    target,
                    _ => Task.FromResult(bytes),
                    authorization,
                    // Inside the installer's lane: the secret facts of these exact bytes against
                    // the files they replace.
                    current =>
                        Authorize(
                            current,
                            target == "tool-rules"
                                ? []
                                : Foxwarm.Secrets.SecretConfigurationChanges.ForConfiguration(
                                    configuration,
                                    target,
                                    text
                                )
                        ),
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
        if (target == "tool-rules")
        {
            var policy = ToolAuthorizationYaml.Parse(bytes);
            if (policy.Warnings.Count > 0)
                installed["warnings"] = new JsonArray(
                    policy.Warnings.Select(warning => (JsonNode?)warning).ToArray()
                );
        }
        return installed;
    }
}
