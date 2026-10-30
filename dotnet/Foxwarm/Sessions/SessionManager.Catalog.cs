using System.Text.Json.Nodes;
using Microsoft.Data.Sqlite;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    private readonly object presentationGate = new();
    private readonly Dictionary<string, JsonObject> localVisible = new(StringComparer.Ordinal);
    private long volatileSequence;
    internal string PresentationRevision
    {
        get
        {
            var persisted = Catalog.Revision;
            lock (presentationGate)
                return persisted + ":" + volatileSequence;
        }
    }

    internal JsonObject[] LocalProjections()
    {
        lock (presentationGate)
            return localVisible.Values.Select(row => (JsonObject)row.DeepClone()).ToArray();
    }

    private static JsonObject SnapshotProjection(SessionSnapshot snapshot)
    {
        var raw = new JsonObject { ["id"] = snapshot.Id };
        foreach (
            var key in new[]
            {
                "agent",
                "aliases",
                "parentSessionId",
                "displayName",
                "archived",
                "pinned",
                "sidebarOrder",
                "currentNode",
                "cwd",
                "runtime",
                "externalRuntime",
                "model",
                "effort",
                "childModelDefault",
                "childEffortDefault",
                "vectorIndexPosition",
                "stats",
                "verbose",
                "compactThresholdTokens",
            }
        )
            SessionCatalog.Copy(snapshot.AuthorityEnvelope, raw, key);
        var meta = new JsonObject
        {
            ["lastMessageTime"] = snapshot.Meta["lastMessageTime"]?.DeepClone(),
            ["messageCount"] = snapshot.History.Count,
        };
        SessionCatalog.Copy(snapshot.Meta, meta, "lastChannel");
        SessionCatalog.Copy(snapshot.Meta, meta, "llmFailed");
        if (SessionCatalog.WaitProjection(snapshot.Meta["wait"]) is { } wait)
            meta["wait"] = wait;
        raw["meta"] = meta;
        raw["busy"] = snapshot.Busy;
        raw["stopping"] = snapshot.Stopping;
        if (snapshot.BusyStartedAt is { } started)
            raw["busyStartedAt"] = started;
        raw["queueLength"] = snapshot.Queue.Count(SessionCompactor.Ordinary);
        return raw;
    }

    private void PublishCatalogSnapshot(SessionSnapshot snapshot, IdentitySlot slot)
    {
        lock (lifecycle)
            if (
                !identities.TryGetValue(snapshot.Id, out var current)
                || current != slot
                || slot.Retired
            )
                throw new InvalidOperationException(
                    "Session authority lifetime is no longer current."
                );
        Catalog.PublishAuthority(
            SnapshotProjection(snapshot),
            slot.Creating && !slot.CatalogCreated
        );
        slot.CatalogCreated = true;
    }

    private static SessionMetadata Metadata(JsonObject row)
    {
        static long N(JsonNode? node) => (long)(SessionCatalog.Number(node) ?? 0);
        static string? T(JsonNode? node) => SessionCatalog.Text(node);
        return new(
            T(row["id"])!,
            T(row["agent"]) ?? "main",
            T(row["parentSessionId"]),
            T(row["displayName"]),
            SessionCatalog.Flag(row["busy"]),
            SessionCatalog.Flag(row["stopping"]),
            SessionCatalog.Number(row["busyStartedAt"]) is { } start ? (long)start : null,
            (int)N(row["queueLength"]),
            (int)N(row["meta"]?["messageCount"]),
            0,
            0,
            SessionCatalog.Number(row["meta"]?["lastMessageTime"]) ?? 0,
            SessionCatalog.Flag(row["archived"]),
            SessionCatalog.Flag(row["pinned"]),
            SessionCatalog.Number(row["sidebarOrder"]),
            T(row["runtime"]) == ClaudeRuntimeState.Kind ? T(row["externalRuntime"]?["model"]) : T(row["model"]),
            T(row["effort"]),
            SessionCatalog.Number(row["stats"]?["totalCachedTokens"]) ?? 0,
            SessionCatalog.Number(row["stats"]?["totalInputTokens"]) ?? 0,
            SessionCatalog.Number(row["stats"]?["totalOutputTokens"]) ?? 0,
            SessionCatalog.WaitProjection(row["meta"]?["wait"]),
            T(row["childModelDefault"]),
            T(row["childEffortDefault"]),
            SessionCatalog.Number(row["compactThresholdTokens"]),
            Cost: SessionCatalog.Number(row["stats"]?["totalCost"]),
            LlmFailed: SessionCatalog.Flag(row["meta"]?["llmFailed"]),
            Runtime: T(row["runtime"]) ?? "foxwarm",
            ExternalRuntime: row["externalRuntime"]?.DeepClone() as JsonObject
        );
    }

    internal SessionMetadata? CatalogMetadata(string requested)
    {
        var resolution = Catalog.Resolve(requested);
        return SessionCatalog.Text(resolution["sessionId"]) is { } id && Catalog.Get(id) is { } row
            ? Metadata(row)
            : null;
    }

    private SessionMetadata OverlayMainMetadata(SessionMetadata value)
    {
        if (Catalog.Get(value.Id) is not { } main)
            return value;
        return value with
        {
            Agent = SessionCatalog.Text(main["agent"])!,
            ParentSessionId = SessionCatalog.Text(main["parentSessionId"]),
            DisplayName = SessionCatalog.Text(main["displayName"]),
            Archived = SessionCatalog.Flag(main["archived"]),
            Pinned = SessionCatalog.Flag(main["pinned"]),
            SidebarOrder = SessionCatalog.Number(main["sidebarOrder"]),
        };
    }

    private void CaptureLocalProjection(SessionOwner owner)
    {
        if (!IsCurrentOwner(owner))
            return;
        var meta = owner.Metadata();
        var context = ExecutionPlacement(owner);
        var runtime = owner.RuntimeSnapshot(meta);
        var active =
            runtime["processing"]?.GetValue<bool>() == true
            || meta.Busy
            || meta.Stopping
            || meta.QueueLength > 0
            || meta.Wait is not null
            || owner.ToolActive
            || owner.Compacting
            || runtime["compaction"] is not null;
        var projected = new JsonObject
        {
            ["id"] = meta.Id,
            ["agent"] = meta.Agent,
            ["parentSessionId"] = meta.ParentSessionId,
            ["busy"] = meta.Busy,
            ["stopping"] = meta.Stopping,
            ["busyStartedAt"] = meta.BusyStartedAt,
            ["queueLength"] = meta.QueueLength,
            ["runtime"] = meta.Runtime,
            ["externalRuntime"] = meta.ExternalRuntime?.DeepClone(),
            ["model"] = meta.Model,
            ["effort"] = meta.Effort,
            ["childModelDefault"] = meta.ChildModel,
            ["childEffortDefault"] = meta.ChildEffort,
            ["compactThresholdTokens"] = meta.CompactThreshold,
            ["meta"] = new JsonObject
            {
                ["lastMessageTime"] = meta.LastMessageTime,
                ["messageCount"] = meta.MessageCount,
                ["wait"] = meta.Wait?.DeepClone(),
                ["llmFailed"] = meta.LlmFailed,
            },
            ["stats"] = new JsonObject
            {
                ["totalCachedTokens"] = meta.CachedTokens,
                ["totalInputTokens"] = meta.InputTokens,
                ["totalOutputTokens"] = meta.OutputTokens,
            },
            ["currentNode"] = context.Node,
            ["cwd"] = context.Cwd,
            ["_toolActive"] = owner.ToolActive,
            ["_compacting"] = owner.Compacting,
        };
        if (meta.Cost is double cost)
            projected["stats"]!["totalCost"] = cost;
        // Signature contains only list-visible bounded data, never messages or queue bodies.
        if (meta.Effort is null)
            projected.Remove("effort");
        if (meta.ChildEffort is null)
            projected.Remove("childEffortDefault");
        projected = SessionCatalog
            .Project(projected)
            .AlsoRuntimeFlags(owner.ToolActive, owner.Compacting);
        if (active)
            projected["_runtimeState"] = runtime;
        var persisted = Catalog.Get(owner.Id);
        if (persisted is not null)
            SessionCatalog.OverlayMain(projected, persisted);
        var differs =
            persisted is null
            || !JsonNode.DeepEquals(VisibleSignature(projected), VisibleSignature(persisted));
        lock (presentationGate)
        {
            if (!active && !differs)
            {
                if (localVisible.Remove(owner.Id))
                    volatileSequence++;
                return;
            }
            if (
                !localVisible.TryGetValue(owner.Id, out var prior)
                || !JsonNode.DeepEquals(prior, projected)
            )
            {
                localVisible[owner.Id] = projected;
                volatileSequence++;
            }
        }
    }

    private static JsonObject VisibleSignature(JsonObject row)
    {
        var signature = new JsonObject();
        foreach (
            var field in new[]
            {
                "runtime",
                "externalRuntime",
                "model",
                "effort",
                "childModelDefault",
                "childEffortDefault",
                "currentNode",
                "cwd",
            }
        )
            signature[field] = SessionCatalog.Text(row[field]);
        foreach (var field in new[] { "busy", "stopping", "_toolActive", "_compacting" })
            signature[field] = SessionCatalog.Flag(row[field]);
        signature["compactThresholdTokens"] = SessionCatalog.Number(row["compactThresholdTokens"]);
        signature["busyStartedAt"] = SessionCatalog.Number(row["busyStartedAt"]);
        signature["queueLength"] = SessionCatalog.Number(row["queueLength"]) ?? 0;
        foreach (var field in new[] { "messageCount", "lastMessageTime" })
            signature[field] = SessionCatalog.Number(row["meta"]?[field]) ?? 0;
        foreach (
            var field in new[] { "totalCachedTokens", "totalInputTokens", "totalOutputTokens" }
        )
            signature[field] = SessionCatalog.Number(row["stats"]?[field]) ?? 0;
        signature["totalCost"] = SessionCatalog.Number(row["stats"]?["totalCost"]);
        signature["runtimeState"] = row["_runtimeState"]?.DeepClone();
        signature["llmFailed"] = SessionCatalog.Flag(row["meta"]?["llmFailed"]);
        signature["wait"] = SessionCatalog.WaitProjection(row["meta"]?["wait"]);
        return signature;
    }

    private JsonObject[] MetadataRows()
    {
        var rows = Catalog
            .List()
            .ToDictionary(row => SessionCatalog.Text(row["id"])!, StringComparer.Ordinal);
        foreach (var local in LocalProjections())
            rows[SessionCatalog.Text(local["id"])!] = local;
        return rows.Values.ToArray();
    }

    internal JsonObject[] CatalogPresentations(string[] ids, bool includeLocal)
    {
        var all = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        foreach (var chunk in ids.Distinct(StringComparer.Ordinal).Chunk(200))
        foreach (var row in Catalog.GetMany(chunk))
            all[SessionCatalog.Text(row["id"])!] = row;
        var current = LocalProjections();
        var currentMain = new Dictionary<string, JsonObject>(all, StringComparer.Ordinal);
        if (includeLocal)
            foreach (
                var chunk in current
                    .Select(row => SessionCatalog.Text(row["id"])!)
                    .Where(id => !currentMain.ContainsKey(id))
                    .Chunk(200)
            )
            foreach (var row in Catalog.GetMany(chunk))
                currentMain[SessionCatalog.Text(row["id"])!] = row;
        foreach (var local in current)
        {
            var id = SessionCatalog.Text(local["id"])!;
            if (!includeLocal && !all.ContainsKey(id))
                continue;
            var copy = (JsonObject)local.DeepClone();
            if (currentMain.GetValueOrDefault(id) is { } main)
                SessionCatalog.OverlayMain(copy, main);
            all[id] = copy;
        }
        var scopes = new Dictionary<string, JsonObject>(StringComparer.Ordinal);
        var childCounts = new Dictionary<string, long>(StringComparer.Ordinal);
        foreach (var chunk in all.Keys.Chunk(200))
        {
            foreach (var pair in Catalog.Scopes(chunk))
                scopes[pair.Key] = pair.Value;
            foreach (var pair in Catalog.ChildCounts(chunk))
                childCounts[pair.Key] = pair.Value;
        }
        var sequences = ArchiveSequenceCounts(all.Keys.ToArray());
        var ancestry = PresentationAncestry(all, current);
        return all
            .Values.Select(row =>
            {
                var id = SessionCatalog.Text(row["id"])!;
                var dto = SessionPresentation.Build(
                    Metadata(row),
                    models,
                    id => ancestry.GetValueOrDefault(id),
                    SessionCatalog.Flag(row["_toolActive"]),
                    SessionCatalog.Flag(row["_compacting"])
                );
                if (row["_runtimeState"] is JsonObject runtime)
                    dto["runtimeState"] = runtime.DeepClone();
                dto["aliases"] = row["aliases"]?.DeepClone() ?? new JsonArray();
                dto["currentNode"] = row["currentNode"]?.DeepClone();
                dto["cwd"] = row["cwd"]?.DeepClone();
                if (scopes.TryGetValue(id, out var scope))
                {
                    dto["parentSessionId"] = scope["parentSessionId"]?.DeepClone();
                    dto["pinned"] = scope["pinned"]?.DeepClone();
                    dto["agent"] = scope["agent"]?.DeepClone();
                }
                dto["childTotal"] = childCounts.GetValueOrDefault(id);
                dto["sequenceMessageCount"] = sequences.GetValueOrDefault(id);
                return dto;
            })
            .ToArray();
    }

    private Dictionary<string, SessionMetadata> PresentationAncestry(
        Dictionary<string, JsonObject> supplied,
        JsonObject[] current
    )
    {
        var records = new Dictionary<string, JsonObject>(supplied, StringComparer.Ordinal);
        var local = current.ToDictionary(
            row => SessionCatalog.Text(row["id"])!,
            StringComparer.Ordinal
        );
        var result = records.ToDictionary(
            pair => pair.Key,
            pair => Metadata(pair.Value),
            StringComparer.Ordinal
        );
        var seen = new HashSet<string>(StringComparer.Ordinal);
        var pending = records
            .Values.Select(row => SessionCatalog.Text(row["parentSessionId"]))
            .OfType<string>()
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        while (pending.Length > 0)
        {
            var next = new List<string>();
            foreach (var chunk in pending.Where(seen.Add).Chunk(200))
            {
                var resolved = Catalog.ResolveMany(chunk);
                var ids = resolved
                    .Values.Select(row => SessionCatalog.Text(row["sessionId"]))
                    .OfType<string>()
                    .Distinct(StringComparer.Ordinal)
                    .ToArray();
                foreach (var row in Catalog.GetMany(ids))
                {
                    var id = SessionCatalog.Text(row["id"])!;
                    if (local.TryGetValue(id, out var hot))
                    {
                        var copy = (JsonObject)hot.DeepClone();
                        SessionCatalog.OverlayMain(copy, row);
                        records[id] = copy;
                    }
                    else
                        records[id] = row;
                }
                foreach (var request in chunk)
                {
                    if (
                        SessionCatalog.Text(resolved[request]["sessionId"]) is not { } id
                        || !records.TryGetValue(id, out var row)
                    )
                        continue;
                    result[request] = Metadata(row);
                    if (SessionCatalog.Text(row["parentSessionId"]) is { } parent)
                        next.Add(parent);
                }
            }
            pending = next.Distinct(StringComparer.Ordinal).ToArray();
        }
        return result;
    }

    internal JsonObject[] ListPresentations()
    {
        // Explicit legacy external API: unbounded output, unlike normal bounded navigation.
        var ids = Catalog.List().Select(row => SessionCatalog.Text(row["id"])!).ToArray();
        return CatalogPresentations(ids, true);
    }

    internal PresentationChange ChangePresentation(Func<SessionCatalog, PresentationChange> action)
    {
        var change = action(Catalog);
        try
        {
            foreach (var id in change.ChangedIds)
                SyncHotParent(id);
            foreach (var id in change.ChangedIds)
                Find(id)?.PublishStateChanged();
        }
        catch (Exception error)
        {
            throw new PresentationCommittedException(change, error);
        }
        return change;
    }

    private void SyncHotParent(string id)
    {
        var owner = Find(id);
        if (owner is null)
            return;
        while (true)
        {
            var revision = Catalog.Revision;
            var parent = SessionCatalog.Text(Catalog.Get(id)?["parentSessionId"]);
            owner.Entry.WithState(state =>
            {
                if (parent is null)
                    state.AuthorityEnvelope.Remove("parentSessionId");
                else
                    state.AuthorityEnvelope["parentSessionId"] = parent;
            });
            if (revision == Catalog.Revision)
                return;
        }
    }

    internal void ReplyToCommand(string id, string text)
    {
        var data = new JsonObject
        {
            ["role"] = "assistant",
            ["parts"] = new JsonArray(new JsonObject { ["text"] = text }),
            ["__meta"] = new JsonObject
            {
                ["timestamp"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                ["channelUserId"] = id,
                ["username"] = "webui",
                ["platform"] = "webui",
                ["temporary"] = true,
                ["isCommandResponse"] = true,
            },
        };
        if (Find(id) is { } owner)
            owner.Emit(SessionEventKind.CommandReply, data);
        else
            Changed?.Invoke(new(id, SessionEventKind.CommandReply, data));
    }

    internal Task RenameAsync(string id, string? name)
    {
        Catalog.Rename(id, name);
        Find(id)?.PublishStateChanged();
        return Task.CompletedTask;
    }

    private Dictionary<string, long> ArchiveSequenceCounts(string[] ids)
    {
        var result = new Dictionary<string, long>(StringComparer.Ordinal);
        var file = Path.Combine(root, "state", "archive-store.sqlite");
        if (!File.Exists(file))
            return result;
        using var connection = new SqliteConnection(
            new SqliteConnectionStringBuilder
            {
                DataSource = file,
                Mode = SqliteOpenMode.ReadOnly,
                Pooling = false,
            }.ToString()
        );
        connection.Open();
        foreach (var chunk in ids.Chunk(200))
        {
            using var command = connection.CreateCommand();
            var parameters = Enumerable
                .Range(0, chunk.Length)
                .Select(index => "$id" + index)
                .ToArray();
            for (var index = 0; index < chunk.Length; index++)
                command.Parameters.AddWithValue(parameters[index], chunk[index]);
            command.CommandText = $"""
WITH requested(session_id) AS (VALUES {string.Join(
                    ',',
                    parameters.Select(parameter => "(" + parameter + ")")
                )}),
local_max AS (SELECT messages.session_id,MAX(messages.seq) max_seq FROM archive_messages messages INNER JOIN requested ON requested.session_id=messages.session_id GROUP BY messages.session_id)
SELECT requested.session_id,COALESCE(local_max.max_seq,0),branches.parent_session_id,branches.fork_message_seq
FROM requested LEFT JOIN local_max ON local_max.session_id=requested.session_id LEFT JOIN archive_branches branches ON branches.session_id=requested.session_id
""";
            using var reader = command.ExecuteReader();
            while (reader.Read())
                result[reader.GetString(0)] = reader.IsDBNull(2)
                    ? reader.GetInt64(1)
                    : Math.Max(0, reader.GetInt64(1) - reader.GetInt64(3));
        }
        return result;
    }
}

internal static class CatalogRuntimeFlags
{
    internal static JsonObject AlsoRuntimeFlags(this JsonObject row, bool tool, bool compacting)
    {
        row["_toolActive"] = tool;
        row["_compacting"] = compacting;
        return row;
    }
}
