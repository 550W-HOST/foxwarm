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
            // Resolve exactly as `tool call` would for this caller's current Node.
            var call = (JsonObject)probe.DeepClone();
            call.Remove("sessionId");
            call.Remove("label");
            if (!call.ContainsKey("args") && !call.ContainsKey("argsJson"))
                call["args"] = new JsonObject();
            var resolved = tools.Resolve("call_tool", call, CurrentNode(target));
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
            var files = IdentityWorkspace(target);
            var explained = new List<(string Name, ExplainedVariant Variant)>();
            foreach (var (name, policy) in variants)
                explained.Add(
                    (name, await ExplainVariantAsync(target, resolved, files, policy, token))
                );
            if (compact && explained.Count == 1)
                ToolAuthorizationExplain.CompactVariant(explained[0].Variant, result);
            else
                foreach (var (name, variant) in explained)
                    result[name] = compact
                        ? ToolAuthorizationExplain.CompactVariant(variant, new JsonObject())
                        : ToolAuthorizationExplain.FullVariant(variant);
            if (variants.Count == 2)
                result["changed"] = explained[0].Variant.Decision != explained[1].Variant.Decision;
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
