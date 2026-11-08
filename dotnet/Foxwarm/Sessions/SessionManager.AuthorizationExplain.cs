using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal async Task<JsonObject> ExplainToolAuthorizationAsync(
        SessionOwner caller,
        WorkspaceTools files,
        JsonObject args,
        CancellationToken token
    )
    {
        ToolRegistry.Keys(args, ["probes", "policyFilePath", "compare"]);
        if (
            args["probes"] is not JsonArray probes
            || probes.Count is 0 or > ToolAuthorizationToolDefinition.MaxExplainProbes
            || probes.Any(probe => probe is not JsonObject)
        )
            throw new InvalidDataException(
                $"explain_tool_authorization requires 1 to {ToolAuthorizationToolDefinition.MaxExplainProbes} probe objects."
            );
        var compare = args["compare"] switch
        {
            null => false,
            JsonValue value when value.TryGetValue<bool>(out var flag) => flag,
            _ => throw new InvalidDataException("compare must be a boolean."),
        };
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
        foreach (var probe in probes.OfType<JsonObject>())
            results.Add((JsonNode?)await ExplainProbeAsync(caller, probe, variants, token));
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
        return new JsonObject { ["output"] = output.ToJsonString() };
    }

    private async Task<JsonObject> ExplainProbeAsync(
        SessionOwner caller,
        JsonObject probe,
        IReadOnlyList<(string Name, ToolAuthorizationPolicy Policy)> variants,
        CancellationToken token
    )
    {
        var requested = ToolRegistry.Text(probe, "sessionId");
        var result = new JsonObject { ["sessionId"] = requested };
        try
        {
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
            // Resolve exactly as call_tool would for this caller's current Node.
            var call = (JsonObject)probe.DeepClone();
            call.Remove("sessionId");
            if (!call.ContainsKey("args") && !call.ContainsKey("argsJson"))
                call["args"] = new JsonObject();
            var resolved = tools.Resolve("call_tool", call, CurrentNode(target));
            result["tool"] = new JsonObject
            {
                ["source"] = resolved.Source,
                ["name"] = resolved.Name,
                ["server"] = resolved.Server,
                ["executionNode"] = resolved.ExecutionNode,
            };
            var files = IdentityWorkspace(target);
            foreach (var (name, policy) in variants)
                result[name] = await ExplainVariantAsync(target, resolved, files, policy, token);
            if (variants.Count == 2)
                result["changed"] =
                    result["active"]?["allowed"]?.GetValue<bool>()
                    != result["candidate"]?["allowed"]?.GetValue<bool>();
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

    private async Task<JsonObject> ExplainVariantAsync(
        SessionOwner target,
        ResolvedTool resolved,
        WorkspaceTools files,
        ToolAuthorizationPolicy global,
        CancellationToken token
    )
    {
        AuthorizationAssessment assessment;
        try
        {
            assessment = await AssessToolAsync(target, resolved, files, token, global: global);
        }
        catch (ToolAuthorizationDeniedException denied)
        {
            return new JsonObject
            {
                ["allowed"] = false,
                ["deniedBy"] = "precheck",
                ["precheck"] = denied.Message,
            };
        }
        var isolation = Isolation(target.Agent);
        var isolationResult = new JsonObject { ["isolated"] = isolation.Isolated };
        if (isolation.Isolated)
        {
            isolationResult["node"] = isolation.RecordedNode ?? "master";
            try
            {
                IsolatedToolCompatibility.Check(isolation, assessment.Request, AuthorizationTarget);
                isolationResult["allowed"] = true;
            }
            catch (ToolAuthorizationDeniedException denied)
            {
                isolationResult["allowed"] = false;
                isolationResult["reason"] = denied.Message;
            }
        }
        var policyDenied = assessment.Denied is not null;
        var isolationDenied = isolationResult["allowed"]?.GetValue<bool>() == false;
        return new JsonObject
        {
            ["allowed"] = !policyDenied && !isolationDenied,
            ["deniedBy"] =
                policyDenied ? "policy"
                : isolationDenied ? "isolation"
                : null,
            ["layers"] = new JsonArray(
                assessment
                    .Layers.Select(layer => (JsonNode?)ToolAuthorizationExplain.Layer(layer))
                    .ToArray()
            ),
            ["isolation"] = isolationResult,
            ["facts"] = ToolAuthorizationExplain.Facts(assessment.Request),
        };
    }
}
