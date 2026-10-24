using System.Text.Json.Nodes;

namespace Foxwarm.Sessions;

internal sealed partial class SessionManager
{
    internal async Task<string?> DeclareWaitAsync(SessionOwner source, JsonObject args)
    {
        var wait = ValidateWait(source, args);
        try
        {
            return await source.Entry.SaveLane.StartWaitAsync(wait);
        }
        catch (AuthorityCommittedException error)
        {
            throw new CommittedWaitDeclarationException(SessionWait.Text(wait["id"])!, error);
        }
    }

    internal JsonObject ValidateWait(SessionOwner source, JsonObject args)
    {
        Keys(
            args,
            [
                "reason",
                "wakeIfNoActivityAfterSeconds",
                "waitAllSessions",
                "waitAnySessions",
                "waitExecIds",
                "waitForInput",
            ],
            []
        );
        var reason = OptionalString(args, "reason");
        var all = ParseIds(args, "waitAllSessions", 2);
        var any = ParseIds(args, "waitAnySessions", 1);
        var exec = ParseIds(args, "waitExecIds", 1);
        if (all is not null && any is not null)
            throw new InvalidDataException(
                "waitAllSessions and waitAnySessions are mutually exclusive."
            );
        var input = OptionalBool(args, "waitForInput");
        if (input == false)
            throw new InvalidDataException("waitForInput must be exactly true when provided.");
        double? seconds = null;
        if (
            args.ContainsKey("wakeIfNoActivityAfterSeconds")
            && args["wakeIfNoActivityAfterSeconds"] is not null
        )
        {
            seconds = SessionWait.Number(args["wakeIfNoActivityAfterSeconds"]);
            if (seconds is not double value || !double.IsFinite(value) || value <= 0)
                throw new InvalidDataException(
                    "wakeIfNoActivityAfterSeconds must be a positive finite number."
                );
        }
        if (!args.ContainsKey("wakeIfNoActivityAfterSeconds") && exec is not null && input != true)
            seconds = 600;
        if (all is null && any is null && exec is null && input != true && seconds is null)
            throw new InvalidDataException(
                "wait requires at least one progress source or fallback; reason alone is not sufficient."
            );
        string[]? ResolveTargets(string[]? ids)
        {
            if (ids is null)
                return null;
            var targets = ids.Select(id =>
                    SessionCatalog.Text(
                        Catalog.Resolve(ResolveSessionReference(source, id))["sessionId"]
                    )
                    ?? throw new InvalidDataException(
                        $"Wait source '{id}' must be an existing other Session."
                    )
                )
                .Distinct(StringComparer.Ordinal)
                .ToArray();
            if (targets.Contains(source.Id, StringComparer.Ordinal))
                throw new InvalidDataException("A Session cannot wait for itself.");
            return targets;
        }
        all = ResolveTargets(all);
        any = ResolveTargets(any);
        if (all is { Length: < 2 })
            throw new InvalidDataException(
                "waitAllSessions must resolve to at least two distinct Sessions."
            );
        if (exec is not null)
        {
            var queued = source.Entry.WithState(state =>
                state
                    .Queue.Select(item => SessionWait.Text(item.OpenFields?["execId"]))
                    .OfType<string>()
                    .ToHashSet(StringComparer.Ordinal)
            );
            foreach (var id in exec)
                if (
                    !executor.IsOwnedActive(source.Id, id)
                    && !Nodes.ExecClaims.Has(source, id)
                    && !queued.Contains(id)
                )
                    throw new InvalidDataException(
                        $"waitExecIds entry `{id}` is not an active exec owned by this Session and has no queued completion. Use the exact execId, never a PID, log path, or command text."
                    );
        }
        var wait = NewWait();
        if (!string.IsNullOrWhiteSpace(reason))
            wait["reason"] = reason.Trim();
        if (seconds is double timeout)
            wait["timeoutSeconds"] = timeout;
        if (input == true)
            wait["waitForInput"] = true;
        if (exec is not null)
            wait["waitExecIds"] = IdArray(exec);
        if (any is not null)
            wait["waitAnySessions"] = IdArray(any);
        if (all is not null)
            wait["waitAll"] = new JsonObject
            {
                ["sessions"] = IdArray(all),
                ["satisfiedSessions"] = new JsonArray(),
                ["deferredQueue"] = new JsonArray(),
            };
        return wait;
    }

    internal Task<string?> StartHandoffWaitAsync(SessionOwner source, IReadOnlyList<string> targets)
    {
        var wait = NewWait();
        if (targets.Count > 0)
            wait["waitAnySessions"] = IdArray(targets.Distinct(StringComparer.Ordinal));
        else
            wait["waitForInput"] = true;
        return source.Entry.SaveLane.StartWaitAsync(wait);
    }

    private static JsonObject NewWait() =>
        new()
        {
            ["id"] = Guid.NewGuid().ToString(),
            ["startedAt"] = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
            ["declarationVersion"] = 1,
        };

    private static JsonArray IdArray(IEnumerable<string> ids) =>
        new(ids.Select(id => (JsonNode?)JsonValue.Create(id)).ToArray());

    private static string[]? ParseIds(JsonObject args, string key, int minimum)
    {
        if (!args.ContainsKey(key))
            return null;
        if (
            args[key] is not JsonArray array
            || array.Any(value => string.IsNullOrWhiteSpace(SessionWait.Text(value)))
        )
            throw new InvalidDataException($"{key} must contain nonempty string IDs.");
        var ids = array
            .Select(value => SessionWait.Text(value)!.Trim())
            .Distinct(StringComparer.Ordinal)
            .ToArray();
        if (ids.Length < minimum)
            throw new InvalidDataException($"{key} requires at least {minimum} distinct IDs.");
        return ids;
    }

    internal async Task AdmitWaitEventAsync(string sessionId, QueueItem item)
    {
        if (!Accepting)
            return;
        if (
            SessionWait.Text(item.OpenFields?["waitLivenessWaitId"]) is not null
            && !WaitLiveness.Recent(
                (Find(sessionId)?.Metadata() ?? CatalogMetadata(sessionId))?.LastMessageTime ?? 0,
                DateTimeOffset.UtcNow.ToUnixTimeMilliseconds()
            )
        )
            return;
        var owner = await GetExistingAsync(sessionId);
        if (owner is null)
            return;
        bool admitted;
        try
        {
            admitted = await owner.Entry.SaveLane.AdmitAsync(item, SaveKind.Strict);
        }
        catch (AuthorityCommittedException)
        {
            if (
                Accepting
                && !owner.Entry.WithState(state => state.Busy || state.Stopping)
                && owner.Registry.HasRunnableWork(owner.Entry)
            )
                _ = owner.StartProcessing();
            throw;
        }
        if (
            Accepting
            && admitted
            && !owner.Entry.WithState(state => state.Busy || state.Stopping)
            && owner.Registry.HasRunnableWork(owner.Entry)
        )
            _ = owner.StartProcessing();
    }
}

internal sealed class CommittedWaitDeclarationException(string waitId, Exception cause)
    : IOException(cause.Message, cause)
{
    internal string WaitId => waitId;
}
