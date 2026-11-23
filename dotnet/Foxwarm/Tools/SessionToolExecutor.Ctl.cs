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

    // A command is listed when its capability might be allowed with the command's fixed
    // arguments (its action), so help for a permitted action does not list a denied one.
    private bool CtlVisible(CtlCommand command) =>
        command.Local is not null
        || sessions.ToolVisible(hosted, command.Source!, command.Name!, fixedArgs: command.Fixed);

    private async Task<JsonObject> ExecuteCtlAsync(JsonObject args, CancellationToken token)
    {
        var visible = new Func<CtlCommand, bool>(CtlVisible);
        switch (CtlParser.Parse(args))
        {
            case CtlHelpRequest request:
                return CtlHelp.Render(request, visible) is { } help
                    ? new JsonObject { ["output"] = help }
                    : CtlFailure(CtlHelp.Unknown(request), visible);
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
            case CtlToolHelp toolHelp:
            {
                var target = CtlParser.DescribeCall(toolHelp.Descriptor);
                var described = target is null
                    ? null
                    : await UnifiedTools.ToolHelpAsync(
                        registry,
                        target,
                        token,
                        (source, name, scope) =>
                            sessions.ToolVisible(
                                hosted,
                                source,
                                name,
                                source == "mcp" ? scope : null,
                                node: source == "node" ? scope : null
                            ),
                        ScriptBudget,
                        hosted
                    );
                if (described is not null)
                    return described;
                var message =
                    target is { Source: "mcp", Server: null or "" }
                        ? "Give the MCP server with --server or in the tool ID."
                        : "Unknown tool. Find tools with `tool search`.";
                if (Programmatic)
                    throw new InvalidDataException(message);
                return ToolFailure.Result(message);
            }
            case CtlSkillHelp skillHelp:
            {
                // Shown when running that skill might be allowed, like the help of a command.
                var request = new CtlHelpRequest(skillHelp.Command.Noun, skillHelp.Command.Verb);
                if (
                    CtlHelp.Render(request, visible) is not { } commandHelp
                    || !sessions.ToolVisible(hosted, "builtin", "run_skill", fixedArgs: skillHelp.Args)
                )
                    return CtlFailure(CtlHelp.Unknown(request), visible);
                try
                {
                    var info = await sessions.SkillCatalog.RunnableAsync(
                        SessionWait.Text(skillHelp.Args["skillName"])!.Trim(),
                        Skills.RequestedAgent(SessionWait.Text(skillHelp.Args["agentName"]), hosted.Agent)
                    );
                    return new JsonObject { ["output"] = CtlHelp.Skill(commandHelp, info, info.Run!) };
                }
                catch (Exception error)
                    when (error is InvalidDataException or IOException or UnauthorizedAccessException)
                {
                    if (Programmatic)
                        throw new InvalidDataException(error.Message);
                    return ToolFailure.Result(error.Message);
                }
            }
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
        return ToolFailure.Result(message);
    }
}
