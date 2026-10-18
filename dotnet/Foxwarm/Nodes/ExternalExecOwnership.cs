using System.Text;
using System.Text.Json.Nodes;
using Foxwarm.Sessions;

namespace Foxwarm.Nodes;

internal sealed class ExternalExecOwnership(RemoteExecAuthority capabilities)
{
    internal sealed class Record(
        McpExternalContext context,
        string node,
        string id,
        JsonObject args,
        string capability,
        long generation
    )
    {
        internal McpExternalContext Context = context;
        internal string Node = node;
        internal string Id = id;
        internal JsonObject Args = args;
        internal string Capability = capability;
        internal long Generation = generation;
        internal volatile string State = "reserved";
        internal long Started = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
        internal long? Completed;
        internal string? Output;
        internal string? Cwd;
    }

    private readonly object gate = new();
    private readonly Dictionary<McpExternalContext, Dictionary<string, Record>> records = [];

    internal Record Reserve(
        McpExternalContext context,
        string node,
        JsonObject args,
        long selectionGeneration
    )
    {
        if (Encoding.UTF8.GetByteCount(args.ToJsonString()) > 64 * 1024)
            throw new McpInboundSafeException("External exec arguments exceed 64 KiB.");
        lock (gate)
        {
            context.Require();
            if (!records.TryGetValue(context, out var scoped))
                records[context] = scoped = new(StringComparer.Ordinal);
            Record? oldest = null;
            if (scoped.Count >= 20)
            {
                oldest = scoped
                    .Values.Where(record => record.State == "completed")
                    .OrderBy(record => record.Completed ?? record.Started)
                    .FirstOrDefault();
                if (oldest is null)
                    throw new McpInboundSafeException(
                        "Too many active executions in this external context."
                    );
            }
            var id = capabilities.NextId(false);
            for (var i = 0; scoped.ContainsKey(id) && i < 8; i++)
                id = capabilities.NextId(false);
            if (scoped.ContainsKey(id))
                throw new McpInboundSafeException("A unique external exec ID is not available.");
            var record = new Record(
                context,
                node,
                id,
                (JsonObject)args.DeepClone(),
                capabilities.IssueExternal(node, context.ExternalId, context.Id, id),
                selectionGeneration
            );
            if (oldest is not null)
                scoped.Remove(oldest.Id);
            scoped.Add(id, record);
            context.UsedNode(node);
            return record;
        }
    }

    internal Record? Get(McpExternalContext context, string id)
    {
        lock (gate)
            return records.GetValueOrDefault(context)?.GetValueOrDefault(id);
    }

    internal Record[] List(McpExternalContext context, int limit)
    {
        lock (gate)
            return records
                    .GetValueOrDefault(context)
                    ?.Values.OrderByDescending(r => r.Started)
                    .Take(limit)
                    .ToArray()
                ?? [];
    }

    private Record? Exact(string node, JsonObject? owner, string? id, string? capability)
    {
        if (
            owner is null
            || SessionWait.Text(owner["kind"]) != "external"
            || id is null
            || capability is null
        )
            return null;
        var externalId = SessionWait.Text(owner["externalId"]);
        var contextId = SessionWait.Text(owner["contextId"]);
        var context = records.Keys.FirstOrDefault(context =>
            context.ExternalId == externalId && context.Id == contextId
        );
        var record = context is null ? null : records[context].GetValueOrDefault(id);
        return
            record is not null
            && context!.Available
            && record.Node == node
            && record.Capability == capability
            && capabilities.VerifyExternal(node, context.ExternalId, context.Id, id, capability)
            ? record
            : null;
    }

    internal bool Background(string node, JsonObject? owner, string? id, string? capability)
    {
        lock (gate)
        {
            var record = Exact(node, owner, id, capability);
            if (record is null)
                return false;
            if (record.State != "completed")
                record.State = "running";
            return true;
        }
    }

    internal bool Complete(
        string node,
        JsonObject? owner,
        string? id,
        string? capability,
        string? output,
        string? cwd
    )
    {
        if (
            output is null
            || Encoding.UTF8.GetByteCount(output) > 256 * 1024
            || cwd is { Length: < 1 or > 4096 }
        )
            return false;
        lock (gate)
        {
            var record = Exact(node, owner, id, capability);
            if (record is null)
                return false;
            if (record.State == "completed")
                return record.Output == output;
            record.Output = output;
            record.Cwd = cwd;
            record.Completed = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds();
            if (cwd is not null)
                record.Context.UpdateCwd(node, record.Generation, cwd);
            record.State = "completed";
            return true;
        }
    }

    internal void Failed(Record record, bool notStarted)
    {
        lock (gate)
            if (ReferenceEquals(Get(record.Context, record.Id), record))
            {
                if (notStarted)
                    records[record.Context].Remove(record.Id);
                else if (record.State == "reserved")
                    record.State = "unknown";
            }
    }

    internal void Release(McpExternalContext context)
    {
        lock (gate)
            records.Remove(context);
    }
}
