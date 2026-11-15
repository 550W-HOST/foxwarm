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
        CancellationToken token
    )
    {
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
                new JsonObject { ["filePath"] = authorization.PolicyPath }
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
                    new JsonObject { ["filePath"] = candidatePath }
                ),
                files,
                token
            );
            var bytes = await files.CaptureConfigCandidateAsync(candidatePath, true, token);
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
                resolved = tools.Resolve("ctl", call, CurrentNode(target));
            }
            else
            {
                // Resolve exactly as `tool call` would for this caller's current Node.
                if (!call.ContainsKey("args") && !call.ContainsKey("argsJson"))
                    call["args"] = new JsonObject();
                resolved = tools.Resolve("call_tool", call, CurrentNode(target));
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
            var files = IdentityWorkspace(target);
            var explained = new List<(string Name, ExplainedVariant Variant)>();
            foreach (var (name, policy) in variants)
                explained.Add(
                    (name, await ExplainVariantAsync(target, resolved, files, policy, token))
                );
            // The plan uses the facts the assessment established; it reads nothing itself.
            var plan = OperationPlan.Derive(
                resolved,
                PlanFacts(
                    target,
                    explained.Select(item => item.Variant.Assessment).FirstOrDefault(item => item is not null)?.Request
                ),
                new PlanContext(CurrentNode(target))
                {
                    PolicyPath = authorization.PolicyPath,
                    Subtree = id =>
                    {
                        try
                        {
                            return Nodes.Registry.Forest().Subtree(id);
                        }
                        catch (InvalidDataException)
                        {
                            return null;
                        }
                    },
                    SessionExists = id => AuthorizationTarget(id) is not null,
                }
            );
            var obligations = new List<JsonArray>();
            for (var item = 0; item < variants.Count; item++)
                obligations.Add(
                    await ExplainObligationsAsync(
                        target,
                        plan,
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
            if (variants.Count == 2)
                result["changed"] = explained[0].Variant.Decision != explained[1].Variant.Decision;
            // The plan follows the existing fields, which keep their order.
            if (!compact)
            {
                result["invocation"] = invocation;
                foreach (var pair in plan.ToJson())
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
            else if (obligation.Request is { } request)
                entry = await ExplainObligationAsync(target, obligation, request, files, global, token);
            else if (obligation.CreationAgent is { } agent)
                entry = ExplainCreationTarget(target, obligation, agent, global);
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

    private async Task<JsonObject> ExplainObligationAsync(
        SessionOwner target,
        PlannedObligation obligation,
        ResolvedTool request,
        WorkspaceTools files,
        ToolAuthorizationPolicy global,
        CancellationToken token
    )
    {
        try
        {
            return OperationAttribution.Obligation(
                obligation,
                await AssessToolAsync(target, request, files, token, global: global)
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
        catch (Exception error)
            when (error is InvalidDataException or InvalidOperationException or NotSupportedException)
        {
            return new JsonObject { ["id"] = obligation.Id, ["error"] = error.Message };
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
            var decision = ToolAuthorizationEvaluation.EvaluateCreationTarget(policy, request);
            decisions.Add(decision);
            layers.Add(
                (JsonNode?)
                    new JsonObject
                    {
                        ["layer"] = layer is null ? "global" : "agent:" + layer,
                        ["decision"] = decision.ToString().ToLowerInvariant(),
                    }
            );
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
