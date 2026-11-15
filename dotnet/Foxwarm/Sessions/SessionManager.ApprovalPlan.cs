using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

// One request a call must pass besides its own, as its owner will construct it. An optional
// check (the default-cwd probe of node select) joins an approval the call needs anyway, but
// never causes one or stops the call.
// A check whose owner reports a deny as part of its result (an explain probe it cannot view)
// joins the approval when it asks, but its deny does not stop the call.
internal sealed record PlannedCheck(
    string Id,
    ResolvedTool Request,
    WorkspaceTools? Files,
    bool Optional = false,
    bool DenyStops = true
);

internal sealed record AssessedCheck(
    PlannedCheck Check,
    AuthorizationAssessment Assessment,
    ToolAuthorizationRequest Facts,
    string Fingerprint
);

// Staged approval of one call under version-1 rules (phase 2 of operation authorization).
//
// A. Protected inputs whose content decides facts of the call (the set_config candidate of
//    config and models) are assessed first. A deny stops the call; asks become one input
//    approval; the admitted bytes are captured for the effect.
// B. The call's own request and every other request of its plan that can be built before it
//    runs are assessed. Asks become one call approval whose grant lists each asking request.
//    Any deny among required checks prevents the approval.
// C. Each owner still checks its requests against the current policy and facts when it runs
//    (AuthorizeToolAsync); a grant covers an ask only for a request it lists.
internal sealed partial class SessionManager
{
    // Whether any effective layer of the Agent can produce an ask. Without one, a call is
    // assessed exactly as before staging: its own request at the gate, every other request at
    // its owner.
    // Layers that cannot be read leave the decision to the call's own assessment, which reports
    // them as before.
    internal bool PolicyCanAsk(string agent, ToolAuthorizationPolicy global)
    {
        try
        {
            return PolicyLayersCanAsk(agent, global);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            return false;
        }
    }

    private bool PolicyLayersCanAsk(string agent, ToolAuthorizationPolicy global) =>
        EffectiveLayers(agent, global)
            .Any(layer =>
                SessionWait.Text(layer.Policy.Value["defaultAction"]) == "ask"
                || (layer.Policy.Value["rules"] as JsonArray ?? [])
                    .OfType<JsonObject>()
                    .Any(rule =>
                        rule["enabled"]?.GetValue<bool>() != false
                        && SessionWait.Text(rule["action"]) == "ask"
                    )
            );

    // The gate's authorization of a call. Throws the denial, or ToolApprovalRequiredException
    // with every asking check of the stage when an approval is needed.
    internal async Task AuthorizeCallAsync(
        SessionOwner owner,
        ResolvedTool resolved,
        WorkspaceTools? files,
        string currentNode,
        CancellationToken token,
        Action<AuthorizationAssessment>? observe = null
    )
    {
        var scope =
            ToolApprovalScope.Current is { } current && ReferenceEquals(current.Owner, owner)
                ? current
                : null;
        var staged = PolicyCanAsk(owner.Agent, await authorization.LoadAsync(token));
        // A denied input stops derivation: the call is never offered for approval. Without any
        // ask its owner reports the denial, as before staging.
        AssessedCheck? deniedInput = null;
        if (staged)
        {
            // Stage A.
            var inputs = await AssessChecksAsync(owner, InputChecks(resolved, files), token);
            deniedInput = inputs.FirstOrDefault(check => check.Assessment.Denied is not null);
            var asking = deniedInput is null ? Uncovered(owner, scope, inputs) : [];
            if (asking.Count > 0)
                throw new ToolApprovalRequiredException(asking, resolved, ToolApprovalStage.Input);
            if (scope is not null && deniedInput is null)
                await AdmitInputsAsync(resolved, files, scope, token);
        }
        // Stage B.
        var primary = await AssessToolAsync(owner, resolved, files, token);
        observe?.Invoke(primary);
        if (primary.Denied is not null)
            throw Denial(owner, resolved, primary);
        var checks = new List<ApprovalCheck>();
        if (primary.Effect == ToolAuthorizationEffect.Ask)
        {
            var fingerprint = ApprovalFingerprint(owner, resolved, primary.Request);
            if (scope?.Covers(owner, fingerprint) != true)
                checks.Add(new("primary", resolved, primary, fingerprint, true));
        }
        if (deniedInput is not null && (checks.Count > 0 || scope?.Grant is not null))
            throw Denial(owner, deniedInput.Check.Request, deniedInput.Assessment);
        if (staged && deniedInput is null)
        {
            var planned = CallChecks(owner, resolved, primary.Request, files, currentNode);
            var assessed = await AssessChecksAsync(owner, planned, token);
            var required = assessed.Where(check => !check.Check.Optional).ToArray();
            checks.AddRange(Uncovered(owner, scope, required));
            // A call that asks is never offered for approval, nor dispatched after one, when a
            // check it needs is denied; a call without any ask leaves that deny to its owner.
            if (checks.Count > 0 || scope?.Grant is not null)
            {
                if (
                    required.FirstOrDefault(check =>
                        check.Check.DenyStops && check.Assessment.Denied is not null
                    ) is { } denied
                )
                    throw Denial(owner, denied.Check.Request, denied.Assessment);
                await RequireCreationTargetAsync(owner, resolved, token);
                // Optional checks join an approval the call needs anyway; they never cause one.
                if (checks.Count > 0)
                    checks.AddRange(
                    Uncovered(owner, scope, assessed.Where(check => check.Check.Optional).ToArray())
                );
            }
        }
        if (checks.Count > 0)
            throw new ToolApprovalRequiredException(
                // A check identical to an earlier one (a cascade's root member) is listed once.
                checks.DistinctBy(check => check.Fingerprint).ToArray(),
                resolved,
                ToolApprovalStage.Call,
                primary.Request
            );
        if (!IsCurrentOwner(owner))
            throw new InvalidOperationException(
                "Tool source is no longer the current Session owner."
            );
    }

