using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal static class ClaudeRuntimeToolSupport
{
    private static readonly HashSet<string> unavailable = new(StringComparer.Ordinal)
    {
        "wait",
        "submit_compact_plan",
        "compact_session",
        "run_script",
        "start_toolscript_run",
        "continue_script",
    };

    internal static bool Visible(string source, string name) =>
        source != "builtin" || !unavailable.Contains(name);

    internal static JsonObject Project(JsonObject declaration)
    {
        var projected = (JsonObject)declaration.DeepClone();
        var name = SessionWait.Text(projected["name"]);
        if (name is "send_to_session" or "create_child_session")
        {
            var after = projected["parameters"]?["properties"]?["afterSend"] as JsonObject;
            if (after is not null)
            {
                after["enum"] = new JsonArray("continue");
                after["description"] =
                    "Continue the current Session after delivery. This runtime supports only continue (the default).";
            }
            if (name == "send_to_session")
            {
                var description = SessionWait.Text(projected["description"]) ?? "";
                var framing = description.IndexOf("A structured handoff", StringComparison.Ordinal);
                projected["description"] =
                    "Send a message to another Session. Use this to assign work or report results across Sessions."
                    + (framing < 0 ? "" : " " + description[framing..]);
            }
        }
        return projected;
    }

    internal static void Require(SessionOwner owner, SessionManager sessions, ResolvedTool resolved)
    {
        if (!Visible(resolved.Source, resolved.Name))
            throw new InvalidOperationException(
                "This control is not supported by the Claude Code runtime: " + resolved.Name
            );
        if (resolved.Args.ContainsKey("__cancelAllToolsThisTurn"))
            throw new InvalidDataException(
                "Response-wide batch controls are not supported by the Claude Code runtime."
            );
        if (resolved.Source != "builtin")
            return;
        var args = resolved.Args;
        if (
            resolved.Name is "send_to_session" or "create_child_session"
            && SessionWait.Text(args["afterSend"]) is { } after
            && after != "continue"
        )
            throw new InvalidOperationException(
                "Claude Code runtime supports only afterSend=continue."
            );
        bool IsSelf(JsonNode? input, bool specialReferences = false)
        {
            var requested = SessionWait.Text(input);
            var target = requested is null ? null : SessionGoal.Trim(requested);
            if (string.IsNullOrEmpty(target))
                return true;
            if (specialReferences)
            {
                try
                {
                    target = sessions.ResolveSessionReference(owner, target);
                }
                catch (InvalidDataException)
                {
                    return false;
                }
            }
            return target == owner.Id
                || SessionCatalog.Text(sessions.Catalog.Resolve(target)["sessionId"]) == owner.Id;
        }
        if (
            resolved.Name is "stop_session" or "move_session" or "delete_session"
            && IsSelf(args["sessionId"], resolved.Name == "stop_session")
        )
            throw new InvalidOperationException(
                "Current-Session lifecycle controls are not supported from the Claude Code runtime."
            );
        if (
            resolved.Name == "session"
            && SessionGoal.Trim(SessionWait.Text(args["action"]) ?? "").ToLowerInvariant()
                == "update-parent"
            && IsSelf(args["sessionId"])
        )
            throw new InvalidOperationException(
                "Current-Session identity controls are not supported from the Claude Code runtime."
            );
        if (
            resolved.Name == "create_agent"
            && args["convertSession"] is JsonValue convert
            && convert.TryGetValue<bool>(out var converting)
            && converting
            && IsSelf(args["sourceSessionId"])
        )
            throw new InvalidOperationException(
                "Current-Session Agent conversion is not supported from the Claude Code runtime."
            );
    }
}
