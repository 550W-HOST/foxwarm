using System.Text.Json.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm;

// `ctl` for external MCP clients: the same command grammar as the model's ctl, restricted to
// commands with external ingress. Each command is written as the call of the existing wrapper
// that owns it, so validation, the external principal, policy, ownership, budgets and activity
// records are the wrappers' own.
internal sealed partial class McpInboundCatalog
{
    private const string Ingress = "external";

    private async Task<JsonObject> CtlAsync(
        McpExternalContext context,
        JsonObject args,
        CancellationToken token
    )
    {
        Keys(args, "command", "values");
        var visible = new Func<CtlCommand, bool>(command => CtlVisible(context, command));
        switch (CtlParser.Parse(args, Ingress))
        {
            case CtlHelpRequest request:
                return CtlHelp.Render(request, visible, Ingress) is { } help
                    ? Result(JsonValue.Create(help))
                    : Error(CtlHelp.Error(CtlHelp.Unknown(request), visible, Ingress));
            case CtlError error:
                return Error(CtlHelp.Error(error, visible, Ingress));
            case CtlSearch search:
                return await CallAsync(context, "foxwarm_discover", search.Args, token);
            case CtlCall call:
                if (CtlParser.DescribeCall(call.Descriptor) is not { } described)
                    return Error(CtlHelp.Error(new CtlError("Invalid tool ID.", call.Command), visible, Ingress));
                var scope = described.Source switch
                {
                    "mcp" => described.Server,
                    "node" => described.Node is "current" ? null : described.Node,
                    _ => null,
                };
                if (described.Source != "builtin" && scope is null)
                    return Error(
                        described.Source == "node"
                            ? "Give the Node with --node-id or in the tool ID."
                            : "Give the MCP server with --server or in the tool ID."
                    );
                return await CallTargetAsync(
                    context,
                    described.Source,
                    scope,
                    described.Name,
                    described.Args,
                    token
                );
            case CtlLocal { Local: "exec-result" } local:
                return await CallAsync(context, "foxwarm_exec_result", local.Args, token);
            case CtlTarget target:
                var mapped = (JsonObject)target.Args.DeepClone();
                switch (target.Command.Path)
                {
                    case "session list":
                        return await CallAsync(context, "foxwarm_session", mapped, token);
                    case "session view":
                        mapped["action"] = "read";
                        return await CallAsync(context, "foxwarm_session", mapped, token);
                    case "session send":
                        mapped["action"] = "send";
                        return await CallAsync(context, "foxwarm_session", mapped, token);
                    case "node list" or "node status" or "node select":
                        return await CallAsync(context, "foxwarm_node", mapped, token);
                    case "node pair-list" or "node approve":
                        return await CallTargetAsync(context, "builtin", null, target.Name, mapped, token);
                }
                break;
        }
        return Error("Command is not available.");
    }

    private async Task<JsonObject> CallTargetAsync(
        McpExternalContext context,
        string source,
        string? scope,
        string name,
        JsonObject args,
        CancellationToken token
    )
    {
        try
        {
            context.Require();
            var result = await CallRecordedAsync(context, source, scope, name, args, token);
            context.Require();
            return result;
        }
        catch (McpInboundSafeException error)
        {
            return Error(error.Message);
        }
    }

    // Help lists a command unless external policy definitely denies its capability; the tool
    // commands are filtered by discovery itself.
    private bool CtlVisible(McpExternalContext context, CtlCommand command) =>
        command.Source != "builtin"
        || authorization.Visible(
            context,
            authorization.Request(
                context,
                "builtin",
                command.Name!,
                command.Fixed is { } fixedArgs ? (JsonObject)fixedArgs.DeepClone() : new JsonObject()
            )
        );
}
