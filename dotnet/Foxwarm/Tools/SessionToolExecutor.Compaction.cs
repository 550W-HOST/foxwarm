using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal sealed partial class SessionToolExecutor
{
    private static JsonObject? CompactSubmissionCall(JsonObject call)
    {
        var name = SessionWait.Text(call["name"]);
        if (name == "submit_compact_plan")
            return (JsonObject)call.DeepClone();
        if (name != "call_tool" || call["args"] is not JsonObject wrapper)
            return null;
        if (
            SessionWait.Text(wrapper["toolId"]) != "builtin:submit_compact_plan"
            && !(
                SessionWait.Text(wrapper["source"]) == "builtin"
                && SessionWait.Text(wrapper["name"]) == "submit_compact_plan"
            )
        )
            return null;
        if (wrapper.ContainsKey("args") && wrapper.ContainsKey("argsJson"))
            return null; // The dispatcher owns malformed wrapper arguments.
        var parsed = FunctionCallArguments.Parse(wrapper["argsJson"] ?? wrapper["args"]);
        var result = new JsonObject { ["args"] = parsed.Args };
        if (parsed.RawArgsText is not null)
            result["rawArgsText"] = parsed.RawArgsText;
        if (parsed.ArgsParseError is not null)
            result["argsParseError"] = parsed.ArgsParseError;
        return result;
    }

    private async Task<JsonObject> SubmitCompactPlanAsync(JsonObject args, CancellationToken token)
    {
        var call = invocation.Value?.CompactCall ?? new JsonObject { ["args"] = args.DeepClone() };
        var malformed = call["argsParseError"] is not null;
        if (!malformed && !args.ContainsKey("inContext"))
            return UnsupportedTurnToolExecutor.ToolError(
                "unknown_tool",
                "submit_compact_plan is available only to the dedicated compactor."
            );
        if (
            !malformed
            && args["inContext"] is JsonValue flag
            && flag.TryGetValue<bool>(out var enabled)
            && !enabled
        )
            return UnsupportedTurnToolExecutor.ToolError(
                "unknown_tool",
                "submit_compact_plan is available only to the dedicated compactor."
            );
        if (
            unattended
            || Programmatic
            || foregroundBatch is not long seq
            || CurrentCallId.Length == 0
        )
            return UnsupportedTurnToolExecutor.ToolError(
                "compact_plan_invalid",
                "In-context submission requires an ordinary foreground tool batch; nested ToolScript and unattended calls are not supported."
            );

        var files = new CompactPlanFiles(
            sessions,
            hosted,
            ExecutionNode,
            ExecutionCwd,
            Files ?? throw new NotSupportedException("This executor has no physical path resolver.")
        );
        string? content = null;
        string? submittedFile = null;
        try
        {
            content = CompactPlanInput.Content(call);
            var planArgs = CompactPlanInput.Arguments(call);
            if (
                planArgs["inContext"] is not JsonValue value
                || !value.TryGetValue<bool>(out var optIn)
                || !optIn
            )
                throw new CompactPlanInvalidException("inContext must be a boolean.");
            submittedFile = CompactPlanInput.FilePath(planArgs);
            if (submittedFile is not null)
            {
                // I/O and authorization failures are not plan rejections.
                content = await files.ReadAsync(submittedFile, token);
                planArgs = CompactPlanInput.ParseFile(content);
            }
            return hosted.Compactor.SubmitInContext(planArgs, seq, CurrentCallId);
        }
        catch (CompactPlanInvalidException error)
        {
            var result = UnsupportedTurnToolExecutor.ToolError(
                "compact_plan_invalid",
                error.Message
            );
            try
            {
                var path =
                    submittedFile
                    ?? await files.SaveAsync(content ?? CompactPlanInput.Content(call), token);
                result["argsFilePath"] = path;
                result["nodeId"] = ExecutionNode;
                if (ExecutionCwd is not null)
                    result["cwd"] = ExecutionCwd;
                result["output"] = CompactPlanInput.RepairGuidance + "\n" + path;
            }
            catch (OperationCanceledException) when (token.IsCancellationRequested)
            {
                throw;
            }
            catch (ToolAuthorizationUnavailableException saveError)
            {
                Interlocked.Exchange(ref policyUnavailable, 1);
                result["stagingError"] = new JsonObject
                {
                    ["type"] = ToolAuthorizationUnavailableException.Code,
                    ["message"] = saveError.Message,
                };
            }
            catch (Exception saveError)
                when (saveError
                        is InvalidDataException
                            or IOException
                            or UnauthorizedAccessException
                            or ArgumentException
                            or NotSupportedException
                            or ToolAuthorizationDeniedException
                )
            {
                result["stagingError"] = new JsonObject
                {
                    ["type"] =
                        saveError is ToolAuthorizationDeniedException
                            ? "tool_authorization_denied"
                            : "tool_io_error",
                    ["message"] = saveError.Message,
                };
            }
            return result;
        }
    }
}