    private List<ApprovalCheck> Uncovered(
        SessionOwner owner,
        ToolApprovalScope? scope,
        IEnumerable<AssessedCheck> assessed
    ) =>
        assessed
            .Where(check =>
                check.Assessment.Effect == ToolAuthorizationEffect.Ask
                && scope?.Covers(owner, check.Fingerprint) != true
            )
            .Select(check =>
                new ApprovalCheck(
                    check.Check.Id,
                    check.Check.Request,
                    check.Assessment,
                    check.Fingerprint,
                    false
                )
                {
                    Facts = check.Facts,
                }
            )
            .ToList();

    // Each check as its owner would assess it now. A check that cannot be assessed before the
    // call runs (invalid arguments, an unreadable path) is left to its owner, which reports it
    // as before.
    private async Task<IReadOnlyList<AssessedCheck>> AssessChecksAsync(
        SessionOwner owner,
        IReadOnlyList<PlannedCheck> checks,
        CancellationToken token
    )
    {
        var assessed = new List<AssessedCheck>();
        foreach (var check in checks)
        {
            AuthorizationAssessment assessment;
            try
            {
                assessment = await AssessToolAsync(owner, check.Request, check.Files, token);
            }
            catch (Exception error)
                when (error
                        is not OperationCanceledException
                            and not ToolAuthorizationUnavailableException
                            and not SessionIdentityUnavailableException
                )
            {
                continue;
            }
            var facts = ApprovalRequest(owner, assessment.Request);
            assessed.Add(
                new(check, assessment, facts, ToolApprovalScope.Fingerprint(check.Request, facts))
            );
        }
        return assessed;
    }

    // Stage A inputs: protected reads whose content decides facts of the call.
    private IReadOnlyList<PlannedCheck> InputChecks(ResolvedTool resolved, WorkspaceTools? files) =>
        CandidateInputPath(resolved, files) is { } path
            ? [new("candidate-read", CandidateRead(path), files)]
            : [];

    // The set_config candidate of config or models, whose secret facts come from its content.
    private string? CandidateInputPath(ResolvedTool resolved, WorkspaceTools? files) =>
        resolved is { Source: "builtin", Name: "set_config" }
        && files is not null
        && models.ConfigurationOwner is not null
        && SessionWait.Text(resolved.Args["target"]) is "config" or "models"
        && SessionWait.Text(resolved.Args["filePath"]) is { } path
        && !string.IsNullOrWhiteSpace(path)
        && System.Text.Encoding.UTF8.GetByteCount(path) <= 4096
            ? path
            : null;

    // Captures the admitted bytes of each input once per invocation. A read failure is left to
    // the handler, which reports it.
    private async Task AdmitInputsAsync(
        ResolvedTool resolved,
        WorkspaceTools? files,
        ToolApprovalScope scope,
        CancellationToken token
    )
    {
        if (CandidateInputPath(resolved, files) is not { } path)
            return;
        var key = CandidateInput(path);
        if (scope.Inputs.ContainsKey(key))
            return;
        try
        {
            scope.Inputs[key] = await files!.CaptureConfigCandidateAsync(path, false, token);
        }
        catch (Exception error) when (error is not OperationCanceledException)
        {
            // The handler reads the candidate itself and reports why it cannot.
        }
    }

