using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private static bool Flag(JsonObject args, string name) =>
        args[name] switch
        {
            null => false,
            JsonValue value when value.TryGetValue<bool>(out var flag) => flag,
            _ => throw new InvalidDataException($"{name} must be a boolean."),
        };

    // The structured explanation. Model callers receive it as JSON text, ToolScript as is.
    internal async Task<JsonObject> ExplainToolAuthorizationAsync(
        SessionOwner caller,
        WorkspaceTools files,
        JsonObject args,
        CancellationToken token,
        WorkspaceTools? candidateFiles = null
    )
    {
        // The candidate is a file of the Agent's folder where there is no master.
        candidateFiles ??= files;
        ToolRegistry.Keys(args, ["probes", "policyFilePath", "compare", "compact"]);
        if (
            args["probes"] is not JsonArray probes
            || probes.Count is 0 or > ToolAuthorizationToolDefinition.MaxExplainProbes
            || probes.Any(probe => probe is not JsonObject)
        )
            throw new InvalidDataException(
                $"explain_tool_authorization requires 1 to {ToolAuthorizationToolDefinition.MaxExplainProbes} probe objects."
            );
        var compare = Flag(args, "compare");
        var compact = Flag(args, "compact");
        var candidatePath = ToolRegistry.Text(args, "policyFilePath");
        if (
            candidatePath is not null
            && (
                string.IsNullOrWhiteSpace(candidatePath)
                || Encoding.UTF8.GetByteCount(candidatePath) > 4096
            )
        )
            throw new InvalidDataException(
                "policyFilePath must be one nonempty path within 4096 UTF-8 bytes."
            );
        if (compare && candidatePath is null)
            throw new InvalidDataException("compare requires policyFilePath.");

        // An explanation must not reveal more than the caller could read directly.
        await AuthorizeToolAsync(
            caller,
            new(
                "explain_tool_authorization",
                "node",
                "read",
                new JsonObject { ["filePath"] = authorization.PolicyLocator }
            ),
            files,
            token
        );
        ToolAuthorizationPolicy? candidate = null;
        if (candidatePath is not null)
        {
            await AuthorizeToolAsync(
                caller,
                new(
                    "explain_tool_authorization",
                    "node",
                    "read",
                    new JsonObject { ["filePath"] = candidatePath },
                    ExecutionNode: candidateFiles.AgentFolder is { Store: true } ? AgentStorePaths.Endpoint : "master"
                )
                {
                    AgentFolder = candidateFiles.AgentFolder is not null,
                },
                candidateFiles,
                token
            );
            var bytes = await candidateFiles.CaptureConfigCandidateAsync(candidatePath, true, token);
            try
            {
                candidate = ToolAuthorizationYaml.Parse(bytes);
            }
            catch (Exception error) when (error is InvalidDataException or DecoderFallbackException)
            {
                throw new InvalidDataException("Invalid tool-rules candidate: " + error.Message);
            }
        }
        var active = await authorization.LoadAsync(token);
        var variants = new List<(string Name, ToolAuthorizationPolicy Policy)>();
        if (candidate is null || compare)
            variants.Add(("active", active));
        if (candidate is not null)
            variants.Add(("candidate", candidate));

        var results = new JsonArray();
        var index = 0;
        foreach (var probe in probes.OfType<JsonObject>())
            results.Add(
                (JsonNode?)
                    await ExplainProbeAsync(caller, index++, probe, variants, compact, token)
            );
        var output = new JsonObject
        {
            ["policy"] =
                candidate is null ? "active"
                : compare ? "compare"
                : "candidate",
            ["probes"] = results,
        };
        if (compare)
            output["ruleDiff"] = ToolAuthorizationExplain.RuleDiff(active, candidate!);
        return output;
    }

    private async Task<JsonObject> ExplainProbeAsync(
        SessionOwner caller,
        int index,
        JsonObject probe,
        IReadOnlyList<(string Name, ToolAuthorizationPolicy Policy)> variants,
        bool compact,
        CancellationToken token
    )
    {
        var requested = ToolRegistry.Text(probe, "sessionId");
        var result = new JsonObject();
        if (compact)
            result["index"] = index;
        result["sessionId"] = requested;
        try
        {
            if (probe["label"] is { } label)
            {
                if (
                    label is not JsonValue value
                    || !value.TryGetValue<string>(out var text)
                    || text.Length is 0 or > ToolAuthorizationToolDefinition.MaxExplainLabelLength
                )
                    throw new InvalidDataException(
                        $"label must be a string of 1 to {ToolAuthorizationToolDefinition.MaxExplainLabelLength} characters."
                    );
                result["label"] = text;
            }
            if (string.IsNullOrWhiteSpace(requested))
                throw new InvalidDataException("Each probe requires sessionId.");
            var reference = requested.Trim();
            var self = reference == caller.Id;
            SessionOwner? target;
            try
            {
                if (!self)
                    self =
                        SessionCatalog.Text(Catalog.Resolve(reference)["sessionId"]) == caller.Id;
                target = await GetExistingAsync(reference, token);
            }
            catch (Exception error) when (!self && error is not OperationCanceledException)
            {
                target = null;
            }
            if (target is not null && target.Id != caller.Id)
                try
                {
                    await AuthorizeToolAsync(
                        caller,
                        new(
                            "view_session",
                            "builtin",
                            "view_session",
                            new JsonObject { ["sessionId"] = reference }
                        ),
                        null,
                        token,
                        target
                    );
                }
                catch (Exception error) when (error is not OperationCanceledException)
                {
                    target = null;
                }
            if (target is null)
                throw new InvalidDataException("Session not found or unavailable.");
            result["sessionId"] = target.Id;
            var call = (JsonObject)probe.DeepClone();
            call.Remove("sessionId");
            call.Remove("label");
            ResolvedTool resolved;
            if (call.ContainsKey("command"))
            {
                // A ctl command, parsed and resolved as the model's ctl call would be.
                if (call.Any(pair => pair.Key is not ("command" or "values" or "valuesJson")))
                    throw new InvalidDataException(
                        "A probe gives either command (with values) or a tool, not both."
                    );
                if (CtlParser.Parse(call) is CtlError error)
                    throw new InvalidDataException(error.Message);
                resolved = tools.Route(tools.Resolve("ctl", call, CurrentNode(target)), CurrentNode(target), "ctl", call);
            }
            else
            {
                // Resolve exactly as `tool call` would for this caller's current Node.
                if (!call.ContainsKey("args") && !call.ContainsKey("argsJson"))
                    call["args"] = new JsonObject();
                resolved = tools.Route(tools.Resolve("call_tool", call, CurrentNode(target)), CurrentNode(target), "call_tool", call);
            }
            if (SessionToolExecutor.IsCtlFrontEnd(resolved))
                throw new InvalidDataException(
                    "ctl help, discovery and malformed commands are not authorized; probe a command's target instead."
                );
            if (compact)
                result["toolId"] = ToolAuthorizationExplain.ToolId(resolved);
            else
                result["tool"] = new JsonObject
                {
                    ["source"] = resolved.Source,
                    ["name"] = resolved.Name,
                    ["server"] = resolved.Server,
                    ["executionNode"] = resolved.ExecutionNode,
                };
            var invocation = resolved.Command is { } command
                ? "ctl " + command
                : "ctl tool call";
            // As dispatch does: an Agent-folder call's facts are the Agent folder's.
            var files = resolved.AgentFolder ? AgentFolderWorkspace(target) : IdentityWorkspace(target);
            var explained = new List<(string Name, ExplainedVariant Variant)>();
            // The probe's own assessment inspects master paths as it always has; the record keeps
            // what it inspected, and the additions below may use only that.
            var inspected = new PathInspectionRecord();
            using (AuthorizationPaths.Inspecting(inspected, replay: false))
                foreach (var (name, policy) in variants)
                    explained.Add(
                        (name, await ExplainVariantAsync(target, resolved, files, policy, token))
                    );
            using var replay = AuthorizationPaths.Inspecting(inspected, replay: true);
            // Each policy variant has its own plan, from the facts its own assessment established
            // (a candidate policy can allow a read that reveals more facts); the plan reads
            // nothing itself.
            var plans = explained
                .Select(item =>
                    OperationPlan.Derive(
                        resolved,
                        PlanFacts(target, item.Variant.Assessment?.Request),
                        PlanContextFor(target, item.Variant.Assessment)
                    )
                )
                .ToArray();
            var plan = plans[0];
            var obligations = new List<JsonArray>();
            for (var item = 0; item < variants.Count; item++)
                obligations.Add(
                    await ExplainObligationsAsync(
                        target,
                        plans[item],
                        explained[item].Variant.Assessment,
                        files,
                        variants[item].Policy,
                        token
                    )
                );
            if (compact)
            {
                // toolId already names the capability. A command probe adds the command it
                // ran as, and any row adds the first other check that denies, else asks; the
                // full plan is left out.
                if (resolved.Command is not null)
                    result["invocation"] = invocation;
                if (explained.Count == 1)
                {
                    ToolAuthorizationExplain.CompactVariant(explained[0].Variant, result);
                    ToolAuthorizationExplain.CompactObligation(obligations[0], result);
                }
                else
                    for (var item = 0; item < explained.Count; item++)
                    {
                        var row = ToolAuthorizationExplain.CompactVariant(
                            explained[item].Variant,
                            new JsonObject()
                        );
                        ToolAuthorizationExplain.CompactObligation(obligations[item], row);
                        result[explained[item].Name] = row;
                    }
            }
            else
                for (var item = 0; item < explained.Count; item++)
                {
                    var full = ToolAuthorizationExplain.FullVariant(explained[item].Variant);
                    full["obligations"] = obligations[item];
                    result[explained[item].Name] = full;
                }
            // A variant whose facts give a different plan carries its own.
            var differing = Enumerable
                .Range(1, plans.Length - 1)
                .Where(item => !JsonNode.DeepEquals(plans[item].ToJson(), plan.ToJson()))
                .ToArray();
            if (variants.Count == 2)
                result["changed"] = explained[0].Variant.Decision != explained[1].Variant.Decision;
            // The plan follows the existing fields, which keep their order.
            if (!compact)
            {
                result["invocation"] = invocation;
                var shared = plan.ToJson();
                if (differing.Length > 0)
                {
                    var incomplete = shared["incomplete"] as JsonArray ?? [];
                    foreach (var item in differing)
                    {
                        incomplete.Add(
                            (JsonNode?)
                                $"the {explained[item].Name} policy establishes different facts; its plan is in {explained[item].Name}.plan"
                        );
                        result[explained[item].Name]!["plan"] = plans[item].ToJson();
                    }
                    shared["incomplete"] = incomplete;
                }
                foreach (var pair in shared)
                    result[pair.Key] = pair.Value?.DeepClone();
            }
        }
        catch (Exception error)
            when (error is InvalidDataException or InvalidOperationException
                && error is not ToolAuthorizationDeniedException
            )
        {
            result["error"] = error.Message;
        }
        return result;
    }

    private PlanContext PlanContextFor(SessionOwner target, AuthorizationAssessment? assessment) =>
        OperationContext(target, null, assessment);

    // Whether node select probes the Node's default cwd, as SelectNodeAsync decides it: a remote
    // Node that is not Provider-backed and advertises get_default_cwd. The handler reaches that
    // check only for an online Node, so an unconnected one has no probe.
    internal bool DefaultCwdProbe(string id) =>
        id != "master"
        && !NodeProviders.IsProviderNode(id)
        && Nodes
            .DiscoveredDefinitions(id)
            .Any(value => SessionWait.Text(value?["name"]) == "get_default_cwd");

    // Facts for the plan: the assessment's request, with the Session target its resolver names
    // filled in when no rule needed it. That is a catalog lookup, never a protected read.
    private ToolAuthorizationRequest? PlanFacts(
        SessionOwner target,
        ToolAuthorizationRequest? request
    )
    {
        if (request is null || request.SessionTarget is not null)
            return request;
        try
        {
            return PopulateAuthorizationTargets(request, target);
        }
        catch (Exception error) when (error is InvalidDataException or InvalidOperationException)
        {
            return request;
        }
    }

    // Each planned obligation's existing decision under one global policy variant. Obligations
    // the plan cannot construct are reported with the reason instead.
    private async Task<JsonArray> ExplainObligationsAsync(
        SessionOwner target,
        OperationPlan plan,
        AuthorizationAssessment? primary,
        WorkspaceTools files,
        ToolAuthorizationPolicy global,
        CancellationToken token
    )
    {
        var results = new JsonArray();
        foreach (var obligation in plan.Obligations)
        {
            JsonObject entry;
            if (obligation.SameAsPrimary)
            {
                entry = primary is null
                    ? new JsonObject
                    {
                        ["id"] = obligation.Id,
                        ["decision"] = "deny",
                        ["deniedBy"] = "precheck",
                    }
                    : OperationAttribution.Obligation(obligation, primary);
                if (obligation.Kind != ObligationKind.Primary)
                    entry["sameAs"] = "primary";
            }
            else if (obligation.Request is not null || obligation.CreationAgent is not null)
                // An addition never changes or fails the probe's result: whatever stops it is
                // reported as this obligation's reason.
                try
                {
                    entry =
                        obligation.Request is { } request
                            ? Unadmitted(request, primary, out var reused) is { } reason
                                ? NotEvaluated(obligation, reason)
                                : await ExplainObligationAsync(
                                    target,
                                    obligation,
                                    request,
                                    files,
                                    global,
                                    reused,
                                    token
                                )
                            : ExplainCreationTarget(target, obligation, obligation.CreationAgent!, global);
                }
                catch (Exception error) when (error is not OperationCanceledException)
                {
                    entry = NotEvaluated(obligation, error.Message);
                }
            else
                entry = new JsonObject
                {
                    ["id"] = obligation.Id,
                    ["evaluated"] = false,
                    ["reason"] = obligation.Gap,
                };
            results.Add((JsonNode?)entry);
        }
        return results;
    }

    private static JsonObject NotEvaluated(PlannedObligation obligation, string? reason) =>
        new()
        {
            ["id"] = obligation.Id,
            ["evaluated"] = false,
            ["reason"] = reason,
        };

    private async Task<JsonObject> ExplainObligationAsync(
        SessionOwner target,
        PlannedObligation obligation,
        ResolvedTool request,
        WorkspaceTools files,
        ToolAuthorizationPolicy global,
        IReadOnlyList<AuthorizationPath>? paths,
        CancellationToken token
    )
    {
        try
        {
            return OperationAttribution.Obligation(
                obligation,
                await AssessToolAsync(target, request, files, token, global: global, paths: paths)
            );
        }
        catch (ToolAuthorizationDeniedException denied)
        {
            return new JsonObject
            {
                ["id"] = obligation.Id,
                ["decision"] = "deny",
                ["deniedBy"] = "precheck",
                ["precheck"] = denied.Message,
            };
        }
    }

    // Why an obligation is not assessed, or null when it can be assessed from facts already
    // admitted. Explaining a call performs no work the explained call's own assessment did not:
    // it never resolves a Provider endpoint (which runs discovery and admits Node metadata),
    // never inspects a path on master that the probe did not (its path facts are reused, as
    // `paths`), and never derives facts from file contents.
    private string? Unadmitted(
        ResolvedTool request,
        AuthorizationAssessment? primary,
        out IReadOnlyList<AuthorizationPath>? paths
    )
    {
        paths = null;
        var endpoints =
            request is { Source: "builtin", Name: "node" }
                ? NodeProviders.AuthorizationTargets(request.Args)
                : ToolAuthorizationNodeEffects.Resolve(
                    request.Source,
                    request.Name,
                    request.ExecutionNode,
                    request.Args
                );
        var forest = Nodes.Registry.Forest();
        foreach (var node in endpoints ?? [])
            if (NodeProviders.IsProviderNode(node) && !forest.Contains(node))
                return $"Node `{node}` is not yet admitted";
        switch (request)
        {
            case { Source: "node", ExecutionNode: not "master" }:
                // Remote path facts are lexical.
                return null;
            case { Source: "node", Name: "read" or "write" or "edit" or "exec" }:
                var arg = request.Name == "exec" ? "cwd" : "filePath";
                if (
                    SessionWait.Text(request.Args[arg]) is not { } raw
                    || request.Args.ContainsKey("apply_patch")
                    || primary?.Request.Paths.FirstOrDefault(path =>
                        path.Raw == raw && path.Node == "master"
                    ) is not { } established
                )
                    return "its path facts are not established by the probe";
                paths = [established with { Arg = arg }];
                return null;
            case { Source: "node" }:
                return null;
            case { Source: "builtin", Name: "view_session" or "mcp_notifications" or "node_remove" }:
                return null;
            default:
                return "its facts are established only when the call runs";
        }
    }

    // A timer's creation-target probe, combined as timer registration combines it: any deny
    // rejects, then any indeterminate layer, then any ask.
    private JsonObject ExplainCreationTarget(
        SessionOwner target,
        PlannedObligation obligation,
        string agent,
        ToolAuthorizationPolicy global
    )
    {
        var request = AuthorizationRequest(
            target,
            "builtin",
            "create_session",
            null,
            new JsonObject { ["agentName"] = agent },
            []
        );
        var layers = new JsonArray();
        var decisions = new List<CreationTargetDecision>();
        foreach (var (layer, policy) in EffectiveLayers(target.Agent, global))
        {
            var outcome = ToolAuthorizationEvaluation.EvaluateCreationTargetOutcome(policy, request);
            decisions.Add(outcome.Decision);
            layers.Add((JsonNode?)OperationAttribution.CreationLayer(layer, policy, outcome));
        }
        var combined =
            decisions.Contains(CreationTargetDecision.Deny) ? "deny"
            : decisions.Contains(CreationTargetDecision.Indeterminate) ? "indeterminate"
            : decisions.Contains(CreationTargetDecision.Ask) ? "ask"
            : "allow";
        return new JsonObject
        {
            ["id"] = obligation.Id,
            ["decision"] = combined,
            ["agentName"] = agent,
            ["layers"] = layers,
        };
    }

    private async Task<ExplainedVariant> ExplainVariantAsync(
        SessionOwner target,
        ResolvedTool resolved,
        WorkspaceTools files,
        ToolAuthorizationPolicy global,
        CancellationToken token
    )
    {
        try
        {
            return new(
                await AssessToolAsync(target, resolved, files, token, global: global),
                null
            );
        }
        catch (ToolAuthorizationDeniedException denied)
        {
            return new(null, denied.Message);
        }
    }
}
