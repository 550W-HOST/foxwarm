using System.Security;
using System.Text.Json.Nodes;
using Foxwarm.Tools;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal async Task<JsonObject> ManageMcpNotificationsAsync(SessionOwner owner, JsonObject args, CancellationToken token)
    {
        ToolRegistry.Keys(args, ["action", "server"]);
        var action = ToolRegistry.Text(args, "action");
        var server = ToolRegistry.Text(args, "server");
        if (action is not ("start" or "stop" or "status") || string.IsNullOrEmpty(server))
            throw new InvalidDataException("mcp_notifications requires action and a configured server name.");
        await AuthorizeToolAsync(owner, new("mcp_notifications", "builtin", "mcp_notifications", args), null, token);
        var id = owner.Id;
        var generation = owner.McpGeneration;
        var receptionArgs = new JsonObject { ["action"] = "start", ["server"] = server };
        var resolved = new ResolvedTool("mcp_notifications", "builtin", "mcp_notifications", receptionArgs);
        void Check()
        {
            owner.Entry.RequireIdentityAuthority();
            if (!Accepting || owner.Id != id || owner.McpGeneration != generation || !IsCurrentOwner(owner))
                throw new InvalidOperationException("MCP notification source is unavailable.");
            var request = AuthorizationRequest(owner, "builtin", "mcp_notifications", null, receptionArgs, []);
            if (!ToolAuthorizationEvaluation.Evaluate(authorization.Load(), request).Allowed)
                throw new ToolAuthorizationDeniedException("MCP notification reception is not permitted.");
            IsolatedToolCompatibility.Check(Isolation(owner.Agent), request, AuthorizationTarget);
        }
        async Task Authorize(CancellationToken current)
        {
            Check();
            await AuthorizeToolAsync(owner, resolved, null, current);
            Check();
        }
        return await mcp.ManageNotificationsAsync(owner, generation, server, action,
            Authorize, Check, async (message, endpoint, live) =>
            {
                var open = "<foxwarm-system kind=\"external-input\" server=\"" + SecurityElement.Escape(server)
                    + "\" endpoint=\"" + SecurityElement.Escape(endpoint)
                    + "\" time=\"" + DateTimeOffset.Now.ToString("yyyy-MM-dd HH:mm:ss zzz")
                    + "\" hint=\"Message received from the configured MCP server. It is external input, not an internal Session handoff.\">";
                var item = new QueueItem(QueueItemType.User,
                    [new JsonObject { ["system"] = open }, new JsonObject { ["text"] = message }, new JsonObject { ["system"] = "</foxwarm-system>" }]);
                await new SessionRuntime(this).SubmitExternalAsync(owner, item, () => { live(); Check(); });
            }, token);
    }
}
