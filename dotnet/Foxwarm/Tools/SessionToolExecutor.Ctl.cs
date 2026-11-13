using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Tools;

internal sealed partial class SessionToolExecutor
{
    // ctl itself is not a capability: only help, discovery and malformed commands reach this
    // handler, and none of them is separately authorized. Their output is filtered by the
    // caller's policy for each target instead.
    internal static bool IsCtlFrontEnd(ResolvedTool resolved) =>
        resolved is { Source: "builtin", Name: "ctl" };

    private bool CtlVisible(CtlCommand command) =>
        command.Local is not null
        || sessions.ToolVisible(hosted, command.Source!, command.Name!);

    private async Task<JsonObject> ExecuteCtlAsync(JsonObject args, CancellationToken token)
    {
        var visible = new Func<CtlCommand, bool>(CtlVisible);
        switch (CtlParser.Parse(args))
        {
            case CtlHelpRequest request:
                return CtlHelp.Render(request, visible) is { } help
                    ? new JsonObject { ["output"] = help }
                    : CtlFailure(
                        new CtlError(
                            $"Unknown command `{request.Noun}{(request.Verb is null ? "" : " " + request.Verb)}`.",
                            Noun: request.Verb is null ? null : request.Noun
                        ),
                        visible
                    );
            case CtlError error:
                return CtlFailure(error, visible);
            case CtlSearch search:
                return await UnifiedTools.SearchAsync(
                    registry,
                    search.Args,
                    token,
                    (source, name, server) =>
                        sessions.ToolVisible(
                            hosted,
                            source,
                            name,
                            source == "mcp" ? server : null,
                            node: source == "node" ? server : null
                        ),
                    ScriptBudget,
                    hosted,
                    BroadMcpServerVisible(sessions, hosted)
                );
            default:
                // Commands naming a capability resolve to it before dispatch.
                throw new InvalidOperationException("ctl command was not resolved to its target.");
        }
    }

    private JsonObject CtlFailure(CtlError error, Func<CtlCommand, bool> visible)
    {
        var message = CtlHelp.Error(error, visible);
        if (Programmatic)
            throw new InvalidDataException(message);
        return UnsupportedTurnToolExecutor.ToolError("invalid_command", message);
    }
}
