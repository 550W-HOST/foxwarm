using System.Text;
using System.Text.Json.Nodes;
using System.Text.RegularExpressions;
using Foxwarm.Nodes;
using Foxwarm.Sessions;
using Foxwarm.Tools;

namespace Foxwarm;

internal sealed class McpInboundNodes(
    NodeConnectionHub nodes,
    McpExternalAuthorization authorization
)
{
    private static readonly string[] supported = ["read", "write", "edit", "apply_patch", "exec"];

    private static IReadOnlyList<AuthorizationPath> Paths(string node, string name, JsonObject args)
    {
        var records = new List<AuthorizationPath>();
        void Add(string key, string? value)
        {
            if (!string.IsNullOrEmpty(value))
                records.Add(new(key, value, null, node));
        }
        if (name is "read" or "write" or "edit")
            Add("filePath", SessionWait.Text(args["filePath"]));
        if (name == "exec")
            Add("cwd", SessionWait.Text(args["cwd"]));
        if (name == "apply_patch" && SessionWait.Text(args["input"]) is string input)
            foreach (var operation in WorkspacePatch.Parse(input))
                Add("input", operation.Path);
        return records;
    }

    private ToolAuthorizationRequest Permission(
        McpExternalContext context,
        string node,
        string name,
        JsonObject args
    ) =>
        authorization.Request(
            context,
            "node",
            name,
            args,
            node: node,
            paths: Paths(node, name, args)
        );

    internal IReadOnlyList<JsonObject> Tools(McpExternalContext context)
    {
        context.Require();
        var result = new List<JsonObject>();
        foreach (var row in nodes.List().OfType<JsonObject>().Take(100))
        {
            var node = SessionWait.Text(row["id"])!;
            if (!nodes.SupportsExternal(node))
                continue;
            foreach (var tool in nodes.DiscoveredDefinitions(node).OfType<JsonObject>().Take(200))
            {
                var name = SessionWait.Text(tool["name"])!;
                if (
                    !supported.Contains(name)
                    || !authorization.Visible(context, Permission(context, node, name, new()))
                )
                    continue;
                var description = SessionWait.Text(tool["description"]) ?? "";
                var descriptor = new JsonObject
                {
                    ["nodeId"] = node,
                    ["name"] = name,
                    ["description"] = description[..Math.Min(description.Length, 2000)],
                };
                if (
                    tool["parameters"] is JsonNode schema
                    && Encoding.UTF8.GetByteCount(schema.ToJsonString()) <= 16 * 1024
                )
                    descriptor["inputSchema"] = schema.DeepClone();
                result.Add(descriptor);
            }
        }
        return result;
    }

    internal async Task<JsonNode?> CallAsync(
        McpExternalContext context,
        string node,
        string name,
        JsonObject args,
        CancellationToken token
    )
    {
        if (!supported.Contains(name))
            throw new McpInboundSafeException(
                "This Node capability is not available to external callers."
            );
        var permission = Permission(context, node, name, args);
        await authorization.RequireAsync(context, permission, token);
        if (
            !nodes.SupportsExternal(node)
            || !nodes
                .DiscoveredDefinitions(node)
                .OfType<JsonObject>()
                .Any(tool => SessionWait.Text(tool["name"]) == name)
        )
            throw new McpInboundSafeException(
                "Node or Node capability is not available to external callers."
            );
        var selection = context.Selection;
        var cwd = selection.Node == node ? selection.Cwd : null;
        ExternalExecOwnership.Record? record = null;
        if (name == "exec")
            record = nodes.ExternalExec.Reserve(
                context,
                node,
                args,
                selection.Node == node ? selection.Generation : -1
            );
        try
        {
            var value = await nodes.ExecuteExternalAsync(
                context,
                node,
                name,
                args,
                cwd,
                record,
                () => authorization.Require(context, permission),
                token
            );
            if (record is null)
                return value;
            if (
                value is not JsonObject response
                || SessionWait.Text(response["execId"]) != record.Id
                || response["background"] is not JsonValue backgroundValue
                || !backgroundValue.TryGetValue<bool>(out var background)
                || SessionWait.Text(response["output"]) is not string output
            )
                throw new McpInboundSafeException(
                    "External Node exec outcome is unknown; do not retry automatically."
                );
            if (
                !background
                && !nodes.ExternalExec.Complete(
                    node,
                    context.WireOwner(),
                    record.Id,
                    record.Capability,
                    output,
                    SessionWait.Text(response["cwd"])
                )
            )
                throw new McpInboundSafeException(
                    "External Node exec output could not be retained; do not retry automatically."
                );
            return value;
        }
        catch
        {
            if (record is not null)
                nodes.ExternalExec.Failed(record, false);
            throw;
        }
    }

    internal async Task<JsonObject> ResultAsync(
        McpExternalContext context,
        string? execId,
        int limit,
        CancellationToken token
    )
    {
        context.Require();
        var records =
            execId is null ? nodes.ExternalExec.List(context, limit)
            : nodes.ExternalExec.Get(context, execId) is { } found ? [found]
            : Array.Empty<ExternalExecOwnership.Record>();
        if (execId is not null && records.Length != 1)
            throw new McpInboundSafeException("Execution ID is unavailable in this context.");
        var allowed = new List<ExternalExecOwnership.Record>();
        foreach (var record in records)
        {
            try
            {
                await authorization.RequireAsync(
                    context,
                    Permission(context, record.Node, "exec", record.Args),
                    token
                );
                allowed.Add(record);
            }
            catch (McpInboundSafeException)
            {
                context.Require();
            }
        }
        if (execId is null)
            return new JsonObject
            {
                ["executions"] = new JsonArray(
                    allowed
                        .Select(record =>
                            (JsonNode?)
                                new JsonObject
                                {
                                    ["execId"] = record.Id,
                                    ["nodeId"] = record.Node,
                                    ["state"] = record.State,
                                }
                        )
                        .ToArray()
                ),
            };
        if (allowed.Count != 1)
            throw new McpInboundSafeException("Execution result is not permitted.");
        var selected = allowed[0];
        JsonObject? Completed()
        {
            if (
                selected.State != "completed"
                || !ReferenceEquals(nodes.ExternalExec.Get(context, selected.Id), selected)
            )
                return null;
            var result = new JsonObject
            {
                ["execId"] = selected.Id,
                ["nodeId"] = selected.Node,
                ["state"] = "completed",
                ["output"] = selected.Output,
            };
            if (selected.Cwd is not null)
                result["cwd"] = selected.Cwd;
            return result;
        }
        if (Completed() is { } completed)
            return completed;
        try
        {
            var permission = Permission(context, selected.Node, "exec", selected.Args);
            var answer = await nodes.QueryExternalAsync(
                context,
                selected.Node,
                selected.Id,
                () => authorization.Require(context, permission),
                token
            );
            authorization.Require(context, permission);
            if (!ReferenceEquals(nodes.ExternalExec.Get(context, selected.Id), selected))
                throw new IOException("Execution unavailable.");
            if (
                SessionWait.Text(answer["state"]) is not ("running" or "completed")
                || SessionWait.Text(answer["output"]) is not string output
                || Encoding.UTF8.GetByteCount(output) > 256 * 1024
            )
                throw new IOException("Invalid execution result.");
            var cwd = SessionWait.Text(answer["cwd"]);
            if (SessionWait.Text(answer["state"]) == "completed")
                nodes.ExternalExec.Complete(
                    selected.Node,
                    context.WireOwner(),
                    selected.Id,
                    selected.Capability,
                    output,
                    cwd
                );
            var result = new JsonObject
            {
                ["execId"] = execId,
                ["nodeId"] = selected.Node,
                ["state"] = answer["state"]!.DeepClone(),
                ["output"] = output,
            };
            if (cwd is { Length: <= 4096 })
                result["cwd"] = cwd;
            return result;
        }
        catch
        {
            context.Require();
            authorization.Require(
                context,
                Permission(context, selected.Node, "exec", selected.Args)
            );
            return Completed()
                ?? new JsonObject
                {
                    ["execId"] = execId,
                    ["nodeId"] = selected.Node,
                    ["state"] = "unavailable",
                    ["output"] = null,
                };
        }
    }

    internal async Task<JsonObject> ActionAsync(
        McpExternalContext context,
        string action,
        string? node,
        CancellationToken token
    )
    {
        if (action != "select" && node is not null)
            throw new McpInboundSafeException("Node list/status does not accept nodeId.");
        node = node?.Trim();
        if (
            action == "select"
            && (node is null || !Regex.IsMatch(node, "^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$"))
        )
            throw new McpInboundSafeException("Select requires an exact valid nodeId.");
        var args = new JsonObject { ["action"] = action };
        if (node is not null)
            args["nodeId"] = node;
        var selection = context.Selection;
        var permission = authorization.Request(
            context,
            "builtin",
            "node",
            args,
            node: action == "select" ? node
                : action == "status" ? selection.Node
                : null
        );
        await authorization.RequireAsync(context, permission, token);
        if (action == "status")
        {
            var status = new JsonObject
            {
                ["currentNode"] = selection.Node,
                ["available"] = nodes.SupportsExternal(selection.Node),
            };
            if (selection.Cwd is not null)
                status["cwd"] = selection.Cwd;
            return status;
        }
        if (action == "list")
        {
            var allowed = Tools(context)
                .Select(tool => SessionWait.Text(tool["nodeId"])!)
                .ToHashSet(StringComparer.Ordinal);
            var descriptors = nodes
                .List()
                .OfType<JsonObject>()
                .Where(row => allowed.Contains(SessionWait.Text(row["id"])!))
                .Take(100)
                .Select(row =>
                {
                    var descriptor = new JsonObject
                    {
                        ["id"] = row["id"]!.DeepClone(),
                        ["kind"] = "remote",
                        ["provider"] = "authenticated-remote",
                        ["type"] = row["type"]?.DeepClone() ?? JsonValue.Create("remote"),
                        ["availability"] = "ready",
                        ["tools"] = row["tools"]!.DeepClone(),
                    };
                    if (row["protocolCompatibility"] is not null)
                        descriptor["protocolCompatibility"] = row[
                            "protocolCompatibility"
                        ]!.DeepClone();
                    return (JsonNode?)descriptor;
                })
                .ToArray();
            context.Require();
            return new JsonObject
            {
                ["currentNode"] = selection.Node,
                ["nodes"] = new JsonArray(descriptors),
            };
        }
        if (
            !nodes.SupportsExternal(node!)
            || !Tools(context).Any(tool => SessionWait.Text(tool["nodeId"]) == node)
        )
            throw new McpInboundSafeException("Node is not available to this external identity.");
        var result = await nodes.ExecuteExternalAsync(
            context,
            node!,
            "get_default_cwd",
            new(),
            null,
            null,
            () => authorization.Require(context, permission),
            token
        );
        var cwd = SessionWait.Text(result is JsonObject obj ? obj["output"] : result);
        if (cwd is not { Length: > 0 and <= 4096 })
            throw new McpInboundSafeException(
                "Node did not return a valid default working directory."
            );
        authorization.Require(context, permission);
        if (context.Selection.Node != node)
            context.Select(node!, cwd);
        return new JsonObject
        {
            ["currentNode"] = node,
            ["cwd"] = context.Selection.Cwd,
            ["defaultCwd"] = cwd,
        };
    }
}
