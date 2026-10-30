using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

// Runtime selection is creation-only. Version 2 uses the existing old-reader refusal gate.
internal static class ClaudeRuntimeState
{
    internal const string Kind = "claude-code";

    internal static bool IsExternal(JsonObject envelope) =>
        SessionWait.Text(envelope["runtime"]) == Kind;

    internal static string ValidateSelection(JsonNode? value, bool present = false)
    {
        if (value is null)
            return present
                ? throw new InvalidDataException("runtime must be foxwarm or claude-code.")
                : "foxwarm";
        var name = SessionWait.Text(value);
        return name is "foxwarm" or Kind
            ? name
            : throw new InvalidDataException("runtime must be foxwarm or claude-code.");
    }

    internal static bool Interrupted(JsonObject envelope) =>
        IsExternal(envelope)
        && SessionWait.Text(envelope["externalRuntime"]?["status"]) is "running" or "interrupted";

    internal static bool CanContinue(JsonObject envelope, bool queued = false) =>
        queued
        || Interrupted(envelope)
        || (SessionWait.Number(envelope["externalRuntime"]?["lastUserSeq"]) ?? 0)
            > (SessionWait.Number(envelope["externalRuntime"]?["submittedThroughSeq"]) ?? 0);

    internal static void RequireFoxwarm(SessionOwner owner, string operation)
    {
        if (IsExternal(owner.Entry.Snapshot().AuthorityEnvelope))
            throw new InvalidOperationException(
                operation + " is not supported for Claude Code Sessions."
            );
    }

    internal static void ValidateAuthority(JsonObject root)
    {
        var runtime = ValidateSelection(root["runtime"], root.ContainsKey("runtime"));
        var version = SessionWait.Number(root["sessionStateVersion"]);
        if (version != (runtime == Kind ? 2 : 1))
            throw SessionAuthorityErrors.Unsupported(
                "Session authority runtime/version combination is unsupported.",
                "sessionStateVersion"
            );
        if (runtime != Kind)
        {
            if (root.ContainsKey("externalRuntime"))
                throw SessionAuthorityErrors.Invalid(
                    "Foxwarm Sessions cannot carry an external checkpoint."
                );
            return;
        }
        if (root["externalRuntime"] is not JsonObject checkpoint)
            throw SessionAuthorityErrors.Invalid("Claude Code Session requires externalRuntime.");
        if (
            checkpoint.Any(pair =>
                pair.Key
                    is not (
                        "status"
                        or "sessionId"
                        or "transcript"
                        or "cwd"
                        or "model"
                        or "authMethod"
                        or "submittedThroughSeq"
                        or "lastUserSeq"
                        or "lastResult"
                    )
            )
        )
            throw SessionAuthorityErrors.Invalid("Unsupported external runtime checkpoint field.");
        if (
            SessionWait.Text(checkpoint["status"])
            is not ("new" or "running" or "complete" or "interrupted")
        )
            throw SessionAuthorityErrors.Invalid("Invalid external runtime status.");
        foreach (var key in new[] { "sessionId", "transcript", "cwd", "model", "authMethod" })
            if (
                checkpoint.ContainsKey(key)
                && SessionWait.Text(checkpoint[key]) is not { Length: > 0 }
            )
                throw SessionAuthorityErrors.Invalid("Invalid external runtime " + key + ".");
        if (root["model"] is not null || root["effort"] is not null)
            throw SessionAuthorityErrors.Invalid(
                "Claude Code Sessions cannot carry Foxwarm model overrides."
            );
        if (SessionWait.Text(checkpoint["status"]) == "new")
        {
            if (checkpoint.Any(pair => pair.Key is not ("status" or "lastUserSeq")))
                throw SessionAuthorityErrors.Invalid(
                    "A new external context cannot carry a previous checkpoint."
                );
        }
        else
        {
            foreach (var key in new[] { "sessionId", "transcript", "cwd" })
                if (SessionWait.Text(checkpoint[key]) is not { Length: > 0 })
                    throw SessionAuthorityErrors.Invalid(
                        "External runtime checkpoint is missing " + key + "."
                    );
            if (
                !Path.IsPathFullyQualified(SessionWait.Text(checkpoint["cwd"])!)
                || !Path.IsPathFullyQualified(SessionWait.Text(checkpoint["transcript"])!)
            )
                throw SessionAuthorityErrors.Invalid(
                    "External runtime checkpoint paths must be Main-local absolute paths."
                );
            if (checkpoint["submittedThroughSeq"] is null)
                throw SessionAuthorityErrors.Invalid(
                    "External runtime checkpoint requires an input frontier."
                );
            if (
                SessionWait.Number(checkpoint["submittedThroughSeq"])
                >= SessionWait.Number(root["nextMessageSeq"])
            )
                throw SessionAuthorityErrors.Invalid(
                    "External runtime input frontier exceeds committed history."
                );
        }
        if (
            checkpoint["sessionId"] is not null
            && !Guid.TryParse(SessionWait.Text(checkpoint["sessionId"]), out _)
        )
            throw SessionAuthorityErrors.Invalid("Invalid external session UUID.");
        if (
            checkpoint["submittedThroughSeq"] is { } seq
            && (
                SessionWait.Number(seq) is not double n
                || n < 0
                || n > 9_007_199_254_740_991
                || n != Math.Truncate(n)
            )
        )
            throw SessionAuthorityErrors.Invalid("Invalid external input frontier.");
        if (
            checkpoint["lastUserSeq"] is { } userSeq
            && (
                SessionWait.Number(userSeq) is not double last
                || last < 0
                || last != Math.Truncate(last)
                || last >= (SessionWait.Number(root["nextMessageSeq"]) ?? 0)
            )
        )
            throw SessionAuthorityErrors.Invalid("Invalid external latest-user sequence.");
        if (checkpoint.ContainsKey("lastResult") && checkpoint["lastResult"] is not JsonObject)
            throw SessionAuthorityErrors.Invalid("Invalid external result metadata.");
    }
}