    // Stage B checks besides the call's own request: the sub-requests, retained final requests
    // and probes of its plan that can be built from the arguments and current facts. Inputs of
    // stage A are not repeated.
    internal IReadOnlyList<PlannedCheck> CallChecks(
        SessionOwner owner,
        ResolvedTool resolved,
        ToolAuthorizationRequest facts,
        WorkspaceTools? files,
        string currentNode
    )
    {
        var input = InputChecks(resolved, files).Select(check => check.Id).ToHashSet();
        var plan = OperationPlan.Derive(
            resolved,
            PlanFacts(owner, facts),
            PlanContextFor(owner, null) with
            {
                CurrentNode = currentNode,
            }
        );
        var cascade = resolved.Args["cascade"] is JsonValue flag
            && flag.TryGetValue<bool>(out var value)
            && value;
        var checks = new List<PlannedCheck>();
        foreach (var obligation in plan.Obligations)
        {
            if (
                obligation.Request is not { } request
                || obligation.SameAsPrimary
                || obligation.Kind is ObligationKind.Primary or ObligationKind.Nested
                || input.Contains(obligation.Id)
            )
                continue;
            // Without cascade the removal never reaches descendants; the handler rejects it.
            if (
                obligation.Id.StartsWith("member:", StringComparison.Ordinal)
                && !cascade
                && SessionWait.Text(request.Args["nodeId"]) != SessionWait.Text(resolved.Args["nodeId"])?.Trim()
            )
                continue;
            if (obligation.Id.StartsWith("probe-view:", StringComparison.Ordinal))
            {
                // The explain owner views only existing Sessions other than the caller, by
                // alias too, and reports a refused view as that probe's error.
                var probed = ProbedSession(SessionWait.Text(request.Args["sessionId"]));
                if (probed is null || probed == owner.Id)
                    continue;
                checks.Add(new(obligation.Id, request, files, DenyStops: false));
                continue;
            }
            checks.Add(new(obligation.Id, request, files, obligation.Optional));
        }
        checks.AddRange(PromptFileChecks(owner, resolved));
        checks.AddRange(ConfigReadChecks(owner, resolved));
        return checks;
    }

    private string? ProbedSession(string? reference)
    {
        if (string.IsNullOrWhiteSpace(reference))
            return null;
        try
        {
            return SessionCatalog.Text(Catalog.Resolve(reference.Trim())["sessionId"]);
        }
        catch (Exception error) when (error is InvalidDataException or InvalidOperationException or KeyNotFoundException)
        {
            return null;
        }
    }

    // create_session's prompt files, read on master as AuthorizePromptFilesAsync reads them.
    private IEnumerable<PlannedCheck> PromptFileChecks(SessionOwner owner, ResolvedTool resolved)
    {
        if (
            resolved is not { Source: "builtin", Name: "create_session" }
            || resolved.Args["agentName"] is not JsonValue agentValue
            || !agentValue.TryGetValue<string>(out var agent)
        )
            return [];
        IReadOnlyList<string>? selection;
        try
        {
            selection = AgentMemory.NormalizeSelection(resolved.Args["systemPromptFiles"]);
        }
        catch (InvalidDataException)
        {
            return [];
        }
        if (selection is null)
            return [];
        var files = new WorkspaceTools(AgentDirectory(owner.Agent));
        var checks = new List<PlannedCheck>();
        foreach (var reference in selection)
        {
            string path;
            try
            {
                path = memory.ResolveSelectedPath(agent, reference);
            }
            catch (Exception error) when (error is ArgumentException or InvalidDataException)
            {
                continue;
            }
            checks.Add(
                new(
                    "prompt-file-read:" + reference,
                    new("read", "node", "read", new JsonObject { ["filePath"] = path }),
                    files
                )
            );
        }
        return checks;
    }

    // add_secret fromConfig: the read of each configuration file holding the value, as
    // MoveSecretLiteralAsync authorizes it.
    private IEnumerable<PlannedCheck> ConfigReadChecks(SessionOwner owner, ResolvedTool resolved)
    {
        if (
            resolved is not { Source: "builtin", Name: "add_secret" }
            || resolved.Args["fromConfig"] is null
            || models.ConfigurationOwner is not { } configuration
        )
            return [];
        IEnumerable<string> targets;
        try
        {
            targets = Foxwarm.Secrets.SecretLiteralMove
                .Parse(resolved.Args["fromConfig"])
                .Select(location => location.Target)
                .Distinct()
                .ToArray();
        }
        catch (InvalidDataException)
        {
            return [];
        }
        var master = IdentityWorkspace(owner, null, "master");
        return targets.Select(target => new PlannedCheck(
            "config-read:" + target,
            new(
                "add_secret",
                "node",
                "read",
                new JsonObject
                {
                    ["filePath"] = target switch
                    {
                        "models" => configuration.ActivePath,
                        "config" => configuration.AppPath,
                        _ => mcp.Configuration.FilePath,
                    },
                }
            ),
            master
        ));
    }

    // A new-Session timer whose creation target registration would reject is not offered for
    // approval. The probe is never approvable; the timer owner runs it again when it registers.
    private async Task RequireCreationTargetAsync(
        SessionOwner owner,
        ResolvedTool resolved,
        CancellationToken token
    )
    {
        if (
            resolved is { Source: "builtin", Name: "create_timer" }
            && CreationTargetAgent(resolved.Args) is { } agent
        )
            await AuthorizeCreateSessionTargetAsync(owner, agent, token);
    }

    // The Agent of a new-Session timer's creation target when the arguments name it.
    private static string? CreationTargetAgent(JsonObject args) =>
        args["newSession"] is JsonValue flag
        && flag.TryGetValue<bool>(out var value)
        && value
        && SessionWait.Text(args["agentName"]) is { } agent
        && agent.Trim().Length > 0
            ? agent.Trim()
            : null;
}
